import WebSocket from "ws";
import type { Logger } from "../logger.js";

/**
 * A single detected trade from the target trader.
 */
export interface TargetTrade {
  /** Unique ID for dedup */
  id: string;
  /** BUY or SELL */
  side: "BUY" | "SELL";
  /** TRADE, REDEEM, etc. */
  type: string;
  /** Condition ID of the market */
  conditionId: string;
  /** Token ID bought/sold */
  tokenId: string;
  /** Outcome name (Up, Down, Yes, No) */
  outcome: string;
  /** Price in cents (0-100) */
  priceCents: number;
  /** Number of shares */
  shares: number;
  /** USD value of trade */
  usdValue: number;
  /** Market title / question */
  title: string;
  /** Timestamp (ms) */
  timestamp: number;
  /** Detection source: "chain" or "api" */
  source: "chain" | "api";
}

// ---------- Constants ----------

/** Polymarket ConditionalTokens (CTF) contract on Polygon */
const CTF_ADDRESS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";

/**
 * TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)
 * Keccak-256 of the event signature.
 */
const TRANSFER_SINGLE_TOPIC = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";

/** Pad an address to 32 bytes for topic filter */
const padAddress = (addr: string): string => "0x" + addr.replace("0x", "").toLowerCase().padStart(64, "0");

// ---------- Multi-source tracker ----------

/**
 * Ultra-fast tracker using 4 detection layers (per docs.polymarket.com):
 *
 * Layer 0: RTDS Activity WS (FASTEST — ~50ms after CLOB match)
 *   wss://ws-live-data.polymarket.com
 *   Streams ALL platform trades with `proxyWallet` field.
 *   Client-side filter by target address. No auth required.
 *
 * Layer 1: CLOB Market WS `last_trade_price` (~50ms)
 *   Anonymous but instant — triggers immediate Data API poll.
 *
 * Layer 2: Data API polling (~200ms interval)
 *   Queries /activity + /trades endpoints for target's trades.
 *
 * Layer 3: Polygon Chain WS (2-4s)
 *   Reliable backup — on-chain settlement confirmation.
 */
export class TargetTracker {
  private dataApiHost: string;
  private gammaHost: string;
  private targetAddress: string;
  /** Set of addresses to match (lowercase): includes target + any known proxy wallets */
  private targetAddresses: Set<string> = new Set();
  private logger: Logger;
  private seenIds: Set<string> = new Set();
  private onTrade: ((trade: TargetTrade) => void) | null = null;

  // RTDS WebSocket (layer 0 — FASTEST: streams all trades with proxyWallet)
  private rtdsWs: WebSocket | null = null;
  private rtdsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private rtdsReconnectDelay = 1000;
  private rtdsConnected = false;

  // On-chain WebSocket (layer 3 — reliable backup)
  private rpcWsUrl: string;
  private chainWs: WebSocket | null = null;
  private chainSubId: string | null = null;
  private chainReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private chainReconnectDelay = 1000;
  private chainConnected = false;

  // CLOB Market WebSocket (layer 1 — fastest trigger)
  private clobWs: WebSocket | null = null;
  private clobWsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private clobWsReconnectDelay = 1000;
  private clobWsConnected = false;
  private clobWsPingTimer: ReturnType<typeof setInterval> | null = null;
  /** Token IDs we're watching on the CLOB WS (from target's known markets) */
  private watchedTokenIds: Set<string> = new Set();

  // Data API polling (layer 2 — primary detection with metadata)
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number;
  private isPolling = false;
  private lastPollTimestamp: number = 0;

  // Pending on-chain events waiting for metadata from API
  private pendingChainEvents: Map<string, { tokenId: string; shares: number; timestamp: number }> = new Map();

  // Cache: token ID → market metadata (avoid repeated Gamma lookups)
  private marketCache: Map<string, { conditionId: string; title: string; outcome: string; clobTokenId: string } | null> = new Map();

  // Bot start time — ignore trades before this
  private startedAt: number = 0;

  // Stats
  private stats = {
    rtdsDetections: 0,
    chainEvents: 0,
    apiDetections: 0,
    clobWsTriggers: 0,
    totalPolls: 0,
    consecutiveErrors: 0,
  };

  constructor(
    dataApiHost: string,
    targetAddress: string,
    rpcWsUrl: string,
    pollIntervalMs: number,
    logger: Logger,
    gammaHost?: string,
  ) {
    this.dataApiHost = dataApiHost.replace(/\/$/, "");
    this.gammaHost = (gammaHost ?? "https://gamma-api.polymarket.com").replace(/\/$/, "");
    this.targetAddress = targetAddress.toLowerCase();
    this.targetAddresses.add(this.targetAddress);
    this.rpcWsUrl = rpcWsUrl;
    this.pollIntervalMs = pollIntervalMs;
    this.logger = logger;
    this.startedAt = Date.now();
    this.lastPollTimestamp = Math.floor(Date.now() / 1000);

    // Try to resolve proxy wallet in background (RTDS uses proxyWallet, not EOA)
    this.resolveProxyWallet();
  }

  /**
   * Resolve the target's proxy wallet address from Gamma API.
   * RTDS activity events use `proxyWallet`, which may differ from the configured target address.
   */
  private async resolveProxyWallet(): Promise<void> {
    try {
      const resp = await fetch(
        `${this.gammaHost}/profiles/${this.targetAddress}`,
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(3000) },
      );
      if (!resp.ok) return;
      const data = await resp.json() as { proxyWallet?: string; proxy_wallet?: string };
      const proxy = (data.proxyWallet || data.proxy_wallet || "").toLowerCase();
      if (proxy && proxy !== this.targetAddress) {
        this.targetAddresses.add(proxy);
        this.logger.info("Resolved target proxy wallet", {
          eoa: this.targetAddress.slice(0, 8) + "...",
          proxy: proxy.slice(0, 8) + "...",
        });
      }
    } catch {
      // Non-critical — RTDS will still match on EOA
    }
  }

  onNewTrade(cb: (trade: TargetTrade) => void): void {
    this.onTrade = cb;
  }

  /**
   * Trigger an immediate poll from the CLOB WS.
   * Separate from the regular interval — this is the speed boost.
   */
  triggerInstantPoll(): void {
    this.poll();
  }

  /**
   * Start all 4 detection layers:
   * 0. RTDS Activity WS (FASTEST — streams all trades with proxyWallet)
   * 1. CLOB Market WS (fast trigger — last_trade_price events)
   * 2. Data API polling (reliable detection with metadata)
   * 3. Polygon Chain WS (backup — on-chain settlement)
   */
  start(): void {
    this.logger.info("Tracker starting (4-layer detection)", {
      target: this.targetAddress.slice(0, 8) + "..." + this.targetAddress.slice(-6),
      rtds: "enabled (activity/trades stream — FASTEST)",
      clobWs: "enabled (last_trade_price trigger)",
      chainWs: this.rpcWsUrl ? "enabled (backup)" : "disabled",
      pollInterval: `${this.pollIntervalMs}ms`,
    });

    // Layer 0: RTDS Activity WS (FASTEST — sub-second trade stream)
    this.connectRtdsWs();

    // Layer 1: CLOB Market WS (turbo-trigger for known markets)
    this.connectClobWs();

    // Layer 2: Data API polling (always runs at pollIntervalMs as safety net)
    // CLOB WS triggers ADDITIONAL instant polls on top of this interval.
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.poll(); // Immediate first poll

    // Layer 3: On-chain WebSocket (backup)
    if (this.rpcWsUrl) {
      this.connectChainWs();
    }
  }

  stop(): void {
    // Stop RTDS WS
    if (this.rtdsReconnectTimer) {
      clearTimeout(this.rtdsReconnectTimer);
      this.rtdsReconnectTimer = null;
    }
    if (this.rtdsWs) {
      this.rtdsWs.removeAllListeners();
      this.rtdsWs.close();
      this.rtdsWs = null;
    }

    // Stop CLOB WS
    if (this.clobWsReconnectTimer) {
      clearTimeout(this.clobWsReconnectTimer);
      this.clobWsReconnectTimer = null;
    }
    if (this.clobWsPingTimer) {
      clearInterval(this.clobWsPingTimer);
      this.clobWsPingTimer = null;
    }
    if (this.clobWs) {
      this.clobWs.removeAllListeners();
      this.clobWs.close();
      this.clobWs = null;
    }

    // Stop chain WS
    if (this.chainReconnectTimer) {
      clearTimeout(this.chainReconnectTimer);
      this.chainReconnectTimer = null;
    }
    if (this.chainWs) {
      this.chainWs.removeAllListeners();
      this.chainWs.close();
      this.chainWs = null;
    }

    // Stop polling
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.logger.info("Tracker stopped", this.stats);
  }

  getStats() { return { ...this.stats }; }

  /**
   * Add token IDs to watch on the CLOB Market WS.
   * Called when we discover new markets the target trades on
   * (from chain events or API detections).
   */
  watchTokenIds(tokenIds: string[]): void {
    let newCount = 0;
    for (const id of tokenIds) {
      if (!this.watchedTokenIds.has(id)) {
        this.watchedTokenIds.add(id);
        newCount++;
      }
    }
    if (newCount > 0 && this.clobWsConnected) {
      this.subscribeClobWsTokens();
    }
  }

  // ==================== RTDS ACTIVITY WEBSOCKET (LAYER 0 — FASTEST) ====================

  private connectRtdsWs(): void {
    this.logger.info("Connecting to RTDS Activity WebSocket (fastest detection)...");

    this.rtdsWs = new WebSocket("wss://ws-live-data.polymarket.com");

    this.rtdsWs.on("open", () => {
      this.rtdsConnected = true;
      this.rtdsReconnectDelay = 1000;
      this.logger.info("RTDS WebSocket connected");

      // Subscribe to all platform trades
      this.rtdsWs!.send(JSON.stringify({
        action: "subscribe",
        subscriptions: [{ topic: "activity", type: "trades" }],
      }));
    });

    this.rtdsWs.on("message", (data: WebSocket.Data) => {
      const raw = data.toString();
      if (raw === "pong" || raw === "PONG") return;

      try {
        const msg = JSON.parse(raw) as RtdsTradeEvent | { type?: string };

        // Respond to server pings
        if ((msg as { type?: string }).type === "ping") {
          this.rtdsWs?.send(JSON.stringify({ type: "pong" }));
          return;
        }

        // Check if this is a trade event from our target
        const trade = msg as RtdsTradeEvent;
        if (!trade.proxyWallet && !trade.proxy_wallet) return;

        const wallet = (trade.proxyWallet || trade.proxy_wallet || "").toLowerCase();
        if (!this.targetAddresses.has(wallet)) return;

        // This IS our target trader!
        const side = (trade.side || "").toUpperCase() as "BUY" | "SELL";
        if (side !== "BUY" && side !== "SELL") return;

        const tokenId = trade.asset || trade.asset_id || "";
        const conditionId = trade.conditionId || trade.condition_id || "";
        const priceCents = Math.round((parseFloat(trade.price || "0") || 0) * 100);
        const shares = parseFloat(trade.size || "0") || 0;
        const outcome = trade.outcome || trade.outcomeName || "";
        const title = trade.title || trade.question || "";
        const timestamp = trade.timestamp
          ? (Number(trade.timestamp) > 1e12 ? Number(trade.timestamp) : Number(trade.timestamp) * 1000)
          : Date.now();

        const eventId = `rtds-${conditionId || tokenId}-${timestamp}-${side}`;
        if (this.seenIds.has(eventId)) return;
        this.seenIds.add(eventId);

        // Skip trades from before bot started
        if (timestamp < this.startedAt - 5000) return;

        this.stats.rtdsDetections++;

        this.logger.info("RTDS: Target trade detected (FASTEST)", {
          side,
          outcome,
          price: `${priceCents}¢`,
          shares: shares.toFixed(1),
          market: title.slice(0, 60),
          latency: `${Date.now() - timestamp}ms from match`,
        });

        // Auto-learn token ID for CLOB WS
        if (tokenId) {
          this.watchTokenIds([tokenId]);
        }

        const detectedTrade: TargetTrade = {
          id: eventId,
          side,
          type: "TRADE",
          conditionId,
          tokenId,
          outcome,
          priceCents,
          shares,
          usdValue: shares * priceCents / 100,
          title,
          timestamp,
          source: "api", // treat as API source (has full metadata)
        };

        if (this.onTrade) {
          this.onTrade(detectedTrade);
        }
      } catch {
        // ignore parse errors — RTDS sends various message types
      }
    });

    this.rtdsWs.on("close", () => {
      this.rtdsConnected = false;
      this.logger.warn("RTDS WebSocket disconnected");
      this.scheduleRtdsReconnect();
    });

    this.rtdsWs.on("error", (err: Error) => {
      this.logger.error("RTDS WebSocket error", { error: err.message });
      this.rtdsWs?.close();
    });
  }

  private scheduleRtdsReconnect(): void {
    this.rtdsReconnectTimer = setTimeout(() => {
      this.connectRtdsWs();
    }, this.rtdsReconnectDelay);
    this.rtdsReconnectDelay = Math.min(this.rtdsReconnectDelay * 2, 30_000);
  }

  // ==================== CLOB MARKET WEBSOCKET (LAYER 1) ====================

  private connectClobWs(): void {
    this.logger.info("Connecting to CLOB Market WebSocket...");

    this.clobWs = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");

    this.clobWs.on("open", () => {
      this.clobWsConnected = true;
      this.clobWsReconnectDelay = 1000;
      this.logger.info("CLOB Market WS connected");

      // Subscribe to known tokens
      if (this.watchedTokenIds.size > 0) {
        this.subscribeClobWsTokens();
      }

      // Keepalive: PING every 10 seconds (Polymarket disconnects otherwise)
      this.clobWsPingTimer = setInterval(() => {
        if (this.clobWs?.readyState === WebSocket.OPEN) {
          this.clobWs.send("PING");
        }
      }, 10_000);
    });

    this.clobWs.on("message", (data: WebSocket.Data) => {
      const raw = data.toString();
      if (raw === "PONG") return;

      try {
        const msg = JSON.parse(raw) as {
          event_type?: string;
          asset_id?: string;
          price?: string;
          size?: string;
          side?: string;
          timestamp?: string;
        };

        // last_trade_price = a trade just happened on this market!
        // This is our turbo-trigger: immediately poll the Data API
        // to check if it was our target trader.
        if (msg.event_type === "last_trade_price" && msg.asset_id) {
          this.stats.clobWsTriggers++;
          this.logger.debug("CLOB WS: Trade on watched market", {
            tokenId: msg.asset_id.slice(0, 12) + "...",
            price: msg.price,
            size: msg.size,
            side: msg.side,
          });

          // TURBO: Immediately trigger a Data API poll (skip interval wait)
          this.poll();
        }
      } catch {
        // ignore parse errors
      }
    });

    this.clobWs.on("close", () => {
      this.clobWsConnected = false;
      if (this.clobWsPingTimer) {
        clearInterval(this.clobWsPingTimer);
        this.clobWsPingTimer = null;
      }
      this.logger.warn("CLOB Market WS disconnected");
      this.scheduleClobWsReconnect();
    });

    this.clobWs.on("error", (err: Error) => {
      this.logger.error("CLOB Market WS error", { error: err.message });
      this.clobWs?.close();
    });
  }

  private subscribeClobWsTokens(): void {
    if (!this.clobWs || this.clobWs.readyState !== WebSocket.OPEN) return;
    if (this.watchedTokenIds.size === 0) return;

    const msg = {
      assets_ids: Array.from(this.watchedTokenIds),
      type: "market",
    };
    this.clobWs.send(JSON.stringify(msg));
    this.logger.info("CLOB WS: Subscribed to market tokens", {
      count: this.watchedTokenIds.size,
    });
  }

  private scheduleClobWsReconnect(): void {
    this.clobWsReconnectTimer = setTimeout(() => {
      this.connectClobWs();
    }, this.clobWsReconnectDelay);
    this.clobWsReconnectDelay = Math.min(this.clobWsReconnectDelay * 2, 30_000);
  }

  // ==================== ON-CHAIN WEBSOCKET (LAYER 3) ====================

  private connectChainWs(): void {
    this.logger.info("Connecting to Polygon WebSocket...", { url: this.rpcWsUrl });

    this.chainWs = new WebSocket(this.rpcWsUrl);

    this.chainWs.on("open", () => {
      this.chainConnected = true;
      this.chainReconnectDelay = 1000;
      this.logger.info("Polygon WebSocket connected");
      this.subscribeChainEvents();
    });

    this.chainWs.on("message", (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleChainMessage(msg);
      } catch {
        // ignore parse errors
      }
    });

    this.chainWs.on("close", () => {
      this.chainConnected = false;
      this.logger.warn("Polygon WebSocket disconnected");
      this.scheduleChainReconnect();
    });

    this.chainWs.on("error", (err: Error) => {
      this.logger.error("Polygon WebSocket error", { error: err.message });
      this.chainWs?.close();
    });
  }

  private subscribeChainEvents(): void {
    if (!this.chainWs || this.chainWs.readyState !== WebSocket.OPEN) return;

    // Subscribe to TransferSingle events where to == targetAddress
    // topic[0] = TransferSingle sig
    // topic[1] = operator (any)
    // topic[2] = from (any)
    // topic[3] = to (our target)
    const subscribeMsg = {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_subscribe",
      params: [
        "logs",
        {
          address: CTF_ADDRESS,
          topics: [
            TRANSFER_SINGLE_TOPIC,
            null, // operator: any
            null, // from: any
            padAddress(this.targetAddress), // to: target address
          ],
        },
      ],
    };

    this.chainWs.send(JSON.stringify(subscribeMsg));
    this.logger.info("Subscribed to CTF TransferSingle events", {
      target: this.targetAddress.slice(0, 8) + "...",
    });
  }

  private handleChainMessage(msg: {
    id?: number;
    result?: string;
    method?: string;
    params?: {
      result?: {
        transactionHash?: string;
        data?: string;
        topics?: string[];
        blockNumber?: string;
      };
      subscription?: string;
    };
  }): void {
    // Subscription confirmation
    if (msg.id === 1 && msg.result) {
      this.chainSubId = msg.result;
      this.logger.info("Chain subscription active", { subId: this.chainSubId });
      return;
    }

    // Log event
    if (msg.method === "eth_subscription" && msg.params?.result) {
      const log = msg.params.result;
      if (!log.topics || log.topics.length < 4 || !log.data) return;

      // Decode TransferSingle data: (uint256 id, uint256 value)
      // data = id (32 bytes) + value (32 bytes)
      const data = log.data.replace("0x", "");
      if (data.length < 128) return;

      // Convert token ID from hex to decimal string (CLOB/Gamma expect decimal)
      const tokenIdBigInt = BigInt("0x" + data.slice(0, 64));
      const tokenIdDecimal = tokenIdBigInt.toString();
      const rawValue = BigInt("0x" + data.slice(64, 128));
      // CTF tokens use 6 decimals (like USDC)
      const shares = Number(rawValue) / 1e6;

      if (shares <= 0) return;

      const txHash = log.transactionHash || "";
      const eventId = `chain-${txHash}-${tokenIdDecimal}`;

      if (this.seenIds.has(eventId)) return;
      this.seenIds.add(eventId);

      this.stats.chainEvents++;

      this.logger.info("ON-CHAIN: Target received tokens", {
        tokenId: tokenIdDecimal.slice(0, 16) + "...",
        shares: shares.toFixed(1),
        tx: txHash.slice(0, 12) + "...",
        latency: "~2s (block time)",
      });

      // Store pending event for API dedup (use eventId as key to avoid collision on repeated buys)
      this.pendingChainEvents.set(eventId, {
        tokenId: tokenIdDecimal,
        shares,
        timestamp: Date.now(),
      });

      // SPEED: Emit immediately with partial data (executor handles missing metadata).
      // Gamma lookup runs in background to warm cache for future trades.
      const immediateTrade: TargetTrade = {
        id: eventId,
        side: "BUY",
        type: "TRADE",
        conditionId: "",
        tokenId: tokenIdDecimal,
        outcome: "",
        priceCents: 0, // executor will look up orderbook
        shares,
        usdValue: 0,
        title: "",
        timestamp: Date.now(),
        source: "chain",
      };

      // Check cache first — if hit, enrich immediately (no network delay)
      const cached = this.marketCache.get(tokenIdDecimal);
      if (cached) {
        immediateTrade.conditionId = cached.conditionId;
        immediateTrade.title = cached.title;
        immediateTrade.outcome = cached.outcome;
        immediateTrade.tokenId = cached.clobTokenId;
      }

      // Auto-learn: watch this token on CLOB WS for future trades
      this.watchTokenIds([tokenIdDecimal]);

      if (this.onTrade) {
        this.onTrade(immediateTrade);
      }

      // Warm cache in background for next time (fire-and-forget)
      if (!cached) {
        this.resolveAndCacheChainEvent(tokenIdDecimal);
      }
    }
  }

  /**
   * Resolve chain event metadata via Gamma API and cache it.
   * Runs in background — does NOT block trade emission.
   */
  private async resolveAndCacheChainEvent(tokenIdDecimal: string): Promise<void> {
    try {
      const meta = await this.lookupMarketByTokenId(tokenIdDecimal);
      this.marketCache.set(tokenIdDecimal, meta);
      if (meta) {
        this.logger.info("Gamma: Cached chain event metadata", {
          tokenId: tokenIdDecimal.slice(0, 12) + "...",
          market: meta.title.slice(0, 50),
          outcome: meta.outcome,
        });
      } else {
        this.logger.warn("Gamma: Could not resolve token ID", {
          tokenId: tokenIdDecimal.slice(0, 16) + "...",
        });
      }
    } catch (err) {
      this.logger.warn("Gamma background lookup failed", { error: (err as Error).message });
    }
  }

  /**
   * Look up market metadata from Gamma API using a CLOB token ID.
   * Returns conditionId, title, outcome name, and the canonical CLOB token ID.
   */
  private async lookupMarketByTokenId(tokenId: string): Promise<{
    conditionId: string;
    title: string;
    outcome: string;
    clobTokenId: string;
  } | null> {
    const url = `${this.gammaHost}/markets?clob_token_ids=${encodeURIComponent(tokenId)}&limit=1`;
    const resp = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "holypoly-copytrade" },
      signal: AbortSignal.timeout(2000),
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as Array<{
      conditionId?: string;
      condition_id?: string;
      question?: string;
      title?: string;
      outcomes?: string;
      clobTokenIds?: string;
      clob_token_ids?: string;
    }>;

    if (!data || data.length === 0) return null;

    const m = data[0];
    const conditionId = m.conditionId || m.condition_id || "";
    const title = m.question || m.title || "";

    // Parse outcomes and token IDs to find which outcome this token represents
    const outcomes = (() => { try { return JSON.parse(m.outcomes || "[]") as string[]; } catch { return []; } })();
    const clobTokenIds = (() => {
      try { return JSON.parse(m.clobTokenIds || m.clob_token_ids || "[]") as string[]; } catch { return []; }
    })();

    let outcome = "";
    let clobTokenId = tokenId;
    const idx = clobTokenIds.findIndex((id) => id === tokenId);
    if (idx >= 0) {
      outcome = outcomes[idx] || "";
      clobTokenId = clobTokenIds[idx];
    } else if (outcomes.length > 0) {
      // Token ID didn't match - might be a format issue. Use first outcome as fallback.
      outcome = outcomes[0] || "";
      clobTokenId = clobTokenIds[0] || tokenId;
    }

    return { conditionId, title, outcome, clobTokenId };
  }

  private scheduleChainReconnect(): void {
    this.chainReconnectTimer = setTimeout(() => {
      this.connectChainWs();
    }, this.chainReconnectDelay);
    this.chainReconnectDelay = Math.min(this.chainReconnectDelay * 2, 30000);
  }

  // ==================== DATA API POLLING ====================

  private async poll(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;
    this.stats.totalPolls++;

    try {
      // SPEED: Query both endpoints IN PARALLEL — use whichever responds first with data
      const makeUrl = (endpoint: string): string => {
        const url = new URL(`${this.dataApiHost}${endpoint}`);
        url.searchParams.set("user", this.targetAddress);
        if (endpoint === "/activity") {
          url.searchParams.set("type", "TRADE");
          url.searchParams.set("sortBy", "TIMESTAMP");
          url.searchParams.set("sortDirection", "ASC");
        }
        url.searchParams.set("start", String(this.lastPollTimestamp));
        url.searchParams.set("limit", "100");
        return url.toString();
      };

      const fetchEndpoint = async (endpoint: string): Promise<ActivityResponse[]> => {
        const resp = await fetch(makeUrl(endpoint), {
          headers: {
            Accept: "application/json",
            "User-Agent": "holypoly-copytrade",
          },
          signal: AbortSignal.timeout(2000),
        });
        if (!resp.ok) return [];
        const body = await resp.json();
        const items = Array.isArray(body) ? body : (body as Record<string, unknown>).data;
        return Array.isArray(items) ? items as ActivityResponse[] : [];
      };

      // Race both endpoints — first one with data wins
      const results = await Promise.allSettled([
        fetchEndpoint("/activity"),
        fetchEndpoint("/trades"),
      ]);

      let data: ActivityResponse[] = [];
      for (const r of results) {
        if (r.status === "fulfilled" && r.value.length > 0) {
          data = r.value;
          break;
        }
      }

      if (data.length === 0) {
        this.stats.consecutiveErrors = 0;
        return;
      }
      this.stats.consecutiveErrors = 0;

      for (const item of data) {
        const trade = this.parseActivity(item);
        if (!trade) continue;

        // Skip historical trades from before bot started
        if (trade.timestamp < this.startedAt - 5000) {
          this.seenIds.add(trade.id);
          continue;
        }

        // Dedup — may have already been detected via chain WS
        if (this.seenIds.has(trade.id)) continue;

        // Also check if we have a pending chain event for this token
        // Search by tokenId match OR fuzzy shares+time match
        let chainPendingKey: string | null = null;
        for (const [k, p] of this.pendingChainEvents) {
          if (p.tokenId === trade.tokenId
            || (Math.abs(p.shares - trade.shares) < 0.1 && Date.now() - p.timestamp < 60000)) {
            chainPendingKey = k;
            break;
          }
        }
        if (chainPendingKey) {
          // Already emitted via chain — skip API duplicate
          this.pendingChainEvents.delete(chainPendingKey);
          this.seenIds.add(trade.id);
          continue;
        }

        this.seenIds.add(trade.id);
        this.stats.apiDetections++;

        // Update poll cursor
        const tradeSec = Math.floor(trade.timestamp / 1000);
        if (tradeSec > this.lastPollTimestamp) {
          this.lastPollTimestamp = tradeSec;
        }

        this.logger.info("API: Target trade detected", {
          side: trade.side,
          outcome: trade.outcome,
          price: `${trade.priceCents}¢`,
          shares: trade.shares.toFixed(1),
          usd: `$${trade.usdValue.toFixed(2)}`,
          market: trade.title.slice(0, 60),
        });

        // Auto-learn: watch this token on CLOB WS for future trades
        if (trade.tokenId) {
          this.watchTokenIds([trade.tokenId]);
        }

        if (this.onTrade) {
          this.onTrade(trade);
        }
      }

      // Prune seenIds
      if (this.seenIds.size > 5000) {
        const arr = Array.from(this.seenIds);
        this.seenIds = new Set(arr.slice(-2500));
      }
      // Prune marketCache (keep max 200 entries)
      if (this.marketCache.size > 200) {
        const keys = Array.from(this.marketCache.keys());
        for (let i = 0; i < keys.length - 100; i++) this.marketCache.delete(keys[i]);
      }
      // Clean old pending chain events (>60s)
      const now = Date.now();
      for (const [key, val] of this.pendingChainEvents) {
        if (now - val.timestamp > 60000) this.pendingChainEvents.delete(key);
      }
    } catch (err) {
      this.stats.consecutiveErrors++;
      if (this.stats.consecutiveErrors <= 3) {
        this.logger.warn("Poll error", { error: (err as Error).message });
      }
    } finally {
      this.isPolling = false;
    }
  }

  private parseActivity(item: ActivityResponse): TargetTrade | null {
    try {
      const id = item.id || `${item.conditionId || item.condition_id}-${item.timestamp}-${item.side}`;
      const side = (item.side || "").toUpperCase() as "BUY" | "SELL";
      if (side !== "BUY" && side !== "SELL") return null;

      const type = (item.type || "TRADE").toUpperCase();
      const conditionId = item.conditionId || item.condition_id || "";
      const tokenId = item.assetId || item.asset_id || item.asset || item.proxyTokenId || "";
      const outcome = item.outcome || item.outcomeName || "";
      const priceCents = Math.round((parseFloat(item.price || "0") || 0) * 100);
      const shares = parseFloat(item.size || item.tokens || "0") || 0;
      const usdValue = parseFloat(item.cashAmount || item.cash || "0") || shares * priceCents / 100;
      const title = item.title || item.question || item.marketTitle || "";
      const timestamp = item.timestamp
        ? (typeof item.timestamp === "number"
          ? (item.timestamp > 1e12 ? item.timestamp : item.timestamp * 1000)
          : new Date(item.timestamp).getTime())
        : Date.now();

      if (!conditionId || !tokenId) return null;

      return { id, side, type, conditionId, tokenId, outcome, priceCents, shares, usdValue, title, timestamp, source: "api" };
    } catch {
      return null;
    }
  }
}

/** RTDS activity/trades event shape (per docs.polymarket.com RTDS docs) */
interface RtdsTradeEvent {
  proxyWallet?: string;
  proxy_wallet?: string;
  side?: string;
  asset?: string;
  asset_id?: string;
  conditionId?: string;
  condition_id?: string;
  price?: string;
  size?: string;
  outcome?: string;
  outcomeName?: string;
  title?: string;
  question?: string;
  transactionHash?: string;
  timestamp?: string | number;
}

interface ActivityResponse {
  id?: string;
  side?: string;
  type?: string;
  conditionId?: string;
  condition_id?: string;
  assetId?: string;
  asset_id?: string;
  asset?: string; // /trades endpoint uses "asset" for token ID
  proxyTokenId?: string;
  outcome?: string;
  outcomeName?: string;
  price?: string;
  size?: string;
  tokens?: string;
  cashAmount?: string;
  cash?: string;
  title?: string;
  question?: string;
  marketTitle?: string;
  slug?: string;
  transactionHash?: string;
  timestamp?: number | string;
}
