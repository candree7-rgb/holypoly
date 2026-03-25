import { Side, OrderType } from "@polymarket/clob-client";
import type { Logger } from "../logger.js";
import type { TelegramNotifier } from "../telegram.js";
import type { ClobService } from "../data/clob.js";
import type { ClobWsClient, BookSnapshot } from "../data/clob-ws.js";
import type { BinanceWsClient } from "../data/binance-ws.js";
import type { RedeemService } from "../data/redeem.js";
import type { Config } from "../config.js";
import type {
  WindowInfo,
  OrderFill,
  MergeResult,
  WindowExecutionResult,
  InventorySnapshot,
  TradeSide,
} from "../types.js";
import { DryRunEngine } from "./dry-run-engine.js";
import { InventoryStateMachine, classifyPairQuality, type FillDecision, type PairQualityBand } from "./inventory-state-machine.js";
import { sleep, polymarketCryptoFee } from "../utils.js";

type Regime = "OSCILLATION" | "TREND" | "SKIP";

interface ObservationResult {
  regime: Regime;
  avgUpSpreadCents: number;
  avgDnSpreadCents: number;
  upDepthWithinBand: number;
  dnDepthWithinBand: number;
  reversals: number;
  distanceToOpenPct: number;
  refillScore: number;
}

/**
 * Timeframe-specific parameter profile.
 * Same engine, different tuning for 5m vs 15m markets.
 */
export interface TimeframeProfile {
  label: string;                   // "5m" or "15m"
  observationPeriodS: number;      // seconds to observe before first buy
  stopBuyingBeforeEndS: number;    // stop accumulating N seconds before end
  defensiveUnpairedS: number;      // seconds unpaired before DEFENSIVE_REBALANCE
  midWindowMergeMinTimeS: number;  // only mid-merge if >N seconds remain
  maxOrdersPerWindow: number;
  mergeMinSize: number;
  probePhaseEndS: number;          // probing phase duration
  intervalMultiplier: number;      // 1.0 for 5m, ~1.5 for 15m (slower pacing)
}

export const PROFILE_5M: TimeframeProfile = {
  label: "5m",
  observationPeriodS: 15,
  stopBuyingBeforeEndS: 40,
  defensiveUnpairedS: 20,
  midWindowMergeMinTimeS: 120,
  maxOrdersPerWindow: 30,
  mergeMinSize: 10,
  probePhaseEndS: 30,
  intervalMultiplier: 1.0,
};

export const PROFILE_15M: TimeframeProfile = {
  label: "15m",
  observationPeriodS: 25,
  stopBuyingBeforeEndS: 100,
  defensiveUnpairedS: 45,
  midWindowMergeMinTimeS: 300,
  maxOrdersPerWindow: 70,
  mergeMinSize: 15,
  probePhaseEndS: 60,
  intervalMultiplier: 1.4,
};

/** Auto-detect profile from window duration */
export function detectProfile(window: WindowInfo): TimeframeProfile {
  const durationMin = (window.endTime - window.startTime) / 60_000;
  return durationMin > 8 ? PROFILE_15M : PROFILE_5M;
}

/**
 * SignalTakerExecutor V11: Inventory state machine + pair quality bands.
 * Two-sided inventory engine with fast alternation per executor_spec.md.
 */
export class SignalTakerExecutor {
  private dryRunEngine: DryRunEngine | null = null;
  private sessionChunkSize: number | null = null;
  private sessionChunkDate: string | null = null;

  private static readonly OBSERVATION_SAMPLE_MS = 500;
  private static readonly MIN_HEDGEABLE_CHUNKS = 2;
  private static readonly FIRST_LEG_MULTIPLIER = 0.20;
  private static readonly FIRST_LEG_MIN_SHARES = 15;
  private static readonly FIRST_LEG_MAX_SHARES = 30;
  private static readonly REBALANCE_CHUNK_PCT = 0.35;
  private static readonly SOFT_HEDGE_CAP = 0.90;
  private static readonly TREND_FIRST_LEG_MAX_PRICE = 0.70;
  private static readonly BINANCE_BOOTSTRAP_WAIT_MS = 6000;
  private static readonly MAX_RESCUE_COMBINED_CENTS = 102;
  private static readonly MIN_TIME_FOR_NEW_FIRST_LEG_S = 120;
  private static readonly MIN_TIME_FOR_NEW_FIRST_LEG_OSC_S = 80;
  private static readonly POST_TARGET_CHUNK_PCT = 0.25;
  private static readonly ONE_SIDED_EXTREME_LOW = 0.20;
  private static readonly ONE_SIDED_EXTREME_HIGH = 0.80;
  private static readonly BALANCE_PRICE_BUFFER = 0.03; // +3¢ above target-implied hedge price

  // Price momentum: rolling window of BTC prices for reversal detection
  private static readonly PRICE_HISTORY_SIZE = 8;            // ~4s of history at 500ms intervals
  private static readonly REVERSAL_THRESHOLD = 0.00015;      // 0.015% reversal from recent extreme
  private static readonly REBALANCE_OVERPAY = 0.03;          // willing to pay 3¢ over breakeven
  // Emergency rebalance uses same dynamic cap (breakeven + 3¢). Better naked than guaranteed loss.
  private static readonly MERGE_MAX_RETRIES = 4;             // exponential backoff retries for merge

  constructor(
    private clob: ClobService,
    private clobWs: ClobWsClient,
    private binance: BinanceWsClient,
    private redeem: RedeemService | null,
    private config: Config,
    private logger: Logger,
    private telegram: TelegramNotifier,
  ) {}

  /**
   * Execute V11 state-machine-driven strategy for one 5-minute window.
   */
  async executeWindow(window: WindowInfo, balance: number): Promise<WindowExecutionResult> {
    const result: WindowExecutionResult = {
      conditionId: window.conditionId,
      windowStart: window.startTime,
      windowEnd: window.endTime,
      orderFills: [],
      pairs: [],
      merges: [],
      totalUpShares: 0,
      totalDnShares: 0,
      totalUpCost: 0,
      totalDnCost: 0,
      totalMerged: 0,
      totalMergeProfit: 0,
      remainingUp: 0,
      remainingDn: 0,
      totalCost: 0,
      avgCombinedCents: 0,
      takerFees: 0,
      dryRun: this.config.dryRun,
      skipped: false,
    };

    // --- DRY RUN ENGINE ---
    if (this.config.dryRun) {
      this.dryRunEngine = new DryRunEngine(this.clobWs, this.config.takerFeeRate, balance, this.logger);
    }

    // --- PRE-FLIGHT ---
    const preflight = await this.preFlightCheck(window);
    if (!preflight.pass) {
      this.logger.warn("Pre-flight failed, skipping window", { reason: preflight.reason });
      this.telegram.send(`⏭️ Skip: ${preflight.reason}`);
      result.skipped = true;
      result.skipReason = preflight.reason;
      return result;
    }

    // --- BINANCE PRICE CHECK ---
    const btcOpen = await this.awaitBinancePrice();
    if (!btcOpen) {
      this.logger.warn("No Binance price available, skipping window");
      result.skipped = true;
      result.skipReason = "No Binance BTC price";
      return result;
    }

    // --- TIMEFRAME PROFILE ---
    const profile = detectProfile(window);

    const chunkSize = this.getSessionChunkSize(balance);
    const firstLegMultiplier = SignalTakerExecutor.FIRST_LEG_MULTIPLIER;
    const firstLegMinShares = SignalTakerExecutor.FIRST_LEG_MIN_SHARES;
    const firstLegMaxShares = SignalTakerExecutor.FIRST_LEG_MAX_SHARES;
    const firstLegChunk = Math.min(
      firstLegMaxShares,
      Math.max(firstLegMinShares, Math.floor(chunkSize * firstLegMultiplier)),
    );
    const budget = balance * this.config.equityPerWindow;
    let availableBudget = budget;

    // Accumulation state
    let filledUp = 0;
    let filledDn = 0;
    let costUp = 0;
    let costDn = 0;
    let orderCount = 0;
    const orderFills: OrderFill[] = [];
    let totalTakerFees = 0;
    let lastBuySide: TradeSide | null = null;
    let lastBuyTime = 0;
    let combinedCents = Infinity;
    let unpairedStartMs: number | null = null;

    // ── Inventory State Machine ──
    const sm = new InventoryStateMachine({
      nearBalancedRatio: 1.3,
      defensiveUnpairedS: profile.defensiveUnpairedS,
      stopBuildTimeS: profile.stopBuyingBeforeEndS,
      mergeReadyMinShares: profile.mergeMinSize,
      stopBuildCombinedCents: 103,
      defensiveCombinedCents: 100,
    });
    let fillTick = 0;

    const audit = {
      profile: profile.label,
      firstLegLateBlocked: false,
      hedgeGateSkippedWindow: false,
      finalAction: "unknown" as "trade" | "skip" | "no_fill",
      finalReason: "none",
    };

    // Price momentum state: rolling window of recent BTC prices
    const priceHistory: number[] = [btcOpen];
    let rollingHigh = btcOpen;
    let rollingLow = btcOpen;

    this.logger.info("=== V11 Inventory Engine Start ===", {
      profile: profile.label,
      observationS: profile.observationPeriodS,
      stopBuyS: profile.stopBuyingBeforeEndS,
      defensiveUnpairedS: profile.defensiveUnpairedS,
      btc: `$${btcOpen.toFixed(0)}`,
      budget: `$${budget.toFixed(0)}`,
      chunk: chunkSize,
      firstLegChunk,
      target: `${this.config.targetCombinedCents}¢`,
    });

    // Phase A/B gate: observe + classify + hedge-feasibility before first fill.
    const observation = await this.observeAndClassify(window, btcOpen, chunkSize, profile);
    if (observation.regime === "SKIP") {
      result.skipped = true;
      result.skipReason = `Regime skip (${(observation.distanceToOpenPct * 100).toFixed(3)}% from open)`;
      this.telegram.send(`⏭️ Skip: regime=SKIP dist=${(observation.distanceToOpenPct * 100).toFixed(3)}%`);
      return result;
    }
    if (this.isOneSidedToxic(window)) {
      result.skipped = true;
      result.skipReason = "One-sided book too extreme for safe sequential hedge";
      this.telegram.send("⏭️ Skip: one-sided extreme book (hedge toxicity)");
      return result;
    }
    // Hedge feasibility gate: always check if opposite side is executable
    const feasible = this.assessHedgeFeasibility(window, chunkSize, observation);
    if (!feasible.ok) {
      result.skipped = true;
      result.skipReason = feasible.reason;
      audit.hedgeGateSkippedWindow = true;
      audit.finalAction = "skip";
      audit.finalReason = feasible.reason ?? "hedge_gate_skip";
      this.telegram.send(`⏭️ Skip: ${feasible.reason}`);
      return result;
    }

    // ═══════════════════════════════════════════════════
    // PHASE 1: STATE-MACHINE-DRIVEN ACCUMULATION
    // Two-sided inventory engine with fast alternation
    // Mid-window merge recycles capital (Stargate-style)
    // ═══════════════════════════════════════════════════
    const merges: MergeResult[] = [];
    const stopBuyingTime = window.endTime - profile.stopBuyingBeforeEndS * 1000;
    const windowStartTime = Date.now();

    while (
      Date.now() < stopBuyingTime &&
      availableBudget > chunkSize * 0.20 &&
      orderCount < profile.maxOrdersPerWindow
    ) {
      const btcNow = this.binance.price;
      if (!btcNow) {
        await sleep(this.config.signalCheckIntervalMs);
        continue;
      }

      // Update price history rolling window
      priceHistory.push(btcNow);
      if (priceHistory.length > SignalTakerExecutor.PRICE_HISTORY_SIZE) {
        priceHistory.shift();
      }
      rollingHigh = Math.max(...priceHistory);
      rollingLow = Math.min(...priceHistory);

      // Momentum: how far has price moved from recent extremes?
      const dipFromHigh = (rollingHigh - btcNow) / rollingHigh;   // +ve when falling
      const bounceFromLow = (btcNow - rollingLow) / rollingLow;   // +ve when rising
      const isFirstBuy = orderCount === 0;
      const timeRemainingS = Math.max(0, (window.endTime - Date.now()) / 1000);

      // ── EVALUATE STATE MACHINE ──
      const currentState = sm.evaluate({
        filledUp, filledDn, costUp, costDn,
        unpairedStartMs, timeRemainingS,
        mergeMinSize: this.config.mergeMinSize,
        tick: fillTick,
      });
      const allowed = sm.getAllowedActions();

      // STOP_BUILD: no more accumulation
      if (currentState === "STOP_BUILD" && !allowed.canAccumulate) {
        this.logger.info("State machine: STOP_BUILD — exiting accumulation", {
          variant: profile.label,
          state: currentState,
          timeRemainingS: timeRemainingS.toFixed(0),
        });
        break;
      }

      // Late first-leg check
      const minTimeForFirstLeg = observation.regime === "OSCILLATION"
        ? SignalTakerExecutor.MIN_TIME_FOR_NEW_FIRST_LEG_OSC_S
        : SignalTakerExecutor.MIN_TIME_FOR_NEW_FIRST_LEG_S;
      if (isFirstBuy && timeRemainingS < minTimeForFirstLeg) {
        audit.firstLegLateBlocked = true;
        this.logger.info("Skip late first-leg opening", { timeRemainingS: timeRemainingS.toFixed(1) });
        break;
      }

      // ── SIDE SELECTION (state-machine-aware) ──
      let nextSide = this.chooseNextSide(
        observation.regime, lastBuySide, filledUp, filledDn, costUp, costDn, dipFromHigh, bounceFromLow, window, isFirstBuy,
      );
      let sideReason = "chooseNextSide";
      let altReason: string | null = null;

      if (!nextSide) {
        // Record skip decision
        sm.recordDecision({
          tick: fillTick++, state: currentState, regime: observation.regime,
          chosenSide: null, reason: "no_side_available", altReason: null,
          pairBand: combinedCents !== Infinity ? classifyPairQuality(combinedCents) : null,
          filledUp, filledDn, combinedCents,
          imbalanceRatio: Math.min(filledUp, filledDn) > 0 ? Math.max(filledUp, filledDn) / Math.min(filledUp, filledDn) : 0,
          unpairedDurationMs: unpairedStartMs ? Date.now() - unpairedStartMs : 0,
          timeRemainingS,
        });
        await sleep(this.config.signalCheckIntervalMs);
        continue;
      }

      // State-machine overrides on side selection
      const shortSide = sm.getShortSide(filledUp, filledDn);
      if (allowed.mustPrioritizeShortSide && shortSide && nextSide !== shortSide) {
        altReason = `state=${currentState} forced short_side=${shortSide} (was ${nextSide})`;
        nextSide = shortSide;
        sideReason = "sm_priority_short";
      } else if (!isFirstBuy && !allowed.canAccumulateLongSide && shortSide && nextSide !== shortSide) {
        altReason = `state=${currentState} blocked long_side=${nextSide}`;
        nextSide = shortSide;
        sideReason = "sm_blocked_long";
      }

      // Pair quality resolution (may switch side for better pair economics)
      const resolvedSide = this.resolveSideByPairQuality(
        nextSide, observation.regime, isFirstBuy,
        filledUp, filledDn, costUp, costDn, chunkSize, window,
      );
      if (resolvedSide !== nextSide) {
        // Only allow pair-quality override if state permits long-side accumulation
        if (allowed.canAccumulateLongSide || resolvedSide === shortSide) {
          sideReason = `pair_quality_resolve: ${nextSide}->${resolvedSide}`;
          nextSide = resolvedSide;
        }
      }

      // Late window unpaired stop — handled by state machine (STOP_BUILD / DEFENSIVE_REBALANCE)

      // Dynamic interval: momentum-aware timing
      const hasBothSides = filledUp > 0 && filledDn > 0;
      const hasMomentum = this.isGoodTimeToBuy(nextSide, dipFromHigh, bounceFromLow);
      const baseInterval = Math.round(this.computeInterval(combinedCents) * profile.intervalMultiplier);
      const minInterval = hasBothSides && !hasMomentum
        ? Math.max(baseInterval, 2000)  // V11: 2s floor (was 3s) — still buy without momentum
        : baseInterval;
      const now = Date.now();
      if (now - lastBuyTime < minInterval) {
        await sleep(this.config.signalCheckIntervalMs);
        continue;
      }

      // Get ask price
      const tokenId = nextSide === "Up" ? window.upTokenId : window.downTokenId;
      const book = this.getBook(tokenId);
      const bestAsk = this.getAskPrice(book);

      if (bestAsk === null) {
        this.logger.debug("No ask price available, skipping", { side: nextSide });
        await sleep(this.config.signalCheckIntervalMs);
        continue;
      }

      // Safety cap
      const sidePriceCap = this.getPriceCap(
        observation.regime, isFirstBuy, nextSide,
        filledUp, filledDn, costUp, costDn,
      );
      if (bestAsk >= sidePriceCap) {
        sm.recordDecision({
          tick: fillTick++, state: currentState, regime: observation.regime,
          chosenSide: nextSide, reason: `ask=${(bestAsk*100).toFixed(1)}c >= cap=${(sidePriceCap*100).toFixed(0)}c`,
          altReason: sideReason, pairBand: combinedCents !== Infinity ? classifyPairQuality(combinedCents) : null,
          filledUp, filledDn, combinedCents,
          imbalanceRatio: Math.min(filledUp, filledDn) > 0 ? Math.max(filledUp, filledDn) / Math.min(filledUp, filledDn) : 0,
          unpairedDurationMs: unpairedStartMs ? Date.now() - unpairedStartMs : 0,
          timeRemainingS,
        });
        await sleep(this.config.signalCheckIntervalMs);
        continue;
      }

      // Imbalance guard
      const thisSideShares = nextSide === "Up" ? filledUp : filledDn;
      const otherSideShares = nextSide === "Up" ? filledDn : filledUp;
      if (otherSideShares > 0 && thisSideShares >= otherSideShares * this.config.maxImbalanceRatio) {
        this.logger.debug("Imbalance guard: too many shares on one side", {
          side: nextSide,
          thisShares: thisSideShares.toFixed(0),
          otherShares: otherSideShares.toFixed(0),
          ratio: (thisSideShares / otherSideShares).toFixed(1),
        });
        await sleep(this.config.signalCheckIntervalMs);
        continue;
      }

      // Budget-reserve
      const thisSideCost = nextSide === "Up" ? costUp : costDn;
      if (otherSideShares === 0 && thisSideCost >= budget * this.config.budgetReservePct) {
        this.logger.debug("Budget-reserve: waiting for other side", {
          side: nextSide,
          thisCost: `$${thisSideCost.toFixed(2)}`,
          limit: `$${(budget * this.config.budgetReservePct).toFixed(2)}`,
        });
        await sleep(this.config.signalCheckIntervalMs);
        continue;
      }

      // Projected combined check
      if (filledUp > 0 && filledDn > 0) {
        const projected = this.projectCombined(
          nextSide, bestAsk, chunkSize, filledUp, filledDn, costUp, costDn,
        );
        if (projected > combinedCents && combinedCents <= this.config.targetCombinedCents) {
          this.logger.debug("Skip: would worsen combined past target", {
            projected: `${projected.toFixed(1)}¢`,
            current: `${combinedCents.toFixed(1)}¢`,
          });
          await sleep(this.config.signalCheckIntervalMs);
          continue;
        }
      }

      // Band-aware chunk sizing
      const currentBand = (filledUp > 0 && filledDn > 0 && combinedCents !== Infinity)
        ? classifyPairQuality(combinedCents) : null;
      let orderSize = orderCount === 0 ? firstLegChunk : this.getAdaptiveChunk(windowStartTime, chunkSize);
      if (combinedCents <= this.config.targetCombinedCents) {
        orderSize = Math.max(10, Math.floor(chunkSize * SignalTakerExecutor.POST_TARGET_CHUNK_PCT));
      }
      // In DEFENSIVE band: smaller chunks to limit damage
      if (currentBand === "DEFENSIVE") {
        orderSize = Math.max(10, Math.floor(orderSize * 0.5));
      }
      const projectedPair = this.projectPairState(nextSide, bestAsk, orderSize, filledUp, filledDn, costUp, costDn);
      if (projectedPair.projectedMarginalPairCostCents > 110) {
        this.logger.warn("Skip expensive rescue leg", {
          side: nextSide,
          projectedMarginalPairCost: `${projectedPair.projectedMarginalPairCostCents.toFixed(1)}¢`,
        });
        await sleep(this.config.signalCheckIntervalMs);
        continue;
      }

      // ── BUY! ──
      const buyPrice = bestAsk + this.config.slippageBuffer;
      const fill = await this.buyOrder(tokenId, orderSize, buyPrice, nextSide);

      if (fill.filled) {
        const fee = polymarketCryptoFee(fill.filledSize, fill.avgPrice);
        totalTakerFees += fee;

        if (nextSide === "Up") {
          filledUp += fill.filledSize;
          costUp += fill.totalCost;
        } else {
          filledDn += fill.filledSize;
          costDn += fill.totalCost;
        }
        availableBudget -= fill.totalCost;
        lastBuySide = nextSide;
        lastBuyTime = Date.now();

        orderFills.push({
          orderNum: orderCount,
          side: nextSide,
          filledSize: fill.filledSize,
          avgPrice: fill.avgPrice,
          totalCost: fill.totalCost,
          fee,
          timestamp: Date.now(),
        });
        orderCount++;

        // Recalc combined
        const avgUp = filledUp > 0 ? costUp / filledUp : 0;
        const avgDn = filledDn > 0 ? costDn / filledDn : 0;
        if (filledUp > 0 && filledDn > 0) {
          combinedCents = (avgUp + avgDn) * 100;
        }

        // Update unpaired tracking
        const isUnpaired = filledUp !== filledDn;
        if (isUnpaired && unpairedStartMs === null) unpairedStartMs = Date.now();
        if (!isUnpaired) unpairedStartMs = null;

        // Re-evaluate state after fill
        const postFillState = sm.evaluate({
          filledUp, filledDn, costUp, costDn,
          unpairedStartMs, timeRemainingS,
          mergeMinSize: this.config.mergeMinSize,
          tick: fillTick,
        });
        const pairBand = combinedCents !== Infinity && filledUp > 0 && filledDn > 0
          ? classifyPairQuality(combinedCents) : null;

        // Record decision with full context
        sm.recordDecision({
          tick: fillTick++, state: postFillState, regime: observation.regime,
          chosenSide: nextSide,
          reason: `FILL ${sideReason} @${(fill.avgPrice*100).toFixed(1)}c x${fill.filledSize.toFixed(0)}`,
          altReason,
          pairBand,
          filledUp, filledDn, combinedCents,
          imbalanceRatio: Math.min(filledUp, filledDn) > 0 ? Math.max(filledUp, filledDn) / Math.min(filledUp, filledDn) : 1,
          unpairedDurationMs: unpairedStartMs ? Date.now() - unpairedStartMs : 0,
          timeRemainingS,
        });

        const pairState = this.projectPairState(nextSide, fill.avgPrice, fill.filledSize, filledUp, filledDn, costUp, costDn);
        this.logger.info("V11 fill", {
          variant: profile.label,
          state: postFillState,
          side: nextSide,
          sideReason,
          price: `${(fill.avgPrice * 100).toFixed(1)}¢`,
          size: fill.filledSize.toFixed(0),
          combined: combinedCents === Infinity ? "—" : `${combinedCents.toFixed(1)}¢`,
          pairBand: pairBand ?? "—",
          marginalPair: `${pairState.projectedMarginalPairCostCents.toFixed(1)}¢`,
          balance: `Up=${filledUp.toFixed(0)} Dn=${filledDn.toFixed(0)}`,
        });

        // STOP conditions driven by state machine
        if (postFillState === "STOP_BUILD") {
          this.logger.info("State machine: STOP_BUILD after fill — exiting", {
            variant: profile.label,
          });
          break;
        }

        // Tail guard: marginal pair cost explosion
        if (pairState.projectedMarginalPairCostCents > 108 && orderCount >= 3) {
          this.logger.warn("TAIL GUARD: stopping accumulation due to expensive marginal pair", {
            marginal: `${pairState.projectedMarginalPairCostCents.toFixed(1)}¢`,
            fills: orderCount,
          });
          break;
        }

        // Circuit breaker
        if (
          combinedCents > this.config.circuitBreakerCents &&
          orderCount >= 5 &&
          filledUp > 0 && filledDn > 0
        ) {
          this.logger.warn("CIRCUIT BREAKER: combined too high, stopping accumulation", {
            combined: `${combinedCents.toFixed(1)}¢`,
            breaker: `${this.config.circuitBreakerCents}¢`,
            fills: orderCount,
          });
          this.telegram.send(
            `🛑 Circuit breaker: ${combinedCents.toFixed(1)}¢ > ${this.config.circuitBreakerCents}¢ after ${orderCount} fills`,
          );
          break;
        }

        // Target reached notification (keep accumulating)
        if (
          combinedCents <= this.config.targetCombinedCents &&
          filledUp > 0 && filledDn > 0
        ) {
          this.logger.info("Target reached!", {
            combined: `${combinedCents.toFixed(1)}¢`,
            target: `${this.config.targetCombinedCents}¢`,
          });
        }

        // ── MID-WINDOW MERGE ──
        // When MERGE_READY with GOOD+ quality and enough time left, merge now
        // and recycle capital for more accumulation (Stargate-style capital recycling)
        const postAllowed = sm.getAllowedActions();
        if (
          postAllowed.canMerge &&
          (postFillState === "MERGE_READY" || postFillState === "NEAR_BALANCED") &&
          pairBand !== null &&
          (pairBand === "IDEAL" || pairBand === "GOOD" || pairBand === "ACCEPTABLE") &&
          timeRemainingS > profile.midWindowMergeMinTimeS
        ) {
          const midMatched = Math.min(filledUp, filledDn);
          if (midMatched >= this.config.mergeMinSize) {
            this.logger.info("Mid-window merge triggered", {
              variant: profile.label,
              state: postFillState,
              band: pairBand,
              matched: midMatched.toFixed(0),
              combined: `${combinedCents.toFixed(1)}¢`,
              timeLeftS: timeRemainingS.toFixed(0),
            });
            const midMerge = await this.doMerge(
              window, midMatched, filledUp, filledDn, costUp, costDn,
            );
            if (midMerge) {
              merges.push(midMerge);
              // Recycle: consume matched shares from both sides.
              // Short side goes to 0. Long side keeps remainder with proportional cost.
              const prevUp = filledUp;
              const prevDn = filledDn;
              const prevCostUp = costUp;
              const prevCostDn = costDn;
              // Both sides lose midMatched shares
              filledUp -= midMatched;
              filledDn -= midMatched;
              // Adjust cost proportionally to remaining shares
              costUp = prevUp > 0 ? prevCostUp * (filledUp / prevUp) : 0;
              costDn = prevDn > 0 ? prevCostDn * (filledDn / prevDn) : 0;
              // Recycle recovered capital back into budget
              availableBudget += midMerge.recovered;
              combinedCents = Infinity; // reset — need new fills to recalc
              unpairedStartMs = (filledUp !== filledDn) ? Date.now() : null;
              // Re-evaluate state after merge
              sm.evaluate({
                filledUp, filledDn, costUp, costDn,
                unpairedStartMs, timeRemainingS,
                mergeMinSize: this.config.mergeMinSize,
                tick: fillTick,
              });
              this.logger.info("Mid-window merge complete — capital recycled", {
                variant: profile.label,
                recovered: `$${midMerge.recovered.toFixed(2)}`,
                profit: `$${midMerge.profit.toFixed(2)}`,
                remainingUp: filledUp.toFixed(0),
                remainingDn: filledDn.toFixed(0),
                newBudget: `$${availableBudget.toFixed(2)}`,
                newState: sm.state,
              });
            }
          }
        }
      }

      await sleep(this.config.signalCheckIntervalMs);
    }

    ({ filledUp, filledDn, costUp, costDn, availableBudget, totalTakerFees, orderCount } =
      await this.chunkedRebalance(
        window,
        { filledUp, filledDn, costUp, costDn, availableBudget, totalTakerFees, orderCount, orderFills, chunkSize },
      ));

    // ═══════════════════════════════════════════════════
    // PHASE 3: MERGE
    // ═══════════════════════════════════════════════════
    const matched = Math.min(filledUp, filledDn);

    if (matched >= profile.mergeMinSize) {
      const avgUp = filledUp > 0 ? costUp / filledUp : 0;
      const avgDn = filledDn > 0 ? costDn / filledDn : 0;
      const finalCombined = (avgUp + avgDn) * 100;

      this.logger.info("Phase 3: Merge", {
        matched: matched.toFixed(0),
        combined: `${finalCombined.toFixed(1)}¢`,
      });

      const mergeResult = await this.doMerge(
        window, matched, filledUp, filledDn, costUp, costDn,
      );
      if (mergeResult) {
        merges.push(mergeResult);
      }
    } else if (matched > 0) {
      this.logger.info("Matched below merge minimum", {
        matched: matched.toFixed(0),
        min: this.config.mergeMinSize,
      });
    }

    // ─── RESULT ───
    const totalMerged = merges.reduce((s, m) => s + m.merged, 0);
    const totalMergeProfit = merges.reduce((s, m) => s + m.profit, 0);
    const avgUp = filledUp > 0 ? costUp / filledUp : 0;
    const avgDn = filledDn > 0 ? costDn / filledDn : 0;
    const finalCombined = (avgUp + avgDn) * 100;

    // Build inventory snapshot
    const pairedShares = Math.min(filledUp, filledDn);
    const unpairedUp = filledUp - pairedShares;
    const unpairedDn = filledDn - pairedShares;
    const upProp = filledUp > 0 ? pairedShares / filledUp : 0;
    const dnProp = filledDn > 0 ? pairedShares / filledDn : 0;
    const pairedCostBasis = costUp * upProp + costDn * dnProp;
    const pairedAvgUp = pairedShares > 0 ? (costUp * upProp) / pairedShares : 0;
    const pairedAvgDn = pairedShares > 0 ? (costDn * dnProp) / pairedShares : 0;
    const pairedCombinedAvgCents = pairedShares > 0 ? (pairedAvgUp + pairedAvgDn) * 100 : 0;
    const mergeableCollateralValue = pairedShares * 1.0;
    const pairedProfit = mergeableCollateralValue - pairedCostBasis;

    const inventory: InventorySnapshot = {
      pairedShares,
      pairedCombinedAvgCents,
      unpairedUp,
      unpairedDown: unpairedDn,
      unpairedExposureDurationMs: 0, // at window end, exposure is resolved
      mergeableCollateralValue,
      pairedCostBasis,
      pairedProfit,
    };

    result.orderFills = orderFills;
    result.merges = merges;
    result.totalUpShares = filledUp;
    result.totalDnShares = filledDn;
    result.totalUpCost = costUp;
    result.totalDnCost = costDn;
    result.totalMerged = totalMerged;
    result.totalMergeProfit = totalMergeProfit;
    result.remainingUp = filledUp - totalMerged;
    result.remainingDn = filledDn - totalMerged;
    result.totalCost = costUp + costDn;
    result.avgCombinedCents = finalCombined;
    result.takerFees = totalTakerFees;
    result.inventory = inventory;

    // State machine final summary
    const smSummary = sm.summary(filledUp, filledDn, costUp, costDn);
    this.logger.info("=== V11 Window Summary ===", {
      variant: profile.label,
      fills: orderCount,
      up: `${filledUp.toFixed(0)}@${(avgUp * 100).toFixed(1)}¢`,
      dn: `${filledDn.toFixed(0)}@${(avgDn * 100).toFixed(1)}¢`,
      combined: `${finalCombined.toFixed(1)}¢`,
      pairBand: smSummary.pairBand ?? "—",
      finalState: smSummary.state,
      stateTransitions: smSummary.transitionCount,
      paired: `${pairedShares.toFixed(0)}sh @${pairedCombinedAvgCents.toFixed(1)}¢`,
      unpaired: `Up=${unpairedUp.toFixed(0)} Dn=${unpairedDn.toFixed(0)}`,
      merged: totalMerged.toFixed(0),
      profit: `$${totalMergeProfit.toFixed(2)}`,
      pairedProfit: `$${pairedProfit.toFixed(2)}`,
    });

    // Log all state transitions for this window
    if (sm.transitions.length > 0) {
      this.logger.info("State transitions", {
        variant: profile.label,
        transitions: sm.transitions.map(t => `${t.from}->${t.to} (${t.reason})`),
      });
    }

    // Log decision summary (how many fills, skips, and reasons)
    const decisions = sm.decisions;
    const fillDecisions = decisions.filter(d => d.chosenSide !== null && d.reason.startsWith("FILL"));
    const skipDecisions = decisions.filter(d => d.chosenSide === null || !d.reason.startsWith("FILL"));
    if (decisions.length > 0) {
      const sideReasons = fillDecisions.reduce((acc, d) => {
        const key = d.reason.split(" ")[1] ?? "unknown"; // extract sideReason
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      this.logger.info("Fill decision summary", {
        variant: profile.label,
        totalDecisions: decisions.length,
        fills: fillDecisions.length,
        skips: skipDecisions.length,
        sideReasons,
      });
    }

    audit.finalAction = orderCount > 0 ? "trade" : (result.skipped ? "skip" : "no_fill");
    audit.finalReason = result.skipReason ?? (orderCount > 0 ? "filled" : "no_fill");
    this.logger.info("Variant decision audit", audit);

    // ── SINGLE TG MESSAGE ──
    if (totalMerged > 0) {
      const emoji = totalMergeProfit > 0 ? "+" : "";
      let msg = `${totalMergeProfit > 0 ? "✅" : "❌"} ${totalMerged.toFixed(0)}sh merged | ` +
        `paired@${pairedCombinedAvgCents.toFixed(1)}¢ | ${emoji}$${totalMergeProfit.toFixed(2)}`;
      if (unpairedUp > 0 || unpairedDn > 0) {
        msg += `\n⚠️ Unpaired: Up=${unpairedUp.toFixed(0)} Dn=${unpairedDn.toFixed(0)} (hedge failed)`;
      }
      this.telegram.send(msg);
    } else if (orderCount > 0) {
      this.telegram.send(
        `⚠️ ${orderCount} fills, no merge | paired=${pairedShares.toFixed(0)}@${pairedCombinedAvgCents.toFixed(1)}¢ | Up=${filledUp.toFixed(0)} Dn=${filledDn.toFixed(0)}`,
      );
    }

    return result;
  }

  // ─── MOMENTUM HELPERS ───

  /**
   * Choose which side to buy next.
   * Priority: 1) side behind, 2) alternate from last, 3) cheaper ask (first buy), 4) momentum.
   */
  private chooseNextSide(
    regime: Regime,
    lastBuySide: TradeSide | null,
    filledUp: number,
    filledDn: number,
    costUp: number,
    costDn: number,
    dipFromHigh: number,
    bounceFromLow: number,
    window: WindowInfo,
    isFirstBuy: boolean,
  ): TradeSide | null {
    // Preferred side: whichever has fewer shares (strict alternation / catch-up)
    let preferred: TradeSide | null = null;
    if (filledUp < filledDn) preferred = "Up";
    else if (filledDn < filledUp) preferred = "Down";
    else if (lastBuySide === "Up") preferred = "Down";
    else if (lastBuySide === "Down") preferred = "Up";

    // First buy order is regime-aware: oscillation=cheaper-first, trend=expensive-first.
    if (isFirstBuy) {
      const upBook = this.getBook(window.upTokenId);
      const dnBook = this.getBook(window.downTokenId);
      const upAsk = this.getAskPrice(upBook) ?? 1.0;
      const dnAsk = this.getAskPrice(dnBook) ?? 1.0;
      if (regime === "TREND") {
        return dnAsk > upAsk ? "Down" : "Up";
      }
      return dnAsk < upAsk ? "Down" : "Up";
    }

    // Try preferred side first
    if (preferred) {
      const prefToken = preferred === "Up" ? window.upTokenId : window.downTokenId;
      const prefBook = this.getBook(prefToken);
      const prefAsk = this.getAskPrice(prefBook);
      const cap = this.getPriceCap(regime, false, preferred, filledUp, filledDn, costUp, costDn);
      if (prefAsk !== null && prefAsk < cap) {
        return preferred;
      }
      // Preferred side too expensive — wait. Do NOT fall through to buy the other side,
      // as that creates runaway imbalance (the imbalance guard in the caller is the last resort).
      return null;
    }

    // Equal and no last buy: use momentum
    if (dipFromHigh > SignalTakerExecutor.REVERSAL_THRESHOLD) return "Up";
    if (bounceFromLow > SignalTakerExecutor.REVERSAL_THRESHOLD) return "Down";

    return null;
  }

  /**
   * Check if BTC price is moving favorably for buying this side.
   * Uses direct price momentum instead of EMA crossover.
   */
  private isGoodTimeToBuy(side: TradeSide, dipFromHigh: number, bounceFromLow: number): boolean {
    const threshold = SignalTakerExecutor.REVERSAL_THRESHOLD;
    if (side === "Up") {
      // Up gets cheaper when BTC falls from recent high
      return dipFromHigh > threshold;
    } else {
      // Down gets cheaper when BTC rises from recent low
      return bounceFromLow > threshold;
    }
  }

  /**
   * Dynamic interval based on distance from target combined.
   * Far from target → short interval (aggressive).
   * Close to target → longer interval (selective).
   */
  private computeInterval(combinedCents: number): number {
    // V11: Much faster intervals for micro-fill density.
    // Stargate uses many small fills (30-60+ per window).
    // Old V10: 1.5s-12s → real ~10-15 fills. New: 0.8s-4s → target 30-50+ fills.
    if (combinedCents === Infinity) return 800;  // no data yet, go fast

    const target = this.config.targetCombinedCents;
    const dist = target - combinedCents; // positive = below target (good)

    if (dist > 15) return 800;    // very far below target: 0.8s (aggressive)
    if (dist > 8)  return 1200;   // far below: 1.2s
    if (dist > 3)  return 2000;   // getting close: 2s
    if (dist > 0)  return 3000;   // near target: 3s
    return 4000;                   // at/above target: 4s (still active, not frozen)
  }

  /**
   * Project what combined cost would be after buying `size` shares of `side` at `askPrice`.
   */
  private projectCombined(
    side: TradeSide,
    askPrice: number,
    size: number,
    filledUp: number,
    filledDn: number,
    costUp: number,
    costDn: number,
  ): number {
    const estCost = size * askPrice;
    let newAvgUp: number;
    let newAvgDn: number;

    if (side === "Up") {
      newAvgUp = (costUp + estCost) / (filledUp + size);
      newAvgDn = costDn / filledDn;
    } else {
      newAvgUp = costUp / filledUp;
      newAvgDn = (costDn + estCost) / (filledDn + size);
    }

    return (newAvgUp + newAvgDn) * 100;
  }

  private async observeAndClassify(window: WindowInfo, btcOpen: number, chunkSize: number, profile: TimeframeProfile): Promise<ObservationResult> {
    const until = Date.now() + profile.observationPeriodS * 1000;
    const prices: number[] = [btcOpen];
    let reversals = 0;
    let lastDir = 0;
    let upSpreadSum = 0;
    let dnSpreadSum = 0;
    let samples = 0;
    let upDepthSum = 0;
    let dnDepthSum = 0;
    let refillHits = 0;
    let lastUpDepth = 0;
    let lastDnDepth = 0;

    while (Date.now() < until) {
      const btcNow = this.binance.price;
      if (btcNow) {
        const prev = prices[prices.length - 1] ?? btcNow;
        const delta = (btcNow - prev) / prev;
        const dir = delta > 0 ? 1 : delta < 0 ? -1 : 0;
        if (dir !== 0 && lastDir !== 0 && dir !== lastDir && Math.abs(delta) >= SignalTakerExecutor.REVERSAL_THRESHOLD / 3) {
          reversals++;
        }
        if (dir !== 0) lastDir = dir;
        prices.push(btcNow);
      }

      const upBook = this.getBook(window.upTokenId);
      const dnBook = this.getBook(window.downTokenId);
      const upSpread = this.getSpreadCents(upBook);
      const dnSpread = this.getSpreadCents(dnBook);
      if (upSpread !== null) upSpreadSum += upSpread;
      if (dnSpread !== null) dnSpreadSum += dnSpread;

      const upDepth = this.depthWithinBand(upBook, this.getAskPrice(upBook), 0.02);
      const dnDepth = this.depthWithinBand(dnBook, this.getAskPrice(dnBook), 0.02);
      upDepthSum += upDepth;
      dnDepthSum += dnDepth;
      if (upDepth > lastUpDepth * 0.95 || dnDepth > lastDnDepth * 0.95) refillHits++;
      lastUpDepth = upDepth;
      lastDnDepth = dnDepth;
      samples++;
      await sleep(SignalTakerExecutor.OBSERVATION_SAMPLE_MS);
    }

    const btcNow = this.binance.price ?? btcOpen;
    const distanceToOpenPct = Math.abs(btcNow - btcOpen) / btcOpen;
    const avgUpSpreadCents = samples > 0 ? upSpreadSum / samples : 99;
    const avgDnSpreadCents = samples > 0 ? dnSpreadSum / samples : 99;
    const upDepthWithinBand = samples > 0 ? upDepthSum / samples : 0;
    const dnDepthWithinBand = samples > 0 ? dnDepthSum / samples : 0;
    const refillScore = samples > 0 ? refillHits / samples : 0;

    let regime: Regime;
    if (distanceToOpenPct >= this.config.trendSkipThreshold) regime = "SKIP";
    else if (distanceToOpenPct <= this.config.oscillationThreshold && reversals >= 2) regime = "OSCILLATION";
    else regime = "TREND";

    this.logger.info("Observation complete", {
      regime,
      distance: `${(distanceToOpenPct * 100).toFixed(3)}%`,
      reversals,
      spread: `Up=${avgUpSpreadCents.toFixed(2)}¢ Dn=${avgDnSpreadCents.toFixed(2)}¢`,
      depth: `Up=${upDepthWithinBand.toFixed(0)} Dn=${dnDepthWithinBand.toFixed(0)}`,
      probeChunk: Math.max(10, Math.floor(chunkSize * this.config.probeChunkPct)),
    });

    return { regime, avgUpSpreadCents, avgDnSpreadCents, upDepthWithinBand, dnDepthWithinBand, reversals, distanceToOpenPct, refillScore };
  }

  private assessHedgeFeasibility(
    window: WindowInfo,
    chunkSize: number,
    observation: ObservationResult,
  ): { ok: boolean; reason?: string } {
    const secondsLeft = Math.max(0, (window.endTime - Date.now()) / 1000);
    const requiredSeconds = Math.max(this.config.stopBuyingBeforeEndS + 15, 65);
    if (secondsLeft < requiredSeconds) return { ok: false, reason: "Too little time left for safe hedging" };
    if (observation.avgUpSpreadCents > this.config.maxSpreadCents || observation.avgDnSpreadCents > this.config.maxSpreadCents) {
      return { ok: false, reason: "Spread quality too poor for chunked hedge" };
    }
    const minDepthNeed = Math.max(15, chunkSize * SignalTakerExecutor.REBALANCE_CHUNK_PCT);
    if (observation.upDepthWithinBand < minDepthNeed || observation.dnDepthWithinBand < minDepthNeed) {
      return { ok: false, reason: "Insufficient depth in intended hedge band" };
    }
    if (observation.refillScore < 0.20) {
      return { ok: false, reason: "Book refill resilience too weak" };
    }
    const hedgeableChunksUp = observation.upDepthWithinBand / minDepthNeed;
    const hedgeableChunksDn = observation.dnDepthWithinBand / minDepthNeed;
    if (Math.min(hedgeableChunksUp, hedgeableChunksDn) < SignalTakerExecutor.MIN_HEDGEABLE_CHUNKS) {
      return { ok: false, reason: "Opposite side not hedgeable in chunks" };
    }
    return { ok: true };
  }

  private getAdaptiveChunk(windowStartTime: number, baseChunk: number): number {
    const elapsedS = (Date.now() - windowStartTime) / 1000;
    if (elapsedS <= this.config.probePhaseEndS) {
      return Math.max(10, Math.floor(baseChunk * this.config.probeChunkPct));
    }
    return baseChunk;
  }

  private projectPairState(
    side: TradeSide,
    askPrice: number,
    size: number,
    filledUp: number,
    filledDn: number,
    costUp: number,
    costDn: number,
  ): { projectedMarginalPairCostCents: number } {
    const beforePaired = Math.min(filledUp, filledDn);
    const projectedUp = side === "Up" ? filledUp + size : filledUp;
    const projectedDn = side === "Down" ? filledDn + size : filledDn;
    const projectedPaired = Math.min(projectedUp, projectedDn);
    const newPairs = Math.max(0, projectedPaired - beforePaired);
    const marginal = newPairs > 0 ? askPrice * 100 : (askPrice + 0.60) * 100;
    return { projectedMarginalPairCostCents: marginal };
  }

  private resolveSideByPairQuality(
    preferredSide: TradeSide,
    regime: Regime,
    isFirstBuy: boolean,
    filledUp: number,
    filledDn: number,
    costUp: number,
    costDn: number,
    chunkSize: number,
    window: WindowInfo,
  ): TradeSide {
    const candidateSides: TradeSide[] = preferredSide === "Up" ? ["Up", "Down"] : ["Down", "Up"];
    let best: { side: TradeSide; score: number } = { side: preferredSide, score: Number.POSITIVE_INFINITY };
    for (const side of candidateSides) {
      const tokenId = side === "Up" ? window.upTokenId : window.downTokenId;
      const ask = this.getAskPrice(this.getBook(tokenId));
      const sideCap = this.getPriceCap(regime, isFirstBuy, side, filledUp, filledDn, costUp, costDn);
      if (ask === null || ask >= sideCap) continue;
      const chunk = Math.max(10, Math.floor(chunkSize * this.config.probeChunkPct));
      const pair = this.projectPairState(side, ask, chunk, filledUp, filledDn, costUp, costDn);
      const imbalancePenalty = side === "Up" ? Math.max(0, (filledUp + chunk) - filledDn) : Math.max(0, (filledDn + chunk) - filledUp);
      const score = pair.projectedMarginalPairCostCents + imbalancePenalty * 0.08;
      if (score < best.score) best = { side, score };
    }
    return best.side;
  }

  private getPriceCap(
    regime: Regime,
    isFirstBuy: boolean,
    side: TradeSide,
    filledUp: number,
    filledDn: number,
    costUp: number,
    costDn: number,
  ): number {
    if (regime === "TREND" && isFirstBuy) {
      return Math.max(this.config.cheapThreshold, SignalTakerExecutor.TREND_FIRST_LEG_MAX_PRICE);
    }
    const isBalancingSide =
      (side === "Up" && filledUp < filledDn) ||
      (side === "Down" && filledDn < filledUp);
    if (!isFirstBuy && isBalancingSide) {
      const longAvg = side === "Up"
        ? (filledDn > 0 ? costDn / filledDn : 0)
        : (filledUp > 0 ? costUp / filledUp : 0);
      // Balance-friendly cap: allow a little above target-implied hedge price
      // to improve hedge completion without permitting expensive rescues.
      const targetCap = (this.config.targetCombinedCents / 100) - longAvg + SignalTakerExecutor.BALANCE_PRICE_BUFFER;
      const hedgeCap = Math.min(this.config.rebalanceMaxPrice, Math.max(this.config.cheapThreshold, targetCap));
      return hedgeCap;
    }
    return this.config.cheapThreshold;
  }

  private isOneSidedToxic(window: WindowInfo): boolean {
    const upAsk = this.getAskPrice(this.getBook(window.upTokenId));
    const dnAsk = this.getAskPrice(this.getBook(window.downTokenId));
    if (upAsk === null || dnAsk === null) return false;
    return (
      (upAsk <= SignalTakerExecutor.ONE_SIDED_EXTREME_LOW && dnAsk >= SignalTakerExecutor.ONE_SIDED_EXTREME_HIGH) ||
      (dnAsk <= SignalTakerExecutor.ONE_SIDED_EXTREME_LOW && upAsk >= SignalTakerExecutor.ONE_SIDED_EXTREME_HIGH)
    );
  }

  private async awaitBinancePrice(): Promise<number | null> {
    const until = Date.now() + SignalTakerExecutor.BINANCE_BOOTSTRAP_WAIT_MS;
    while (Date.now() < until) {
      const price = this.binance.price;
      if (price) return price;
      await sleep(250);
    }
    return this.binance.price ?? null;
  }

  private projectCombinedAfterRebalance(
    shortSide: TradeSide,
    ask: number,
    chunk: number,
    filledUp: number,
    filledDn: number,
    costUp: number,
    costDn: number,
  ): number {
    if (shortSide === "Up") {
      const nextUp = filledUp + chunk;
      const nextCostUp = costUp + chunk * ask;
      const avgUp = nextCostUp / Math.max(nextUp, 1);
      const avgDn = costDn / Math.max(filledDn, 1);
      return (avgUp + avgDn) * 100;
    }
    const nextDn = filledDn + chunk;
    const nextCostDn = costDn + chunk * ask;
    const avgUp = costUp / Math.max(filledUp, 1);
    const avgDn = nextCostDn / Math.max(nextDn, 1);
    return (avgUp + avgDn) * 100;
  }

  private async chunkedRebalance(
    window: WindowInfo,
    state: {
      filledUp: number; filledDn: number; costUp: number; costDn: number; availableBudget: number;
      totalTakerFees: number; orderCount: number; orderFills: OrderFill[]; chunkSize: number;
    },
  ): Promise<{
    filledUp: number; filledDn: number; costUp: number; costDn: number; availableBudget: number; totalTakerFees: number; orderCount: number;
  }> {
    let { filledUp, filledDn, costUp, costDn, availableBudget, totalTakerFees, orderCount, orderFills, chunkSize } = state;
    for (let attempt = 0; attempt < 6; attempt++) {
      const imbalance = Math.abs(filledUp - filledDn);
      if (imbalance <= 0 || availableBudget <= 0) break;
      const shortSide: TradeSide = filledUp > filledDn ? "Down" : "Up";
      const shortToken = shortSide === "Up" ? window.upTokenId : window.downTokenId;
      const chunk = Math.max(10, Math.min(imbalance, Math.floor(chunkSize * SignalTakerExecutor.REBALANCE_CHUNK_PCT)));
      const longSideAvg = shortSide === "Down" ? (filledUp > 0 ? costUp / filledUp : 0) : (filledDn > 0 ? costDn / filledDn : 0);
      const dynamicSoftCap = 1 - longSideAvg + SignalTakerExecutor.REBALANCE_OVERPAY;
      const softCap = Math.min(dynamicSoftCap, SignalTakerExecutor.SOFT_HEDGE_CAP);
      const hardCap = this.config.rebalanceMaxPrice;

      const book = await this.getRebalanceBook(shortToken);
      const ask = this.getAskPrice(book);
      if (ask === null) continue;
      const cap = ask <= softCap ? softCap : hardCap;
      if (ask > cap) continue;
      const projectedCombined = this.projectCombinedAfterRebalance(
        shortSide,
        ask,
        chunk,
        filledUp,
        filledDn,
        costUp,
        costDn,
      );
      if (projectedCombined > SignalTakerExecutor.MAX_RESCUE_COMBINED_CENTS) {
        this.logger.warn("Rebalance stop: projected combined too expensive", {
          projectedCombined: `${projectedCombined.toFixed(1)}¢`,
          max: `${SignalTakerExecutor.MAX_RESCUE_COMBINED_CENTS}¢`,
          shortSide,
          chunk: chunk.toFixed(0),
        });
        break;
      }

      const fill = await this.buyOrder(shortToken, chunk, ask + this.config.slippageBuffer, shortSide);
      if (!fill.filled) continue;
      const fee = polymarketCryptoFee(fill.filledSize, fill.avgPrice);
      totalTakerFees += fee;
      if (shortSide === "Up") { filledUp += fill.filledSize; costUp += fill.totalCost; }
      else { filledDn += fill.filledSize; costDn += fill.totalCost; }
      availableBudget -= fill.totalCost;
      orderFills.push({ orderNum: orderCount++, side: shortSide, filledSize: fill.filledSize, avgPrice: fill.avgPrice, totalCost: fill.totalCost, fee, timestamp: Date.now() });
      this.telegram.send(`🔒 Hedged: ${fill.filledSize.toFixed(0)}sh ${shortSide} @${(fill.avgPrice * 100).toFixed(1)}¢`);
      this.logger.info("Chunked hedge fill", {
        shortSide,
        chunk: chunk.toFixed(0),
        ask: `${(ask * 100).toFixed(1)}¢`,
        softCap: `${(softCap * 100).toFixed(1)}¢`,
        hardCap: `${(hardCap * 100).toFixed(1)}¢`,
      });
      if (ask > softCap) await sleep(1200);
    }

    const rest = Math.abs(filledUp - filledDn);
    if (rest > 0) {
      const shortSide: TradeSide = filledUp > filledDn ? "Down" : "Up";
      this.telegram.send(`🔴 HEDGE FAILED: ${rest.toFixed(0)}sh ${shortSide} — NO liquidity below ${(this.config.rebalanceMaxPrice * 100).toFixed(0)}¢`);
    }
    return { filledUp, filledDn, costUp, costDn, availableBudget, totalTakerFees, orderCount };
  }

  private depthWithinBand(book: BookSnapshot | null, bestAsk: number | null, band: number): number {
    if (!book || bestAsk === null) return 0;
    const maxAsk = bestAsk + band;
    return (book.asks ?? []).filter((a) => a.price <= maxAsk).reduce((s, a) => s + a.size, 0);
  }

  private getSpreadCents(book: BookSnapshot | null): number | null {
    if (!book || book.bestAsk === null || book.bestBid === null) return null;
    return Math.max(0, (book.bestAsk - book.bestBid) * 100);
  }

  // ─── PRIVATE METHODS (unchanged) ───

  /**
   * Get book for rebalance: if WS ask looks stale/empty (null or ≥ 90¢),
   * fetch a fresh snapshot via REST. At end-of-window, MMs pull orders
   * and WS book can show 1.0 or be empty.
   */
  private async getRebalanceBook(tokenId: string): Promise<BookSnapshot | null> {
    const wsBook = this.getBook(tokenId);
    const wsAsk = this.getAskPrice(wsBook);

    // WS book looks reasonable
    if (wsAsk !== null && wsAsk < 0.90) {
      return wsBook;
    }

    // WS book is stale/empty — try REST
    this.logger.debug("Rebalance: WS book stale, fetching REST snapshot", {
      wsAsk: wsAsk !== null ? `${(wsAsk * 100).toFixed(1)}¢` : "null",
    });
    try {
      const ob = await this.clob.getOrderbook(tokenId);
      return {
        assetId: tokenId,
        bids: ob.bids.map(b => ({ price: b.price, size: b.size })),
        asks: ob.asks.map(a => ({ price: a.price, size: a.size })),
        bestBid: ob.bestBid,
        bestAsk: ob.bestAsk,
      };
    } catch {
      return wsBook; // fallback to whatever WS had
    }
  }

  private getBook(tokenId: string): BookSnapshot | null {
    if (this.config.dryRun && this.dryRunEngine) {
      return this.dryRunEngine.getBookView(tokenId);
    }
    return this.clobWs.getBook(tokenId);
  }

  /** Get best ask price from book — uses asks[0] first, falls back to bestAsk, never defaults to 1.0 */
  private getAskPrice(book: BookSnapshot | null): number | null {
    if (!book) return null;
    if (book.asks.length > 0) return book.asks[0].price;
    if (book.bestAsk !== null) return book.bestAsk;
    return null;
  }

  /**
   * Buy as taker: FOK order against the ask.
   */
  private async buyOrder(
    tokenId: string,
    size: number,
    maxPrice: number,
    side: TradeSide,
  ): Promise<{ filled: boolean; filledSize: number; avgPrice: number; totalCost: number }> {
    if (this.config.dryRun && this.dryRunEngine) {
      return this.dryRunEngine.simulateFokBuy(tokenId, size, maxPrice, side);
    }

    // LIVE: FOK taker order
    const amount = size * maxPrice;
    const result = await this.clob.placeMarketOrderFOK({
      tokenId,
      side: Side.BUY,
      amount,
      worstPrice: maxPrice,
    });

    if (!result.filled || result.orderIds.length === 0) {
      return { filled: false, filledSize: 0, avgPrice: 0, totalCost: 0 };
    }

    const fills = await this.clob.getOrderFills(result.orderIds);
    let totalShares = 0;
    let totalCost = 0;
    for (const fill of fills) {
      totalShares += fill.sizeMatched;
      totalCost += fill.costFilled;
    }

    const avgPrice = totalShares > 0 ? totalCost / totalShares : 0;
    const fee = polymarketCryptoFee(totalShares, avgPrice);
    return {
      filled: totalShares > 0,
      filledSize: totalShares,
      avgPrice,
      totalCost: totalCost + fee,
    };
  }

  private async preFlightCheck(
    window: WindowInfo,
  ): Promise<{ pass: boolean; reason?: string }> {
    let upBook = this.clobWs.getBook(window.upTokenId);
    let dnBook = this.clobWs.getBook(window.downTokenId);

    const upLevelsWs = upBook?.asks?.length ?? 0;
    const dnLevelsWs = dnBook?.asks?.length ?? 0;

    // If either book is missing or has insufficient depth from WS,
    // fall back to REST API for a fresh full snapshot
    if (!upBook || !dnBook || upLevelsWs < this.config.minBookLevels || dnLevelsWs < this.config.minBookLevels) {
      this.logger.debug("PreFlight: WS book thin/missing, fetching REST snapshot", {
        upLevelsWs, dnLevelsWs,
      });
      try {
        const upOb = await this.clob.getOrderbook(window.upTokenId);
        const dnOb = await this.clob.getOrderbook(window.downTokenId);
        upBook = { assetId: window.upTokenId, bids: upOb.bids.map(b => ({ price: b.price, size: b.size })), asks: upOb.asks.map(a => ({ price: a.price, size: a.size })), bestBid: upOb.bestBid, bestAsk: upOb.bestAsk };
        dnBook = { assetId: window.downTokenId, bids: dnOb.bids.map(b => ({ price: b.price, size: b.size })), asks: dnOb.asks.map(a => ({ price: a.price, size: a.size })), bestBid: dnOb.bestBid, bestAsk: dnOb.bestAsk };
      } catch (err) {
        return { pass: false, reason: `REST orderbook fetch failed: ${(err as Error).message}` };
      }
    }

    if (!upBook || !dnBook) {
      return { pass: false, reason: "No orderbook data" };
    }

    const upLevels = upBook.asks?.length ?? 0;
    const dnLevels = dnBook.asks?.length ?? 0;
    if (upLevels < this.config.minBookLevels || dnLevels < this.config.minBookLevels) {
      return { pass: false, reason: `Insufficient depth: Up=${upLevels} Dn=${dnLevels}` };
    }

    const top3Up = (upBook.asks ?? []).slice(0, 3);
    const top3Dn = (dnBook.asks ?? []).slice(0, 3);
    const fmt = (levels: { price: number; size: number }[]) =>
      levels.map(l => `${(l.price * 100).toFixed(1)}¢×${l.size}`).join(" | ");
    this.logger.info("Book snapshot", { upAsks: fmt(top3Up), dnAsks: fmt(top3Dn) });

    return { pass: true };
  }

  private async doMerge(
    window: WindowInfo,
    amount: number,
    upShares: number,
    dnShares: number,
    upCost: number,
    dnCost: number,
  ): Promise<MergeResult | null> {
    if (this.config.dryRun && this.dryRunEngine) {
      const sim = this.dryRunEngine.simulateMerge(amount);
      return sim.merged > 0 ? { merged: sim.merged, recovered: sim.recovered, profit: sim.profit, timestamp: Date.now() } : null;
    }

    if (!this.redeem) {
      this.logger.warn("Merge requested but no RedeemService available");
      return null;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s
    let txHash: string | null = null;
    for (let attempt = 0; attempt < SignalTakerExecutor.MERGE_MAX_RETRIES; attempt++) {
      txHash = await this.redeem.mergePositions(window.conditionId, amount, window.negRisk);
      if (txHash) break;
      const delayMs = 1000 * Math.pow(2, attempt);
      this.logger.warn(`Merge attempt ${attempt + 1}/${SignalTakerExecutor.MERGE_MAX_RETRIES} failed, retrying in ${delayMs}ms...`);
      await sleep(delayMs);
    }
    if (!txHash) {
      this.logger.error("Merge FAILED after all retries — holding for resolution", {
        attempts: SignalTakerExecutor.MERGE_MAX_RETRIES,
        shares: amount.toFixed(0),
      });
      this.telegram.send(`🔴 Merge failed after ${SignalTakerExecutor.MERGE_MAX_RETRIES} retries! ${amount.toFixed(0)}sh held`);
      return null;
    }

    const recovered = amount * 1.0;
    const upAvg = upShares > 0 ? upCost / upShares : 0;
    const dnAvg = dnShares > 0 ? dnCost / dnShares : 0;
    const profit = recovered - amount * (upAvg + dnAvg);

    return { merged: amount, recovered, profit, timestamp: Date.now() };
  }

  private getSessionChunkSize(balance: number): number {
    const today = new Date().toISOString().slice(0, 10);
    if (this.sessionChunkSize !== null && this.sessionChunkDate === today) {
      return this.sessionChunkSize;
    }

    const budget = balance * this.config.equityPerWindow;
    // V11: micro-fill density — target 60+ fills per window (Stargate-style)
    const estimatedFills = 60;
    const estimatedAvgPrice = 0.42;
    const rawChunk = Math.floor(budget / (estimatedFills * estimatedAvgPrice));
    const chunkSize = Math.min(Math.max(rawChunk, 10), this.config.maxChunkSize);

    this.sessionChunkSize = chunkSize;
    this.sessionChunkDate = today;
    this.logger.info("Session chunk size", { balance: `$${balance.toFixed(2)}`, chunkSize });

    return chunkSize;
  }
}
