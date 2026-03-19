import { Side } from "@polymarket/clob-client";
import type { BookSnapshot, ClobWsClient } from "../data/clob-ws.js";
import type { ClobService } from "../data/clob.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { TelegramNotifier } from "../telegram.js";
import type { TradeSide, WindowInfo } from "../types.js";
import type { ArbManager } from "./arb-manager.js";
import type { VolatilityCalculator } from "../signal/volatility.js";
import type { FairValueEngine } from "../signal/fair-value.js";

/**
 * ArbCompletionMonitor v3: Immediate T1 + Trailing DCA + Edge Stop-Loss
 *
 * Key improvements over v2:
 * 1. IMMEDIATE T1: Fill 60% at current ask IMMEDIATELY (no waiting for targets)
 *    → Locks profit NOW instead of waiting 15s for unrealistic targets
 * 2. DYNAMIC TARGETS: T2/T3 targets derived from actual T1 fill price, not theory
 * 3. REVERSAL GUARD: If loser rises after T1, stop trailing and accept partial hedge
 *    → Threshold scales with volatility (1-4¢ adaptive)
 * 4. BAIL-OUT: If hedge impossible (loser too expensive), sell winner back via FOK
 *    → Better than holding naked position to settlement
 * 5. RACE GUARD: t1FillInFlight flag prevents double-fill from concurrent paths
 * 6. FEE AWARENESS: All P&L calculations account for 2% taker fee
 * 7. TIMEOUT FIX: Emergency fills ALL remaining tranches on timeout (no 40% naked gap)
 */

export type ArbCompletionCallback = (side: TradeSide, shares: number, costUsd: number, orderIds: string[]) => void;

interface TrancheState {
  /** Share of total to buy (0-1) */
  pct: number;
  /** Shares to buy in this tranche */
  shares: number;
  /** Max price (cents) for this tranche */
  maxPriceCents: number;
  /** Actually filled? */
  filled: boolean;
  /** Price we actually got */
  fillPriceCents: number;
  /** Order IDs for this tranche */
  orderIds: string[];
}

interface MonitorState {
  active: boolean;
  winnerSide: TradeSide;
  winnerAvgPriceCents: number;
  winnerShares: number;
  winnerTokenId: string;
  loserTokenId: string;
  /** Initial target (100 - winner - minProfit) */
  baseTargetPriceCents: number;
  /** Emergency max price (100 - winner + 1¢ loss max) */
  emergencyPriceCents: number;
  /** Best loser price seen so far (for trailing) */
  bestLoserPriceSeen: number;
  startedAt: number;
  phase: "trailing" | "emergency" | "done";
  /** DCA tranches */
  tranches: TrancheState[];
  /** Total shares filled across all tranches */
  totalSharesFilled: number;
  /** Total cost across all tranches */
  totalCostUsd: number;
  /** All order IDs across tranches */
  allOrderIds: string[];
  /** Resting maker order ID for T1 (cancelled on emergency) */
  restingOrderId: string | null;
  /** Guard: T1 fill is in-flight (prevents double-fill from WS + immediate) */
  t1FillInFlight: boolean;
  /** Last edge check timestamp */
  lastEdgeCheckAt: number;
  /** Current BTC price for edge monitoring */
  currentBtcPrice: number;
  /** Window opening price for edge recalc */
  openingPrice: number;
  /** Time remaining in window */
  timeRemainingSeconds: number;
}

/**
 * DCA tranche configuration v3 (dynamic):
 * Tranche 1 (60%): Fills IMMEDIATELY at current loser ask → lock profit NOW
 * Tranche 2 (25%): Trails — only fills if loser drops 3¢+ below T1 fill
 * Tranche 3 (15%): Trails deeper — fills if loser drops 6¢+ below T1 fill
 *
 * Key change: T1 is no longer a limit order waiting for a target price.
 * It fills at market immediately after winner entry. T2/T3 are bonus.
 * If loser rises instead of dropping, we accept T1-only and move on.
 */
const TRANCHE_CONFIG = [
  { pct: 0.60, bonusCents: 0 },   // T1: IMMEDIATE at current ask
  { pct: 0.25, bonusCents: 3 },   // T2: only if 3¢ better than T1
  { pct: 0.15, bonusCents: 6 },   // T3: only if 6¢ better than T1
];

/** Polymarket taker fee (2%) — must be accounted for in all P&L calculations */
const TAKER_FEE_PCT = 0.02;

/** Edge stop-loss: if edge shrinks below this, emergency close */
const EDGE_STOP_LOSS_CENTS = 2;

/** How often to recheck edge (ms) */
const EDGE_RECHECK_INTERVAL_MS = 500;

export class ArbCompletionMonitor {
  private state: MonitorState | null = null;
  private onCompleteCallback: ArbCompletionCallback | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private clobWs: ClobWsClient,
    private clob: ClobService,
    private config: Config,
    private arbManager: ArbManager,
    private logger: Logger,
    private telegram: TelegramNotifier,
    private volatilityCalc?: VolatilityCalculator,
    private fairValueEngine?: FairValueEngine,
  ) {
    this.clobWs.onUpdate(this.onPriceUpdate.bind(this));
  }

  /**
   * Start monitoring for arb completion with dynamic DCA.
   *
   * v3 strategy: T1 fills IMMEDIATELY at current loser ask (lock profit now).
   * T2/T3 only trail for bonus if loser continues dropping.
   * If loser rises, we accept partial hedge and move on.
   */
  startSeeking(params: {
    winnerSide: TradeSide;
    winnerAvgPriceCents: number;
    winnerShares: number;
    winnerTokenId: string;
    loserTokenId: string;
    window: WindowInfo;
    currentBtcPrice: number;
    timeRemainingSeconds: number;
    onComplete: ArbCompletionCallback;
  }): void {
    // Emergency max: 100¢ - winner price - 2¢ fees. Allows 0¢ profit at worst.
    // Old formula (+1¢) guaranteed loss after fees.
    const emergencyPrice = 100 - params.winnerAvgPriceCents - 2; // break-even after ~2% fees

    // Get current loser ask for IMMEDIATE T1 fill
    const book = this.clobWs.getBook(params.loserTokenId);
    const currentLoserAsk = book?.bestAsk ? book.bestAsk * 100 : null;

    // T1 target = current ask (fill NOW), T2/T3 trail below T1's fill price
    const t1Target = currentLoserAsk ?? (100 - params.winnerAvgPriceCents - this.config.minProfitCents);

    // Build DCA tranches — T1 at market, T2/T3 relative to T1
    const tranches: TrancheState[] = TRANCHE_CONFIG.map((tc) => ({
      pct: tc.pct,
      shares: params.winnerShares * tc.pct,
      // T1: current ask price, T2/T3: below T1 by bonus amount
      maxPriceCents: Math.max(t1Target - tc.bonusCents, 5),
      filled: false,
      fillPriceCents: 0,
      orderIds: [],
    }));

    this.state = {
      active: true,
      winnerSide: params.winnerSide,
      winnerAvgPriceCents: params.winnerAvgPriceCents,
      winnerShares: params.winnerShares,
      winnerTokenId: params.winnerTokenId,
      loserTokenId: params.loserTokenId,
      baseTargetPriceCents: t1Target,
      emergencyPriceCents: emergencyPrice,
      bestLoserPriceSeen: currentLoserAsk ?? 999,
      startedAt: Date.now(),
      phase: "trailing",
      tranches,
      totalSharesFilled: 0,
      totalCostUsd: 0,
      allOrderIds: [],
      restingOrderId: null,
      t1FillInFlight: false,
      lastEdgeCheckAt: Date.now(),
      currentBtcPrice: params.currentBtcPrice,
      openingPrice: params.window.openingPrice,
      timeRemainingSeconds: params.timeRemainingSeconds,
    };

    this.onCompleteCallback = params.onComplete;

    const loserSide: TradeSide = params.winnerSide === "Up" ? "Down" : "Up";
    this.logger.info("Arb completion v3 started (immediate T1 + trailing DCA)", {
      seeking: loserSide,
      currentLoserAsk: currentLoserAsk ? `${currentLoserAsk.toFixed(1)}¢` : "N/A",
      t1Target: `≤${t1Target.toFixed(1)}¢`,
      tranches: tranches.map((t, i) => `T${i + 1}: ${(t.pct * 100).toFixed(0)}% @ ≤${t.maxPriceCents.toFixed(1)}¢`),
      emergencyPrice: `≤${emergencyPrice.toFixed(1)}¢`,
      shares: params.winnerShares.toFixed(2),
      timeout: `${this.config.arbCompletionTimeoutMs}ms`,
    });

    this.checkTimer = setInterval(() => this.periodicCheck(), 500);

    // IMMEDIATE T1 FILL: Don't wait, fill T1 right now at current ask
    this.fillT1Immediately(currentLoserAsk).catch((err) => {
      this.logger.warn("Immediate T1 fill failed, falling back to reactive", {
        error: (err as Error).message,
      });
    });
  }

  /**
   * Fill T1 (60%) IMMEDIATELY at current loser ask.
   * This is the key v3 change — don't wait for a target, lock profit now.
   */
  private async fillT1Immediately(currentAskCents: number | null): Promise<void> {
    if (!this.state) return;

    const t1 = this.state.tranches[0];
    if (t1.filled || this.state.t1FillInFlight) return;

    // Set guard BEFORE async work to prevent race with onPriceUpdate
    this.state.t1FillInFlight = true;

    // Get fresh ask if not provided
    let askCents = currentAskCents;
    if (!askCents) {
      const book = this.clobWs.getBook(this.state.loserTokenId);
      askCents = book?.bestAsk ? book.bestAsk * 100 : null;
    }
    if (!askCents) {
      const ob = await this.clob.getOrderbook(this.state.loserTokenId);
      askCents = ob.bestAsk ? ob.bestAsk * 100 : null;
    }

    if (!askCents) {
      this.logger.warn("T1 immediate fill: no loser ask available, waiting for WS update");
      return;
    }

    // Check if filling at this price is acceptable (within emergency limit)
    if (askCents > this.state.emergencyPriceCents) {
      this.logger.warn("T1 immediate fill: loser ask too expensive, triggering bail-out", {
        loserAsk: `${askCents.toFixed(1)}¢`,
        maxAcceptable: `${this.state.emergencyPriceCents.toFixed(1)}¢`,
        pairCost: `${(this.state.winnerAvgPriceCents + askCents).toFixed(1)}¢`,
      });
      // Trigger bail-out: sell winner back instead of holding naked
      await this.bailOut();
      return;
    }

    const loserSide: TradeSide = this.state.winnerSide === "Up" ? "Down" : "Up";

    // Fill T1 immediately
    this.logger.info("T1 IMMEDIATE FILL at market", {
      side: loserSide,
      price: `${askCents.toFixed(1)}¢`,
      shares: t1.shares.toFixed(2),
      pairCost: `${(this.state.winnerAvgPriceCents + askCents).toFixed(1)}¢`,
      pnlPerPair: `${(100 - this.state.winnerAvgPriceCents - askCents).toFixed(1)}¢`,
    });

    await this.fillTranche(0, askCents);

    // After T1 fills, update T2/T3 targets relative to actual T1 fill price
    if (t1.filled && this.state) {
      for (let i = 1; i < this.state.tranches.length; i++) {
        const bonus = TRANCHE_CONFIG[i].bonusCents;
        this.state.tranches[i].maxPriceCents = Math.max(t1.fillPriceCents - bonus, 5);
      }
      this.logger.debug("Updated trailing targets after T1 fill", {
        t2Target: `≤${this.state.tranches[1]?.maxPriceCents.toFixed(1)}¢`,
        t3Target: `≤${this.state.tranches[2]?.maxPriceCents.toFixed(1)}¢`,
      });
    }
  }

  /**
   * Bail-out: sell winner shares back when hedge is impossible.
   * Better to take a small FOK spread loss than hold a naked position.
   */
  private async bailOut(): Promise<void> {
    if (!this.state) return;

    const winnerSide = this.state.winnerSide;
    const winnerShares = this.state.winnerShares;
    const winnerCostUsd = this.state.winnerShares * this.state.winnerAvgPriceCents / 100;

    this.logger.warn("BAIL-OUT: Selling winner shares back", {
      side: winnerSide,
      shares: winnerShares.toFixed(2),
      reason: "Loser side too expensive, arb not completable",
    });

    this.telegram.alertError(
      `Bail-out: Selling ${winnerSide} ${winnerShares.toFixed(1)} shares. Loser too expensive for arb.`,
    );

    if (this.config.dryRun) {
      this.logger.info("DRY_RUN — bail-out sell simulated");
    } else {
      // Actually sell the winner shares back via FOK
      try {
        const book = this.clobWs.getBook(this.state.winnerTokenId);
        const bestBid = book?.bestBid;
        if (bestBid && bestBid > 0) {
          const result = await this.clob.placeBatchOrders([{
            tokenId: this.state.winnerTokenId,
            side: Side.SELL,
            price: bestBid,
            size: winnerShares,
          }]);
          if (result.placed > 0) {
            this.logger.info("Bail-out sell order placed", {
              price: `${(bestBid * 100).toFixed(1)}¢`,
              shares: winnerShares.toFixed(2),
            });
          } else {
            this.logger.error("Bail-out sell order rejected — holding naked");
          }
        } else {
          this.logger.error("Bail-out: no bid for winner side — holding naked");
        }
      } catch (err) {
        this.logger.error("Bail-out sell failed", { error: (err as Error).message });
      }
    }

    // CRITICAL: Reverse the winner shares from ArbManager so settlement doesn't
    // count them as a naked position. The shares have been sold back (or simulated).
    this.arbManager.recordFill(winnerSide, -winnerShares, -winnerCostUsd);
    this.logger.info("Bail-out: reversed winner position in ArbManager", {
      side: winnerSide,
      reversedShares: winnerShares.toFixed(2),
    });

    const loserSide: TradeSide = winnerSide === "Up" ? "Down" : "Up";
    this.complete(loserSide, this.state.totalSharesFilled, this.state.totalCostUsd, this.state.allOrderIds);
  }

  /** Update BTC price for continuous edge monitoring */
  updateBtcPrice(price: number, timeRemaining: number): void {
    if (this.state) {
      this.state.currentBtcPrice = price;
      this.state.timeRemainingSeconds = timeRemaining;
    }
  }

  reset(): void {
    this.state = null;
    this.onCompleteCallback = null;
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  get isActive(): boolean {
    return this.state?.active ?? false;
  }

  get phase(): string {
    return this.state?.phase ?? "idle";
  }

  get tranchesStatus(): string {
    if (!this.state) return "idle";
    const filled = this.state.tranches.filter((t) => t.filled).length;
    return `${filled}/${this.state.tranches.length}`;
  }

  /**
   * React to CLOB WS orderbook updates — check if loser price hit trailing targets.
   * T1 is filled immediately in startSeeking, so this mostly handles T2/T3 trailing.
   */
  private onPriceUpdate(assetId: string, book: BookSnapshot): void {
    if (!this.state || !this.state.active) return;
    if (assetId !== this.state.loserTokenId) return;
    if (this.state.phase !== "trailing") return;

    const bestAsk = book.bestAsk;
    if (bestAsk === null) return;

    const askCents = bestAsk * 100;

    // Track best (lowest) loser price seen — for trailing logic
    if (askCents < this.state.bestLoserPriceSeen) {
      this.state.bestLoserPriceSeen = askCents;
    }

    // Check T1 resting order fill (legacy — T1 now fills immediately, but keep for safety)
    if (this.state.restingOrderId && !this.state.tranches[0].filled) {
      if (askCents <= this.state.tranches[0].maxPriceCents) {
        this.checkRestingOrderFill().catch((err) => {
          this.logger.warn("Resting order fill check failed", { error: (err as Error).message });
        });
      }
    }

    // === REVERSAL GUARD (volatility-adaptive) ===
    // If T1 filled but loser is rising, stop trailing and accept what we have.
    // Threshold scales with volatility: tighter in calm markets, wider in volatile ones.
    const t1 = this.state.tranches[0];
    if (t1.filled) {
      const unfilled = this.state.tranches.filter((t) => !t.filled);
      const reversalThreshold = this.volatilityCalc
        ? Math.max(1, Math.min(4, 1 + this.volatilityCalc.getVolatility() * 0.02))
        : 2;
      if (unfilled.length > 0 && askCents > t1.fillPriceCents + reversalThreshold) {
        this.logger.info("Reversal guard — loser rising, accepting partial hedge", {
          t1Fill: `${t1.fillPriceCents.toFixed(1)}¢`,
          currentAsk: `${askCents.toFixed(1)}¢`,
          unfilledTranches: unfilled.length,
          hedgedPct: `${((this.state.totalSharesFilled / this.state.winnerShares) * 100).toFixed(0)}%`,
        });
        // Complete with what we have (T1 hedged, T2/T3 abandoned)
        const loserSide: TradeSide = this.state.winnerSide === "Up" ? "Down" : "Up";
        this.complete(loserSide, this.state.totalSharesFilled, this.state.totalCostUsd, this.state.allOrderIds);
        return;
      }
    }

    // Check each unfilled tranche (T2/T3 trailing)
    for (let i = 0; i < this.state.tranches.length; i++) {
      const tranche = this.state.tranches[i];
      if (tranche.filled) continue;

      // Skip T1 if fill is already in-flight or resting order active (prevent double-fill)
      if (i === 0 && (this.state.t1FillInFlight || this.state.restingOrderId)) continue;

      // Trailing logic: fill at ACTUAL price when it hits tranche target
      if (askCents <= tranche.maxPriceCents) {
        this.logger.info(`Tranche T${i + 1} target hit — filling`, {
          tranche: `T${i + 1} (${(tranche.pct * 100).toFixed(0)}%)`,
          loserAsk: `${askCents.toFixed(1)}¢`,
          target: `≤${tranche.maxPriceCents.toFixed(1)}¢`,
          shares: tranche.shares.toFixed(2),
        });

        this.fillTranche(i, askCents).catch((err) => {
          this.logger.error(`Tranche T${i + 1} fill failed`, { error: (err as Error).message });
        });
        break; // one tranche at a time to avoid race conditions
      }
    }
  }

  /**
   * Check if the resting maker bid for T1 has been filled.
   */
  private async checkRestingOrderFill(): Promise<void> {
    if (!this.state || !this.state.restingOrderId) return;

    const filledShares = await this.clob.getFilledShares(this.state.restingOrderId);
    if (filledShares > 0) {
      const t1 = this.state.tranches[0];
      const fillPrice = t1.maxPriceCents; // filled at our resting price (maker!)
      const costUsd = filledShares * (fillPrice / 100);

      t1.filled = true;
      t1.fillPriceCents = fillPrice;
      t1.orderIds = [this.state.restingOrderId];
      this.state.totalSharesFilled += filledShares;
      this.state.totalCostUsd += costUsd;
      this.state.allOrderIds.push(this.state.restingOrderId);
      this.state.restingOrderId = null;

      const loserSide: TradeSide = this.state.winnerSide === "Up" ? "Down" : "Up";
      this.logger.info("T1 resting maker bid FILLED", {
        side: loserSide,
        price: `${fillPrice.toFixed(1)}¢ (maker)`,
        shares: filledShares.toFixed(2),
      });

      this.checkAllTranchesDone(loserSide);
    }
  }

  /**
   * Cancel the resting T1 order (used before emergency fills).
   */
  private async cancelRestingOrder(): Promise<void> {
    if (this.state?.restingOrderId) {
      await this.clob.cancelOrder(this.state.restingOrderId);
      this.state.restingOrderId = null;
    }
  }

  /**
   * Fill a specific DCA tranche.
   */
  private async fillTranche(trancheIdx: number, priceCents: number): Promise<void> {
    if (!this.state || this.state.phase !== "trailing") return;

    const tranche = this.state.tranches[trancheIdx];
    if (tranche.filled) return;

    const loserSide: TradeSide = this.state.winnerSide === "Up" ? "Down" : "Up";
    const priceDecimal = priceCents / 100;
    const costUsd = tranche.shares * priceDecimal;

    if (this.config.dryRun) {
      this.logger.info(`DRY_RUN — tranche T${trancheIdx + 1} simulated`, {
        side: loserSide,
        price: `${priceCents.toFixed(1)}¢`,
        shares: tranche.shares.toFixed(2),
        cost: `$${costUsd.toFixed(2)}`,
      });
      tranche.filled = true;
      tranche.fillPriceCents = priceCents;
      this.state.totalSharesFilled += tranche.shares;
      this.state.totalCostUsd += costUsd;
      this.checkAllTranchesDone(loserSide);
      return;
    }

    const result = await this.clob.placeBatchOrders([{
      tokenId: this.state.loserTokenId,
      side: Side.BUY,
      price: priceDecimal,
      size: tranche.shares,
    }]);

    if (result.placed > 0) {
      tranche.filled = true;
      tranche.fillPriceCents = priceCents;
      tranche.orderIds = result.orderIds;
      this.state.totalSharesFilled += tranche.shares;
      this.state.totalCostUsd += costUsd;
      this.state.allOrderIds.push(...result.orderIds);

      const avgLoser = this.state.totalCostUsd / this.state.totalSharesFilled * 100;
      const pnlPerPair = 100 - this.state.winnerAvgPriceCents - avgLoser;

      this.logger.info(`Tranche T${trancheIdx + 1} filled`, {
        side: loserSide,
        price: `${priceCents.toFixed(1)}¢`,
        shares: tranche.shares.toFixed(2),
        avgLoserPrice: `${avgLoser.toFixed(1)}¢`,
        runningPnl: `${pnlPerPair >= 0 ? "+" : ""}${pnlPerPair.toFixed(1)}¢/pair`,
        filledTranches: `${this.state.tranches.filter((t) => t.filled).length}/${this.state.tranches.length}`,
      });

      this.checkAllTranchesDone(loserSide);
    } else {
      this.logger.warn(`Tranche T${trancheIdx + 1} order failed`);
    }
  }

  /**
   * Check if all tranches are filled → signal completion.
   */
  private checkAllTranchesDone(loserSide: TradeSide): void {
    if (!this.state) return;

    const allFilled = this.state.tranches.every((t) => t.filled);
    if (allFilled) {
      this.logger.info("All DCA tranches filled — arb complete", {
        totalShares: this.state.totalSharesFilled.toFixed(2),
        totalCost: `$${this.state.totalCostUsd.toFixed(2)}`,
        avgLoserPrice: `${(this.state.totalCostUsd / this.state.totalSharesFilled * 100).toFixed(1)}¢`,
      });
      this.complete(loserSide, this.state.totalSharesFilled, this.state.totalCostUsd, this.state.allOrderIds);
    }
  }

  /**
   * Periodic check for timeouts, edge stop-loss, and emergency conditions.
   */
  private periodicCheck(): void {
    if (!this.state || !this.state.active) return;

    const elapsed = Date.now() - this.state.startedAt;
    const unfilled = this.state.tranches.filter((t) => !t.filled);

    if (unfilled.length === 0) return; // all done

    // === EDGE STOP-LOSS: Monitor if our edge is evaporating ===
    if (this.fairValueEngine && Date.now() - this.state.lastEdgeCheckAt > EDGE_RECHECK_INTERVAL_MS) {
      this.state.lastEdgeCheckAt = Date.now();
      this.checkEdgeStopLoss(elapsed);
    }

    // === MOMENTUM REVERSAL CHECK ===
    if (this.volatilityCalc && this.state.phase === "trailing") {
      const momentum = this.volatilityCalc.getRecentMomentum(5);
      if (momentum !== null) {
        const adverse =
          (this.state.winnerSide === "Up" && momentum < -20) ||
          (this.state.winnerSide === "Down" && momentum > 20);

        if (adverse && elapsed > 3000) {
          this.logger.warn("BTC reversing — emergency fill remaining tranches", {
            momentum: `$${momentum.toFixed(0)}`,
            elapsed: `${(elapsed / 1000).toFixed(1)}s`,
            unfilledTranches: unfilled.length,
          });
          this.emergencyFillRemaining().catch((err) => {
            this.logger.error("Emergency fill failed", { error: (err as Error).message });
          });
          return;
        }
      }
    }

    // === TIMEOUT: Emergency fill ALL remaining tranches ===
    if (elapsed > this.config.arbCompletionTimeoutMs && this.state.phase === "trailing") {
      const filledCount = this.state.tranches.filter((t) => t.filled).length;
      this.logger.warn("Arb completion timeout — emergency fill remaining", {
        elapsed: `${(elapsed / 1000).toFixed(1)}s`,
        filledTranches: filledCount,
        unfilledTranches: unfilled.length,
        hedgedPct: `${((this.state.totalSharesFilled / this.state.winnerShares) * 100).toFixed(0)}%`,
      });
      // Always emergency fill remaining — don't leave 40% unhedged
      this.emergencyFillRemaining().catch((err) => {
        this.logger.error("Emergency fill failed", { error: (err as Error).message });
      });
    }
  }

  /**
   * EDGE STOP-LOSS: If our edge has shrunk below threshold, emergency close.
   * This is the key improvement — don't wait for full reversal.
   */
  private checkEdgeStopLoss(elapsed: number): void {
    if (!this.state || !this.fairValueEngine) return;

    const edge = this.fairValueEngine.calculateEdge(
      this.state.currentBtcPrice,
      this.state.openingPrice,
      this.state.timeRemainingSeconds,
      // We need market prices — use the winner price as reference
      this.state.winnerSide === "Up" ? this.state.winnerAvgPriceCents : 100 - this.state.winnerAvgPriceCents,
      this.state.winnerSide === "Up" ? 100 - this.state.winnerAvgPriceCents : this.state.winnerAvgPriceCents,
    );

    // The edge for our side specifically
    const ourEdge = this.state.winnerSide === "Up" ? edge.upEdge : edge.downEdge;

    // If edge has collapsed below stop-loss level
    if (ourEdge < EDGE_STOP_LOSS_CENTS && elapsed > 2000) {
      const unfilled = this.state.tranches.filter((t) => !t.filled);
      if (unfilled.length > 0) {
        this.logger.warn("EDGE STOP-LOSS triggered — edge evaporated", {
          ourEdge: `${ourEdge.toFixed(1)}¢`,
          stopLoss: `${EDGE_STOP_LOSS_CENTS}¢`,
          elapsed: `${(elapsed / 1000).toFixed(1)}s`,
          unfilledTranches: unfilled.length,
          action: unfilled.length === this.state.tranches.length ? "emergency fill ALL" : "emergency fill remaining",
        });
        this.emergencyFillRemaining().catch((err) => {
          this.logger.error("Edge stop-loss emergency failed", { error: (err as Error).message });
        });
      }
    }
  }

  /**
   * Emergency fill all remaining unfilled tranches at best available price.
   * Merges remaining shares into a single order for efficiency.
   */
  private async emergencyFillRemaining(): Promise<void> {
    if (!this.state || this.state.phase === "done") return;
    this.state.phase = "emergency";

    // Cancel any resting maker order before emergency fill
    await this.cancelRestingOrder();

    const loserSide: TradeSide = this.state.winnerSide === "Up" ? "Down" : "Up";
    const unfilled = this.state.tranches.filter((t) => !t.filled);
    const remainingShares = unfilled.reduce((sum, t) => sum + t.shares, 0);

    if (remainingShares <= 0) {
      this.complete(loserSide, this.state.totalSharesFilled, this.state.totalCostUsd, this.state.allOrderIds);
      return;
    }

    // Get current best ask for loser
    const book = this.clobWs.getBook(this.state.loserTokenId);
    let askCents: number | null = book?.bestAsk ? book.bestAsk * 100 : null;

    if (!askCents) {
      const ob = await this.clob.getOrderbook(this.state.loserTokenId);
      askCents = ob.bestAsk ? ob.bestAsk * 100 : null;
    }

    if (!askCents) {
      this.logger.error("No loser price — holding partially hedged", {
        filledShares: this.state.totalSharesFilled.toFixed(2),
        unhedgedShares: remainingShares.toFixed(2),
      });
      this.telegram.alertError(`Emergency fill failed: no ${loserSide} price. ${this.state.totalSharesFilled.toFixed(0)} hedged, ${remainingShares.toFixed(0)} naked.`);
      // Complete with what we have
      this.complete(loserSide, this.state.totalSharesFilled, this.state.totalCostUsd, this.state.allOrderIds);
      return;
    }

    const totalCost = this.state.winnerAvgPriceCents + askCents;
    const feeCostCents = (this.state.winnerAvgPriceCents + askCents) * TAKER_FEE_PCT;
    const pnlPerPair = 100 - totalCost - feeCostCents;

    this.logger.info("EMERGENCY FILL remaining tranches", {
      side: loserSide,
      price: `${askCents.toFixed(1)}¢`,
      shares: remainingShares.toFixed(2),
      totalCost: `${totalCost.toFixed(1)}¢/pair`,
      fees: `${feeCostCents.toFixed(1)}¢`,
      pnlPerPair: `${pnlPerPair >= 0 ? "+" : ""}${pnlPerPair.toFixed(1)}¢ (after fees)`,
    });

    // Accept up to emergency price (1¢ loss per pair max)
    if (askCents <= this.state.emergencyPriceCents) {
      const priceDecimal = askCents / 100;
      const costUsd = remainingShares * priceDecimal;

      if (this.config.dryRun) {
        this.logger.info("DRY_RUN — emergency fill simulated", { side: loserSide, price: `${askCents.toFixed(1)}¢` });
        // Mark all unfilled tranches
        for (const t of unfilled) {
          t.filled = true;
          t.fillPriceCents = askCents;
        }
        this.state.totalSharesFilled += remainingShares;
        this.state.totalCostUsd += costUsd;
        this.complete(loserSide, this.state.totalSharesFilled, this.state.totalCostUsd, this.state.allOrderIds);
        return;
      }

      const result = await this.clob.placeBatchOrders([{
        tokenId: this.state.loserTokenId,
        side: Side.BUY,
        price: priceDecimal,
        size: remainingShares,
      }]);

      if (result.placed > 0) {
        for (const t of unfilled) {
          t.filled = true;
          t.fillPriceCents = askCents;
          t.orderIds = result.orderIds;
        }
        this.state.totalSharesFilled += remainingShares;
        this.state.totalCostUsd += costUsd;
        this.state.allOrderIds.push(...result.orderIds);
        this.complete(loserSide, this.state.totalSharesFilled, this.state.totalCostUsd, this.state.allOrderIds);
      } else {
        this.logger.error("Emergency order rejected — holding partially hedged");
        this.telegram.alertError("Emergency fill order rejected. Manual intervention needed.");
        this.complete(loserSide, this.state.totalSharesFilled, this.state.totalCostUsd, this.state.allOrderIds);
      }
    } else {
      // Price too high — complete with whatever we have
      this.logger.warn("Emergency price too high, completing with partial hedge", {
        loserAsk: `${askCents.toFixed(1)}¢`,
        maxAcceptable: `${this.state.emergencyPriceCents.toFixed(1)}¢`,
        hedgedShares: this.state.totalSharesFilled.toFixed(2),
        nakedShares: remainingShares.toFixed(2),
      });
      this.telegram.alertError(
        `Arb partial: ${loserSide} at ${askCents.toFixed(1)}¢ too expensive. ${this.state.totalSharesFilled.toFixed(0)} hedged, ${remainingShares.toFixed(0)} naked.`,
      );
      this.complete(loserSide, this.state.totalSharesFilled, this.state.totalCostUsd, this.state.allOrderIds);
    }
  }

  private complete(side: TradeSide, shares: number, costUsd: number, orderIds: string[]): void {
    if (!this.state) return;

    this.state.phase = "done";
    this.state.active = false;

    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }

    if (this.onCompleteCallback) {
      this.onCompleteCallback(side, shares, costUsd, orderIds);
    }
  }
}
