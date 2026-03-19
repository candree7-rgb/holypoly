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
 * ArbCompletionMonitor v5: SIMPLE & FAST
 *
 * Strategy:
 * 1. Winner bought → IMMEDIATELY try to fill loser at ANY profitable price
 * 2. React to WS orderbook updates (event-driven, no polling)
 * 3. Safety timer every 2s as fallback (in case WS update missed)
 * 4. After 5s → bail out (sell winner back)
 *
 * NO tranches. NO trailing. NO DCA. Just fill or bail.
 */

export type ArbCompletionCallback = (side: TradeSide, shares: number, costUsd: number, orderIds: string[]) => void;

/** Safety fallback interval — WS is primary, this is just a backup (ms) */
const SAFETY_CHECK_INTERVAL_MS = 2000;

/** Phase 1: Fill if pair cost < 98¢ (guaranteed profit even after max fees) */
const PHASE1_MAX_PAIR_CENTS = 98;

/** Phase 2: Accept pair ≤ 100¢ (break-even — settlement pays 100¢, fees are small at extreme prices) */
const PHASE2_AFTER_MS = 5000;
const PHASE2_MAX_PAIR_CENTS = 100;

/** Phase 3: After this many ms, bail out entirely */
const BAILOUT_AFTER_MS = 15000;

interface HedgeState {
  active: boolean;
  winnerSide: TradeSide;
  winnerAvgPriceCents: number;
  winnerShares: number;
  winnerTokenId: string;
  loserTokenId: string;
  startedAt: number;
  filled: boolean;
  fillInFlight: boolean;
  totalSharesFilled: number;
  totalCostUsd: number;
  allOrderIds: string[];
  /** Best (lowest) loser ask seen during monitoring */
  bestLoserAskSeen: number;
  /** Initial loser ask when monitoring started */
  initialLoserAsk: number | null;
  /** BTC price for edge monitoring */
  currentBtcPrice: number;
  openingPrice: number;
  timeRemainingSeconds: number;
}

export class ArbCompletionMonitor {
  private state: HedgeState | null = null;
  private onCompleteCallback: ArbCompletionCallback | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

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
    // Also react to WS price updates for faster detection
    this.clobWs.onUpdate(this.onPriceUpdate.bind(this));
  }

  /**
   * Start seeking loser side. Simple 3-phase approach:
   * Phase 1 (0-3s): Fill if pair cost < 98¢ (profitable after fees)
   * Phase 2 (3-5s): Fill if pair cost ≤ 100¢ (break-even OK)
   * Phase 3 (5s+):  Bail out — sell winner back
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
    const loserSide: TradeSide = params.winnerSide === "Up" ? "Down" : "Up";

    // Get current loser ask for initial log
    const book = this.clobWs.getBook(params.loserTokenId);
    const currentLoserAsk = book?.bestAsk ? book.bestAsk * 100 : null;
    const pairCost = currentLoserAsk ? params.winnerAvgPriceCents + currentLoserAsk : null;

    this.state = {
      active: true,
      winnerSide: params.winnerSide,
      winnerAvgPriceCents: params.winnerAvgPriceCents,
      winnerShares: params.winnerShares,
      winnerTokenId: params.winnerTokenId,
      loserTokenId: params.loserTokenId,
      startedAt: Date.now(),
      filled: false,
      fillInFlight: false,
      totalSharesFilled: 0,
      totalCostUsd: 0,
      allOrderIds: [],
      bestLoserAskSeen: currentLoserAsk ?? 999,
      initialLoserAsk: currentLoserAsk,
      currentBtcPrice: params.currentBtcPrice,
      openingPrice: params.window.openingPrice,
      timeRemainingSeconds: params.timeRemainingSeconds,
    };

    this.onCompleteCallback = params.onComplete;

    this.logger.info("Arb completion v5 — seeking loser (SIMPLE MODE)", {
      seeking: loserSide,
      winnerPrice: `${params.winnerAvgPriceCents.toFixed(1)}¢`,
      currentLoserAsk: currentLoserAsk ? `${currentLoserAsk.toFixed(1)}¢` : "N/A",
      pairCost: pairCost ? `${pairCost.toFixed(1)}¢` : "N/A",
      profitableAt: `≤${(PHASE1_MAX_PAIR_CENTS - params.winnerAvgPriceCents).toFixed(1)}¢`,
      breakEvenAt: `≤${(PHASE2_MAX_PAIR_CENTS - params.winnerAvgPriceCents).toFixed(1)}¢`,
      phases: `0-5s: fill<98¢ | 5-15s: fill≤100¢ | 15s+: bail`,
    });

    // WS-driven: onPriceUpdate fires on every orderbook change (primary path)
    // Safety fallback timer in case WS misses an update
    this.pollTimer = setInterval(() => this.checkAndFill(), SAFETY_CHECK_INTERVAL_MS);

    // Try immediately with current book data
    this.checkAndFill();
  }

  /** Update BTC price for monitoring */
  updateBtcPrice(price: number, timeRemaining: number): void {
    if (this.state) {
      this.state.currentBtcPrice = price;
      this.state.timeRemainingSeconds = timeRemaining;
    }
  }

  reset(): void {
    this.state = null;
    this.onCompleteCallback = null;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  get isActive(): boolean {
    return this.state?.active ?? false;
  }

  get phase(): string {
    if (!this.state) return "idle";
    if (this.state.filled) return "done";
    const elapsed = Date.now() - this.state.startedAt;
    if (elapsed < PHASE2_AFTER_MS) return "profitable";
    if (elapsed < BAILOUT_AFTER_MS) return "breakeven";
    return "bailout";
  }

  get tranchesStatus(): string {
    if (!this.state) return "idle";
    return this.state.filled ? "1/1" : "0/1";
  }

  /**
   * React to WS orderbook updates — try to fill on every update.
   */
  private onPriceUpdate(assetId: string, _book: BookSnapshot): void {
    if (!this.state || !this.state.active) return;
    if (assetId !== this.state.loserTokenId) return;
    this.checkAndFill();
  }

  /**
   * Core logic: check if we can fill the loser side now.
   * Called on every WS update + safety timer every 2s.
   * WS path is sync (fast), timer path uses async REST fallback.
   */
  private checkAndFill(): void {
    if (!this.state || !this.state.active || this.state.filled || this.state.fillInFlight) return;

    const elapsed = Date.now() - this.state.startedAt;

    // Phase 3: bail out
    if (elapsed >= BAILOUT_AFTER_MS) {
      this.state.fillInFlight = true;
      this.doBailOut().catch((err) => {
        this.logger.error("Bail-out failed", { error: (err as Error).message });
      });
      return;
    }

    // Get current loser ask from WS
    const book = this.clobWs.getBook(this.state.loserTokenId);
    const askCents = book?.bestAsk ? book.bestAsk * 100 : null;

    if (!askCents) {
      // WS has no data — fetch from REST API as fallback
      this.state.fillInFlight = true; // prevent re-entry during async
      this.fetchAndCheck(elapsed).catch((err) => {
        this.logger.error("REST fallback check failed", { error: (err as Error).message });
        if (this.state && !this.state.filled) this.state.fillInFlight = false;
      });
      return;
    }

    this.evaluateAndFill(askCents, elapsed);
  }

  /**
   * Async REST fallback when WS has no book data for the loser.
   */
  private async fetchAndCheck(elapsed: number): Promise<void> {
    if (!this.state || this.state.filled) return;

    const ob = await this.clob.getOrderbook(this.state.loserTokenId);
    const askCents = ob.bestAsk ? ob.bestAsk * 100 : null;

    if (!askCents) {
      this.logger.warn("No loser price from WS or REST", {
        elapsed: `${(elapsed / 1000).toFixed(1)}s`,
        loserTokenId: this.state.loserTokenId.slice(0, 12) + "...",
      });
      this.state.fillInFlight = false;
      return;
    }

    this.logger.debug("Using REST price (WS has no data)", {
      loserAsk: `${askCents.toFixed(1)}¢`,
    });

    this.evaluateAndFill(askCents, elapsed);
  }

  /**
   * Evaluate loser ask price and fill if within threshold.
   */
  private evaluateAndFill(askCents: number, elapsed: number): void {
    if (!this.state || this.state.filled || (this.state.fillInFlight && elapsed < BAILOUT_AFTER_MS)) {
      // fillInFlight is set by fetchAndCheck — allow it through
    }

    // Track best (lowest) loser price seen
    if (askCents < this.state!.bestLoserAskSeen) {
      this.state!.bestLoserAskSeen = askCents;
    }

    const pairCost = this.state!.winnerAvgPriceCents + askCents;

    // Phase 1: profitable fill (pair < 98¢)
    if (elapsed < PHASE2_AFTER_MS) {
      if (pairCost <= PHASE1_MAX_PAIR_CENTS) {
        this.state!.fillInFlight = true;
        this.fillLoser(askCents, "profitable").catch((err) => {
          this.logger.error("Profitable fill failed — will retry on next update", {
            error: (err as Error).message,
          });
          if (this.state && !this.state.filled) this.state.fillInFlight = false;
        });
      } else {
        // Release lock if set by fetchAndCheck
        if (this.state) this.state.fillInFlight = false;
      }
      return;
    }

    // Phase 2: break-even fill (pair ≤ 100¢ — settlement pays 100¢)
    if (pairCost <= PHASE2_MAX_PAIR_CENTS) {
      this.state!.fillInFlight = true;
      this.fillLoser(askCents, "breakeven").catch((err) => {
        this.logger.error("Break-even fill failed — will retry on next update", {
          error: (err as Error).message,
        });
        if (this.state && !this.state.filled) this.state.fillInFlight = false;
      });
    } else {
      // Release lock if set by fetchAndCheck
      if (this.state) this.state.fillInFlight = false;
    }
  }

  /**
   * Fill 100% of loser shares at the given price.
   */
  private async fillLoser(askCents: number, reason: string): Promise<void> {
    if (!this.state) return;

    const loserSide: TradeSide = this.state.winnerSide === "Up" ? "Down" : "Up";
    const pairCost = this.state.winnerAvgPriceCents + askCents;
    const profitCents = 100 - pairCost; // fees are dynamic & small at extreme prices
    const priceDecimal = askCents / 100;
    const shares = this.state.winnerShares;
    const costUsd = shares * priceDecimal;

    this.logger.info(`HEDGE FILL (${reason}) — buying 100% loser`, {
      side: loserSide,
      price: `${askCents.toFixed(1)}¢`,
      shares: shares.toFixed(2),
      pairCost: `${pairCost.toFixed(1)}¢`,
      profit: `${profitCents >= 0 ? "+" : ""}${profitCents.toFixed(1)}¢/pair`,
      elapsed: `${((Date.now() - this.state.startedAt) / 1000).toFixed(1)}s`,
    });

    if (this.config.dryRun) {
      this.logger.info("DRY_RUN — hedge fill simulated", { side: loserSide, price: `${askCents.toFixed(1)}¢` });
      this.state.filled = true;
      this.state.totalSharesFilled = shares;
      this.state.totalCostUsd = costUsd;
      this.complete(loserSide, shares, costUsd, []);
      return;
    }

    // Cross-check with REST API to avoid stale WS data
    const freshBook = await this.clob.getOrderbook(this.state.loserTokenId);
    const freshAskCents = freshBook.bestAsk ? freshBook.bestAsk * 100 : null;

    if (freshAskCents && Math.abs(freshAskCents - askCents) > 5) {
      this.logger.warn("WS/REST price mismatch — using REST price", {
        wsAsk: `${askCents.toFixed(1)}¢`,
        restAsk: `${freshAskCents.toFixed(1)}¢`,
        diff: `${Math.abs(freshAskCents - askCents).toFixed(1)}¢`,
      });
      // Re-check with fresh price
      const freshPairCost = this.state.winnerAvgPriceCents + freshAskCents;
      const maxPair = (Date.now() - this.state.startedAt) >= PHASE2_AFTER_MS
        ? PHASE2_MAX_PAIR_CENTS
        : PHASE1_MAX_PAIR_CENTS;
      if (freshPairCost > maxPair) {
        this.logger.info("Fresh price too expensive — aborting fill, will retry");
        this.state.fillInFlight = false;
        return;
      }
    }

    const fillPrice = freshAskCents ?? askCents;
    const fillPriceDecimal = fillPrice / 100;
    const fillCostUsd = shares * fillPriceDecimal;

    const result = await this.clob.placeBatchOrders([{
      tokenId: this.state.loserTokenId,
      side: Side.BUY,
      price: fillPriceDecimal,
      size: shares,
    }]);

    if (result.placed > 0) {
      this.state.filled = true;
      this.state.totalSharesFilled = shares;
      this.state.totalCostUsd = fillCostUsd;
      this.state.allOrderIds = result.orderIds;
      this.complete(loserSide, shares, fillCostUsd, result.orderIds);
    } else {
      this.logger.warn("Hedge order rejected — will retry on next tick");
      this.state.fillInFlight = false;
    }
  }

  /**
   * Hedge timeout: loser side didn't fill. Keep naked winner position
   * (positive EV from edge) — don't sell back and eat the spread.
   */
  private async doBailOut(): Promise<void> {
    if (!this.state) return;

    const winnerSide = this.state.winnerSide;
    const loserSide: TradeSide = winnerSide === "Up" ? "Down" : "Up";

    // Before giving up on hedge, one last check — maybe loser dropped
    const book = this.clobWs.getBook(this.state.loserTokenId);
    const askCents = book?.bestAsk ? book.bestAsk * 100 : null;
    if (askCents) {
      const pairCost = this.state.winnerAvgPriceCents + askCents;
      if (pairCost <= PHASE2_MAX_PAIR_CENTS) {
        this.logger.info("Last-second fill opportunity — filling instead of holding naked");
        await this.fillLoser(askCents, "last-chance");
        return;
      }
    }

    const bestSeen = this.state.bestLoserAskSeen;
    const initialAsk = this.state.initialLoserAsk;
    const neededForBreakeven = PHASE2_MAX_PAIR_CENTS - this.state.winnerAvgPriceCents;
    const elapsedSec = ((Date.now() - this.state.startedAt) / 1000).toFixed(1);

    this.logger.info("HEDGE TIMEOUT — holding naked winner (positive EV from edge)", {
      side: winnerSide,
      shares: this.state.winnerShares.toFixed(2),
      entryPrice: `${this.state.winnerAvgPriceCents.toFixed(1)}¢`,
      elapsed: `${elapsedSec}s`,
      loserAskNow: askCents ? `${askCents.toFixed(1)}¢` : "N/A",
      loserAskInitial: initialAsk ? `${initialAsk.toFixed(1)}¢` : "N/A",
      bestLoserAskSeen: `${bestSeen.toFixed(1)}¢`,
      neededForBreakeven: `≤${neededForBreakeven.toFixed(1)}¢`,
      gap: `${(bestSeen - neededForBreakeven).toFixed(1)}¢`,
    });

    // Don't sell winner — hold for settlement. Edge = positive EV directional bet.
    // Settlement logic handles naked positions correctly (win: +shares-cost, lose: -cost).
    this.telegram.alertError(
      `Naked hold: ${winnerSide} ${this.state.winnerShares.toFixed(0)}sh @ ${this.state.winnerAvgPriceCents.toFixed(0)}¢ — hedge timeout ${elapsedSec}s, gap=${(bestSeen - neededForBreakeven).toFixed(0)}¢`,
    );

    this.complete(loserSide, 0, 0, []);
  }

  private complete(side: TradeSide, shares: number, costUsd: number, orderIds: string[]): void {
    if (!this.state) return;

    this.state.active = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.onCompleteCallback) {
      this.onCompleteCallback(side, shares, costUsd, orderIds);
    }
  }
}
