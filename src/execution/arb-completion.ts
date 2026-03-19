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

/** Polymarket taker fee (~2%) */
const TAKER_FEE_PCT = 0.02;

/** Safety fallback interval — WS is primary, this is just a backup (ms) */
const SAFETY_CHECK_INTERVAL_MS = 2000;

/** Phase 1: Fill if profitable (pair < 98¢ after fees) */
const PHASE1_MAX_PAIR_CENTS = 98;

/** Phase 2: After this many ms, accept break-even (pair ≤ 100¢) */
const PHASE2_AFTER_MS = 3000;
const PHASE2_MAX_PAIR_CENTS = 100;

/** Phase 3: After this many ms, bail out entirely */
const BAILOUT_AFTER_MS = 5000;

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
      phases: `0-3s: fill<98¢ | 3-5s: fill≤100¢ | 5s+: bail`,
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
   * Called every 100ms AND on every WS update.
   */
  private checkAndFill(): void {
    if (!this.state || !this.state.active || this.state.filled || this.state.fillInFlight) return;

    const elapsed = Date.now() - this.state.startedAt;

    // Phase 3: bail out
    if (elapsed >= BAILOUT_AFTER_MS) {
      this.state.fillInFlight = true; // prevent re-entry
      this.doBailOut().catch((err) => {
        this.logger.error("Bail-out failed", { error: (err as Error).message });
      });
      return;
    }

    // Get current loser ask
    const book = this.clobWs.getBook(this.state.loserTokenId);
    const askCents = book?.bestAsk ? book.bestAsk * 100 : null;
    if (!askCents) return; // no price yet, wait for next tick

    const pairCost = this.state.winnerAvgPriceCents + askCents;
    const feeCents = pairCost * TAKER_FEE_PCT;

    // Phase 1: profitable fill (pair + fees < 98¢)
    if (elapsed < PHASE2_AFTER_MS) {
      if (pairCost + feeCents <= PHASE1_MAX_PAIR_CENTS) {
        this.state.fillInFlight = true;
        this.fillLoser(askCents, "profitable").catch((err) => {
          this.logger.error("Profitable fill failed — will retry on next update", {
            error: (err as Error).message,
          });
          // Release lock so next WS update or timer can retry
          if (this.state && !this.state.filled) this.state.fillInFlight = false;
        });
      }
      return;
    }

    // Phase 2: break-even fill (pair + fees ≤ 100¢)
    if (pairCost + feeCents <= PHASE2_MAX_PAIR_CENTS) {
      this.state.fillInFlight = true;
      this.fillLoser(askCents, "breakeven").catch((err) => {
        this.logger.error("Break-even fill failed — will retry on next update", {
          error: (err as Error).message,
        });
        if (this.state && !this.state.filled) this.state.fillInFlight = false;
      });
    }
    // If still too expensive in phase 2, wait — phase 3 (bail) will trigger on next tick
  }

  /**
   * Fill 100% of loser shares at the given price.
   */
  private async fillLoser(askCents: number, reason: string): Promise<void> {
    if (!this.state) return;

    const loserSide: TradeSide = this.state.winnerSide === "Up" ? "Down" : "Up";
    const pairCost = this.state.winnerAvgPriceCents + askCents;
    const profitCents = 100 - pairCost - (pairCost * TAKER_FEE_PCT);
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
      if (freshPairCost + freshPairCost * TAKER_FEE_PCT > maxPair) {
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
   * Bail-out: sell winner shares back. Better a small spread loss than naked.
   */
  private async doBailOut(): Promise<void> {
    if (!this.state) return;

    const winnerSide = this.state.winnerSide;
    const loserSide: TradeSide = winnerSide === "Up" ? "Down" : "Up";
    const winnerShares = this.state.winnerShares;
    const winnerCostUsd = winnerShares * this.state.winnerAvgPriceCents / 100;

    // Before bailing, one last check — maybe loser dropped
    const book = this.clobWs.getBook(this.state.loserTokenId);
    const askCents = book?.bestAsk ? book.bestAsk * 100 : null;
    if (askCents) {
      const pairCost = this.state.winnerAvgPriceCents + askCents;
      const feeCents = pairCost * TAKER_FEE_PCT;
      // Accept anything ≤ 100¢ (break-even) before bailing
      if (pairCost + feeCents <= PHASE2_MAX_PAIR_CENTS) {
        this.logger.info("Last-second fill opportunity — filling instead of bailing");
        await this.fillLoser(askCents, "last-chance");
        return;
      }
    }

    this.logger.warn("BAIL-OUT: Selling winner shares back", {
      side: winnerSide,
      shares: winnerShares.toFixed(2),
      elapsed: `${((Date.now() - this.state.startedAt) / 1000).toFixed(1)}s`,
      loserAsk: askCents ? `${askCents.toFixed(1)}¢` : "N/A",
    });

    this.telegram.alertError(
      `Bail-out: Selling ${winnerSide} ${winnerShares.toFixed(1)} shares after 5s. Loser too expensive.`,
    );

    if (this.config.dryRun) {
      this.logger.info("DRY_RUN — bail-out sell simulated");
    } else {
      try {
        const winnerBook = this.clobWs.getBook(this.state.winnerTokenId);
        const bestBid = winnerBook?.bestBid;
        if (bestBid && bestBid > 0) {
          const result = await this.clob.placeBatchOrders([{
            tokenId: this.state.winnerTokenId,
            side: Side.SELL,
            price: bestBid,
            size: winnerShares,
          }]);
          if (result.placed > 0) {
            this.logger.info("Bail-out sell placed", {
              price: `${(bestBid * 100).toFixed(1)}¢`,
              shares: winnerShares.toFixed(2),
            });
          } else {
            this.logger.error("Bail-out sell rejected — holding naked");
          }
        } else {
          this.logger.error("No bid for winner side — holding naked");
        }
      } catch (err) {
        this.logger.error("Bail-out sell failed", { error: (err as Error).message });
      }
    }

    // Reverse winner position in ArbManager
    this.arbManager.recordFill(winnerSide, -winnerShares, -winnerCostUsd);
    this.logger.info("Bail-out: reversed winner position in ArbManager");

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
