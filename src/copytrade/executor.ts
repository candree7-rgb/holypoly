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

export interface FillEvent {
  orderId: string;
  trade: TargetTrade;
  filledShares: number;
  price: number;
  usd: number;
  placedAt: number;
  filledAt: number;
}

export interface UnfilledEvent {
  orderId: string;
  trade: TargetTrade;
  requestedShares: number;
  filledShares: number;
  price: number;
  placedAt: number;
  cancelled: boolean;
}

interface WindowTracker {
  windowKey: string;
  copies: number;
  totalUsd: number;
  createdAt: number;
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

  // Track pending GTC orders for fill tracking + bumps
  private pendingOrders: Map<string, {
    orderId: string;
    tokenId: string;
    side: Side;
    price: number;
    size: number;
    placedAt: number;
    bumped: boolean;
    trade: TargetTrade;
  }> = new Map();

  /** Fill timeout — cancel unfilled orders after this many ms (default 5 min) */
  private fillTimeoutMs = 5 * 60_000;
  /** Fill check interval (ms) */
  private fillCheckIntervalMs = 3_000;
  /** Guard against overlapping checkPendingOrders runs */
  private isCheckingPending = false;

  // Callbacks
  private onFilledCb: ((event: FillEvent) => void) | null = null;
  private onUnfilledCb: ((event: UnfilledEvent) => void) | null = null;

  constructor(clob: ClobService, config: CopyTradeConfig, logger: Logger) {
    this.clob = clob;
    this.config = config;
    this.logger = logger;

    // Always run fill checker — tracks fills AND handles bumps
    setInterval(() => this.checkPendingOrders(), this.fillCheckIntervalMs);
  }

  /** Register callback for when an order is filled */
  onFilled(cb: (event: FillEvent) => void): void { this.onFilledCb = cb; }

  /** Register callback for when an order times out unfilled */
  onUnfilled(cb: (event: UnfilledEvent) => void): void { this.onUnfilledCb = cb; }

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

    // Parallel: refresh balances + resolve orderbook price simultaneously
    const needsOrderbook = trade.source === "chain" || trade.priceCents === 0;
    const [, , obResult] = await Promise.all([
      this.refreshBalance(),
      this.refreshLeaderBalance(),
      needsOrderbook
        ? this.clob.getOrderbook(trade.tokenId).catch((err: Error) => {
            this.logger.warn("Orderbook lookup failed, using 51¢ fallback", {
              tokenId: trade.tokenId.slice(0, 12) + "...",
              error: err.message,
            });
            return null;
          })
        : Promise.resolve(null),
    ]);

    if (this.balance < this.config.minBalanceFloorUsd) {
      this.totalSkipped++;
      return { success: false, trade, latencyMs: Date.now() - startMs, reason: `balance_floor_${this.balance.toFixed(0)}` };
    }

    // Determine price — maximize fill probability while staying maker (0% fee)
    let priceCents: number;
    if (needsOrderbook) {
      if (obResult) {
        const isBuy = trade.side === "BUY";
        const bestBid = obResult.bestBid;
        const bestAsk = obResult.bestAsk;

        if (isBuy) {
          if (bestBid !== null && bestAsk !== null) {
            // Place at bestAsk - 1 tick: top of bid book, just below the ask
            // This is still MAKER (0% fee) but maximizes fill probability
            // Example: bestBid=50, bestAsk=52 → we place at 51¢ (matches leader's likely entry)
            priceCents = Math.round(bestAsk * 100) - 1;
            // But never below bestBid
            priceCents = Math.max(priceCents, Math.round(bestBid * 100));
          } else if (bestAsk !== null) {
            // No bids — place just below ask
            priceCents = Math.round(bestAsk * 100) - 1;
          } else if (bestBid !== null) {
            // No asks — place at bestBid + 1 (become top bidder)
            priceCents = Math.round(bestBid * 100) + 1;
          } else {
            this.totalSkipped++;
            return { success: false, trade, latencyMs: Date.now() - startMs, reason: "no_liquidity" };
          }
        } else {
          // SELL: place at bestBid + 1 tick (top of ask book, just above bid)
          if (bestBid !== null && bestAsk !== null) {
            priceCents = Math.round(bestBid * 100) + 1;
            priceCents = Math.min(priceCents, Math.round(bestAsk * 100));
          } else if (bestBid !== null) {
            priceCents = Math.round(bestBid * 100) + 1;
          } else if (bestAsk !== null) {
            priceCents = Math.round(bestAsk * 100);
          } else {
            this.totalSkipped++;
            return { success: false, trade, latencyMs: Date.now() - startMs, reason: "no_liquidity" };
          }
        }

        this.logger.info("Orderbook price resolved", {
          tokenId: trade.tokenId.slice(0, 12) + "...",
          side: trade.side,
          ourPrice: `${priceCents}¢`,
          bestAsk: bestAsk !== null ? `${Math.round(bestAsk * 100)}¢` : "null",
          bestBid: bestBid !== null ? `${Math.round(bestBid * 100)}¢` : "null",
          strategy: "maker (bestAsk-1 for BUY, bestBid+1 for SELL)",
        });
      } else {
        // Orderbook lookup failed entirely — skip trade (don't guess a price)
        this.totalSkipped++;
        return { success: false, trade, latencyMs: Date.now() - startMs, reason: "orderbook_failed" };
      }
      trade.priceCents = priceCents;
    } else {
      priceCents = trade.priceCents;
    }

    // Max price check
    if (priceCents > this.config.maxPriceCents) {
      this.totalSkipped++;
      return { success: false, trade, latencyMs: Date.now() - startMs, reason: `price_too_high_${priceCents}c` };
    }

    // Calculate copy size — clamp to minimum rather than skipping
    const price = priceCents / 100;
    let copyUsd = this.calculateCopySize(trade, priceCents);
    if (copyUsd < this.config.minTradeUsd) {
      // Use minimum trade size instead of skipping — we still want to follow the trade
      copyUsd = this.config.minTradeUsd;
    }

    // Exposure check (only count trackers from last 5 minutes)
    const expiryCutoff = Date.now() - 5 * 60_000;
    const totalExposure = Array.from(this.windowTrackers.values())
      .filter((w) => w.createdAt > expiryCutoff)
      .reduce((s, w) => s + w.totalUsd, 0);
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

    // LIVE: GTC limit first (maker, 0% fee), then FOK fallback (taker, guaranteed fill)
    //
    // Strategy: "always fill, cheapest price possible"
    //   1. Place GTC limit at our price (bestAsk-1¢) → maker = 0% fee
    //   2. Wait 10s for fill (maker fill = best outcome)
    //   3. If not filled → cancel → FOK at bestAsk (taker, ~1% fee, but GUARANTEED fill)
    //   Result: ~80% of trades fill as maker (free), ~20% as taker (small fee)
    //
    const side = trade.side === "BUY" ? Side.BUY : Side.SELL;

    try {
      const result = await this.clob.placeLimitThenFOK({
        tokenId: trade.tokenId,
        side,
        price,
        size: shares,
        timeoutMs: 1_500, // 1.5s to try maker, then FOK (fast fill)
      });

      if (!result.filled && result.orderIds.length === 0) {
        this.totalFailed++;
        return {
          success: false, trade,
          latencyMs: Date.now() - startMs,
          reason: "order_failed_no_liquidity",
        };
      }

      this.lastCopyTime = Date.now();
      tracker.copies++;
      tracker.totalUsd += copyUsd;
      this.totalCopied++;
      this.balance -= copyUsd;

      const latency = Date.now() - startMs;
      const feeType = result.maker ? "0% (maker)" : "~1% (taker)";
      const orderId = result.orderIds[0] || "";

      this.logger.info(result.filled ? "ORDER FILLED" : "ORDER PLACED (pending)", {
        side: trade.side,
        outcome: trade.outcome || "?",
        price: `${priceCents}¢`,
        shares: shares.toFixed(1),
        usd: `$${copyUsd.toFixed(2)}`,
        fee: feeType,
        maker: result.maker,
        latency: `${latency}ms`,
        source: trade.source,
        totalCopied: this.totalCopied,
      });

      // Only track in pendingOrders if NOT already filled
      // (filled orders get notified via notifyResult, not onFilledCb)
      if (!result.filled && orderId) {
        // GTC still pending (maker attempt, FOK not triggered yet within placeLimitThenFOK)
        this.pendingOrders.set(orderId, {
          orderId,
          tokenId: trade.tokenId,
          side,
          price,
          size: shares,
          placedAt: Date.now(),
          bumped: false,
          trade,
        });
      }

      return {
        success: true, trade, orderId,
        executedPrice: price, executedShares: shares, executedUsd: copyUsd,
        leaderPriceCents: trade.priceCents, leaderUsd: trade.usdValue, leaderShares: trade.shares,
        latencyMs: latency,
        reason: result.maker ? "maker_fill" : result.filled ? "taker_fill" : "pending",
      };
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.warn("Order failed", { error: msg, outcome: trade.outcome });
      this.totalFailed++;
      return {
        success: false, trade,
        latencyMs: Date.now() - startMs,
        reason: "order_failed",
      };
    }
  }

  /**
   * Check all pending orders: detect fills, handle bumps, cancel timed-out orders.
   *
   * Runs every 3s. For each pending order:
   * 1. Check if filled (≥95%) → emit onFilled callback
   * 2. If bumpAfterMs > 0 and not bumped → bump price
   * 3. If past fillTimeoutMs → cancel and emit onUnfilled callback
   */
  private async checkPendingOrders(): Promise<void> {
    if (this.pendingOrders.size === 0) return;
    if (this.isCheckingPending) return; // Prevent overlapping runs
    this.isCheckingPending = true;
    const now = Date.now();

    for (const [key, order] of this.pendingOrders) {
      try {
        const filled = await this.clob.getFilledShares(order.orderId);

        // FILLED (≥95% matched)
        if (filled >= order.size * 0.95) {
          this.pendingOrders.delete(key);

          this.logger.info("Order FILLED (maker, 0% fee)", {
            orderId: order.orderId.slice(0, 12) + "...",
            filled: filled.toFixed(1),
            price: `${Math.round(order.price * 100)}¢`,
            elapsed: `${((now - order.placedAt) / 1000).toFixed(1)}s`,
          });

          if (this.onFilledCb) {
            this.onFilledCb({
              orderId: order.orderId,
              trade: order.trade,
              filledShares: filled,
              price: order.price,
              usd: filled * order.price,
              placedAt: order.placedAt,
              filledAt: now,
            });
          }
          continue;
        }

        // BUMP: if bumpAfterMs > 0, not yet bumped, and past threshold
        if (this.config.bumpAfterMs > 0 && !order.bumped && now - order.placedAt >= this.config.bumpAfterMs) {
          const bumpPrice = order.price + this.config.maxSlippageCents / 100;
          this.logger.info("Bumping unfilled order", {
            orderId: order.orderId.slice(0, 12) + "...",
            oldPrice: `${Math.round(order.price * 100)}¢`,
            newPrice: `${Math.round(bumpPrice * 100)}¢`,
            bump: `+${this.config.maxSlippageCents}¢`,
          });

          await this.clob.cancelOrder(order.orderId);
          const remaining = order.size - filled;
          try {
            const { orderId: newId } = await this.clob.placeLimitOrder({
              tokenId: order.tokenId,
              side: order.side,
              price: bumpPrice,
              size: remaining,
            });
            // Replace in pending map with new order
            this.pendingOrders.delete(key);
            if (newId) {
              this.pendingOrders.set(newId, {
                ...order,
                orderId: newId,
                price: bumpPrice,
                size: remaining,
                placedAt: now,
                bumped: true,
              });
            }
          } catch (err) {
            this.logger.warn("Bump order placement failed", { error: (err as Error).message });
            order.bumped = true; // Don't retry
          }
          continue;
        }

        // TIMEOUT: always cancel remaining unfilled portion after fillTimeoutMs
        if (now - order.placedAt >= this.fillTimeoutMs) {
          this.pendingOrders.delete(key);

          // Always cancel to free locked collateral (cancel on filled order is a safe no-op)
          await this.clob.cancelOrder(order.orderId);

          // Re-check fill after cancel to get accurate final state
          let finalFilled = filled;
          try {
            finalFilled = await this.clob.getFilledShares(order.orderId);
          } catch { /* use stale value */ }

          const unfilled = order.size - finalFilled;

          this.logger.warn("Order timed out — cancelled remaining", {
            orderId: order.orderId.slice(0, 12) + "...",
            filled: finalFilled.toFixed(1),
            unfilled: unfilled.toFixed(1),
            requested: order.size.toFixed(1),
            elapsed: `${((now - order.placedAt) / 1000).toFixed(0)}s`,
          });

          // Refund balance for unfilled portion
          if (unfilled > 0) {
            this.balance += unfilled * order.price;
          }

          // Emit filled if partially filled, unfilled otherwise
          if (finalFilled >= order.size * 0.95) {
            if (this.onFilledCb) {
              this.onFilledCb({
                orderId: order.orderId,
                trade: order.trade,
                filledShares: finalFilled,
                price: order.price,
                usd: finalFilled * order.price,
                placedAt: order.placedAt,
                filledAt: now,
              });
            }
          } else {
            if (this.onUnfilledCb) {
              this.onUnfilledCb({
                orderId: order.orderId,
                trade: order.trade,
                requestedShares: order.size,
                filledShares: finalFilled,
                price: order.price,
                placedAt: order.placedAt,
                cancelled: true,
              });
            }
          }
        }
      } catch (err) {
        this.logger.warn("Fill check failed", { error: (err as Error).message, orderId: order.orderId.slice(0, 12) + "..." });
      }
    }
    this.isCheckingPending = false;
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
  private leaderBalancePromise: Promise<void> | null = null;

  async refreshLeaderBalance(): Promise<void> {
    if (this.config.sizingMode !== "portfolio") return;
    const now = Date.now();
    if (now - this.lastLeaderBalanceCheck < 60_000 && this.leaderBalance > 0) return;

    // Prevent concurrent fetches (avoid spam when many trades fire simultaneously)
    if (this.leaderBalancePromise) return this.leaderBalancePromise;
    this.leaderBalancePromise = this._fetchLeaderBalance();
    try { await this.leaderBalancePromise; } finally { this.leaderBalancePromise = null; }
  }

  private async _fetchLeaderBalance(): Promise<void> {
    const now = Date.now();
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
    // Prune expired trackers (>5 min old)
    const now = Date.now();
    const expiryCutoff = now - 5 * 60_000;
    for (const [k, v] of this.windowTrackers) {
      if (v.createdAt < expiryCutoff) this.windowTrackers.delete(k);
    }

    let t = this.windowTrackers.get(key);
    if (!t) {
      t = { windowKey: key, copies: 0, totalUsd: 0, createdAt: now };
      this.windowTrackers.set(key, t);
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
