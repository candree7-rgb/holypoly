import type { Logger } from "../logger.js";

/**
 * A single activity event from the target trader.
 */
export interface TargetTrade {
  /** Unique trade ID (used for dedup) */
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
}

/**
 * Ultra-fast tracker that monitors a target wallet's Polymarket activity.
 *
 * Uses aggressive polling of the Data API /activity endpoint.
 * Designed for Bun runtime — uses native fetch with keep-alive.
 */
export class TargetTracker {
  private dataApiHost: string;
  private targetAddress: string;
  private logger: Logger;
  private seenIds: Set<string> = new Set();
  private lastTimestamp: number = 0;
  private onTrade: ((trade: TargetTrade) => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number;
  private isPolling = false;
  private consecutiveErrors = 0;
  private totalPolls = 0;
  private totalTradesDetected = 0;

  constructor(
    dataApiHost: string,
    targetAddress: string,
    pollIntervalMs: number,
    logger: Logger,
  ) {
    this.dataApiHost = dataApiHost.replace(/\/$/, "");
    this.targetAddress = targetAddress;
    this.pollIntervalMs = pollIntervalMs;
    this.logger = logger;
    // Start from now — only copy new trades
    this.lastTimestamp = Math.floor(Date.now() / 1000);
  }

  /**
   * Register callback for new trades.
   */
  onNewTrade(cb: (trade: TargetTrade) => void): void {
    this.onTrade = cb;
  }

  /**
   * Start polling the target wallet.
   */
  start(): void {
    if (this.pollTimer) return;

    this.logger.info("Tracker started", {
      target: this.targetAddress,
      interval: `${this.pollIntervalMs}ms`,
    });

    // Immediate first poll
    this.poll();

    // Then poll on interval
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  /**
   * Stop polling.
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.logger.info("Tracker stopped", {
      totalPolls: this.totalPolls,
      totalTrades: this.totalTradesDetected,
    });
  }

  /**
   * Single poll cycle — fetch recent activity and emit new trades.
   */
  private async poll(): Promise<void> {
    if (this.isPolling) return; // Skip if previous poll still running
    this.isPolling = true;
    this.totalPolls++;

    try {
      const url = new URL(`${this.dataApiHost}/activity`);
      url.searchParams.set("user", this.targetAddress);
      url.searchParams.set("type", "TRADE");
      url.searchParams.set("start", String(this.lastTimestamp));
      url.searchParams.set("sortBy", "TIMESTAMP");
      url.searchParams.set("sortDirection", "ASC");

      const startMs = Date.now();
      const resp = await fetch(url.toString(), {
        headers: {
          Accept: "application/json",
          "User-Agent": "holypoly-copytrade",
        },
        // Bun supports keepalive natively
        keepalive: true,
      });

      const latencyMs = Date.now() - startMs;

      if (!resp.ok) {
        this.consecutiveErrors++;
        if (this.consecutiveErrors <= 3) {
          this.logger.warn("Activity API error", {
            status: resp.status,
            latency: `${latencyMs}ms`,
          });
        }
        return;
      }

      this.consecutiveErrors = 0;
      const data = (await resp.json()) as ActivityResponse[];

      if (!Array.isArray(data) || data.length === 0) return;

      let newCount = 0;
      for (const item of data) {
        const trade = this.parseActivity(item);
        if (!trade) continue;

        // Dedup by trade ID
        if (this.seenIds.has(trade.id)) continue;
        this.seenIds.add(trade.id);

        // Update last timestamp for next poll
        const tradeSec = Math.floor(trade.timestamp / 1000);
        if (tradeSec > this.lastTimestamp) {
          this.lastTimestamp = tradeSec;
        }

        newCount++;
        this.totalTradesDetected++;

        this.logger.info("TARGET TRADE DETECTED", {
          side: trade.side,
          outcome: trade.outcome,
          price: `${trade.priceCents}¢`,
          shares: trade.shares.toFixed(1),
          usd: `$${trade.usdValue.toFixed(2)}`,
          market: trade.title.slice(0, 60),
          latency: `${latencyMs}ms`,
          detectionDelay: `${Date.now() - trade.timestamp}ms`,
        });

        // Emit to executor
        if (this.onTrade) {
          this.onTrade(trade);
        }
      }

      // Prune seen IDs to prevent memory leak (keep last 5000)
      if (this.seenIds.size > 5000) {
        const arr = Array.from(this.seenIds);
        this.seenIds = new Set(arr.slice(-2500));
      }
    } catch (err) {
      this.consecutiveErrors++;
      if (this.consecutiveErrors <= 3) {
        this.logger.warn("Poll error", { error: (err as Error).message });
      }
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Parse a raw activity response into a TargetTrade.
   */
  private parseActivity(item: ActivityResponse): TargetTrade | null {
    try {
      // The Data API activity response fields
      const id = item.id || `${item.conditionId}-${item.timestamp}-${item.side}`;
      const side = (item.side || "").toUpperCase() as "BUY" | "SELL";
      if (side !== "BUY" && side !== "SELL") return null;

      const type = (item.type || "TRADE").toUpperCase();
      const conditionId = item.conditionId || item.condition_id || "";
      const tokenId = item.assetId || item.asset_id || item.proxyTokenId || "";
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

      return {
        id,
        side,
        type,
        conditionId,
        tokenId,
        outcome,
        priceCents,
        shares,
        usdValue,
        title,
        timestamp,
      };
    } catch {
      return null;
    }
  }

  getStats(): { totalPolls: number; totalTrades: number; consecutiveErrors: number } {
    return {
      totalPolls: this.totalPolls,
      totalTrades: this.totalTradesDetected,
      consecutiveErrors: this.consecutiveErrors,
    };
  }
}

/**
 * Raw activity response from Polymarket Data API.
 * Field names vary between versions — we handle multiple formats.
 */
interface ActivityResponse {
  id?: string;
  side?: string;
  type?: string;
  conditionId?: string;
  condition_id?: string;
  assetId?: string;
  asset_id?: string;
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
  timestamp?: number | string;
}
