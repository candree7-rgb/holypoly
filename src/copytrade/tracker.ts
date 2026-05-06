import WebSocket from "ws";
import type { Logger } from "../logger.js";

/**
 * A single detected trade from a target trader.
 */
export interface TargetTrade {
  /** Unique ID for dedup */
  id: string;
  /** Address of the leader who made this trade (lowercase) */
  leaderAddress: string;
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
 * Ultra-fast tracker using 3 detection layers (per docs.polymarket.com):
 *
 * Layer 1: CLOB Market WS `last_trade_price` (~50ms after CLOB match)
 *   wss://ws-subscriptions-clob.polymarket.com/ws/market
 *   Anonymous but instant — triggers dedicated instantCheck().
 *   Connects lazily after first token ID is learned.
 *
 * Layer 2: Data API polling (100ms interval)
 *   Queries /activity + /trades endpoints for target's trades.
 *   Only source that identifies WHO traded.
 *
 * Layer 3: Polygon Chain WS (2-4s)
 *   Reliable backup — on-chain settlement confirmation.
 */
export class TargetTracker {
  private dataApiHost: string;
  private gammaHost: string;
  /** All target addresses to watch (lowercase) */
  private targetAddresses: string[];
  /** First address for logging / backwards-compat with single-leader paths */
  private targetAddress: string;
  private logger: Logger;
  private seenIds: Set<string> = new Set();
  private onTrade: ((trade: TargetTrade) => void) | null = null;
  /** Per-address last poll cursor (Unix seconds) */
  private lastPollTimestamps: Map<string, number> = new Map();

  // On-chain WebSocket (layer 3 — reliable backup)
  private rpcWsUrl: string;
  private chainWs: WebSocket | null = null;
  // chain subscription IDs per leader live in chainSubIdToAddr below
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
  // per-address cursors live in lastPollTimestamps below

  // Our own wallet address — used for outbound TransferSingle subscription
  private profileAddress: string = "";

  // Callback for our own outbound fills (SELLs settled on-chain)
  private onOurFillCb: ((event: { tokenId: string; shares: number; direction: "in" | "out"; txHash: string }) => void) | null = null;

  // Pending on-chain events waiting for metadata from API (keyed by unique eventId)
  private pendingChainEvents: Map<string, { leaderAddress: string; tokenId: string; shares: number; timestamp: number }> = new Map();

  // Cache: token ID → market metadata (avoid repeated Gamma lookups)
  private marketCache: Map<string, { conditionId: string; title: string; outcome: string; clobTokenId: string } | null> = new Map();

  // Bot start time — ignore trades before this
  private startedAt: number = 0;

  // Stats
  private stats = {
    chainEvents: 0,
    apiDetections: 0,
    clobWsTriggers: 0,
    totalPolls: 0,
    consecutiveErrors: 0,
  };

  constructor(
    dataApiHost: string,
    /** Single target address (backwards-compat) OR array of addresses */
    targetAddresses: string | string[],
    rpcWsUrl: string,
    pollIntervalMs: number,
    logger: Logger,
    gammaHost?: string,
    /** Our own profile wallet — used to subscribe to outbound TransferSingle for SELL ground-truth */
    profileAddress?: string,
  ) {
    this.dataApiHost = dataApiHost.replace(/\/$/, "");
    this.gammaHost = (gammaHost ?? "https://gamma-api.polymarket.com").replace(/\/$/, "");

    const addrs = Array.isArray(targetAddresses) ? targetAddresses : [targetAddresses];
    this.targetAddresses = addrs.map((a) => a.toLowerCase());
    this.targetAddress = this.targetAddresses[0];

    this.profileAddress = (profileAddress ?? "").toLowerCase();
    this.rpcWsUrl = rpcWsUrl;
    this.pollIntervalMs = pollIntervalMs;
    this.logger = logger;
    this.startedAt = Date.now();
    const startSec = Math.floor(Date.now() / 1000);
    for (const a of this.targetAddresses) this.lastPollTimestamps.set(a, startSec);
  }

  onNewTrade(cb: (trade: TargetTrade) => void): void {
    this.onTrade = cb;
  }

  /** Register callback for our own outbound TransferSingle (SELL settled on-chain) */
  onOurFill(cb: (event: { tokenId: string; shares: number; direction: "in" | "out"; txHash: string }) => void): void {
    this.onOurFillCb = cb;
  }

  /**
   * Instant check — dedicated fast-path triggered by CLOB WS.
   * Has its own guard (not blocked by regular poll's isPolling).
   * Only hits the fastest endpoint (/activity) for minimum latency.
   */
  private isInstantChecking = false;
  private async instantCheck(): Promise<void> {
    if (this.isInstantChecking) return;
    this.isInstantChecking = true;
    try {
      // Query all target addresses in parallel
      const fetchForAddr = async (addr: string): Promise<{ addr: string; items: ActivityResponse[] }> => {
        const startSec = this.lastPollTimestamps.get(addr) ?? Math.floor(Date.now() / 1000);
        const url = new URL(`${this.dataApiHost}/activity`);
        url.searchParams.set("user", addr);
        url.searchParams.set("type", "TRADE");
        url.searchParams.set("sortBy", "TIMESTAMP");
        url.searchParams.set("sortDirection", "ASC");
        url.searchParams.set("start", String(startSec));
        url.searchParams.set("limit", "10");
        const resp = await fetch(url.toString(), {
          headers: { Accept: "application/json", "User-Agent": "holypoly-copytrade" },
          signal: AbortSignal.timeout(1500),
        });
        if (!resp.ok) return { addr, items: [] };
        const body = await resp.json();
        const items = Array.isArray(body) ? body : (body as Record<string, unknown>).data;
        return { addr, items: Array.isArray(items) ? items as ActivityResponse[] : [] };
      };

      const results = await Promise.allSettled(this.targetAddresses.map(fetchForAddr));

      for (const settled of results) {
        if (settled.status !== "fulfilled") continue;
        const { addr, items } = settled.value;
        if (items.length === 0) continue;

        for (const item of items) {
          const trade = this.parseActivity(item, addr);
          if (!trade) continue;
          if (trade.timestamp < this.startedAt - 5000) { this.seenIds.add(trade.id); continue; }
          if (this.seenIds.has(trade.id)) continue;

          this.seenIds.add(trade.id);
          this.stats.apiDetections++;

          const tradeSec = Math.floor(trade.timestamp / 1000);
          const prev = this.lastPollTimestamps.get(addr) ?? 0;
          if (tradeSec > prev) this.lastPollTimestamps.set(addr, tradeSec);

          this.logger.info("INSTANT: Target trade detected (WS-triggered)", {
            leader: addr.slice(0, 8) + "...",
            side: trade.side,
            outcome: trade.outcome,
            price: `${trade.priceCents}¢`,
            shares: trade.shares.toFixed(1),
            market: trade.title.slice(0, 60),
          });

          if (trade.tokenId) {
            this.watchTokenIds([trade.tokenId]);
          }

          if (this.onTrade) {
            this.onTrade(trade);
          }
        }
      }
    } catch {
      // Non-critical — regular poll will catch it
    } finally {
      this.isInstantChecking = false;
    }
  }

  /**
   * Start all 3 detection layers:
   * 1. CLOB Market WS (fast trigger — last_trade_price, connects on first token)
   * 2. Data API polling (100ms — primary detection with user identity)
   * 3. Polygon Chain WS (2-4s — backup, on-chain settlement)
   */
  start(): void {
    this.logger.info("Tracker starting (3-layer detection)", {
      target: this.targetAddress.slice(0, 8) + "..." + this.targetAddress.slice(-6),
      clobWs: "lazy (connects on first token ID)",
      chainWs: this.rpcWsUrl ? "enabled (backup)" : "disabled",
      pollInterval: `${this.pollIntervalMs}ms`,
    });

    // Layer 1: CLOB Market WS — connects lazily when first token ID is learned
    // (connecting with no subscriptions causes Polymarket to disconnect us)

    // Layer 2: Data API polling (always runs at pollIntervalMs as safety net)
    // CLOB WS triggers ADDITIONAL instant polls on top of this interval.
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.poll(); // Immediate first poll

    // Layer 3: On-chain WebSocket (backup)
    if (this.rpcWsUrl) {
      this.connectChainWs();
    }

    // Pre-warm: subscribe CLOB WS to all token IDs each leader currently holds.
    // Without this, the first trade on a new token is detected via API poll only.
    // Pre-warming makes every leader trade trigger the instant-check path.
    this.prewarmLeaderTokens().catch((err) =>
      this.logger.warn("Initial pre-warm failed", { error: (err as Error).message }),
    );
    setInterval(() => this.prewarmLeaderTokens().catch(() => {}), 60_000);
  }

  /**
   * Query each leader's open positions + recent activity, subscribe CLOB WS
   * to every relevant token ID. Critical for detecting the first trade on a
   * new market (otherwise we'd only catch it via API poll, ~50-100ms slower).
   */
  private async prewarmLeaderTokens(): Promise<void> {
    const tokens = new Set<string>();
    const cutoffSec = Math.floor(Date.now() / 1000) - 3600; // last 1h

    for (const addr of this.targetAddresses) {
      // Open positions — subscribe so we catch SELLs and add-on BUYs
      try {
        const url = `${this.dataApiHost}/positions?user=${addr}&sizeThreshold=0&limit=200`;
        const resp = await fetch(url, {
          headers: { Accept: "application/json", "User-Agent": "holypoly-copytrade" },
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
          const positions = await resp.json() as Array<{ asset?: string; size?: number }>;
          for (const p of positions) {
            if (p.asset && (p.size ?? 0) > 0) tokens.add(p.asset);
          }
        }
      } catch { /* skip */ }

      // Recently traded (last 1h) — subscribe to catch quick re-entries
      try {
        const url = `${this.dataApiHost}/activity?user=${addr}&type=TRADE&limit=100`;
        const resp = await fetch(url, {
          headers: { Accept: "application/json", "User-Agent": "holypoly-copytrade" },
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
          const acts = await resp.json() as Array<{ asset?: string; assetId?: string; timestamp?: number | string }>;
          for (const a of acts) {
            const ts = typeof a.timestamp === "number" ? a.timestamp : Number(a.timestamp);
            if (ts >= cutoffSec) {
              const id = a.assetId || a.asset;
              if (id) tokens.add(id);
            }
          }
        }
      } catch { /* skip */ }
    }

    if (tokens.size > 0) {
      const before = this.watchedTokenIds.size;
      this.watchTokenIds(Array.from(tokens));
      const added = this.watchedTokenIds.size - before;
      if (added > 0) {
        this.logger.info("Pre-warmed CLOB WS subscriptions", {
          totalWatched: this.watchedTokenIds.size,
          newTokens: added,
        });
      }
    }
  }

  stop(): void {
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
    if (newCount === 0) return;

    if (this.clobWsConnected) {
      this.subscribeClobWsTokens();
    } else if (!this.clobWs) {
      // First token learned — connect CLOB WS now
      this.logger.info("First token ID learned, connecting CLOB Market WS...");
      this.connectClobWs();
    }
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
        // Instant check: dedicated fast-path that bypasses isPolling guard.
        if (msg.event_type === "last_trade_price" && msg.asset_id) {
          this.stats.clobWsTriggers++;
          this.instantCheck();
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

  /** Map subscription ID → leader address for multi-target chain WS */
  private chainSubIdToAddr: Map<string, string> = new Map();
  /** Subscription ID for our own outbound transfers (SELL settlements). Empty = not subscribed. */
  private ourOutboundSubId: string = "";

  private subscribeChainEvents(): void {
    if (!this.chainWs || this.chainWs.readyState !== WebSocket.OPEN) return;

    // One eth_subscribe per target address (Polygon WS doesn't support OR on topic filters).
    // Each subscription's response ID maps back to the originating leader.
    this.chainSubIdToAddr.clear();
    this.ourOutboundSubId = "";
    // Clear pending req map too — prevents stale req IDs from surviving reconnects
    (this as unknown as { _pendingChainReqs?: Map<number, string> })._pendingChainReqs = new Map();

    let nextReqId = 1;
    this.targetAddresses.forEach((addr) => {
      const reqId = nextReqId++;
      const subscribeMsg = {
        jsonrpc: "2.0",
        id: reqId,
        method: "eth_subscribe",
        params: [
          "logs",
          {
            address: CTF_ADDRESS,
            topics: [
              TRANSFER_SINGLE_TOPIC,
              null, // operator: any
              null, // from: any
              padAddress(addr), // to: this specific target (BUY settlement)
            ],
          },
        ],
      };
      this.chainWs!.send(JSON.stringify(subscribeMsg));
      (this as unknown as { _pendingChainReqs: Map<number, string> })._pendingChainReqs ??= new Map();
      (this as unknown as { _pendingChainReqs: Map<number, string> })._pendingChainReqs.set(reqId, addr);
    });

    // Subscribe to OUR OUTBOUND transfers (SELL settlements for our wallet).
    // Used as ground-truth for SellEngine fill confirmation (~2s vs /positions API lag).
    if (this.profileAddress) {
      const reqId = nextReqId++;
      const ourMsg = {
        jsonrpc: "2.0",
        id: reqId,
        method: "eth_subscribe",
        params: [
          "logs",
          {
            address: CTF_ADDRESS,
            topics: [
              TRANSFER_SINGLE_TOPIC,
              null,
              padAddress(this.profileAddress), // from: our wallet (SELL)
              null,
            ],
          },
        ],
      };
      this.chainWs.send(JSON.stringify(ourMsg));
      (this as unknown as { _pendingChainReqs: Map<number, string> })._pendingChainReqs.set(reqId, "OUR_OUTBOUND");
    }

    this.logger.info("Subscribed to CTF TransferSingle events", {
      targets: this.targetAddresses.length,
      ourOutbound: this.profileAddress ? "enabled" : "disabled",
      addresses: this.targetAddresses.map((a) => a.slice(0, 8) + "...").join(","),
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
    // Subscription confirmation (per-target or our outbound)
    if (typeof msg.id === "number" && msg.result) {
      const pending = (this as unknown as { _pendingChainReqs?: Map<number, string> })._pendingChainReqs;
      const tag = pending?.get(msg.id);
      if (tag === "OUR_OUTBOUND") {
        this.ourOutboundSubId = msg.result;
        pending!.delete(msg.id);
        this.logger.info("Chain subscription active (OUR OUTBOUND)", { subId: msg.result });
      } else if (tag) {
        this.chainSubIdToAddr.set(msg.result, tag);
        pending!.delete(msg.id);
        this.logger.info("Chain subscription active", { subId: msg.result, leader: tag.slice(0, 8) + "..." });
      }
      return;
    }

    // Log event
    if (msg.method === "eth_subscription" && msg.params?.result) {
      const log = msg.params.result;
      if (!log.topics || log.topics.length < 4 || !log.data) return;

      const subId = msg.params.subscription || "";

      // Decode TransferSingle data first (shared by all branches)
      const dataHex = log.data.replace("0x", "");
      if (dataHex.length < 128) return;
      const tokenIdBigInt = BigInt("0x" + dataHex.slice(0, 64));
      const tokenIdDecimal = tokenIdBigInt.toString();
      const rawValue = BigInt("0x" + dataHex.slice(64, 128));
      const sharesValue = Number(rawValue) / 1e6;
      const txHashValue = log.transactionHash || "";

      // OUR OUTBOUND (we sold) — emit OurFill event for SellEngine ground truth
      if (subId && subId === this.ourOutboundSubId) {
        if (sharesValue > 0 && this.onOurFillCb) {
          this.logger.info("ON-CHAIN: Our wallet transferred OUT (SELL settled)", {
            tokenId: tokenIdDecimal.slice(0, 12) + "...",
            shares: sharesValue.toFixed(1),
            tx: txHashValue.slice(0, 12) + "...",
          });
          this.onOurFillCb({
            tokenId: tokenIdDecimal,
            shares: sharesValue,
            direction: "out",
            txHash: txHashValue,
          });
        }
        return;
      }

      // Resolve which leader this subscription belongs to.
      // If unresolved (race: event arrived before subscribe confirmation),
      // drop the event — the API poll will catch it. Falling back to
      // targets[0] would misattribute the trade and apply wrong multiplier.
      const leaderAddress = this.chainSubIdToAddr.get(subId);
      if (!leaderAddress) {
        this.logger.warn("Chain event with unresolved subscription — dropping (API poll will catch it)", { subId });
        return;
      }

      // (TransferSingle data already decoded above into tokenIdDecimal/sharesValue/txHashValue)
      const shares = sharesValue;
      const txHash = txHashValue;
      if (shares <= 0) return;

      const eventId = `chain-${leaderAddress}-${txHash}-${tokenIdDecimal}`;

      if (this.seenIds.has(eventId)) return;
      this.seenIds.add(eventId);

      this.stats.chainEvents++;

      this.logger.info("ON-CHAIN: Target received tokens", {
        leader: leaderAddress.slice(0, 8) + "...",
        tokenId: tokenIdDecimal.slice(0, 16) + "...",
        shares: shares.toFixed(1),
        tx: txHash.slice(0, 12) + "...",
        latency: "~2s (block time)",
      });

      // Store pending event for API dedup
      this.pendingChainEvents.set(eventId, {
        leaderAddress,
        tokenId: tokenIdDecimal,
        shares,
        timestamp: Date.now(),
      });

      // SPEED: Emit immediately with partial data (executor handles missing metadata).
      const immediateTrade: TargetTrade = {
        id: eventId,
        leaderAddress,
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
      // For each target address, query /activity and /trades in parallel
      const makeUrl = (endpoint: string, user: string, startSec: number): string => {
        const url = new URL(`${this.dataApiHost}${endpoint}`);
        url.searchParams.set("user", user);
        if (endpoint === "/activity") {
          url.searchParams.set("type", "TRADE");
          url.searchParams.set("sortBy", "TIMESTAMP");
          url.searchParams.set("sortDirection", "ASC");
        }
        url.searchParams.set("start", String(startSec));
        url.searchParams.set("limit", "100");
        return url.toString();
      };

      const fetchForAddress = async (addr: string): Promise<{ addr: string; items: ActivityResponse[] }> => {
        const startSec = this.lastPollTimestamps.get(addr) ?? Math.floor(Date.now() / 1000);
        const fetchEndpoint = async (endpoint: string): Promise<ActivityResponse[]> => {
          const resp = await fetch(makeUrl(endpoint, addr, startSec), {
            headers: { Accept: "application/json", "User-Agent": "holypoly-copytrade" },
            signal: AbortSignal.timeout(2000),
          });
          if (!resp.ok) return [];
          const body = await resp.json();
          const items = Array.isArray(body) ? body : (body as Record<string, unknown>).data;
          return Array.isArray(items) ? items as ActivityResponse[] : [];
        };
        const results = await Promise.allSettled([
          fetchEndpoint("/activity"),
          fetchEndpoint("/trades"),
        ]);
        let items: ActivityResponse[] = [];
        for (const r of results) {
          if (r.status === "fulfilled" && r.value.length > 0) {
            items = r.value;
            break;
          }
        }
        return { addr, items };
      };

      // Poll all target addresses in parallel
      const perAddrResults = await Promise.allSettled(
        this.targetAddresses.map((addr) => fetchForAddress(addr)),
      );

      this.stats.consecutiveErrors = 0;

      for (const settled of perAddrResults) {
        if (settled.status !== "fulfilled") {
          this.stats.consecutiveErrors++;
          continue;
        }
        const { addr, items } = settled.value;
        if (items.length === 0) continue;

        for (const item of items) {
          const trade = this.parseActivity(item, addr);
          if (!trade) continue;

          // Skip historical trades from before bot started
          if (trade.timestamp < this.startedAt - 5000) {
            this.seenIds.add(trade.id);
            continue;
          }

          // Dedup — may have already been detected via chain WS
          if (this.seenIds.has(trade.id)) continue;

          // Also check if we have a pending chain event for this token (same leader)
          let chainPendingKey: string | null = null;
          for (const [k, p] of this.pendingChainEvents) {
            // Require leader + tokenId match AND recent timestamp.
            // (The old shares-only fallback could drop genuinely distinct trades
            // on different markets with similar size.)
            if (p.leaderAddress === trade.leaderAddress
              && p.tokenId === trade.tokenId
              && Date.now() - p.timestamp < 60000) {
              chainPendingKey = k;
              break;
            }
          }
          if (chainPendingKey) {
            this.pendingChainEvents.delete(chainPendingKey);
            this.seenIds.add(trade.id);
            continue;
          }

          this.seenIds.add(trade.id);
          this.stats.apiDetections++;

          // Update per-address poll cursor
          const tradeSec = Math.floor(trade.timestamp / 1000);
          const prev = this.lastPollTimestamps.get(addr) ?? 0;
          if (tradeSec > prev) this.lastPollTimestamps.set(addr, tradeSec);

          this.logger.info("API: Target trade detected", {
            leader: addr.slice(0, 8) + "...",
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

  private parseActivity(item: ActivityResponse, leaderAddress: string): TargetTrade | null {
    try {
      const id = item.id || `${leaderAddress}-${item.conditionId || item.condition_id}-${item.timestamp}-${item.side}`;
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

      return { id, leaderAddress, side, type, conditionId, tokenId, outcome, priceCents, shares, usdValue, title, timestamp, source: "api" };
    } catch {
      return null;
    }
  }
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
