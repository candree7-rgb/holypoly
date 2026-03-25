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
 * SignalTakerExecutor V10: Regime-aware pair construction with hard tail-loss control.
 */
export class SignalTakerExecutor {
  private dryRunEngine: DryRunEngine | null = null;
  private sessionChunkSize: number | null = null;
  private sessionChunkDate: string | null = null;

  private static readonly OBSERVATION_SAMPLE_MS = 500;
  private static readonly MIN_HEDGEABLE_CHUNKS = 2;
  private static readonly FIRST_LEG_MULTIPLIER = 0.25;
  private static readonly FIRST_LEG_MIN_SHARES = 31;
  private static readonly FIRST_LEG_MAX_SHARES = 46;
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
   * Execute V7 adaptive strategy for one 5-minute window.
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

    const chunkSize = this.getSessionChunkSize(balance);
    const firstLegChunk = Math.min(
      SignalTakerExecutor.FIRST_LEG_MAX_SHARES,
      Math.max(SignalTakerExecutor.FIRST_LEG_MIN_SHARES, Math.floor(chunkSize * SignalTakerExecutor.FIRST_LEG_MULTIPLIER)),
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

    // Price momentum state: rolling window of recent BTC prices
    const priceHistory: number[] = [btcOpen];
    let rollingHigh = btcOpen;
    let rollingLow = btcOpen;

    this.logger.info("=== V10 Regime Window Start ===", {
      btc: `$${btcOpen.toFixed(0)}`,
      budget: `$${budget.toFixed(0)}`,
      chunk: chunkSize,
      firstLegChunk,
      target: `${this.config.targetCombinedCents}¢`,
    });

    // Phase A/B gate: observe + classify + hedge-feasibility before first fill.
    const observation = await this.observeAndClassify(window, btcOpen, chunkSize);
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
    const feasible = this.assessHedgeFeasibility(window, chunkSize, observation);
    if (!feasible.ok) {
      result.skipped = true;
      result.skipReason = feasible.reason;
      this.telegram.send(`⏭️ Skip: ${feasible.reason}`);
      return result;
    }

    // ═══════════════════════════════════════════════════
    // PHASE 1: MOMENTUM-BASED ACCUMULATION
    // Strict alternation, price-reversal timed, combined-improving
    // ═══════════════════════════════════════════════════
    const stopBuyingTime = window.endTime - this.config.stopBuyingBeforeEndS * 1000;
    const windowStartTime = Date.now();

    while (
      Date.now() < stopBuyingTime &&
      availableBudget > chunkSize * 0.20 &&
      orderCount < this.config.maxOrdersPerWindow
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
      const minTimeForFirstLeg = observation.regime === "OSCILLATION"
        ? SignalTakerExecutor.MIN_TIME_FOR_NEW_FIRST_LEG_OSC_S
        : SignalTakerExecutor.MIN_TIME_FOR_NEW_FIRST_LEG_S;
      if (isFirstBuy && timeRemainingS < minTimeForFirstLeg) {
        this.logger.info("Skip late first-leg opening", { timeRemainingS: timeRemainingS.toFixed(1) });
        break;
      }

      // Determine which side to buy (strict alternation + balance + momentum)
      let nextSide = this.chooseNextSide(
        observation.regime, lastBuySide, filledUp, filledDn, costUp, costDn, dipFromHigh, bounceFromLow, window, isFirstBuy,
      );
      if (!nextSide) {
        await sleep(this.config.signalCheckIntervalMs);
        continue;
      }
      nextSide = this.resolveSideByPairQuality(
        nextSide,
        observation.regime,
        isFirstBuy,
        filledUp,
        filledDn,
        costUp,
        costDn,
        chunkSize,
        window,
      );
      const shortSide: TradeSide = filledUp > filledDn ? "Down" : "Up";
      if (!isFirstBuy && filledUp !== filledDn && nextSide !== shortSide) {
        // Balancing-only mode: once unpaired inventory exists, prioritize hedge completion.
        nextSide = shortSide;
      }

      // Dynamic interval: momentum-aware timing (no hard gate!)
      // Good momentum → short interval (aggressive). No signal → normal interval. Near target → longer.
      const hasBothSides = filledUp > 0 && filledDn > 0;
      const hasMomentum = this.isGoodTimeToBuy(nextSide, dipFromHigh, bounceFromLow);
      const baseInterval = this.computeInterval(combinedCents);
      // Momentum bonus: buy faster when BTC favors this side, slower when not
      const minInterval = hasBothSides && !hasMomentum
        ? Math.max(baseInterval, 3000)  // no signal → at least 3s, but still buy!
        : baseInterval;                  // momentum aligned or first buys → use base
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

      // Safety cap: prevent buying a side so expensive that combined > $1 (guaranteed loss).
      // The projectedCombined check (below) handles the softer target check.
      // cheapThreshold is the absolute max we'll pay for any single side.
      const sidePriceCap = this.getPriceCap(
        observation.regime,
        isFirstBuy,
        nextSide,
        filledUp,
        filledDn,
        costUp,
        costDn,
      );
      if (bestAsk >= sidePriceCap) {
        this.logger.debug("Ask above safety cap", {
          side: nextSide,
          ask: `${(bestAsk * 100).toFixed(1)}¢`,
          cap: `${(sidePriceCap * 100).toFixed(0)}¢`,
          regime: observation.regime,
          isFirstBuy,
        });
        await sleep(this.config.signalCheckIntervalMs);
        continue;
      }

      // Imbalance guard: never let one side exceed MAX_IMBALANCE_RATIO× the other side's shares.
      // This prevents the runaway accumulation bug where cheap side is bought endlessly.
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

      // Budget-reserve: max 50% on one side until other side has ≥1 fill
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

      // Projected combined check: only buy if it improves (or is first buy on a side)
      if (filledUp > 0 && filledDn > 0) {
        const projected = this.projectCombined(
          nextSide, bestAsk, chunkSize, filledUp, filledDn, costUp, costDn,
        );
        // Only block if we're already at/below target and this would worsen it
        if (projected > combinedCents && combinedCents <= this.config.targetCombinedCents) {
          this.logger.debug("Skip: would worsen combined past target", {
            projected: `${projected.toFixed(1)}¢`,
            current: `${combinedCents.toFixed(1)}¢`,
          });
          await sleep(this.config.signalCheckIntervalMs);
          continue;
        }
      }

      let orderSize = orderCount === 0 ? firstLegChunk : this.getAdaptiveChunk(windowStartTime, chunkSize);
      if (combinedCents <= this.config.targetCombinedCents) {
        orderSize = Math.max(10, Math.floor(chunkSize * SignalTakerExecutor.POST_TARGET_CHUNK_PCT));
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

        const pairState = this.projectPairState(nextSide, fill.avgPrice, fill.filledSize, filledUp, filledDn, costUp, costDn);
        const isUnpaired = filledUp !== filledDn;
        if (isUnpaired && unpairedStartMs === null) unpairedStartMs = Date.now();
        if (!isUnpaired) unpairedStartMs = null;
        this.logger.info("V10 fill", {
          side: nextSide,
          price: `${(fill.avgPrice * 100).toFixed(1)}¢`,
          size: fill.filledSize.toFixed(0),
          combined: combinedCents === Infinity ? "—" : `${combinedCents.toFixed(1)}¢`,
          marginalPair: `${pairState.projectedMarginalPairCostCents.toFixed(1)}¢`,
          balance: `Up=${filledUp.toFixed(0)} Dn=${filledDn.toFixed(0)}`,
        });

        // Early tail-loss kill-switch: stop if marginal rescue is exploding.
        if (pairState.projectedMarginalPairCostCents > 108 && orderCount >= 3) {
          this.logger.warn("TAIL GUARD: stopping accumulation due to expensive marginal pair", {
            marginal: `${pairState.projectedMarginalPairCostCents.toFixed(1)}¢`,
            fills: orderCount,
          });
          break;
        }
        if (unpairedStartMs !== null && Date.now() - unpairedStartMs > this.config.maxNakedDurationS * 1000) {
          this.logger.warn("TAIL GUARD: unpaired exposure duration exceeded", {
            unpairedForS: ((Date.now() - unpairedStartMs) / 1000).toFixed(1),
            limitS: this.config.maxNakedDurationS,
            up: filledUp.toFixed(0),
            dn: filledDn.toFixed(0),
          });
          break;
        }

        // Circuit breaker: stop if combined > threshold after enough fills
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

        // Check if target reached
        if (
          combinedCents <= this.config.targetCombinedCents &&
          filledUp > 0 && filledDn > 0
        ) {
          this.logger.info("Target reached!", {
            combined: `${combinedCents.toFixed(1)}¢`,
            target: `${this.config.targetCombinedCents}¢`,
          });
          // Keep going — try to accumulate more pairs at good prices
          // But the dynamic interval will slow us down near target
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
    const merges: MergeResult[] = [];

    if (matched >= this.config.mergeMinSize) {
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

    this.logger.info("=== V10 Window Summary ===", {
      fills: orderCount,
      up: `${filledUp.toFixed(0)}@${(avgUp * 100).toFixed(1)}¢`,
      dn: `${filledDn.toFixed(0)}@${(avgDn * 100).toFixed(1)}¢`,
      combined: `${finalCombined.toFixed(1)}¢`,
      paired: `${pairedShares.toFixed(0)}sh @${pairedCombinedAvgCents.toFixed(1)}¢`,
      unpaired: `Up=${unpairedUp.toFixed(0)} Dn=${unpairedDn.toFixed(0)}`,
      merged: totalMerged.toFixed(0),
      profit: `$${totalMergeProfit.toFixed(2)}`,
      pairedProfit: `$${pairedProfit.toFixed(2)}`,
    });

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
    if (combinedCents === Infinity) return 1500; // no data yet, use 1.5s base

    const target = this.config.targetCombinedCents;
    const dist = target - combinedCents; // positive = below target (good)

    if (dist > 15) return 1500;   // very far below target: 1.5s
    if (dist > 8)  return 3000;   // far below: 3s
    if (dist > 3)  return 5000;   // getting close: 5s
    if (dist > 0)  return 8000;   // near target: 8s
    return 12000;                  // at/above target: 12s (very selective)
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

  private async observeAndClassify(window: WindowInfo, btcOpen: number, chunkSize: number): Promise<ObservationResult> {
    const until = Date.now() + this.config.observationPeriodS * 1000;
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

  private assessHedgeFeasibility(window: WindowInfo, chunkSize: number, observation: ObservationResult): { ok: boolean; reason?: string } {
    const secondsLeft = Math.max(0, (window.endTime - Date.now()) / 1000);
    const requiredSeconds = Math.max(this.config.stopBuyingBeforeEndS + 20, 75);
    if (secondsLeft < requiredSeconds) return { ok: false, reason: "Too little time left for safe hedging" };
    if (observation.avgUpSpreadCents > this.config.maxSpreadCents || observation.avgDnSpreadCents > this.config.maxSpreadCents) {
      return { ok: false, reason: "Spread quality too poor for chunked hedge" };
    }
    const minDepthNeed = Math.max(20, chunkSize * SignalTakerExecutor.REBALANCE_CHUNK_PCT);
    if (observation.upDepthWithinBand < minDepthNeed || observation.dnDepthWithinBand < minDepthNeed) {
      return { ok: false, reason: "Insufficient depth in intended hedge band" };
    }
    if (observation.refillScore < 0.25) {
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
    // V8: many small alternating fills (Up/Down/Up/Down...) — target ~40-50 fills total
    const estimatedFills = 40;
    const estimatedAvgPrice = 0.40;
    const rawChunk = Math.floor(budget / (estimatedFills * estimatedAvgPrice));
    const chunkSize = Math.min(Math.max(rawChunk, 20), this.config.maxChunkSize);

    this.sessionChunkSize = chunkSize;
    this.sessionChunkDate = today;
    this.logger.info("Session chunk size", { balance: `$${balance.toFixed(2)}`, chunkSize });

    return chunkSize;
  }
}
