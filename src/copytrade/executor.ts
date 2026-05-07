import { Side } from "@polymarket/clob-client-v2";
import { ClobService } from "../data/clob.js";
import { getPortfolioValue, getPositionForToken } from "./portfolio.js";
import { PositionLedger } from "./ledger.js";
import { SellEngine, type SellIntent } from "./sell-engine.js";
import type { ResolutionTracker } from "./resolution.js";
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
 * Strategy: GTC test → FOK fill → patient GTC fallback.
 *
 * 1. GTC at leader's exact price (500ms) → 0% fee if instant match
 * 2. FOK at leader price +2¢ → instant fill (like PolyGun), max 2¢ slippage
 * 3. If no liquidity → patient GTC at leader price, fills over minutes
 * 4. Bumps +1¢ after bumpAfterMs if still unfilled (safety net)
 */
export class CopyExecutor {
  private clob: ClobService;
  private config: CopyTradeConfig;
  private logger: Logger;
  private balance: number = 0; // Free USDC from CLOB (overwritten by refresh)
  private equity: number = 0; // Total portfolio (USDC + open positions)
  private lastBalanceCheck: number = 0;
  /**
   * In-flight reservations. Kept separate from `balance` so that
   * background `refreshBalance` can overwrite `balance` from truth
   * without losing pending reservations. effective = balance - reservedBalance.
   */
  private reservedBalance: number = 0;

  /** Free USDC minus any in-flight reservations */
  private get effectiveBalance(): number {
    return Math.max(0, this.balance - this.reservedBalance);
  }
  private windowTrackers: Map<string, WindowTracker> = new Map();
  private lastCopyTime: number = 0;
  private totalCopied = 0;
  private totalSkipped = 0;
  private totalFailed = 0;

  // Per-leader balance cache (keyed by lowercase address)
  private leaderBalances: Map<string, number> = new Map();
  private lastLeaderBalanceChecks: Map<string, number> = new Map();

  // Track pending GTC orders for fill tracking + bumps
  private pendingOrders: Map<string, {
    orderId: string;
    tokenId: string;
    side: Side;
    /** Called once when pendingOrder is removed (fill, timeout, or cancel) */
    onFinalize?: () => void;
    price: number;
    /** Original price at first placement (for slippage tracking) */
    originalPrice: number;
    size: number;
    placedAt: number;
    /** When this specific order was placed (resets on bump) */
    orderPlacedAt: number;
    bumpCount: number;
    trade: TargetTrade;
  }> = new Map();

  /** Fill timeout — cancel unfilled orders after this many ms (default 15 min) */
  private fillTimeoutMs = 5 * 60_000;
  /** Fill check interval (ms) */
  private fillCheckIntervalMs = 3_000;
  /** Guard against overlapping checkPendingOrders runs */
  private isCheckingPending = false;

  // Per-leader position ledger (source of truth for SELL sizing)
  private ledger: PositionLedger;
  // SELL execution engine
  private sellEngine: SellEngine;

  // Callbacks
  private onFilledCb: ((event: FillEvent) => void) | null = null;
  private onUnfilledCb: ((event: UnfilledEvent) => void) | null = null;
  private onSellIntentCompleteCb: ((intent: SellIntent) => void) | null = null;

  constructor(clob: ClobService, config: CopyTradeConfig, logger: Logger, resolution?: ResolutionTracker) {
    this.clob = clob;
    this.config = config;
    this.logger = logger;
    this.ledger = new PositionLedger(logger);
    this.sellEngine = new SellEngine(
      clob,
      this.ledger,
      config,
      logger,
      {
        // Use injected resolution tracker if available, else always-false
        isResolved: async (cid: string) => resolution ? await resolution.isResolved(cid).catch(() => false) : false,
      },
      {
        cancelPendingBuysFor: (leader, tokenId) => this.cancelPendingBuysFor(leader, tokenId),
      },
    );
    this.sellEngine.onIntentComplete((intent) => {
      if (this.onSellIntentCompleteCb) this.onSellIntentCompleteCb(intent);
    });

    // Always run fill checker — tracks fills AND handles bumps
    setInterval(() => this.checkPendingOrders(), this.fillCheckIntervalMs);

    // Prime balance/equity on startup + refresh every 60s
    this.refreshBalance().catch(() => {});
    this.refreshLeaderBalance().catch(() => {});
    setInterval(() => {
      this.refreshBalance().catch(() => {});
      this.refreshLeaderBalance().catch(() => {});
    }, 60_000);

    // Reconcile ledger every N ms against on-chain positions (only ever shrinks)
    setInterval(() => this.reconcileLedger().catch(() => {}), this.config.ledgerReconcileMs);
    setInterval(() => this.ledger.pruneAppliedFills(), 5 * 60_000);
  }

  /** Cancel any pending BUYs for (leader, tokenId) — called by SellEngine before SELL */
  private async cancelPendingBuysFor(leader: string, tokenId: string): Promise<void> {
    const toCancel: string[] = [];
    for (const [orderId, order] of this.pendingOrders) {
      if (order.side === Side.BUY
        && order.tokenId === tokenId
        && order.trade.leaderAddress.toLowerCase() === leader.toLowerCase()) {
        toCancel.push(orderId);
      }
    }
    for (const orderId of toCancel) {
      const order = this.pendingOrders.get(orderId);
      if (!order) continue;
      try {
        await this.clob.cancelOrder(orderId);
      } catch { /* ignore */ }
      order.onFinalize?.();
      this.pendingOrders.delete(orderId);
      this.logger.info("Cancelled pending BUY before SELL", { orderId: orderId.slice(0, 12) + "...", leader: leader.slice(0, 8) + "..." });
    }
  }

  /** Reconcile ledger against on-chain `/positions` data */
  private async reconcileLedger(): Promise<void> {
    const tokenIds = new Set(this.ledger.allEntries().map((e) => e.tokenId));
    for (const tokenId of tokenIds) {
      try {
        const onChain = await getPositionForToken(this.config.profileAddress, tokenId, this.config.dataApiHost);
        const onChainShares = onChain?.size ?? 0;
        this.ledger.reconcile(tokenId, onChainShares);
      } catch { /* skip on error — try next tick */ }
    }
  }

  /** Public hook so external code (index.ts) can listen to completed SELL intents */
  onSellIntentComplete(cb: (intent: SellIntent) => void): void {
    this.onSellIntentCompleteCb = cb;
  }

  /** Hook the executor's BUY fills into the ledger so SELL sizing has truth */
  private applyLedgerBuy(trade: TargetTrade, filledShares: number, fillPrice: number, orderId: string): void {
    if (filledShares <= 0) return;
    this.ledger.applyBuyFill(
      trade.leaderAddress,
      trade.tokenId,
      trade.conditionId,
      filledShares,
      fillPrice,
      `${orderId}:${trade.id}`,
    );
  }

  getLedger(): PositionLedger {
    return this.ledger;
  }

  getSellEngine(): SellEngine {
    return this.sellEngine;
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

    // Cooldown check — BUYs only (SELLs are risk-reducing, always execute)
    if (trade.side === "BUY" && startMs - this.lastCopyTime < this.config.cooldownMs) {
      this.totalSkipped++;
      return { success: false, trade, latencyMs: Date.now() - startMs, reason: "cooldown" };
    }

    // Filter: SELL handling
    // If copyBuysOnly is true, skip sells entirely.
    // Otherwise, we use PROPORTIONAL sell logic (see below) — can't just copy USD amount.
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
    // Namespace by leader so different leaders don't share maxCopiesPerWindow budgets
    const windowKey = `${trade.leaderAddress}:${trade.conditionId || trade.tokenId}`;
    const tracker = this.getWindowTracker(windowKey);
    if (tracker.copies >= this.config.maxCopiesPerWindow) {
      this.totalSkipped++;
      return { success: false, trade, latencyMs: Date.now() - startMs, reason: "window_limit" };
    }

    // Parallel: refresh balances + resolve orderbook price + pre-warm market meta cache
    const needsOrderbook = trade.source === "chain" || trade.priceCents === 0;
    const [, , obResult] = await Promise.all([
      this.refreshBalance(),
      this.refreshLeaderBalance(trade.leaderAddress),
      needsOrderbook
        ? this.clob.getOrderbook(trade.tokenId).catch((err: Error) => {
            this.logger.warn("Orderbook lookup failed, using 51¢ fallback", {
              tokenId: trade.tokenId.slice(0, 12) + "...",
              error: err.message,
            });
            return null;
          })
        : Promise.resolve(null),
      // Pre-warm market meta cache (tick size, min order size) — avoids extra API call during order placement
      this.clob.getMarketMeta(trade.tokenId).catch(() => null),
    ]);

    // Balance floor — only for BUYs (SELLs don't spend USDC)
    if (trade.side === "BUY" && this.effectiveBalance < this.config.minBalanceFloorUsd) {
      this.totalSkipped++;
      return { success: false, trade, latencyMs: Date.now() - startMs, reason: `balance_floor_${this.effectiveBalance.toFixed(0)}` };
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

    // Price range check (default 2¢–98¢)
    if (priceCents > this.config.maxPriceCents) {
      this.totalSkipped++;
      return { success: false, trade, latencyMs: Date.now() - startMs, reason: `price_too_high_${priceCents}c` };
    }
    if (priceCents < this.config.minPriceCents) {
      this.totalSkipped++;
      return { success: false, trade, latencyMs: Date.now() - startMs, reason: `price_too_low_${priceCents}c` };
    }

    // Calculate copy size
    const price = priceCents / 100;
    let copyUsd: number;
    let shares: number;

    if (trade.side === "SELL") {
      // SELL: hand off to SellEngine for staged execution with no-gaps guarantee.
      // Leader pre-sell size: query leader's CURRENT position (post-sell) and add trade.shares.
      // Use 5s cache to handle rapid back-to-back SELLs from same leader.
      const leaderPreSellSize = await this.sellEngine.getLeaderPreSellSize(
        trade.leaderAddress,
        trade.tokenId,
        trade.shares,
        async () => {
          const pos = await getPositionForToken(trade.leaderAddress, trade.tokenId, this.config.dataApiHost);
          return pos?.size || 0;
        },
      ).catch(() => trade.shares); // fallback: assume 100% close

      const intent = await this.sellEngine.exit(trade, leaderPreSellSize);

      // Map intent result into CopyResult
      const success = intent.filledShares > 0;
      if (success) this.totalCopied++; else this.totalSkipped++;
      return {
        success,
        trade,
        executedPrice: intent.avgFillPrice,
        executedShares: intent.filledShares,
        executedUsd: intent.totalProceedsUsd,
        leaderPriceCents: trade.priceCents,
        leaderUsd: trade.usdValue,
        leaderShares: trade.shares,
        latencyMs: Date.now() - startMs,
        reason: intent.reason || intent.status,
        orderId: intent.childOrderIds[0],
      };
    } else {
      // BUY: standard portfolio/percentage/fixed sizing
      copyUsd = this.calculateCopySize(trade, priceCents);
      if (copyUsd < this.config.minTradeUsd) {
        copyUsd = this.config.minTradeUsd;
      }
      shares = copyUsd / price;
    }

    // Exposure check (only for BUYs — SELLs reduce exposure)
    if (trade.side === "BUY") {
      const expiryCutoff = Date.now() - 5 * 60_000;
      const totalExposure = Array.from(this.windowTrackers.values())
        .filter((w) => w.createdAt > expiryCutoff)
        .reduce((s, w) => s + w.totalUsd, 0);
      const maxExposure = this.effectiveBalance * (this.config.maxExposurePct / 100);
      if (totalExposure + copyUsd > maxExposure) {
        this.totalSkipped++;
        return { success: false, trade, latencyMs: Date.now() - startMs, reason: "exposure_limit" };
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // SYNCHRONOUS RESERVATION — prevents concurrent races on:
    //   - Balance double-spend (two leaders sizing against same balance)
    //   - Exposure limit bypass (two leaders both see 0 prior exposure)
    //   - Cooldown bypass (burst of trades all see stale lastCopyTime)
    // Must happen BEFORE any await. Rolled back on failure.
    // ═══════════════════════════════════════════════════════════════
    const reserved = { copyUsd, isBuy: trade.side === "BUY", tracker, rolledBack: false, released: false };
    const rollback = () => {
      if (reserved.rolledBack || reserved.released) return;
      reserved.rolledBack = true;
      if (reserved.isBuy) {
        this.reservedBalance = Math.max(0, this.reservedBalance - reserved.copyUsd);
        reserved.tracker.totalUsd -= reserved.copyUsd;
      }
      reserved.tracker.copies = Math.max(0, reserved.tracker.copies - 1);
    };
    // Release reservation on successful fill — CLOB balance drops, refreshBalance
    // will pick up truth. Until refresh, we stop subtracting this amount from effective.
    const releaseReservation = () => {
      if (reserved.released || reserved.rolledBack) return;
      reserved.released = true;
      if (reserved.isBuy) {
        this.reservedBalance = Math.max(0, this.reservedBalance - reserved.copyUsd);
      }
    };
    if (reserved.isBuy) {
      this.reservedBalance += copyUsd;
      tracker.totalUsd += copyUsd;
    }
    tracker.copies++;
    this.lastCopyTime = startMs;

    // DRY RUN
    if (this.config.dryRun) {
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

    // LIVE: GTC at leader price → FAK at +slippage → patient GTC
    //
    // Step 1: GTC at exact leader price (500ms) — 0% maker fee if matched
    // Step 2: Cancel → FAK at leader price + slippage — partial fills OK
    // Step 3: If still unfilled → patient GTC at leader price
    //
    const side = trade.side === "BUY" ? Side.BUY : Side.SELL;
    // Dynamic slippage: tighter near 100¢ to protect edge, wider at low prices for fills.
    // Formula: slippage = min(normalSlippage, max(0.5, 100 - price - 1))
    //   99¢ → 0.5¢   (edge 1¢, keep 0.5¢ profit)
    //   98¢ → 1¢     (edge 2¢, keep 1¢ profit)
    //   97¢ → 2¢     (edge 3¢, keep 1¢ profit)
    //   96¢ → 3¢     (edge 4¢, keep 1¢ profit)
    //   ≤95¢ → 3¢    (capped at maxSlippageCents)
    const dynamicSlipCents = trade.side === "BUY"
      ? Math.min(this.config.maxSlippageCents, Math.max(0.5, 100 - priceCents - 1))
      : this.config.maxSlippageCents; // SELL uses normal slippage
    const slippage = dynamicSlipCents / 100;
    const worstPrice = trade.side === "BUY" ? price + slippage : Math.max(0.01, price - slippage);

    // High-price fast path: skip Step 1 GTC test (leader ate liquidity, GTC won't fill)
    const isHighPriceBand = trade.side === "BUY"
      && priceCents >= this.config.highPriceFastPathMinCents;

    if (isHighPriceBand) {
      this.logger.info("HIGH-PRICE FAST PATH (skip GTC test, direct FAK)", {
        priceCents,
        threshold: this.config.highPriceFastPathMinCents,
        dynamicSlipCents: dynamicSlipCents.toFixed(1),
      });
    }

    try {
      // ─── STEP 1: GTC at leader's exact price (500ms) ───
      // SKIPPED for high-price band (92-99¢) — leader has eaten liquidity, GTC won't fill
      let gtcFilled = 0;
      let step1OrderId: string | null = null;

      if (!isHighPriceBand) {
        try {
          const { orderId } = await this.clob.placeLimitOrder({
            tokenId: trade.tokenId,
            side,
            price,
            size: shares,
          });
          step1OrderId = orderId;

          if (orderId) {
            await new Promise((r) => setTimeout(r, 500));
            try {
              gtcFilled = await this.clob.getFilledShares(orderId);
            } catch { /* continue */ }
          }
        } catch (err) {
          this.logger.info("Step 1 GTC failed, trying FAK", { error: (err as Error).message });
        }
      }

      // Check if GTC filled instantly (best case: 0% fee)
      if (gtcFilled >= shares * 0.95) {
        // Reservation already made at top of executeCopy — release it (CLOB drops balance)
        releaseReservation();
        this.totalCopied++;

        this.logger.info("STEP 1: GTC filled (maker, 0% fee)", {
          side: trade.side,
          outcome: trade.outcome || "?",
          price: `${priceCents}¢`,
          shares: gtcFilled.toFixed(1),
          latency: `${Date.now() - startMs}ms`,
        });

        // Apply BUY fill to per-leader ledger (source of truth for SELL sizing)
        this.applyLedgerBuy(trade, gtcFilled, price, step1OrderId!);

        if (this.onFilledCb) {
          this.onFilledCb({
            orderId: step1OrderId!,
            trade,
            filledShares: gtcFilled,
            price,
            usd: gtcFilled * price,
            placedAt: Date.now(),
            filledAt: Date.now(),
          });
        }

        return {
          success: true, trade, orderId: step1OrderId ?? undefined,
          executedPrice: price, executedShares: gtcFilled, executedUsd: copyUsd,
          leaderPriceCents: trade.priceCents, leaderUsd: trade.usdValue, leaderShares: trade.shares,
          latencyMs: Date.now() - startMs,
          reason: "gtc_instant_fill",
        };
      }

      // Cancel GTC before FAK attempt, then re-query fills to avoid double-fill
      // (fills could have landed between the first check and the cancel)
      if (step1OrderId) {
        await this.clob.cancelOrder(step1OrderId);
        try {
          gtcFilled = await this.clob.getFilledShares(step1OrderId);
        } catch { /* keep previous value */ }
      }
      const remaining = shares - gtcFilled;

      // ─── STEP 2: FAK at leader price + slippage (partial fills OK) ───
      if (remaining > 0) {
        try {
          // FAK amount: USD for BUY, shares for SELL (per Polymarket CLOB API)
          const fakAmount = trade.side === "BUY" ? remaining * worstPrice : remaining;
          const fakResult = await this.clob.placeMarketOrderFAK({
            tokenId: trade.tokenId,
            side,
            amount: fakAmount,
            worstPrice,
          });

          // CRITICAL: don't trust fakResult.filled — always verify actual shares via getFilledShares.
          // The CLOB returns an orderID even when 0 shares matched (FAK auto-cancels remainder).
          let fakActualFilled = 0;
          if (fakResult.orderIds[0]) {
            try {
              fakActualFilled = await this.clob.getFilledShares(fakResult.orderIds[0]);
            } catch { /* assume 0 */ }
          }

          if (fakActualFilled > 0) {
            const totalFilled = gtcFilled + fakActualFilled;
            // Reservation already made — release it (order filled, CLOB balance drops)
            releaseReservation();
            this.totalCopied++;

            this.logger.info("STEP 2: FAK filled (verified)", {
              side: trade.side,
              outcome: trade.outcome || "?",
              leaderPrice: `${priceCents}¢`,
              worstPrice: `${Math.round(worstPrice * 100)}¢`,
              fakVerified: fakActualFilled.toFixed(1),
              totalShares: totalFilled.toFixed(1),
              latency: `${Date.now() - startMs}ms`,
              step1Partial: gtcFilled > 0 ? `${gtcFilled.toFixed(1)} maker` : "none",
            });

            // Apply BUY fill to ledger
            this.applyLedgerBuy(trade, totalFilled, worstPrice, fakResult.orderIds[0] || step1OrderId || "fak");

            if (this.onFilledCb) {
              this.onFilledCb({
                orderId: fakResult.orderIds[0] || step1OrderId || "fak",
                trade,
                filledShares: totalFilled,
                price: worstPrice,
                usd: totalFilled * worstPrice,
                placedAt: Date.now(),
                filledAt: Date.now(),
              });
            }

            return {
              success: true, trade, orderId: fakResult.orderIds[0],
              executedPrice: worstPrice, executedShares: totalFilled, executedUsd: copyUsd,
              leaderPriceCents: trade.priceCents, leaderUsd: trade.usdValue, leaderShares: trade.shares,
              latencyMs: Date.now() - startMs,
              reason: "fak_filled",
            };
          }
        } catch (err) {
          this.logger.info("Step 2 FAK no match, placing patient GTC", {
            error: (err as Error).message,
          });
        }
      }

      // ─── STEP 3: Patient GTC at leader price ───
      const gtcShares = shares - gtcFilled;

      // Patient GTC placed — keep reservation live until it fills or times out
      // (the checkPendingOrders timer handles fill tracking; reservation released in fill callback)
      this.totalCopied++;

      const { orderId: patientId } = await this.clob.placeLimitOrder({
        tokenId: trade.tokenId,
        side,
        price,
        size: gtcShares,
      });

      if (patientId) {
        const now2 = Date.now();
        this.pendingOrders.set(patientId, {
          orderId: patientId,
          tokenId: trade.tokenId,
          side,
          price,
          originalPrice: price,
          size: gtcShares,
          placedAt: now2,
          orderPlacedAt: now2,
          bumpCount: 0,
          trade,
          onFinalize: releaseReservation,
        });
      }

      this.logger.info("STEP 3: Patient GTC placed", {
        side: trade.side,
        outcome: trade.outcome || "?",
        price: `${priceCents}¢`,
        shares: gtcShares.toFixed(1),
        latency: `${Date.now() - startMs}ms`,
        orderId: patientId ? patientId.slice(0, 12) + "..." : "?",
      });

      return {
        success: true, trade, orderId: patientId ?? undefined,
        executedPrice: price, executedShares: gtcShares, executedUsd: copyUsd,
        leaderPriceCents: trade.priceCents, leaderUsd: trade.usdValue, leaderShares: trade.shares,
        latencyMs: Date.now() - startMs,
        reason: "gtc_pending",
      };
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.warn("Order failed", { error: msg, outcome: trade.outcome });
      this.totalFailed++;
      rollback(); // release reserved balance/exposure on failure
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
          order.onFinalize?.();

          this.logger.info("Order FILLED (maker, 0% fee)", {
            orderId: order.orderId.slice(0, 12) + "...",
            filled: filled.toFixed(1),
            price: `${Math.round(order.price * 100)}¢`,
            elapsed: `${((now - order.placedAt) / 1000).toFixed(1)}s`,
          });

          // Apply BUY fill to ledger (SELLs handled by SellEngine.complete())
          if (order.side === Side.BUY) {
            this.applyLedgerBuy(order.trade, filled, order.price, order.orderId);
          }

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

        // BUMP: if bumpAfterMs > 0, bumps remaining, and enough time since last order placement
        if (
          this.config.bumpAfterMs > 0 &&
          order.bumpCount < this.config.maxBumps &&
          now - order.orderPlacedAt >= this.config.bumpAfterMs
        ) {
          // Bump direction: BUY bumps UP (pay more), SELL bumps DOWN (accept less)
          const bumpSlip = this.config.maxSlippageCents / 100;
          const bumpPrice = order.side === Side.BUY
            ? order.price + bumpSlip
            : Math.max(0.01, order.price - bumpSlip);

          // Don't bump out of valid range (BUY: > max, SELL: < min)
          const bumpCents = Math.round(bumpPrice * 100);
          const outOfRange = order.side === Side.BUY
            ? bumpCents > this.config.maxPriceCents
            : bumpCents < this.config.minPriceCents;
          if (outOfRange) {
            this.logger.info("Bump would exceed price range, skipping to FOK/timeout", {
              orderId: order.orderId.slice(0, 12) + "...",
              side: order.side,
              bumpPrice: `${bumpCents}¢`,
              limit: order.side === Side.BUY ? `${this.config.maxPriceCents}¢` : `${this.config.minPriceCents}¢`,
            });
            // Force to timeout/FOK path by setting bumpCount to max
            order.bumpCount = this.config.maxBumps;
          } else {
            this.logger.info(`Bump #${order.bumpCount + 1}/${this.config.maxBumps}`, {
              orderId: order.orderId.slice(0, 12) + "...",
              oldPrice: `${Math.round(order.price * 100)}¢`,
              newPrice: `${Math.round(bumpPrice * 100)}¢`,
              totalSlippage: `+${Math.round((bumpPrice - order.originalPrice) * 100)}¢`,
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
                  orderPlacedAt: now,
                  bumpCount: order.bumpCount + 1,
                });
              } else {
                // Bump re-placement failed — release reservation (no replacement order)
                order.onFinalize?.();
              }
            } catch (err) {
              this.logger.warn("Bump order placement failed", { error: (err as Error).message });
              order.bumpCount = this.config.maxBumps; // Don't retry, go to FOK/timeout
            }
            continue;
          }
        }

        // FOK FALLBACK: all bumps exhausted, try FOK for remaining shares
        if (
          this.config.fokFallback &&
          order.bumpCount >= this.config.maxBumps &&
          now - order.orderPlacedAt >= this.config.bumpAfterMs
        ) {
          this.pendingOrders.delete(key);
          order.onFinalize?.();
          await this.clob.cancelOrder(order.orderId);

          // Get final fill count after cancel
          let finalFilled = filled;
          try {
            finalFilled = await this.clob.getFilledShares(order.orderId);
          } catch { /* use stale value */ }

          const remaining = order.size - finalFilled;

          if (remaining > 0 && finalFilled < order.size * 0.95) {
            // Try FOK for the remaining unfilled shares
            // Slippage direction depends on side (BUY = higher, SELL = lower)
            const slip = this.config.maxSlippageCents / 100;
            const worstPrice = order.side === Side.BUY
              ? order.price + slip
              : Math.max(0.01, order.price - slip);
            this.logger.info("FOK fallback for remaining shares", {
              remaining: remaining.toFixed(1),
              filled: finalFilled.toFixed(1),
              worstPrice: `${Math.round(worstPrice * 100)}¢`,
              totalElapsed: `${((now - order.placedAt) / 1000).toFixed(0)}s`,
            });

            try {
              // FOK amount: USD for BUY, shares for SELL
              const fokAmount = order.side === Side.BUY ? remaining * worstPrice : remaining;
              const fokResult = await this.clob.placeMarketOrderFOK({
                tokenId: order.tokenId,
                side: order.side,
                amount: fokAmount,
                worstPrice,
              });

              if (fokResult.filled) {
                this.logger.info("FOK filled remaining shares", {
                  remaining: remaining.toFixed(1),
                  totalShares: order.size.toFixed(1),
                });
                // Count total filled = GTC partial + FOK remainder
                const totalFilled = order.size; // FOK filled the rest
                if (this.onFilledCb) {
                  this.onFilledCb({
                    orderId: order.orderId,
                    trade: order.trade,
                    filledShares: totalFilled,
                    price: order.price,
                    usd: totalFilled * order.price,
                    placedAt: order.placedAt,
                    filledAt: now,
                  });
                }
                continue;
              } else {
                this.logger.warn("FOK fallback failed — no matching orders", {
                  remaining: remaining.toFixed(1),
                });
              }
            } catch (err) {
              this.logger.warn("FOK fallback error", { error: (err as Error).message });
            }
          }

          // FOK failed or not needed — emit unfilled/filled based on what we got
          const unfilled = order.size - finalFilled;
          // Reservation already released via onFinalize; refreshBalance syncs truth from CLOB.

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
          continue;
        }

        // TIMEOUT: final safety net — cancel after fillTimeoutMs regardless
        if (now - order.placedAt >= this.fillTimeoutMs) {
          this.pendingOrders.delete(key);
          order.onFinalize?.();
          await this.clob.cancelOrder(order.orderId);

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

          // Reservation already released via onFinalize; refreshBalance syncs truth from CLOB.

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
  private getMultiplierForLeader(leaderAddress: string): number {
    const t = this.config.targets.find((t) => t.address === leaderAddress.toLowerCase());
    return t ? t.multiplier : this.config.copyMultiplier;
  }

  private calculateCopySize(trade: TargetTrade, priceCents: number): number {
    const targetUsd = trade.usdValue > 0 ? trade.usdValue : trade.shares * priceCents / 100;
    const price = priceCents / 100;
    const multiplier = this.getMultiplierForLeader(trade.leaderAddress);
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
        // Use THIS leader's TOTAL equity (USDC + open positions), not just USDC.
        const leaderCached = this.leaderBalances.get(trade.leaderAddress) ?? 0;
        const leaderEquity = leaderCached > 0 ? leaderCached : this.config.leaderPortfolioUsd;
        // Use our equity for sizing math, but cap by free USDC for actual spending.
        const ourEquity = this.equity > 0 ? this.equity : this.effectiveBalance;
        if (leaderEquity > 0 && targetUsd > 0) {
          const leaderPct = targetUsd / leaderEquity;
          copyUsd = ourEquity * leaderPct * multiplier;
        } else {
          copyUsd = targetUsd * multiplier;
        }
        break;
      }

      default:
        copyUsd = targetUsd;
    }

    copyUsd = Math.min(copyUsd, this.config.maxTradeUsd);
    // Cap by FREE USDC (actual spending capacity) — can't spend locked capital
    copyUsd = Math.min(copyUsd, this.effectiveBalance * 0.9);
    return Math.max(copyUsd, 0);
  }

  // ==================== BALANCE MANAGEMENT ====================

  private async refreshBalance(): Promise<void> {
    const now = Date.now();
    if (now - this.lastBalanceCheck < 10_000 && this.balance > 0) return;
    try {
      // Fetch both: free USDC (for spending) and total equity (for sizing math)
      const [clobBalance, portfolio] = await Promise.all([
        this.clob.getBalance(),
        getPortfolioValue(
          this.config.profileAddress,
          this.config.rpcUrl,
          this.config.dataApiHost,
          this.logger,
        ).catch(() => null),
      ]);
      this.balance = clobBalance; // free USDC = what we can spend
      this.equity = portfolio ? portfolio.total : clobBalance; // total for sizing
      this.lastBalanceCheck = now;
    } catch (err) {
      this.logger.warn("Balance check failed", { error: (err as Error).message });
    }
  }

  /**
   * Fetch leader's USDC balance on-chain from Polygon.
   * Called periodically (every 60s) to keep portfolio-weighted sizing accurate.
   */
  private leaderBalancePromises: Map<string, Promise<void>> = new Map();

  /**
   * Refresh leader balance(s). If `address` is given, only that leader.
   * Otherwise refresh all configured targets.
   */
  async refreshLeaderBalance(address?: string): Promise<void> {
    if (this.config.sizingMode !== "portfolio") return;
    const addrs = address ? [address.toLowerCase()] : this.config.targets.map((t) => t.address);
    await Promise.allSettled(addrs.map((a) => this.refreshOneLeader(a)));
  }

  private async refreshOneLeader(addr: string): Promise<void> {
    const now = Date.now();
    const last = this.lastLeaderBalanceChecks.get(addr) ?? 0;
    const cached = this.leaderBalances.get(addr) ?? 0;
    if (now - last < 60_000 && cached > 0) return;

    // Prevent concurrent fetches per address
    const existing = this.leaderBalancePromises.get(addr);
    if (existing) return existing;
    const p = this._fetchLeaderBalance(addr);
    this.leaderBalancePromises.set(addr, p);
    try { await p; } finally { this.leaderBalancePromises.delete(addr); }
  }

  private async _fetchLeaderBalance(addr: string): Promise<void> {
    const now = Date.now();
    try {
      const portfolio = await getPortfolioValue(
        addr,
        this.config.rpcUrl,
        this.config.dataApiHost,
        this.logger,
      );

      this.leaderBalances.set(addr, portfolio.total);
      this.lastLeaderBalanceChecks.set(addr, now);

      this.logger.info("Leader portfolio updated", {
        target: addr.slice(0, 8) + "...",
        usdc: `$${portfolio.usdc.toFixed(2)}`,
        positions: `$${portfolio.positionValue.toFixed(2)}`,
        total: `$${portfolio.total.toFixed(2)}`,
      });
    } catch (err) {
      this.logger.warn("Failed to fetch leader portfolio", { error: (err as Error).message, target: addr.slice(0, 8) + "..." });
      // Use fallback from config
      if (!this.leaderBalances.get(addr) && this.config.leaderPortfolioUsd > 0) {
        this.leaderBalances.set(addr, this.config.leaderPortfolioUsd);
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
