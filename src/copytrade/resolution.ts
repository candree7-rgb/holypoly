import type { Logger } from "../logger.js";
import type { CopyTradeDB } from "./db.js";

export interface ResolutionEvent {
  leaderAddress: string;
  market: string;
  outcome: string;
  side: string;
  won: boolean;
  filledShares: number;
  costUsd: number;
  payoutUsd: number;
  pnl: number;
}

/**
 * Polls Polymarket Gamma API to detect resolved markets, then updates
 * DB rows with payout + realized PNL. Emits resolution events for
 * Telegram notifications.
 */
export class ResolutionTracker {
  private db: CopyTradeDB;
  private gammaHost: string;
  private logger: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private marketCache: Map<string, ResolvedMarket | null> = new Map();
  private isChecking = false;
  private onResolved: ((event: ResolutionEvent) => void) | null = null;

  constructor(db: CopyTradeDB, gammaHost: string, logger: Logger) {
    this.db = db;
    this.gammaHost = gammaHost.replace(/\/$/, "");
    this.logger = logger;
  }

  onTradeResolved(cb: (event: ResolutionEvent) => void): void {
    this.onResolved = cb;
  }

  start(intervalMs = 60_000): void {
    this.tick().catch((err) => this.logger.warn("Resolution tick failed", { error: (err as Error).message }));
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.logger.warn("Resolution tick failed", { error: (err as Error).message }));
    }, intervalMs);
    this.logger.info("ResolutionTracker started", { intervalMs });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.isChecking) return;
    this.isChecking = true;
    try {
      const trades = await this.db.getUnresolvedFilledTrades(200);
      if (trades.length === 0) return;

      // Unique condition IDs to avoid redundant Gamma calls
      const uniqueConditions = Array.from(new Set(trades.map((t) => t.conditionId)));

      let resolvedCount = 0;
      for (const conditionId of uniqueConditions) {
        const market = await this.getResolvedMarket(conditionId);
        if (!market || !market.resolved) continue;

        // Find all trades for this market
        const marketTrades = trades.filter((t) => t.conditionId === conditionId);
        for (const trade of marketTrades) {
          // Only process BUYs (SELLs are already realized from closing)
          if (trade.side !== "BUY") {
            await this.db.recordResolution(
              trade.id,
              market.winningOutcome,
              0,
              0, // SELLs don't contribute here — aggregation handles them
            );
            resolvedCount++;
            continue;
          }

          const won = this.didWin(trade.outcome, market.winningOutcome, market.outcomes, trade.tokenId, market.clobTokenIds);
          const payout = won ? trade.filledShares * 1.0 : 0;
          const pnl = payout - trade.filledUsd;

          await this.db.recordResolution(trade.id, market.winningOutcome, payout, pnl);
          resolvedCount++;

          if (this.onResolved) {
            this.onResolved({
              leaderAddress: trade.leaderAddress,
              market: trade.marketTitle,
              outcome: trade.outcome,
              side: trade.side,
              won,
              filledShares: trade.filledShares,
              costUsd: trade.filledUsd,
              payoutUsd: payout,
              pnl,
            });
          }
        }
      }

      if (resolvedCount > 0) {
        this.logger.info("Resolution tick: updated trades", { resolved: resolvedCount, checked: uniqueConditions.length });
      }
    } finally {
      this.isChecking = false;
    }
  }

  private didWin(
    ourOutcome: string,
    winningOutcome: string,
    outcomes: string[],
    ourTokenId: string,
    clobTokenIds: string[],
  ): boolean {
    // Prefer tokenId match (more reliable than outcome name)
    if (clobTokenIds.length > 0 && outcomes.length === clobTokenIds.length) {
      const idx = clobTokenIds.findIndex((id) => id === ourTokenId);
      if (idx >= 0 && outcomes[idx]) {
        return outcomes[idx].toLowerCase() === winningOutcome.toLowerCase();
      }
    }
    // Fallback to outcome name match
    return ourOutcome.toLowerCase() === winningOutcome.toLowerCase();
  }

  /** Public API for SellEngine: is this market resolved? */
  async isResolved(conditionId: string): Promise<boolean> {
    const m = await this.getResolvedMarket(conditionId);
    return m?.resolved === true;
  }

  private async getResolvedMarket(conditionId: string): Promise<ResolvedMarket | null> {
    // Cache miss = query; cached nulls = market not yet resolved (retry next tick)
    const cached = this.marketCache.get(conditionId);
    if (cached) return cached; // resolved markets are stable

    try {
      const url = `${this.gammaHost}/markets?condition_ids=${conditionId}&limit=1`;
      const resp = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "holypoly-copytrade" },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return null;

      const data = await resp.json() as Array<{
        conditionId?: string;
        condition_id?: string;
        closed?: boolean;
        acceptingOrders?: boolean;
        umaResolutionStatus?: string;
        resolvedBy?: string;
        resolutionSource?: string;
        winningOutcome?: string;
        outcomes?: string;
        clobTokenIds?: string;
        clob_token_ids?: string;
      }>;
      if (!Array.isArray(data) || data.length === 0) return null;

      const m = data[0];
      const closed = m.closed === true;
      const umaResolved = m.umaResolutionStatus === "resolved";
      // A market is considered resolved if it's closed AND UMA confirmed
      const resolved = closed && umaResolved;

      if (!resolved) {
        // Not yet resolved — don't cache (retry next tick)
        return null;
      }

      const outcomes = (() => { try { return JSON.parse(m.outcomes || "[]") as string[]; } catch { return []; } })();
      const clobTokenIds = (() => {
        try { return JSON.parse(m.clobTokenIds || m.clob_token_ids || "[]") as string[]; } catch { return []; }
      })();

      const market: ResolvedMarket = {
        conditionId,
        resolved: true,
        winningOutcome: m.winningOutcome || "",
        outcomes,
        clobTokenIds,
      };
      this.marketCache.set(conditionId, market);
      return market;
    } catch (err) {
      this.logger.warn("Gamma resolution lookup failed", { conditionId, error: (err as Error).message });
      return null;
    }
  }
}

interface ResolvedMarket {
  conditionId: string;
  resolved: boolean;
  winningOutcome: string;
  outcomes: string[];
  clobTokenIds: string[];
}
