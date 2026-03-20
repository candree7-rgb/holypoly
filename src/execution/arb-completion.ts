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
import type { BinanceWsClient } from "../data/binance-ws.js";
import type { RtdsWsClient } from "../data/rtds-ws.js";
import { lookupFairUp } from "../signal/lookup-table.js";

/**
 * Convergence Arb Completion Monitor — NAKED-FIRST strategy.
 *
 * After buying the winner via FOK, this monitor:
 *
 * 1. MONITORS Binance for reversal (2-5s edge over Polymarket)
 * 2. CHECKS lookup table for naked safety (delta+time → P(win))
 * 3. BUYS loser ONLY if ultra-cheap (≤3¢) — opportunistic, not forced
 * 4. SELLS winner back if delta collapses (emergency exit)
 * 5. HOLDS naked if safe (≥95% probability from lookup table)
 *
 * Key insight: at 96%+ win rate, naked hold has HIGHER EV than forced hedge.
 * EV(naked @ 96%) = +6.0¢/share vs EV(hedge @ 5¢) = +5.0¢/share
 */

export type ArbCompletionCallback = (side: TradeSide, shares: number, costUsd: number, orderIds: string[], soldBack?: boolean, maker?: boolean) => void;

/** How often to run safety checks (ms). Binance ticks are event-driven — this is the fallback. */
const SAFETY_CHECK_INTERVAL_MS = 500;

interface MonitorState {
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
  /** BTC price at time of entry */
  entryBtcPrice: number;
  /** BTC delta at time of entry (entryBtcPrice - openingPrice) */
  entryDelta: number;
  /** Current BTC price (updated from Binance) */
  currentBtcPrice: number;
  /** Window opening price */
  openingPrice: number;
  /** Seconds remaining when we entered */
  entryTimeRemaining: number;
  /** Current time remaining */
  timeRemainingSeconds: number;
  /** Whether we already sold the winner back */
  soldBack: boolean;
  /** Loser limit order ID (opportunistic) if placed */
  loserLimitOrderId: string | null;
}

export class ArbCompletionMonitor {
  private state: MonitorState | null = null;
  private onCompleteCallback: ArbCompletionCallback | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private binanceUnsubscribe: (() => void) | null = null;
  /** Generation counter — prevents stale async operations from modifying state after reset */
  private generation = 0;
  /** Debounce timestamps for noisy log messages (prevents log spam from high-frequency ticks) */
  private lastReversalLogAt = 0;
  private lastFlippedLogAt = 0;

  constructor(
    private clobWs: ClobWsClient,
    private clob: ClobService,
    private config: Config,
    private arbManager: ArbManager,
    private logger: Logger,
    private telegram: TelegramNotifier,
    private volatilityCalc: VolatilityCalculator,
    private fairValueEngine: FairValueEngine,
    private binance: BinanceWsClient,
    private rtds: RtdsWsClient,
  ) {
    // React to CLOB WS updates for opportunistic loser fills
    this.clobWs.onUpdate(this.onClobUpdate.bind(this));
  }

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
    const entryDelta = params.currentBtcPrice - params.window.openingPrice;

    this.generation++;

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
      entryBtcPrice: params.currentBtcPrice,
      entryDelta,
      currentBtcPrice: params.currentBtcPrice,
      openingPrice: params.window.openingPrice,
      entryTimeRemaining: params.timeRemainingSeconds,
      timeRemainingSeconds: params.timeRemainingSeconds,
      soldBack: false,
      loserLimitOrderId: null,
    };

    this.onCompleteCallback = params.onComplete;

    // Check current loser ask for logging
    const book = this.clobWs.getBook(params.loserTokenId);
    const currentLoserAsk = book?.bestAsk ? book.bestAsk * 100 : null;

    this.logger.info("CONVERGENCE ARB — monitoring naked position", {
      winner: params.winnerSide,
      winnerPrice: `${params.winnerAvgPriceCents.toFixed(1)}¢`,
      entryDelta: `$${entryDelta.toFixed(2)}`,
      normalizedDelta: `${(Math.abs(entryDelta) / this.volatilityCalc.getVolatility()).toFixed(2)}σ`,
      loserAsk: currentLoserAsk ? `${currentLoserAsk.toFixed(1)}¢` : "N/A",
      timeLeft: `${params.timeRemainingSeconds.toFixed(0)}s`,
      strategy: "naked-first + Binance reversal detection",
    });

    // Subscribe to Binance ticks for real-time reversal detection
    const onBinanceTick = () => this.onBinanceTick();
    this.binance.onTick(onBinanceTick);
    this.binanceUnsubscribe = () => {
      this.binance.offTick(onBinanceTick);
    };

    // Safety fallback timer
    this.pollTimer = setInterval(() => this.safetyCheck(), SAFETY_CHECK_INTERVAL_MS);

    // Try opportunistic loser fill immediately
    this.tryOpportunisticLoserFill();
  }

  updateBtcPrice(price: number, timeRemaining: number): void {
    if (this.state) {
      this.state.currentBtcPrice = price;
      this.state.timeRemainingSeconds = timeRemaining;
    }
  }

  reset(): void {
    this.generation++; // Invalidate any in-flight async operations
    this.lastReversalLogAt = 0;
    this.lastFlippedLogAt = 0;
    if (this.binanceUnsubscribe) {
      this.binanceUnsubscribe();
      this.binanceUnsubscribe = null;
    }
    // Cancel any outstanding loser limit order
    if (this.state?.loserLimitOrderId && !this.config.dryRun) {
      this.clob.cancelOrder(this.state.loserLimitOrderId).catch(() => {});
    }
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
    if (this.state.filled) return "hedged";
    if (this.state.soldBack) return "exited";
    return "naked-monitoring";
  }

  // ===== EVENT-DRIVEN HANDLERS =====

  /**
   * Binance tick handler — fires on every trade (~100ms).
   * This is our FASTEST reversal detection path.
   */
  private onBinanceTick(): void {
    if (!this.state || !this.state.active || this.state.filled || this.state.soldBack) return;

    const btcPrice = this.binance.price;
    if (!btcPrice) return;

    this.state.currentBtcPrice = btcPrice;
    const currentDelta = btcPrice - this.state.openingPrice;

    // Check reversal: has delta collapsed?
    this.checkReversal(currentDelta);
  }

  /**
   * CLOB WS update — check for ultra-cheap loser fills.
   */
  private onClobUpdate(assetId: string, _book: BookSnapshot): void {
    if (!this.state || !this.state.active || this.state.filled || this.state.soldBack) return;
    if (assetId !== this.state.loserTokenId) return;

    this.tryOpportunisticLoserFill();
  }

  // ===== CORE LOGIC =====

  /**
   * Check for BTC reversal using Binance data.
   * Triggers emergency sell-back if delta collapses.
   */
  private checkReversal(currentDelta: number): void {
    if (!this.state || this.state.fillInFlight) return;

    const entryDelta = this.state.entryDelta;
    const absDeltaNow = Math.abs(currentDelta);
    const absDeltaEntry = Math.abs(entryDelta);

    // Direction check: did delta flip sign? (worst case — try hedge first)
    const flipped = (entryDelta > 0 && currentDelta <= 0) || (entryDelta < 0 && currentDelta >= 0);
    if (flipped) {
      // When delta flips, the LOSER becomes cheap — perfect time to hedge!
      const loserBook = this.clobWs.getBook(this.state.loserTokenId);
      const loserAskCents = loserBook?.bestAsk ? loserBook.bestAsk * 100 : null;
      const maxLoserPrice = 100 - this.state.winnerAvgPriceCents - 1;

      if (loserAskCents && loserAskCents <= maxLoserPrice) {
        this.logger.info("DELTA FLIPPED — hedging with loser (now cheap!)", {
          entryDelta: `$${entryDelta.toFixed(2)}`,
          currentDelta: `$${currentDelta.toFixed(2)}`,
          loserAsk: `${loserAskCents.toFixed(1)}¢`,
          pairCost: `${(this.state.winnerAvgPriceCents + loserAskCents).toFixed(1)}¢`,
        });
        this.state.fillInFlight = true;
        this.fillLoser(loserAskCents).catch((err) => {
          this.logger.error("Delta-flipped hedge failed", { error: (err as Error).message });
          if (this.state && !this.state.filled) this.state.fillInFlight = false;
        });
      } else {
        // Can't hedge — sell back only if we'd lose more than entry cost
        // Debounce: only log once every 5 seconds
        const now = Date.now();
        if (now - this.lastFlippedLogAt >= 5000) {
          this.lastFlippedLogAt = now;
          this.logger.warn("DELTA FLIPPED — no cheap loser, holding naked (low entry cost)", {
            entryDelta: `$${entryDelta.toFixed(2)}`,
            currentDelta: `$${currentDelta.toFixed(2)}`,
            entryPrice: `${this.state.winnerAvgPriceCents.toFixed(1)}¢`,
          });
        }
        // At 2¢ entry, max loss is 2¢/share — don't panic sell at 0.1¢
      }
      return;
    }

    // Delta drop check: has delta dropped by more than reversalDeltaDropPct?
    if (absDeltaEntry > 0) {
      const dropPct = ((absDeltaEntry - absDeltaNow) / absDeltaEntry) * 100;
      if (dropPct >= this.config.reversalDeltaDropPct) {
        // Double-check: is the position still safe according to lookup table?
        const vol = this.volatilityCalc.getVolatility();
        const normalizedDelta = vol > 0.01 ? absDeltaNow / vol : 0;
        const lookup = lookupFairUp(
          currentDelta > 0 ? normalizedDelta : -normalizedDelta,
          this.state.timeRemainingSeconds,
        );
        const winnerFairValue = this.state.winnerSide === "Up" ? lookup.fairUp : 100 - lookup.fairUp;

        if (winnerFairValue < this.config.nakedSafetyThreshold) {
          // Try hedge first (buy loser)
          const loserBook = this.clobWs.getBook(this.state.loserTokenId);
          const loserAskCents = loserBook?.bestAsk ? loserBook.bestAsk * 100 : null;
          const maxLoserPrice = 100 - this.state.winnerAvgPriceCents - 1;

          if (loserAskCents && loserAskCents <= maxLoserPrice) {
            this.logger.info("REVERSAL — hedging with loser (preferred over sell-back)", {
              dropPct: `${dropPct.toFixed(0)}%`,
              loserAsk: `${loserAskCents.toFixed(1)}¢`,
              pairCost: `${(this.state.winnerAvgPriceCents + loserAskCents).toFixed(1)}¢`,
            });
            this.state.fillInFlight = true;
            this.fillLoser(loserAskCents).catch((err) => {
              this.logger.error("Reversal hedge failed", { error: (err as Error).message });
              if (this.state && !this.state.filled) this.state.fillInFlight = false;
            });
          } else if (winnerFairValue < this.state.winnerAvgPriceCents) {
            // No hedge available AND EV is negative — sell back
            this.logger.warn("REVERSAL — EV negative, selling back", {
              entryDelta: `$${entryDelta.toFixed(2)}`,
              currentDelta: `$${currentDelta.toFixed(2)}`,
              dropPct: `${dropPct.toFixed(0)}%`,
              winnerFairValue: `${winnerFairValue}¢`,
              entryPrice: `${this.state.winnerAvgPriceCents.toFixed(1)}¢`,
            });
            this.state.fillInFlight = true;
            this.emergencySellBack("delta-drop").catch((err) => {
              this.logger.error("Emergency sell-back failed", { error: (err as Error).message });
              if (this.state) this.state.fillInFlight = false;
            });
          } else {
            // Debounce: only log once every 5 seconds (prevents spam from Binance tick handler)
            const now = Date.now();
            if (now - this.lastReversalLogAt >= 5000) {
              this.lastReversalLogAt = now;
              this.logger.info("REVERSAL — delta dropped but still +EV, holding naked", {
                dropPct: `${dropPct.toFixed(0)}%`,
                winnerFairValue: `${winnerFairValue}¢`,
                entryPrice: `${this.state.winnerAvgPriceCents.toFixed(1)}¢`,
              });
            }
          }
        }
      }
    }
  }

  /**
   * Safety check — runs every 500ms as fallback.
   * Checks lookup table safety, velocity, flash crash, data staleness.
   */
  private safetyCheck(): void {
    if (!this.state || !this.state.active || this.state.filled || this.state.soldBack || this.state.fillInFlight) return;

    // Check Binance data staleness — if we haven't received a tick in 5s, we're flying blind
    const binanceTimestamp = this.binance.timestamp;
    if (binanceTimestamp !== null && Date.now() - binanceTimestamp > 5000) {
      this.logger.warn("Binance data stale (>5s) — cannot monitor reversal safely");
      // If position is not super-safe, sell back proactively
      const vol = this.volatilityCalc.getVolatility();
      const currentDelta = this.state.currentBtcPrice - this.state.openingPrice;
      const nDelta = vol > 0.01 ? currentDelta / vol : 0;
      const lookup = lookupFairUp(nDelta, this.state.timeRemainingSeconds);
      const fv = this.state.winnerSide === "Up" ? lookup.fairUp : 100 - lookup.fairUp;
      if (fv < 98) {
        // Not an overwhelmingly safe position — sell back due to blindness
        this.state.fillInFlight = true;
        this.emergencySellBack("binance-stale").catch((err) => {
          this.logger.error("Binance-stale sell-back failed", { error: (err as Error).message });
          if (this.state) this.state.fillInFlight = false;
        });
        return;
      }
    }

    const btcPrice = this.state.currentBtcPrice;
    const currentDelta = btcPrice - this.state.openingPrice;
    const vol = this.volatilityCalc.getVolatility();
    const normalizedDelta = vol > 0.01 ? currentDelta / vol : 0;

    // Lookup table safety check
    const lookup = lookupFairUp(normalizedDelta, this.state.timeRemainingSeconds);
    const winnerFairValue = this.state.winnerSide === "Up" ? lookup.fairUp : 100 - lookup.fairUp;

    // Flash crash: check volatility spike against our position
    const velocity = this.volatilityCalc.getPriceVelocity(5);
    if (velocity !== null) {
      const isAgainst = (this.state.winnerSide === "Up" && velocity < -20) ||
                        (this.state.winnerSide === "Down" && velocity > 20);
      if (isAgainst && winnerFairValue < 80) {
        // Flash crash = loser is now cheap — perfect hedge opportunity!
        const loserBook = this.clobWs.getBook(this.state.loserTokenId);
        const loserAskCents = loserBook?.bestAsk ? loserBook.bestAsk * 100 : null;
        const maxLoserPrice = 100 - this.state.winnerAvgPriceCents - 1;

        if (loserAskCents && loserAskCents <= maxLoserPrice) {
          this.logger.info("FLASH CRASH — hedging with loser (now cheap!)", {
            velocity: `$${velocity.toFixed(1)}/s`,
            loserAsk: `${loserAskCents.toFixed(1)}¢`,
            pairCost: `${(this.state.winnerAvgPriceCents + loserAskCents).toFixed(1)}¢`,
          });
          this.state.fillInFlight = true;
          this.fillLoser(loserAskCents).catch((err) => {
            this.logger.error("Flash crash hedge failed", { error: (err as Error).message });
            if (this.state && !this.state.filled) this.state.fillInFlight = false;
          });
        } else if (winnerFairValue < this.state.winnerAvgPriceCents) {
          this.logger.warn("FLASH CRASH — EV negative, selling back", {
            velocity: `$${velocity.toFixed(1)}/s`,
            winnerFairValue: `${winnerFairValue}¢`,
            entryPrice: `${this.state.winnerAvgPriceCents.toFixed(1)}¢`,
          });
          this.state.fillInFlight = true;
          this.emergencySellBack("flash-crash").catch((err) => {
            this.logger.error("Flash crash sell-back failed", { error: (err as Error).message });
            if (this.state) this.state.fillInFlight = false;
          });
        } else {
          this.logger.info("FLASH CRASH — still +EV, holding naked", {
            velocity: `$${velocity.toFixed(1)}/s`,
            winnerFairValue: `${winnerFairValue}¢`,
            entryPrice: `${this.state.winnerAvgPriceCents.toFixed(1)}¢`,
          });
        }
        return;
      }
    }

    // If close to settlement and position looks risky, try to HEDGE first (buy loser).
    // Only sell-back if EV is actually negative (fairValue < entryPrice) — at 2¢ entry, holding is almost always +EV.
    if (this.state.timeRemainingSeconds < 15 && winnerFairValue < this.config.nakedSafetyThreshold) {
      // Try emergency hedge (buy loser at any reasonable price) before considering sell-back
      const loserBook = this.clobWs.getBook(this.state.loserTokenId);
      const loserAskCents = loserBook?.bestAsk ? loserBook.bestAsk * 100 : null;
      const maxLoserPrice = 100 - this.state.winnerAvgPriceCents - 1; // Must still be profitable pair

      if (loserAskCents && loserAskCents <= maxLoserPrice) {
        this.logger.info("LATE WINDOW — hedging with loser (preferred over sell-back)", {
          timeLeft: `${this.state.timeRemainingSeconds.toFixed(0)}s`,
          loserAsk: `${loserAskCents.toFixed(1)}¢`,
          pairCost: `${(this.state.winnerAvgPriceCents + loserAskCents).toFixed(1)}¢`,
          profit: `+${(100 - this.state.winnerAvgPriceCents - loserAskCents).toFixed(1)}¢/pair`,
        });
        this.state.fillInFlight = true;
        this.fillLoser(loserAskCents).catch((err) => {
          this.logger.error("Late hedge failed", { error: (err as Error).message });
          if (this.state && !this.state.filled) this.state.fillInFlight = false;
        });
        return;
      }

      // No hedge available — only sell-back if EV is negative (fairValue < entryPrice)
      if (winnerFairValue < this.state.winnerAvgPriceCents) {
        this.logger.warn("LATE WINDOW — EV negative, selling back", {
          timeLeft: `${this.state.timeRemainingSeconds.toFixed(0)}s`,
          winnerFairValue: `${winnerFairValue}¢`,
          entryPrice: `${this.state.winnerAvgPriceCents.toFixed(1)}¢`,
        });
        this.state.fillInFlight = true;
        this.emergencySellBack("late-unsafe").catch((err) => {
          this.logger.error("Late sell-back failed", { error: (err as Error).message });
          if (this.state) this.state.fillInFlight = false;
        });
        return;
      }

      // FairValue > entryPrice → still +EV, HOLD naked (don't sell back!)
      this.logger.info("LATE WINDOW — holding naked (+EV)", {
        timeLeft: `${this.state.timeRemainingSeconds.toFixed(0)}s`,
        winnerFairValue: `${winnerFairValue}¢`,
        entryPrice: `${this.state.winnerAvgPriceCents.toFixed(1)}¢`,
        ev: `+${(winnerFairValue - this.state.winnerAvgPriceCents).toFixed(1)}¢/share`,
      });
      return;
    }

    // Log status periodically (every 5s)
    const elapsed = Date.now() - this.state.startedAt;
    if (elapsed % 5000 < SAFETY_CHECK_INTERVAL_MS) {
      this.logger.debug("Naked position status", {
        winnerFairValue: `${winnerFairValue}¢`,
        delta: `${normalizedDelta.toFixed(2)}σ ($${currentDelta.toFixed(2)})`,
        timeLeft: `${this.state.timeRemainingSeconds.toFixed(0)}s`,
        safe: winnerFairValue >= this.config.nakedSafetyThreshold ? "YES" : "NO",
        elapsed: `${(elapsed / 1000).toFixed(0)}s`,
      });
    }
  }

  /**
   * Try to buy loser at ultra-cheap price (≤3¢) or at any profitable price if urgent.
   * This is the PRIMARY exit strategy — hedge beats sell-back at any entry price.
   */
  private tryOpportunisticLoserFill(urgent = false): void {
    if (!this.state || this.state.filled || this.state.soldBack || this.state.fillInFlight) return;

    const book = this.clobWs.getBook(this.state.loserTokenId);
    const askCents = book?.bestAsk ? book.bestAsk * 100 : null;

    if (!askCents) return;

    // When urgent (late window), accept any loser price that creates a profitable pair
    const maxLoserCents = urgent
      ? 100 - this.state.winnerAvgPriceCents - 1 // any price that locks in ≥1¢ profit per pair
      : this.config.opportunisticLoserMaxCents;

    if (askCents > maxLoserCents) return;

    const pairCost = this.state.winnerAvgPriceCents + askCents;
    const profitCents = 100 - pairCost;

    this.logger.info(urgent ? "LATE HEDGE — buying loser to lock in profit" : "OPPORTUNISTIC LOSER — ultra-cheap fill available!", {
      loserAsk: `${askCents.toFixed(1)}¢`,
      pairCost: `${pairCost.toFixed(1)}¢`,
      profit: `+${profitCents.toFixed(1)}¢/pair`,
    });

    this.state.fillInFlight = true;
    this.fillLoser(askCents).catch((err) => {
      this.logger.error("Hedge fill failed", { error: (err as Error).message });
      if (this.state && !this.state.filled) this.state.fillInFlight = false;
    });
  }

  /**
   * Fill loser side at the given price.
   */
  private async fillLoser(askCents: number): Promise<void> {
    if (!this.state || this.state.filled) return;
    const gen = this.generation;

    const loserSide: TradeSide = this.state.winnerSide === "Up" ? "Down" : "Up";
    const pairCost = this.state.winnerAvgPriceCents + askCents;
    const priceDecimal = askCents / 100;
    const shares = this.state.winnerShares;
    const costUsd = shares * priceDecimal;

    this.logger.info("LOSER FILL — buying hedge", {
      side: loserSide,
      price: `${askCents.toFixed(1)}¢`,
      shares: shares.toFixed(2),
      pairCost: `${pairCost.toFixed(1)}¢`,
      profit: `+${(100 - pairCost).toFixed(1)}¢/pair`,
    });

    if (this.config.dryRun) {
      this.state.filled = true;
      this.state.totalSharesFilled = shares;
      this.state.totalCostUsd = costUsd;
      this.complete(loserSide, shares, costUsd, []);
      return;
    }

    // Try limit order first (maker = 0% fee), fallback to FOK after 1s
    const result = await this.clob.placeLimitThenFOK({
      tokenId: this.state.loserTokenId,
      side: Side.BUY,
      price: priceDecimal + 0.01, // 1¢ above best ask to ensure priority
      size: shares,
      timeoutMs: 1000, // shorter timeout for hedge — speed matters
    });

    // Guard: state may have been reset while we awaited
    if (gen !== this.generation || !this.state) return;

    if (result.filled) {
      this.state.filled = true;
      this.state.totalSharesFilled = shares;
      this.state.totalCostUsd = costUsd;
      this.state.allOrderIds = result.orderIds;
      this.complete(loserSide, shares, costUsd, result.orderIds, result.maker);
    } else {
      this.logger.warn("Loser limit+FOK failed — staying naked (still good EV)");
      this.state.fillInFlight = false;
    }
  }

  /**
   * Emergency sell-back: sell the winner at market (FOK SELL).
   * Loss: ~1-3¢ spread. Prevents catastrophic loss.
   */
  private async emergencySellBack(reason: string): Promise<void> {
    if (!this.state || this.state.soldBack || this.state.filled) return;
    const gen = this.generation;

    const winnerSide = this.state.winnerSide;

    // Cancel any outstanding loser limit order
    if (this.state.loserLimitOrderId) {
      await this.clob.cancelOrder(this.state.loserLimitOrderId).catch(() => {});
      this.state.loserLimitOrderId = null;
    }

    // Get current winner bid
    const book = this.clobWs.getBook(this.state.winnerTokenId);
    const bestBid = book?.bestBid;

    if (!bestBid) {
      // No bid available — try REST as fallback
      try {
        const restBook = await this.clob.getOrderbook(this.state.winnerTokenId);
        if (gen !== this.generation || !this.state) return; // stale
        if (restBook.bestBid) {
          await this.executeSellBack(reason, restBook.bestBid, gen);
        } else {
          this.logger.error("NO BIDS AVAILABLE — cannot sell back, holding naked", { reason });
          this.telegram.alertError(`No bids for sell-back (${reason}). Naked hold: ${winnerSide} ${this.state.winnerShares.toFixed(0)}sh @ ${this.state.winnerAvgPriceCents.toFixed(0)}¢`);
          this.state.fillInFlight = false;
          // Don't complete — let it ride to settlement
        }
      } catch (err) {
        this.logger.error("REST fallback for sell-back failed", { error: (err as Error).message });
        this.state.fillInFlight = false;
      }
      return;
    }

    await this.executeSellBack(reason, bestBid, gen);
  }

  private async executeSellBack(reason: string, bestBid: number, gen?: number): Promise<void> {
    if (!this.state) return;

    const worstPrice = bestBid - (this.config.emergencySellMaxSpreadCents / 100);
    const expectedLossCents = this.state.winnerAvgPriceCents - (bestBid * 100);

    this.logger.info(`EMERGENCY SELL-BACK (${reason})`, {
      side: this.state.winnerSide,
      shares: this.state.winnerShares.toFixed(2),
      entryPrice: `${this.state.winnerAvgPriceCents.toFixed(1)}¢`,
      bestBid: `${(bestBid * 100).toFixed(1)}¢`,
      expectedLoss: `${expectedLossCents.toFixed(1)}¢/share`,
      worstPrice: `${(worstPrice * 100).toFixed(1)}¢`,
    });

    if (this.config.dryRun) {
      this.state.soldBack = true;
      const sellProceeds = this.state.winnerShares * bestBid;
      const entryCost = this.state.winnerShares * (this.state.winnerAvgPriceCents / 100);
      const pnl = sellProceeds - entryCost;
      this.logger.info("DRY_RUN — sell-back simulated", { pnl: `$${pnl.toFixed(4)}` });
      this.telegram.alertError(`SELL-BACK (${reason}): ${this.state.winnerSide} ${this.state.winnerShares.toFixed(0)}sh, loss ~${expectedLossCents.toFixed(0)}¢/sh`);
      // Complete with 0 loser shares (sell-back, not hedge)
      this.completeSellBack();
      return;
    }

    // FOK SELL the winner position
    const result = await this.clob.placeMarketOrderFOK({
      tokenId: this.state.winnerTokenId,
      side: Side.SELL,
      amount: this.state.winnerShares,
      worstPrice,
    });

    // Guard: state may have been reset while we awaited
    if ((gen !== undefined && gen !== this.generation) || !this.state) return;

    if (result.filled) {
      this.state.soldBack = true;
      this.state.allOrderIds.push(...result.orderIds);
      this.telegram.alertError(`SELL-BACK OK (${reason}): ${this.state.winnerSide} ${this.state.winnerShares.toFixed(0)}sh @ ~${(bestBid * 100).toFixed(0)}¢`);
      this.completeSellBack();
    } else {
      this.logger.error("SELL-BACK FOK FAILED — holding naked", { reason });
      this.telegram.alertError(`Sell-back FAILED (${reason}). Naked hold: ${this.state.winnerSide} ${this.state.winnerShares.toFixed(0)}sh`);
      this.state.fillInFlight = false;
    }
  }

  private completeSellBack(): void {
    if (!this.state) return;
    const loserSide: TradeSide = this.state.winnerSide === "Up" ? "Down" : "Up";
    // Signal sell-back: 0 loser shares, soldBack=true
    this.completeInternal(loserSide, 0, 0, [], true);
  }

  private complete(side: TradeSide, shares: number, costUsd: number, orderIds: string[], maker?: boolean): void {
    this.completeInternal(side, shares, costUsd, orderIds, false, maker);
  }

  private completeInternal(side: TradeSide, shares: number, costUsd: number, orderIds: string[], soldBack: boolean, maker?: boolean): void {
    if (!this.state) return;

    this.state.active = false;

    if (this.binanceUnsubscribe) {
      this.binanceUnsubscribe();
      this.binanceUnsubscribe = null;
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.onCompleteCallback) {
      this.onCompleteCallback(side, shares, costUsd, orderIds, soldBack, maker);
    }
  }
}
