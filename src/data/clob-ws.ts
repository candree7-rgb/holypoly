import WebSocket from "ws";
import { Logger } from "../logger.js";

export interface BookSnapshot {
  assetId: string;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  bestBid: number | null;
  bestAsk: number | null;
}

/**
 * Polymarket CLOB WebSocket for realtime orderbook updates.
 * URL: wss://ws-subscriptions-clob.polymarket.com/ws/market
 * No auth required for market channel.
 */
export class ClobWsClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private running = false;
  private subscribedTokens: string[] = [];
  private books: Map<string, BookSnapshot> = new Map();
  private onUpdateCallbacks: ((assetId: string, book: BookSnapshot) => void)[] = [];

  constructor(private logger: Logger) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  getBook(tokenId: string): BookSnapshot | null {
    return this.books.get(tokenId) ?? null;
  }

  onUpdate(cb: (assetId: string, book: BookSnapshot) => void): void {
    this.onUpdateCallbacks.push(cb);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Don't connect yet — wait until subscribe() is called with tokens.
    // Polymarket closes connections that don't send a subscription immediately.
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Subscribe to orderbook updates for given token IDs.
   */
  subscribe(tokenIds: string[]): void {
    this.subscribedTokens = tokenIds;
    if (this.ws?.readyState === WebSocket.OPEN) {
      // Already connected — just send new subscription
      this.sendSubscription();
    } else if (this.running && tokenIds.length > 0 && !this.ws) {
      // Not connected yet — connect now (subscription will be sent on open)
      this.connect();
    }
  }

  /**
   * Clear subscriptions and books (call on window transition).
   */
  clear(): void {
    this.subscribedTokens = [];
    this.books.clear();
    // Disconnect — no point keeping WS open without subscriptions
    // (server will kick us anyway for not having a subscription)
    if (this.ws) {
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  private sendSubscription(): void {
    if (!this.ws || this.subscribedTokens.length === 0) return;
    this.ws.send(JSON.stringify({
      assets_ids: this.subscribedTokens,
      type: "market",
      custom_feature_enabled: true,
    }));
    this.logger.debug("CLOB WS subscribed", { tokens: this.subscribedTokens.length });
  }

  private connect(): void {
    if (!this.running) return;

    const url = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
    this.logger.debug("CLOB WS connecting");

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.logger.info("CLOB WS connected");
      this.reconnectDelay = 1000;

      // Re-subscribe if we have tokens
      if (this.subscribedTokens.length > 0) {
        this.sendSubscription();
      }

      // Keepalive: Polymarket requires PING within 10 seconds.
      // Send every 5s to avoid race condition with server's 10s timeout.
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send("PING");
        }
      }, 5000);
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      const raw = data.toString();
      if (raw === "PONG") return;

      try {
        const msg = JSON.parse(raw) as {
          event_type?: string;
          asset_id?: string;
          market?: string;
          best_bid?: string;
          best_ask?: string;
          spread?: string;
          bids?: Array<{ price: string; size: string }>;
          asks?: Array<{ price: string; size: string }>;
          price_changes?: Array<{
            asset_id: string;
            price: string;
            size: string;
            side: string;
            best_bid: string;
            best_ask: string;
          }>;
        };

        if (msg.event_type === "book" && msg.asset_id) {
          // Full orderbook snapshot
          const book = this.parseBook(
            msg.asset_id,
            msg.bids || [],
            msg.asks || []
          );
          this.books.set(msg.asset_id, book);
          this.notifyUpdate(msg.asset_id, book);

        } else if (msg.event_type === "best_bid_ask" && msg.asset_id) {
          // Top-of-book update (custom_feature_enabled)
          // This is the FASTEST event — fires on every best bid/ask change
          let existing = this.books.get(msg.asset_id);
          if (!existing) {
            existing = {
              assetId: msg.asset_id,
              bids: [],
              asks: [],
              bestBid: null,
              bestAsk: null,
            };
            this.books.set(msg.asset_id, existing);
          }
          if (msg.best_bid) existing.bestBid = parseFloat(msg.best_bid) || existing.bestBid;
          if (msg.best_ask) existing.bestAsk = parseFloat(msg.best_ask) || existing.bestAsk;
          this.notifyUpdate(msg.asset_id, existing);

        } else if (msg.event_type === "price_change" && msg.price_changes) {
          // Price level update — update the actual asks/bids arrays
          for (const change of msg.price_changes) {
            let existing = this.books.get(change.asset_id);
            if (!existing) {
              existing = {
                assetId: change.asset_id,
                bids: [],
                asks: [],
                bestBid: null,
                bestAsk: null,
              };
              this.books.set(change.asset_id, existing);
            }

            // Update the specific price level in bids or asks
            const price = parseFloat(change.price);
            const size = parseFloat(change.size);
            const side = change.side; // "BUY" = bid, "SELL" = ask

            if (!isNaN(price)) {
              const list = side === "BUY" ? existing.bids : existing.asks;
              const idx = list.findIndex(l => l.price === price);

              if (size > 0) {
                // Upsert: update existing level or insert new one
                if (idx >= 0) {
                  list[idx].size = size;
                } else {
                  list.push({ price, size });
                  // Re-sort: bids descending, asks ascending
                  if (side === "BUY") {
                    list.sort((a, b) => b.price - a.price);
                  } else {
                    list.sort((a, b) => a.price - b.price);
                  }
                }
              } else {
                // Size 0: remove level
                if (idx >= 0) list.splice(idx, 1);
              }
            }

            existing.bestBid = parseFloat(change.best_bid) || existing.bestBid;
            existing.bestAsk = parseFloat(change.best_ask) || existing.bestAsk;
            this.notifyUpdate(change.asset_id, existing);
          }
        }
      } catch {
        // ignore
      }
    });

    this.ws.on("close", () => {
      this.logger.warn("CLOB WS disconnected");
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      this.logger.error("CLOB WS error", { error: err.message });
      this.ws?.close();
    });
  }

  private parseBook(
    assetId: string,
    rawBids: Array<{ price: string; size: string }>,
    rawAsks: Array<{ price: string; size: string }>
  ): BookSnapshot {
    const bids = rawBids
      .map((b) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
      .filter((b) => b.size > 0)
      .sort((a, b) => b.price - a.price);

    const asks = rawAsks
      .map((a) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
      .filter((a) => a.size > 0)
      .sort((a, b) => a.price - b.price);

    return {
      assetId,
      bids,
      asks,
      bestBid: bids.length > 0 ? bids[0].price : null,
      bestAsk: asks.length > 0 ? asks[0].price : null,
    };
  }

  private notifyUpdate(assetId: string, book: BookSnapshot): void {
    for (const cb of this.onUpdateCallbacks) {
      cb(assetId, book);
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    // Only reconnect if we have tokens to subscribe to
    if (this.subscribedTokens.length === 0) {
      this.logger.debug("CLOB WS not reconnecting — no subscriptions");
      this.ws = null;
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }
}
