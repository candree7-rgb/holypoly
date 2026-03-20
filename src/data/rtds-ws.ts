import WebSocket from "ws";
import { Logger } from "../logger.js";

export interface ChainlinkTick {
  symbol: string;
  price: number;
  timestamp: number;
}

/**
 * Polymarket RTDS WebSocket client for Chainlink BTC/USD prices.
 * URL: wss://ws-live-data.polymarket.com
 * This is the SETTLEMENT reference — Chainlink is what determines the winner.
 */
export class RtdsWsClient {
  private ws: WebSocket | null = null;
  private lastTick: ChainlinkTick | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private running = false;
  private onTickCallbacks: ((tick: ChainlinkTick) => void)[] = [];

  constructor(private logger: Logger) {}

  get price(): number | null {
    return this.lastTick?.price ?? null;
  }

  get timestamp(): number | null {
    return this.lastTick?.timestamp ?? null;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Check if Chainlink data is stale (> 60s old) */
  get isStale(): boolean {
    if (!this.lastTick) return true;
    return Date.now() - this.lastTick.timestamp > 60000;
  }

  onTick(cb: (tick: ChainlinkTick) => void): void {
    this.onTickCallbacks.push(cb);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
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

  private connect(): void {
    if (!this.running) return;

    const url = "wss://ws-live-data.polymarket.com";
    this.logger.debug("RTDS WS connecting", { url });

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.logger.info("RTDS WS connected");
      this.reconnectDelay = 1000;

      // Subscribe to Chainlink BTC/USD
      this.ws!.send(JSON.stringify({
        action: "subscribe",
        subscriptions: [
          {
            topic: "crypto_prices_chainlink",
            type: "*",
            filters: JSON.stringify({ symbol: "btc/usd" }),
          },
        ],
      }));

      // Keepalive: ping every 5 seconds
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
          topic?: string;
          type?: string;
          timestamp?: number;
          payload?: {
            symbol: string;
            timestamp: number;
            value: number;
          };
        };

        if (msg.topic === "crypto_prices_chainlink" && msg.payload) {
          const tick: ChainlinkTick = {
            symbol: msg.payload.symbol,
            price: msg.payload.value,
            timestamp: msg.payload.timestamp,
          };
          this.lastTick = tick;
          for (const cb of this.onTickCallbacks) {
            cb(tick);
          }
        }
      } catch {
        // ignore malformed messages
      }
    });

    this.ws.on("close", () => {
      this.logger.warn("RTDS WS disconnected");
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      this.logger.error("RTDS WS error", { error: err.message });
      this.ws?.close();
    });
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    this.logger.info("RTDS WS reconnecting", { delayMs: this.reconnectDelay });
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }
}
