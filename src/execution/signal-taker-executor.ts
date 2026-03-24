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
  TradeSide,
} from "../types.js";
import { DryRunEngine } from "./dry-run-engine.js";
import { sleep, polymarketCryptoFee } from "../utils.js";

/**
 * SignalTakerExecutor V8: Price-Momentum Accumulation Strategy.
 *
 * KEY INSIGHT: Buy both sides alternately, timed by direct BTC price reversals.
 * Only buy when it IMPROVES the combined avg cost. Stop when target reached.
 *
 * - First buy: immediate, pick cheaper side from orderbook (no signal needed)
 * - Strict alternation: never buy the same side twice in a row
 * - Price momentum: track BTC rolling high/low, buy on reversals (dip→Up, bounce→Down)
 * - Projected combined check: only buy if it lowers or maintains combined cost
 * - Dynamic intervals: aggressive when far from target, cautious when close
 * - Rebalance: always buy short side at end, dynamic cap (breakeven + 3¢)
 * - Single TG message per window with P&L
 */
export class SignalTakerExecutor {
  private dryRunEngine: DryRunEngine | null = null;
  private sessionChunkSize: number | null = null;
  private sessionChunkDate: string | null = null;

  // Price momentum: rolling window of BTC prices for reversal detection
  private static readonly PRICE_HISTORY_SIZE = 8;            // ~4s of history at 500ms intervals
  private static readonly REVERSAL_THRESHOLD = 0.00015;      // 0.015% reversal from recent extreme
  private static readonly REBALANCE_OVERPAY = 0.03;          // willing to pay 3¢ over breakeven
  private static readonly EMERGENCY_RISK_AVERSION = 0.30;    // 0=risk-neutral, 1=very risk-averse
  private static readonly EMERGENCY_FEE_ESTIMATE = 0.005;   // ~0.5% typical taker fee at these prices
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
    const btcOpen = this.binance.price;
    if (!btcOpen) {
      this.logger.warn("No Binance price available, skipping window");
      result.skipped = true;
      result.skipReason = "No Binance BTC price";
      return result;
    }

    const chunkSize = this.getSessionChunkSize(balance);
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

    // Price momentum state: rolling window of recent BTC prices
    const priceHistory: number[] = [btcOpen];
    let rollingHigh = btcOpen;
    let rollingLow = btcOpen;

    this.logger.info("=== V8 Momentum Window Start ===", {
      btc: `$${btcOpen.toFixed(0)}`,
      budget: `$${budget.toFixed(0)}`,
      chunk: chunkSize,
      target: `${this.config.targetCombinedCents}¢`,
    });

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

      // Determine which side to buy (strict alternation + balance + momentum)
      const nextSide = this.chooseNextSide(
        lastBuySide, filledUp, filledDn, dipFromHigh, bounceFromLow, window, isFirstBuy,
      );
      if (!nextSide) {
        await sleep(this.config.signalCheckIntervalMs);
        continue;
      }

      // After first buy, check if price is moving favorably for this side
      if (!isFirstBuy && !this.isGoodTimeToBuy(nextSide, dipFromHigh, bounceFromLow)) {
        await sleep(this.config.signalCheckIntervalMs);
        continue;
      }

      // Dynamic interval: aggressive when far from target, cautious when close
      const minInterval = this.computeInterval(combinedCents);
      const now = Date.now();
      if (now - lastBuyTime < minInterval) {
        await sleep(this.config.signalCheckIntervalMs);
        continue;
      }

      // Get ask price
      const tokenId = nextSide === "Up" ? window.upTokenId : window.downTokenId;
      const book = this.getBook(tokenId);
      const bestAsk = book?.asks?.[0]?.price ?? 1.0;

      // Safety cap
      if (bestAsk >= this.config.cheapThreshold) {
        this.logger.debug("Ask above safety cap", {
          side: nextSide,
          ask: `${(bestAsk * 100).toFixed(1)}¢`,
          cap: `${(this.config.cheapThreshold * 100).toFixed(0)}¢`,
        });
        await sleep(this.config.signalCheckIntervalMs);
        continue;
      }

      // Budget-reserve: max 50% on one side until other side has ≥1 fill
      const thisSideCost = nextSide === "Up" ? costUp : costDn;
      const otherSideShares = nextSide === "Up" ? filledDn : filledUp;
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

      // ── BUY! ──
      const buyPrice = bestAsk + this.config.slippageBuffer;
      const fill = await this.buyOrder(tokenId, chunkSize, buyPrice, nextSide);

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

        this.logger.info("V8 fill", {
          side: nextSide,
          price: `${(fill.avgPrice * 100).toFixed(1)}¢`,
          size: fill.filledSize.toFixed(0),
          combined: combinedCents === Infinity ? "—" : `${combinedCents.toFixed(1)}¢`,
          balance: `Up=${filledUp.toFixed(0)} Dn=${filledDn.toFixed(0)}`,
        });

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

    // ═══════════════════════════════════════════════════
    // PHASE 2: REBALANCE
    // Always buy short side. Dynamic cap = breakeven + 3¢.
    // ═══════════════════════════════════════════════════
    const imbalance = Math.abs(filledUp - filledDn);
    if (imbalance > 0 && availableBudget > 0) {
      const shortSide: TradeSide = filledUp > filledDn ? "Down" : "Up";
      const shortToken = shortSide === "Up" ? window.upTokenId : window.downTokenId;

      // Dynamic cap: breakeven + 3¢ overpay, clamped to safety max
      const longSideAvg = shortSide === "Down"
        ? (filledUp > 0 ? costUp / filledUp : 0)
        : (filledDn > 0 ? costDn / filledDn : 0);
      const breakeven = 1.00 - longSideAvg;
      const dynamicCap = Math.min(
        breakeven + SignalTakerExecutor.REBALANCE_OVERPAY,
        this.config.rebalanceMaxPrice,
      );

      this.logger.info("Phase 2: Rebalance", {
        shortSide,
        imbalance: imbalance.toFixed(0),
        longAvg: `${(longSideAvg * 100).toFixed(1)}¢`,
        breakeven: `${(breakeven * 100).toFixed(1)}¢`,
        cap: `${(dynamicCap * 100).toFixed(1)}¢`,
      });

      const book = this.getBook(shortToken);
      const bestAsk = book?.asks?.[0]?.price ?? 1.0;

      if (bestAsk <= dynamicCap) {
        const rebalancePrice = bestAsk + this.config.slippageBuffer;
        const fill = await this.buyOrder(shortToken, imbalance, rebalancePrice, shortSide);

        if (fill.filled) {
          const fee = polymarketCryptoFee(fill.filledSize, fill.avgPrice);
          totalTakerFees += fee;
          if (shortSide === "Up") {
            filledUp += fill.filledSize;
            costUp += fill.totalCost;
          } else {
            filledDn += fill.filledSize;
            costDn += fill.totalCost;
          }
          availableBudget -= fill.totalCost;
          orderFills.push({
            orderNum: orderCount,
            side: shortSide,
            filledSize: fill.filledSize,
            avgPrice: fill.avgPrice,
            totalCost: fill.totalCost,
            fee,
            timestamp: Date.now(),
          });
          orderCount++;

          this.logger.info("Rebalance filled", {
            side: shortSide,
            size: fill.filledSize.toFixed(0),
            price: `${(fill.avgPrice * 100).toFixed(1)}¢`,
          });
        }
      } else {
        this.logger.warn("Rebalance: ask exceeds dynamic cap", {
          ask: `${(bestAsk * 100).toFixed(1)}¢`,
          cap: `${(dynamicCap * 100).toFixed(1)}¢`,
        });
      }
    }

    // ═══════════════════════════════════════════════════
    // PHASE 2b: EMERGENCY REBALANCE (EV-based)
    // If still imbalanced after Phase 2a, buy at market up to
    // an EV-derived cap. Merging at a small loss beats naked
    // 50/50 gamble (huge variance on $0-or-$1 resolution).
    //
    // Math: naked EV = 50¢ - longAvg (but stdev = 50¢/share!)
    // Merge is better than naked when:
    //   ask ≤ 50¢ + (50¢ × riskAversion) - fees ≈ 65¢
    // This cap is INDEPENDENT of longSideAvg — always ~65¢.
    // ═══════════════════════════════════════════════════
    const emergencyImbalance = Math.abs(filledUp - filledDn);
    if (emergencyImbalance > 0 && availableBudget > 0) {
      const shortSide: TradeSide = filledUp > filledDn ? "Down" : "Up";
      const shortToken = shortSide === "Up" ? window.upTokenId : window.downTokenId;

      const longSideAvg = shortSide === "Down"
        ? (filledUp > 0 ? costUp / filledUp : 0)
        : (filledDn > 0 ? costDn / filledDn : 0);

      // EV-based cap: 50¢ (naked binary EV) + variance penalty - fees
      const variancePenalty = 0.50 * SignalTakerExecutor.EMERGENCY_RISK_AVERSION;
      const evBasedCap = 0.50 + variancePenalty - SignalTakerExecutor.EMERGENCY_FEE_ESTIMATE;
      const emergencyCap = Math.min(evBasedCap, this.config.rebalanceMaxPrice);

      const emergencyBook = this.getBook(shortToken);
      const emergencyAsk = emergencyBook?.asks?.[0]?.price ?? 1.0;
      const mergeLoss = (longSideAvg + emergencyAsk - 1.00) * 100;

      this.logger.warn("Phase 2b: EMERGENCY rebalance (EV-based)", {
        shortSide,
        imbalance: emergencyImbalance.toFixed(0),
        ask: `${(emergencyAsk * 100).toFixed(1)}¢`,
        evCap: `${(emergencyCap * 100).toFixed(1)}¢`,
        mergeLoss: `${mergeLoss.toFixed(1)}¢/sh`,
        longAvg: `${(longSideAvg * 100).toFixed(1)}¢`,
      });

      if (emergencyAsk <= emergencyCap) {
        const emergencyPrice = emergencyAsk + this.config.slippageBuffer;
        const fill = await this.buyOrder(shortToken, emergencyImbalance, emergencyPrice, shortSide);

        if (fill.filled) {
          const fee = polymarketCryptoFee(fill.filledSize, fill.avgPrice);
          totalTakerFees += fee;
          if (shortSide === "Up") {
            filledUp += fill.filledSize;
            costUp += fill.totalCost;
          } else {
            filledDn += fill.filledSize;
            costDn += fill.totalCost;
          }
          availableBudget -= fill.totalCost;
          orderFills.push({
            orderNum: orderCount,
            side: shortSide,
            filledSize: fill.filledSize,
            avgPrice: fill.avgPrice,
            totalCost: fill.totalCost,
            fee,
            timestamp: Date.now(),
          });
          orderCount++;

          const projCombined = ((costUp / (filledUp || 1)) + (costDn / (filledDn || 1))) * 100;
          this.logger.warn("EMERGENCY rebalance filled", {
            side: shortSide,
            size: fill.filledSize.toFixed(0),
            price: `${(fill.avgPrice * 100).toFixed(1)}¢`,
            combined: `${projCombined.toFixed(1)}¢`,
          });

          this.telegram.send(
            `🚨 Emergency rebalance: ${fill.filledSize.toFixed(0)}sh ${shortSide} @${(fill.avgPrice * 100).toFixed(1)}¢`,
          );
        }
      } else {
        // One re-check after 1.5s — book might update
        this.logger.warn("Emergency ask exceeds cap, waiting 1.5s for re-check...");
        await sleep(1500);
        const retryBook = this.getBook(shortToken);
        const retryAsk = retryBook?.asks?.[0]?.price ?? 1.0;

        if (retryAsk <= emergencyCap) {
          const retryPrice = retryAsk + this.config.slippageBuffer;
          const fill = await this.buyOrder(shortToken, emergencyImbalance, retryPrice, shortSide);

          if (fill.filled) {
            const fee = polymarketCryptoFee(fill.filledSize, fill.avgPrice);
            totalTakerFees += fee;
            if (shortSide === "Up") {
              filledUp += fill.filledSize;
              costUp += fill.totalCost;
            } else {
              filledDn += fill.filledSize;
              costDn += fill.totalCost;
            }
            availableBudget -= fill.totalCost;
            orderFills.push({
              orderNum: orderCount,
              side: shortSide,
              filledSize: fill.filledSize,
              avgPrice: fill.avgPrice,
              totalCost: fill.totalCost,
              fee,
              timestamp: Date.now(),
            });
            orderCount++;

            this.logger.warn("EMERGENCY rebalance filled (retry)", {
              side: shortSide,
              size: fill.filledSize.toFixed(0),
              price: `${(fill.avgPrice * 100).toFixed(1)}¢`,
            });
            this.telegram.send(
              `🚨 Emergency rebalance (retry): ${fill.filledSize.toFixed(0)}sh ${shortSide} @${(fill.avgPrice * 100).toFixed(1)}¢`,
            );
          }
        } else {
          this.logger.error("EMERGENCY rebalance FAILED — ask exceeds EV cap, NAKED POSITION", {
            ask: `${(retryAsk * 100).toFixed(1)}¢`,
            evCap: `${(emergencyCap * 100).toFixed(1)}¢`,
            nakedShares: emergencyImbalance.toFixed(0),
            nakedSide: shortSide === "Up" ? "Down" : "Up",
          });
          this.telegram.send(
            `🔴 NAKED: ${emergencyImbalance.toFixed(0)}sh unhedged! Ask ${(retryAsk * 100).toFixed(0)}¢ > EV cap ${(emergencyCap * 100).toFixed(0)}¢`,
          );
        }
      }
    }

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

    this.logger.info("=== V8 Window Summary ===", {
      fills: orderCount,
      up: `${filledUp.toFixed(0)}@${(avgUp * 100).toFixed(1)}¢`,
      dn: `${filledDn.toFixed(0)}@${(avgDn * 100).toFixed(1)}¢`,
      combined: `${finalCombined.toFixed(1)}¢`,
      merged: totalMerged.toFixed(0),
      profit: `$${totalMergeProfit.toFixed(2)}`,
    });

    // ── SINGLE TG MESSAGE ──
    if (totalMerged > 0) {
      const emoji = totalMergeProfit > 0 ? "✅" : "❌";
      this.telegram.send(
        `${emoji} ${totalMerged.toFixed(0)}sh merged | ${finalCombined.toFixed(1)}¢ | ` +
        `${totalMergeProfit > 0 ? "+" : ""}$${totalMergeProfit.toFixed(2)}`,
      );
    } else if (orderCount > 0) {
      this.telegram.send(
        `⚠️ ${orderCount} fills but no merge | Up=${filledUp.toFixed(0)} Dn=${filledDn.toFixed(0)}`,
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
    lastBuySide: TradeSide | null,
    filledUp: number,
    filledDn: number,
    dipFromHigh: number,
    bounceFromLow: number,
    window: WindowInfo,
    isFirstBuy: boolean,
  ): TradeSide | null {
    // If one side has fewer shares, must buy that side
    if (filledUp < filledDn) return "Up";
    if (filledDn < filledUp) return "Down";

    // Equal (including 0/0): alternate from last buy
    if (lastBuySide === "Up") return "Down";
    if (lastBuySide === "Down") return "Up";

    // First buy ever: pick the cheaper side from the orderbook (no signal needed!)
    if (isFirstBuy) {
      const upBook = this.getBook(window.upTokenId);
      const dnBook = this.getBook(window.downTokenId);
      const upAsk = upBook?.asks?.[0]?.price ?? 1.0;
      const dnAsk = dnBook?.asks?.[0]?.price ?? 1.0;
      // Buy whichever side is cheaper — or Up if equal
      return dnAsk < upAsk ? "Down" : "Up";
    }

    // Use momentum signal: buy the side that BTC is making cheaper
    if (dipFromHigh > SignalTakerExecutor.REVERSAL_THRESHOLD) return "Up";   // BTC falling → Up cheaper
    if (bounceFromLow > SignalTakerExecutor.REVERSAL_THRESHOLD) return "Down"; // BTC rising → Down cheaper

    return null; // flat, wait for movement
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

  // ─── PRIVATE METHODS (unchanged) ───

  private getBook(tokenId: string): BookSnapshot | null {
    if (this.config.dryRun && this.dryRunEngine) {
      return this.dryRunEngine.getBookView(tokenId);
    }
    return this.clobWs.getBook(tokenId);
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

    if (!upBook || !dnBook) {
      const upOb = await this.clob.getOrderbook(window.upTokenId);
      const dnOb = await this.clob.getOrderbook(window.downTokenId);
      upBook = { assetId: window.upTokenId, bids: upOb.bids.map(b => ({ price: b.price, size: b.size })), asks: upOb.asks.map(a => ({ price: a.price, size: a.size })), bestBid: upOb.bestBid, bestAsk: upOb.bestAsk };
      dnBook = { assetId: window.downTokenId, bids: dnOb.bids.map(b => ({ price: b.price, size: b.size })), asks: dnOb.asks.map(a => ({ price: a.price, size: a.size })), bestBid: dnOb.bestBid, bestAsk: dnOb.bestAsk };
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
    // V7: more fills expected with alternation, conservative chunks
    const estimatedFills = 10;
    const estimatedAvgPrice = 0.35;
    const rawChunk = Math.floor(budget / (estimatedFills * estimatedAvgPrice));
    const chunkSize = Math.min(Math.max(rawChunk, 20), this.config.maxChunkSize);

    this.sessionChunkSize = chunkSize;
    this.sessionChunkDate = today;
    this.logger.info("Session chunk size", { balance: `$${balance.toFixed(2)}`, chunkSize });

    return chunkSize;
  }
}
