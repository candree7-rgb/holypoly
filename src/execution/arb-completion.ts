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
 * ArbCompletionMonitor v2: Trailing DCA + Edge Stop-Loss
 *
 * Key improvements over v1:
 * 1. TRAILING DCA: Buy loser in tranches (50/30/20) instead of all-at-once
 *    → Captures better avg price as loser continues dropping
 * 2. EDGE STOP-LOSS: Monitor edge continuously, emergency close if edge evaporates
 *    → Don't wait for full reversal, cut early
 * 3. DYNAMIC TARGET: Trail the target price down as loser drops
 *    → If loser drops to 25¢ and our target was 43¢, buy at 25¢ not 43¢
 * 4. PROFIT LOCK LEVELS: Lock partial profit at different levels
 *    → First tranche locks minimum profit, subsequent tranches are bonus
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
 * DCA tranche configuration:
 * Tranche 1 (50%): Buy at target price → locks minimum profit
 * Tranche 2 (30%): Buy at target - 3¢ → bonus if price drops more
 * Tranche 3 (20%): Buy at target - 6¢ → maximum extraction
 *
 * If price doesn't drop enough for T2/T3, they execute at emergency
 */
const TRANCHE_CONFIG = [
  { pct: 0.50, bonusCents: 0 },   // T1: at target
  { pct: 0.30, bonusCents: 3 },   // T2: 3¢ better than target
  { pct: 0.20, bonusCents: 6 },   // T3: 6¢ better than target
];

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
   * Start monitoring for arb completion with trailing DCA.
   */
  startSeeking(params: {
    winnerSide: TradeSide;
    winnerAvgPriceCents: number;
    winnerShares: number;
    loserTokenId: string;
    window: WindowInfo;
    currentBtcPrice: number;
    timeRemainingSeconds: number;
    onComplete: ArbCompletionCallback;
  }): void {
    const baseTarget = this.arbManager.getLoserTargetPriceCents(params.winnerAvgPriceCents);
    const emergencyPrice = 100 - params.winnerAvgPriceCents + 1; // max 1¢ loss

    // Build DCA tranches
    const tranches: TrancheState[] = TRANCHE_CONFIG.map((tc) => ({
      pct: tc.pct,
      shares: params.winnerShares * tc.pct,
      // Each subsequent tranche has a lower (better) target
      maxPriceCents: Math.max(baseTarget - tc.bonusCents, 5),
      filled: false,
      fillPriceCents: 0,
      orderIds: [],
    }));

    this.state = {
      active: true,
      winnerSide: params.winnerSide,
      winnerAvgPriceCents: params.winnerAvgPriceCents,
      winnerShares: params.winnerShares,
      loserTokenId: params.loserTokenId,
      baseTargetPriceCents: baseTarget,
      emergencyPriceCents: emergencyPrice,
      bestLoserPriceSeen: 999,
      startedAt: Date.now(),
      phase: "trailing",
      tranches,
      totalSharesFilled: 0,
      totalCostUsd: 0,
      allOrderIds: [],
      lastEdgeCheckAt: Date.now(),
      currentBtcPrice: params.currentBtcPrice,
      openingPrice: params.window.openingPrice,
      timeRemainingSeconds: params.timeRemainingSeconds,
    };

    this.onCompleteCallback = params.onComplete;

    const loserSide: TradeSide = params.winnerSide === "Up" ? "Down" : "Up";
    this.logger.info("Arb completion v2 started (trailing DCA)", {
      seeking: loserSide,
      baseTarget: `≤${baseTarget.toFixed(1)}¢`,
      tranches: tranches.map((t, i) => `T${i + 1}: ${(t.pct * 100).toFixed(0)}% @ ≤${t.maxPriceCents.toFixed(1)}¢`),
      emergencyPrice: `≤${emergencyPrice.toFixed(1)}¢`,
      shares: params.winnerShares.toFixed(2),
      timeout: `${this.config.arbCompletionTimeoutMs}ms`,
    });

    this.checkTimer = setInterval(() => this.periodicCheck(), 500);
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
   * React to CLOB WS orderbook updates — check if loser price hit tranche targets.
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

    // Check each unfilled tranche
    for (let i = 0; i < this.state.tranches.length; i++) {
      const tranche = this.state.tranches[i];
      if (tranche.filled) continue;

      // Trailing logic: buy at the ACTUAL price (which may be much better than target)
      // but only trigger when price <= tranche's max price
      if (askCents <= tranche.maxPriceCents) {
        this.logger.info(`Tranche T${i + 1} target hit — filling`, {
          tranche: `T${i + 1} (${(tranche.pct * 100).toFixed(0)}%)`,
          loserAsk: `${askCents.toFixed(1)}¢`,
          target: `≤${tranche.maxPriceCents.toFixed(1)}¢`,
          shares: tranche.shares.toFixed(2),
        });

        // Fill this tranche at current price (may be better than target)
        this.fillTranche(i, askCents).catch((err) => {
          this.logger.error(`Tranche T${i + 1} fill failed`, { error: (err as Error).message });
        });
        break; // one tranche at a time to avoid race conditions
      }
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

    // === TIMEOUT: Force emergency fill for remaining tranches ===
    if (elapsed > this.config.arbCompletionTimeoutMs && this.state.phase === "trailing") {
      this.logger.warn("Arb completion timeout — emergency fill remaining tranches", {
        elapsed: `${(elapsed / 1000).toFixed(1)}s`,
        unfilledTranches: unfilled.length,
        filledTranches: this.state.tranches.filter((t) => t.filled).length,
      });
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
    const pnlPerPair = 100 - totalCost;

    this.logger.info("EMERGENCY FILL remaining tranches", {
      side: loserSide,
      price: `${askCents.toFixed(1)}¢`,
      shares: remainingShares.toFixed(2),
      totalCost: `${totalCost.toFixed(1)}¢/pair`,
      pnlPerPair: `${pnlPerPair >= 0 ? "+" : ""}${pnlPerPair.toFixed(1)}¢`,
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
