import { Side, OrderType } from "@polymarket/clob-client";
import { ClobService } from "../data/clob.js";
import type { Logger } from "../logger.js";
import type { CopyTradeConfig } from "./config.js";
import type { TargetTrade } from "./tracker.js";

export interface CopyResult {
  success: boolean;
  trade: TargetTrade;
  orderId?: string;
  /** Our execution price (0-1) */
  executedPrice?: number;
  executedShares?: number;
  executedUsd?: number;
  /** Leader's price for comparison */
  leaderPriceCents?: number;
  leaderUsd?: number;
  leaderShares?: number;
  latencyMs: number;
  reason?: string;
}

interface WindowTracker {
  windowKey: string;
  copies: number;
  totalUsd: number;
}

/**
 * Order executor for copy trading.
 *
 * Strategy: GTC limit orders at the same price as target.
 *
 * Why GTC limit (not FOK):
 * - The target buys at ~50-51¢ on markets that haven't started yet
 * - There's plenty of liquidity and time — no urgency
 * - GTC limit = MAKER = 0% fee (vs ~1.5% taker fee at 50¢)
 * - Order sits in the book and fills when liquidity arrives
 * - If price moves away, we don't overpay (unlike FOK with slippage)
 *
 * Optional: if not filled after bumpAfterMs, bump price by 1¢ (configurable).
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

  // Track pending GTC orders so we can cancel them if window ends
  private pendingOrders: Map<string, {
    orderId: string;
    tokenId: string;
    price: number;
    size: number;
    placedAt: number;
    bumped: boolean;
  }> = new Map();

  constructor(clob: ClobService, config: CopyTradeConfig, logger: Logger) {
    this.clob = clob;
    this.config = config;
    this.logger = logger;

    // Start bump checker (checks if pending orders need price bump)
    if (config.bumpAfterMs > 0) {
      setInterval(() => this.checkPendingBumps(), 2000);
    }
  }

  /**
   * Execute a copy trade based on detected target trade.
   *
   * For chain-detected trades (source="chain"), we don't have price info,
   * so we look up the current orderbook best ask.
   *
   * For API-detected trades (source="api"), we use the target's actual price.
   */
  async executeCopy(trade: TargetTrade): Promise<CopyResult> {
    const startMs = Date.now();

    // Cooldown check
    if (startMs - this.lastCopyTime < this.config.cooldownMs) {
      this.totalSkipped++;
      return { success: false, trade, latencyMs: Date.now() - startMs, reason: "cooldown" };
    }

    // Filter: only BUY if configured
    if (this.config.copyBuysOnly && trade.side !== "BUY") {
      this.totalSkipped++;
      return { success: false, trade, latencyMs: Date.now() - startMs, reason: "sell_filtered" };
    }

    // Filter: market type
    if (this.config.marketFilter.length > 0) {
      const titleLower = trade.title.toLowerCase();
      const matches = this.config.marketFilter.some((f) => titleLower.includes(f));
      if (!matches && trade.source !== "chain") {
        // Chain events don't have title — let them through, filter on API side
        this.totalSkipped++;
        return { success: false, trade, latencyMs: Date.now() - startMs, reason: "market_filtered" };
      }
    }

    // Per-window limit
    const windowKey = trade.conditionId || trade.tokenId;
    const tracker = this.getWindowTracker(windowKey);
    if (tracker.copies >= this.config.maxCopiesPerWindow) {
      this.totalSkipped++;
      return { success: false, trade, latencyMs: Date.now() - startMs, reason: "window_limit" };
    }

    // Balance check (cached 10s)
    await this.refreshBalance();
    if (this.balance < this.config.minBalanceFloorUsd) {
      this.totalSkipped++;
      return { success: false, trade, latencyMs: Date.now() - startMs, reason: `balance_floor_${this.balance.toFixed(0)}` };
    }

    // Determine price
    let priceCents: number;
    if (trade.source === "chain" || trade.priceCents === 0) {
      // Chain event — look up orderbook for current best ask
      try {
        const ob = await this.clob.getOrderbook(trade.tokenId);
        if (ob.bestAsk !== null) {
          priceCents = Math.round(ob.bestAsk * 100);
        } else {
          priceCents = 51; // Default for 5-min crypto markets
        }
      } catch {
        priceCents = 51;
      }
    } else {
      priceCents = trade.priceCents;
    }

    // Max price check
    if (priceCents > this.config.maxPriceCents) {
      this.totalSkipped++;
      return { success: false, trade, latencyMs: Date.now() - startMs, reason: `price_too_high_${priceCents}c` };
    }

    // Calculate copy size
    const price = priceCents / 100;
    const copyUsd = this.calculateCopySize(trade, priceCents);
    if (copyUsd < this.config.minTradeUsd) {
      this.totalSkipped++;
      return { success: false, trade, latencyMs: Date.now() - startMs, reason: `size_too_small` };
    }

    // Exposure check
    const totalExposure = Array.from(this.windowTrackers.values()).reduce((s, w) => s + w.totalUsd, 0);
    const maxExposure = this.balance * (this.config.maxExposurePct / 100);
    if (totalExposure + copyUsd > maxExposure) {
      this.totalSkipped++;
      return { success: false, trade, latencyMs: Date.now() - startMs, reason: "exposure_limit" };
    }

    const shares = copyUsd / price;

    // DRY RUN
    if (this.config.dryRun) {
      this.lastCopyTime = Date.now();
      tracker.copies++;
      tracker.totalUsd += copyUsd;
      this.totalCopied++;

      this.logger.info("DRY RUN — would place GTC limit", {
        side: trade.side,
        outcome: trade.outcome || "?",
        price: `${priceCents}¢`,
        shares: shares.toFixed(1),
        usd: `$${copyUsd.toFixed(2)}`,
        latency: `${Date.now() - startMs}ms`,
        source: trade.source,
      });

      return {
        success: true, trade, executedPrice: price,
        executedShares: shares, executedUsd: copyUsd,
        leaderPriceCents: trade.priceCents, leaderUsd: trade.usdValue, leaderShares: trade.shares,
        latencyMs: Date.now() - startMs, reason: "dry_run",
      };
    }

    // LIVE: Place GTC limit order at target's exact price
    try {
      const side = trade.side === "BUY" ? Side.BUY : Side.SELL;

      await this.clob.placeLimitOrder({
        tokenId: trade.tokenId,
        side,
        price,
        size: shares,
      });

      this.lastCopyTime = Date.now();
      tracker.copies++;
      tracker.totalUsd += copyUsd;
      this.totalCopied++;
      this.balance -= copyUsd;

      const latency = Date.now() - startMs;

      this.logger.info("GTC LIMIT ORDER PLACED", {
        side: trade.side,
        outcome: trade.outcome || "?",
        price: `${priceCents}¢ (same as target)`,
        shares: shares.toFixed(1),
        usd: `$${copyUsd.toFixed(2)}`,
        fee: "0% (maker)",
        latency: `${latency}ms`,
        source: trade.source,
        totalCopied: this.totalCopied,
      });

      return {
        success: true, trade,
        executedPrice: price, executedShares: shares, executedUsd: copyUsd,
        leaderPriceCents: trade.priceCents, leaderUsd: trade.usdValue, leaderShares: trade.shares,
        latencyMs: latency,
      };
    } catch (err) {
      this.totalFailed++;
      this.logger.error("GTC order placement error", {
        error: (err as Error).message,
        outcome: trade.outcome,
        latency: `${Date.now() - startMs}ms`,
      });

      return {
        success: false, trade,
        latencyMs: Date.now() - startMs,
        reason: `error: ${(err as Error).message}`,
      };
    }
  }

  /**
   * Check pending GTC orders and bump price if not filled after bumpAfterMs.
   */
  private async checkPendingBumps(): Promise<void> {
    const now = Date.now();
    for (const [key, order] of this.pendingOrders) {
      if (order.bumped) continue;
      if (now - order.placedAt < this.config.bumpAfterMs) continue;

      // Check if filled
      try {
        const filled = await this.clob.getFilledShares(order.orderId);
        if (filled >= order.size * 0.95) {
          // Filled — remove from pending
          this.pendingOrders.delete(key);
          this.logger.info("Pending order filled (maker)", {
            orderId: order.orderId.slice(0, 12) + "...",
            filled: filled.toFixed(1),
          });
          continue;
        }

        // Not filled — bump by maxSlippageCents
        const bumpPrice = order.price + this.config.maxSlippageCents / 100;
        this.logger.info("Bumping unfilled order", {
          orderId: order.orderId.slice(0, 12) + "...",
          oldPrice: `${Math.round(order.price * 100)}¢`,
          newPrice: `${Math.round(bumpPrice * 100)}¢`,
          bump: `+${this.config.maxSlippageCents}¢`,
        });

        // Cancel old order
        await this.clob.cancelOrder(order.orderId);

        // Place new order at bumped price
        await this.clob.placeLimitOrder({
          tokenId: order.tokenId,
          side: Side.BUY,
          price: bumpPrice,
          size: order.size - filled,
        });

        order.bumped = true;
      } catch (err) {
        this.logger.warn("Bump check failed", { error: (err as Error).message });
      }
    }
  }

  /**
   * Calculate copy trade size in USD.
   *
   * Three modes:
   * - "fixed":      Always trade fixedAmountUsd
   * - "percentage": Copy X% of target's trade size
   * - "portfolio":  Scale proportionally to our balance vs leader's portfolio.
   *                 If leader has $4000 and trades $100 (2.5%), and we have $200,
   *                 we trade $5 (2.5% of our balance). Same risk proportionally.
   */
  private calculateCopySize(trade: TargetTrade, priceCents: number): number {
    const targetUsd = trade.usdValue > 0 ? trade.usdValue : trade.shares * priceCents / 100;
    let copyUsd: number;

    switch (this.config.sizingMode) {
      case "fixed":
        copyUsd = this.config.fixedAmountUsd;
        break;

      case "percentage":
        copyUsd = targetUsd * (this.config.copyAmountPct / 100);
        break;

      case "portfolio": {
        // Portfolio-weighted: same % of our balance as leader uses of theirs
        // Leader portfolio is estimated from COPY_LEADER_PORTFOLIO_USD env var
        // or we use a reasonable default
        const leaderPortfolio = this.config.leaderPortfolioUsd;
        if (leaderPortfolio > 0 && targetUsd > 0) {
          const pct = targetUsd / leaderPortfolio;
          copyUsd = this.balance * pct;
        } else {
          // Fallback: percentage mode
          copyUsd = targetUsd * (this.config.copyAmountPct / 100);
        }
        break;
      }

      default:
        copyUsd = targetUsd;
    }

    copyUsd = Math.min(copyUsd, this.config.maxTradeUsd);
    copyUsd = Math.min(copyUsd, this.balance * 0.9);
    return Math.max(copyUsd, 0);
  }

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

  private getWindowTracker(key: string): WindowTracker {
    let t = this.windowTrackers.get(key);
    if (!t) {
      t = { windowKey: key, copies: 0, totalUsd: 0 };
      this.windowTrackers.set(key, t);
      if (this.windowTrackers.size > 50) {
        const keys = Array.from(this.windowTrackers.keys());
        for (let i = 0; i < keys.length - 25; i++) this.windowTrackers.delete(keys[i]);
      }
    }
    return t;
  }

  getStats() {
    return {
      totalCopied: this.totalCopied,
      totalSkipped: this.totalSkipped,
      totalFailed: this.totalFailed,
      balance: this.balance,
    };
  }
}
