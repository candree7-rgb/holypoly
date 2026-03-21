import { Side } from "@polymarket/clob-client";
import { ClobService } from "../data/clob.js";

/** USDC.e on Polygon (Polymarket uses this for balances) */
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
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

  // Leader balance (fetched dynamically from on-chain)
  private leaderBalance: number = 0;
  private lastLeaderBalanceCheck: number = 0;

  // Track pending GTC orders so we can cancel them if window ends
  private pendingOrders: Map<string, {
    orderId: string;
    tokenId: string;
    side: Side;
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

    // Balance checks (cached)
    await this.refreshBalance();
    await this.refreshLeaderBalance();
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

    // LIVE: Place GTC limit order at target's exact price (with retry)
    const side = trade.side === "BUY" ? Side.BUY : Side.SELL;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const { orderId } = await this.clob.placeLimitOrder({
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

        // Track pending order for bump logic
        if (orderId && this.config.bumpAfterMs > 0) {
          this.pendingOrders.set(orderId, {
            orderId,
            tokenId: trade.tokenId,
            side,
            price,
            size: shares,
            placedAt: Date.now(),
            bumped: false,
          });
        }

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
          orderId: orderId ? orderId.slice(0, 12) + "..." : "?",
          totalCopied: this.totalCopied,
        });

        return {
          success: true, trade, orderId,
          executedPrice: price, executedShares: shares, executedUsd: copyUsd,
          leaderPriceCents: trade.priceCents, leaderUsd: trade.usdValue, leaderShares: trade.shares,
          latencyMs: latency,
        };
      } catch (err) {
        const msg = (err as Error).message;
        this.logger.warn(`Order attempt ${attempt}/${maxRetries} failed`, {
          error: msg,
          outcome: trade.outcome,
        });

        // Don't retry on non-transient errors
        if (msg.includes("below minimum") || msg.includes("insufficient")) break;

        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, attempt * 500));
        }
      }
    }

    this.totalFailed++;
    return {
      success: false, trade,
      latencyMs: Date.now() - startMs,
      reason: "order_failed_after_retries",
    };
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
          side: order.side,
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
   * Four modes:
   * - "portfolio":  Scale proportionally. Leader uses X% of their balance,
   *                 we use X% * COPY_MULTIPLIER of ours.
   *                 Leader balance fetched dynamically from on-chain USDC.
   * - "percentage": Copy X% of target's trade size (COPY_AMOUNT_PCT)
   * - "fixed":      Always trade COPY_FIXED_AMOUNT_USD
   * - "shares":     Always trade COPY_FIXED_SHARES shares
   *
   * COPY_MULTIPLIER applies on top of portfolio mode:
   *   1.0 = same % as leader (1:1)
   *   2.0 = double the % (2x risk)
   *   0.5 = half the % (conservative)
   */
  private calculateCopySize(trade: TargetTrade, priceCents: number): number {
    const targetUsd = trade.usdValue > 0 ? trade.usdValue : trade.shares * priceCents / 100;
    const price = priceCents / 100;
    let copyUsd: number;

    switch (this.config.sizingMode) {
      case "fixed":
        copyUsd = this.config.fixedAmountUsd;
        break;

      case "shares":
        copyUsd = this.config.fixedShares * price;
        break;

      case "percentage":
        copyUsd = targetUsd * (this.config.copyAmountPct / 100);
        break;

      case "portfolio": {
        const leaderBal = this.leaderBalance > 0 ? this.leaderBalance : this.config.leaderPortfolioUsd;
        if (leaderBal > 0 && targetUsd > 0) {
          // What % of their balance did the leader use?
          const leaderPct = targetUsd / leaderBal;
          // Apply same % to our balance, times multiplier
          copyUsd = this.balance * leaderPct * this.config.copyMultiplier;
        } else {
          // Fallback: just copy same USD * multiplier
          copyUsd = targetUsd * this.config.copyMultiplier;
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

  // ==================== BALANCE MANAGEMENT ====================

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
   * Fetch leader's USDC balance on-chain from Polygon.
   * Called periodically (every 60s) to keep portfolio-weighted sizing accurate.
   */
  async refreshLeaderBalance(): Promise<void> {
    if (this.config.sizingMode !== "portfolio") return;
    const now = Date.now();
    if (now - this.lastLeaderBalanceCheck < 60_000 && this.leaderBalance > 0) return;

    try {
      // ERC-20 balanceOf(address) selector = 0x70a08231
      const paddedAddr = this.config.targetAddress.replace("0x", "").toLowerCase().padStart(64, "0");
      const callData = "0x70a08231" + paddedAddr;

      const resp = await fetch(this.config.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [
            { to: USDC_ADDRESS, data: callData },
            "latest",
          ],
        }),
      });

      const data = (await resp.json()) as { result?: string };
      if (data.result) {
        const raw = BigInt(data.result);
        this.leaderBalance = Number(raw) / 1e6; // USDC has 6 decimals
        this.lastLeaderBalanceCheck = now;

        this.logger.info("Leader USDC balance updated", {
          target: this.config.targetAddress.slice(0, 8) + "...",
          balance: `$${this.leaderBalance.toFixed(2)}`,
        });
      }
    } catch (err) {
      this.logger.warn("Failed to fetch leader balance", { error: (err as Error).message });
      // Use fallback from config
      if (this.leaderBalance === 0 && this.config.leaderPortfolioUsd > 0) {
        this.leaderBalance = this.config.leaderPortfolioUsd;
      }
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
