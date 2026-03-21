import { Side, OrderType } from "@polymarket/clob-client";
import { ClobService } from "../data/clob.js";
import type { Logger } from "../logger.js";
import type { CopyTradeConfig } from "./config.js";
import type { TargetTrade } from "./tracker.js";

export interface CopyResult {
  success: boolean;
  trade: TargetTrade;
  orderId?: string;
  executedPrice?: number;
  executedShares?: number;
  executedUsd?: number;
  latencyMs: number;
  reason?: string;
}

interface WindowTracker {
  windowKey: string;
  copies: number;
  totalUsd: number;
}

/**
 * Ultra-fast order executor for copy trading.
 *
 * Uses FOK (Fill-or-Kill) orders for instant execution.
 * Optimized for minimum latency between detection and fill.
 */
export class CopyExecutor {
  private clob: ClobService;
  private config: CopyTradeConfig;
  private logger: Logger;
  private balance: number = 0;
  private lastBalanceCheck: number = 0;
  private windowTrackers: Map<string, WindowTracker> = new Map();
  private lastCopyTime: number = 0;
  private totalCopied = 0;
  private totalSkipped = 0;
  private totalFailed = 0;

  constructor(clob: ClobService, config: CopyTradeConfig, logger: Logger) {
    this.clob = clob;
    this.config = config;
    this.logger = logger;
  }

  /**
   * Execute a copy trade based on detected target trade.
   * Returns result with latency info.
   */
  async executeCopy(trade: TargetTrade): Promise<CopyResult> {
    const startMs = Date.now();

    // Cooldown check
    if (startMs - this.lastCopyTime < this.config.cooldownMs) {
      this.totalSkipped++;
      return {
        success: false,
        trade,
        latencyMs: Date.now() - startMs,
        reason: "cooldown",
      };
    }

    // Filter: only BUY if configured
    if (this.config.copyBuysOnly && trade.side !== "BUY") {
      this.totalSkipped++;
      return {
        success: false,
        trade,
        latencyMs: Date.now() - startMs,
        reason: "sell_filtered",
      };
    }

    // Filter: market type
    if (this.config.marketFilter.length > 0) {
      const titleLower = trade.title.toLowerCase();
      const matches = this.config.marketFilter.some((f) => titleLower.includes(f));
      if (!matches) {
        this.totalSkipped++;
        return {
          success: false,
          trade,
          latencyMs: Date.now() - startMs,
          reason: "market_filtered",
        };
      }
    }

    // Max price check
    if (trade.priceCents > this.config.maxPriceCents) {
      this.totalSkipped++;
      return {
        success: false,
        trade,
        latencyMs: Date.now() - startMs,
        reason: `price_too_high_${trade.priceCents}c`,
      };
    }

    // Per-window limit
    const windowKey = this.getWindowKey(trade);
    const tracker = this.getWindowTracker(windowKey);
    if (tracker.copies >= this.config.maxCopiesPerWindow) {
      this.totalSkipped++;
      return {
        success: false,
        trade,
        latencyMs: Date.now() - startMs,
        reason: "window_limit",
      };
    }

    // Balance check (cached, refresh every 10s)
    await this.refreshBalance();

    // Balance floor
    if (this.balance < this.config.minBalanceFloorUsd) {
      this.totalSkipped++;
      return {
        success: false,
        trade,
        latencyMs: Date.now() - startMs,
        reason: `balance_floor_${this.balance.toFixed(0)}`,
      };
    }

    // Calculate copy size
    const copyUsd = this.calculateCopySize(trade);
    if (copyUsd < this.config.minTradeUsd) {
      this.totalSkipped++;
      return {
        success: false,
        trade,
        latencyMs: Date.now() - startMs,
        reason: `size_too_small_${copyUsd.toFixed(2)}`,
      };
    }

    // Exposure check
    const totalExposure = Array.from(this.windowTrackers.values())
      .reduce((sum, w) => sum + w.totalUsd, 0);
    const maxExposure = this.balance * (this.config.maxExposurePct / 100);
    if (totalExposure + copyUsd > maxExposure) {
      this.totalSkipped++;
      return {
        success: false,
        trade,
        latencyMs: Date.now() - startMs,
        reason: "exposure_limit",
      };
    }

    // Calculate execution price with slippage
    const targetPrice = trade.priceCents / 100; // Convert to 0-1
    const maxPrice = Math.min(
      (trade.priceCents + this.config.maxSlippageCents) / 100,
      this.config.maxPriceCents / 100,
    );
    const shares = copyUsd / targetPrice;

    // DRY RUN
    if (this.config.dryRun) {
      this.lastCopyTime = Date.now();
      tracker.copies++;
      tracker.totalUsd += copyUsd;
      this.totalCopied++;

      this.logger.info("DRY RUN — would copy trade", {
        side: trade.side,
        outcome: trade.outcome,
        targetPrice: `${trade.priceCents}¢`,
        maxPrice: `${Math.round(maxPrice * 100)}¢`,
        shares: shares.toFixed(1),
        usd: `$${copyUsd.toFixed(2)}`,
        latency: `${Date.now() - startMs}ms`,
      });

      return {
        success: true,
        trade,
        executedPrice: targetPrice,
        executedShares: shares,
        executedUsd: copyUsd,
        latencyMs: Date.now() - startMs,
        reason: "dry_run",
      };
    }

    // LIVE EXECUTION — FOK for instant fill
    try {
      const side = trade.side === "BUY" ? Side.BUY : Side.SELL;

      const result = await this.clob.placeMarketOrderFOK({
        tokenId: trade.tokenId,
        side,
        amount: side === Side.BUY ? copyUsd : shares,
        worstPrice: maxPrice,
      });

      if (result.filled) {
        this.lastCopyTime = Date.now();
        tracker.copies++;
        tracker.totalUsd += copyUsd;
        this.totalCopied++;
        // Debit balance estimate
        this.balance -= copyUsd;

        const latency = Date.now() - startMs;
        this.logger.info("COPY TRADE FILLED", {
          side: trade.side,
          outcome: trade.outcome,
          targetPrice: `${trade.priceCents}¢`,
          maxPrice: `${Math.round(maxPrice * 100)}¢`,
          usd: `$${copyUsd.toFixed(2)}`,
          orderId: result.orderIds[0]?.slice(0, 12),
          latency: `${latency}ms`,
          totalCopied: this.totalCopied,
        });

        return {
          success: true,
          trade,
          orderId: result.orderIds[0],
          executedPrice: targetPrice,
          executedShares: shares,
          executedUsd: copyUsd,
          latencyMs: latency,
        };
      } else {
        this.totalFailed++;
        this.logger.warn("Copy trade NOT filled (FOK rejected)", {
          outcome: trade.outcome,
          targetPrice: `${trade.priceCents}¢`,
          maxPrice: `${Math.round(maxPrice * 100)}¢`,
          latency: `${Date.now() - startMs}ms`,
        });

        return {
          success: false,
          trade,
          latencyMs: Date.now() - startMs,
          reason: "fok_rejected",
        };
      }
    } catch (err) {
      this.totalFailed++;
      this.logger.error("Copy trade execution error", {
        error: (err as Error).message,
        outcome: trade.outcome,
        latency: `${Date.now() - startMs}ms`,
      });

      return {
        success: false,
        trade,
        latencyMs: Date.now() - startMs,
        reason: `error: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Calculate copy trade size in USD.
   */
  private calculateCopySize(trade: TargetTrade): number {
    let copyUsd: number;

    if (this.config.fixedAmountUsd > 0) {
      // Fixed amount mode
      copyUsd = this.config.fixedAmountUsd;
    } else {
      // Percentage mode: copy same proportion relative to our balance
      // or percentage of the target's trade size
      copyUsd = trade.usdValue * (this.config.copyAmountPct / 100);
    }

    // Clamp to limits
    copyUsd = Math.min(copyUsd, this.config.maxTradeUsd);
    copyUsd = Math.min(copyUsd, this.balance * 0.9); // Never use more than 90% of balance
    copyUsd = Math.max(copyUsd, 0);

    return copyUsd;
  }

  /**
   * Refresh balance from CLOB (cached for 10s).
   */
  private async refreshBalance(): Promise<void> {
    const now = Date.now();
    if (now - this.lastBalanceCheck < 10_000 && this.balance > 0) return;

    try {
      this.balance = await this.clob.getBalance();
      this.lastBalanceCheck = now;
    } catch (err) {
      this.logger.warn("Balance check failed", { error: (err as Error).message });
    }
  }

  /**
   * Get or create a window tracker for dedup/limits.
   */
  private getWindowTracker(key: string): WindowTracker {
    let tracker = this.windowTrackers.get(key);
    if (!tracker) {
      tracker = { windowKey: key, copies: 0, totalUsd: 0 };
      this.windowTrackers.set(key, tracker);

      // Prune old trackers (keep last 50)
      if (this.windowTrackers.size > 50) {
        const keys = Array.from(this.windowTrackers.keys());
        for (let i = 0; i < keys.length - 25; i++) {
          this.windowTrackers.delete(keys[i]);
        }
      }
    }
    return tracker;
  }

  /**
   * Create a window key from a trade for grouping/limiting.
   */
  private getWindowKey(trade: TargetTrade): string {
    // Group by condition ID (= market window)
    return trade.conditionId;
  }

  getStats(): {
    totalCopied: number;
    totalSkipped: number;
    totalFailed: number;
    balance: number;
  } {
    return {
      totalCopied: this.totalCopied,
      totalSkipped: this.totalSkipped,
      totalFailed: this.totalFailed,
      balance: this.balance,
    };
  }
}
