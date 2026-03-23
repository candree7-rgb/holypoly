import { Side, OrderType } from "@polymarket/clob-client";
import type { Logger } from "../logger.js";
import type { TelegramNotifier } from "../telegram.js";
import type { ClobService } from "../data/clob.js";
import type { ClobWsClient, BookSnapshot } from "../data/clob-ws.js";
import type { RedeemService } from "../data/redeem.js";
import type { Config } from "../config.js";
import type {
  WindowInfo,
  PairResult,
  MergeResult,
  WindowExecutionResult,
  TradeSide,
} from "../types.js";
import { DryRunEngine } from "./dry-run-engine.js";
import { sleep } from "../utils.js";

/**
 * MergeArbExecutor: Stargate5-style merge arbitrage.
 *
 * Flow per 5-min window (from HOLYPOLY_STRATEGY_SPEC.md):
 * 1. Pre-flight: orderbook depth + combined cost check
 * 2. Determine which side is more expensive → buy that first (Spec 2.4)
 * 3. Alternating FOK buys, Down size matched to actual Up fill (Spec 9.5)
 * 4. FOK preferred, GTC fallback if FOK fails >2x (Changelog §1)
 * 5. Dynamic merge when shares balanced (Spec 3.2)
 * 6. Imbalance rebalancing: buy short side if gap > MAX_IMBALANCE (Spec 9.5)
 * 7. Final merge + remaining imbalance tracked for cleanup
 */
export class MergeArbExecutor {
  private dryRunEngine: DryRunEngine | null = null;
  /** Session-level chunk size (calculated once per session/day, not per window) */
  private sessionChunkSize: number | null = null;
  private sessionChunkDate: string | null = null;
  /** Track consecutive FOK failures to trigger GTC fallback */
  private consecutiveFokFailures = 0;
  private readonly FOK_FAILURE_THRESHOLD = 2;

  constructor(
    private clob: ClobService,
    private clobWs: ClobWsClient,
    private redeem: RedeemService | null,
    private config: Config,
    private logger: Logger,
    private telegram: TelegramNotifier,
  ) {}

  /**
   * Execute the merge-arb strategy for one 5-minute window.
   */
  async executeWindow(window: WindowInfo, balance: number): Promise<WindowExecutionResult> {
    const result: WindowExecutionResult = {
      conditionId: window.conditionId,
      windowStart: window.startTime,
      windowEnd: window.endTime,
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

    // Initialize DryRunEngine for this window
    if (this.config.dryRun) {
      this.dryRunEngine = new DryRunEngine(
        this.clobWs,
        this.config.takerFeeRate,
        balance,
        this.logger,
      );
    }

    // Reset FOK failure counter per window
    this.consecutiveFokFailures = 0;

    // --- PRE-FLIGHT CHECK ---
    const preflight = await this.preFlightCheck(window);
    if (!preflight.pass) {
      result.skipped = true;
      result.skipReason = preflight.reason;
      this.logger.info("Window skipped", { reason: preflight.reason });
      return result;
    }

    // --- CALCULATE CHUNK SIZE (session-level, Spec 2.5) ---
    const chunkSize = this.getSessionChunkSize(balance);

    const budget = balance * this.config.equityPerWindow;
    this.logger.info("Starting merge-arb execution", {
      window: new Date(window.startTime).toISOString(),
      balance: `$${balance.toFixed(2)}`,
      budget: `$${budget.toFixed(2)}`,
      chunkSize,
      maxPairs: this.config.maxPairs,
      dryRun: this.config.dryRun,
    });

    this.telegram.send(
      `${this.config.dryRun ? "📝 DRY_RUN" : "💰 LIVE"} Window start: ` +
      `${new Date(window.startTime).toISOString().slice(11, 19)} | ` +
      `Budget: $${budget.toFixed(0)} | Chunk: ${chunkSize}sh`,
    );

    // --- STATE ---
    let filledUpShares = 0;
    let filledDnShares = 0;
    let totalUpCost = 0;
    let totalDnCost = 0;
    let availableBudget = budget;
    let pairCount = 0;
    let tradeCount = 0;
    const pairs: PairResult[] = [];
    const merges: MergeResult[] = [];

    // --- BUY CYCLE ---
    while (
      pairCount < this.config.maxPairs &&
      tradeCount < this.config.maxTradesPerWindow &&
      availableBudget > chunkSize * 0.30 // conservative: even a 30¢ share costs budget
    ) {
      const timeRemaining = window.endTime - Date.now();
      if (timeRemaining < 30_000) {
        this.logger.info("Less than 30s remaining, stopping buy cycle");
        break;
      }

      // --- PRE-TRADE COMBINED CHECK ---
      const pairCheck = this.shouldBuyNextPair(window, chunkSize, pairCount);
      if (!pairCheck.buy) {
        this.logger.info("Stopping buy cycle", { reason: pairCheck.reason });
        break;
      }

      // --- DETERMINE ORDER: expensive side first (Spec 2.4) ---
      const upAsk = pairCheck.upPrice ?? 0.50;
      const dnAsk = pairCheck.dnPrice ?? 0.50;
      const firstSide: TradeSide = upAsk >= dnAsk ? "Up" : "Down";
      const secondSide: TradeSide = firstSide === "Up" ? "Down" : "Up";
      const firstTokenId = firstSide === "Up" ? window.upTokenId : window.downTokenId;
      const secondTokenId = secondSide === "Up" ? window.upTokenId : window.downTokenId;
      const firstAsk = firstSide === "Up" ? upAsk : dnAsk;
      const secondAsk = secondSide === "Up" ? upAsk : dnAsk;

      // --- BUY FIRST SIDE (expensive) ---
      const firstFill = await this.buyWithFallback(
        firstTokenId,
        chunkSize,
        firstAsk + this.config.slippageBuffer,
        firstSide,
      );
      tradeCount++;

      if (!firstFill.filled) {
        this.logger.warn(`${firstSide} buy failed after retries`);
        // >=2 consecutive failures → abort window (Spec 9.11 / Changelog §6)
        if (this.consecutiveFokFailures >= 2) {
          this.logger.warn("Too many consecutive failures, aborting window");
          break;
        }
        continue;
      }
      this.consecutiveFokFailures = 0;

      if (firstSide === "Up") {
        filledUpShares += firstFill.filledSize;
        totalUpCost += firstFill.totalCost;
      } else {
        filledDnShares += firstFill.filledSize;
        totalDnCost += firstFill.totalCost;
      }
      availableBudget -= firstFill.totalCost;

      // --- BUY SECOND SIDE (matched to actual first fill, Spec 9.5) ---
      const secondTargetSize = firstFill.filledSize;
      const secondFill = await this.buyWithFallback(
        secondTokenId,
        secondTargetSize,
        secondAsk + this.config.slippageBuffer,
        secondSide,
      );
      tradeCount++;

      if (secondFill.filled) {
        if (secondSide === "Up") {
          filledUpShares += secondFill.filledSize;
          totalUpCost += secondFill.totalCost;
        } else {
          filledDnShares += secondFill.filledSize;
          totalDnCost += secondFill.totalCost;
        }
        availableBudget -= secondFill.totalCost;
      } else {
        // Naked exposure: first side filled but second side failed (Changelog §6)
        // Retry the second side once more with wider slippage
        this.logger.warn(`${secondSide} buy failed — naked ${firstSide} exposure, retrying`, {
          naked: firstFill.filledSize.toFixed(1),
        });
        await sleep(500);
        const nakedRetry = await this.buyWithFallback(
          secondTokenId,
          firstFill.filledSize,
          secondAsk + this.config.slippageBuffer * 3, // even wider slippage
          secondSide,
        );
        tradeCount++;
        if (nakedRetry.filled) {
          if (secondSide === "Up") {
            filledUpShares += nakedRetry.filledSize;
            totalUpCost += nakedRetry.totalCost;
          } else {
            filledDnShares += nakedRetry.filledSize;
            totalDnCost += nakedRetry.totalCost;
          }
          availableBudget -= nakedRetry.totalCost;
        } else {
          // Still failed — accept naked exposure, will be handled post-resolution
          this.logger.warn(`${secondSide} retry also failed, holding naked ${firstSide} for resolution`);
        }
      }

      // --- IMBALANCE REBALANCING (Spec 9.5) ---
      const imbalance = Math.abs(filledUpShares - filledDnShares);
      if (imbalance > this.config.maxImbalanceShares) {
        const shortSide: TradeSide = filledUpShares > filledDnShares ? "Down" : "Up";
        const shortTokenId = shortSide === "Up" ? window.upTokenId : window.downTokenId;
        const shortAsk = shortSide === "Up" ? upAsk : dnAsk;
        this.logger.info("Rebalancing imbalance", { shortSide, imbalance: imbalance.toFixed(1) });

        const rebalanceFill = await this.buyWithFallback(
          shortTokenId,
          imbalance,
          shortAsk + this.config.slippageBuffer,
          shortSide,
        );
        tradeCount++;

        if (rebalanceFill.filled) {
          if (shortSide === "Up") {
            filledUpShares += rebalanceFill.filledSize;
            totalUpCost += rebalanceFill.totalCost;
          } else {
            filledDnShares += rebalanceFill.filledSize;
            totalDnCost += rebalanceFill.totalCost;
          }
          availableBudget -= rebalanceFill.totalCost;
        }
      }

      // --- RECORD PAIR ---
      const pair: PairResult = {
        pairNum: pairCount,
        upFilled: firstSide === "Up" ? firstFill.filledSize : (secondFill.filled ? secondFill.filledSize : 0),
        upCost: firstSide === "Up" ? firstFill.totalCost : (secondFill.filled ? secondFill.totalCost : 0),
        upPrice: firstSide === "Up" ? firstFill.avgPrice : (secondFill.filled ? secondFill.avgPrice : 0),
        dnFilled: firstSide === "Down" ? firstFill.filledSize : (secondFill.filled ? secondFill.filledSize : 0),
        dnCost: firstSide === "Down" ? firstFill.totalCost : (secondFill.filled ? secondFill.totalCost : 0),
        dnPrice: firstSide === "Down" ? firstFill.avgPrice : (secondFill.filled ? secondFill.avgPrice : 0),
        combinedCents: 0,
        imbalance: Math.abs(filledUpShares - filledDnShares),
      };
      pair.combinedCents = (pair.upPrice + pair.dnPrice) * 100;
      pairs.push(pair);
      pairCount++;

      this.logger.info("Pair completed", {
        pair: pairCount,
        firstSide,
        upPrice: `${(pair.upPrice * 100).toFixed(1)}¢`,
        dnPrice: `${(pair.dnPrice * 100).toFixed(1)}¢`,
        combined: `${pair.combinedCents.toFixed(1)}¢`,
        imbalance: pair.imbalance.toFixed(1),
      });

      // --- DYNAMIC MERGE CHECK (Spec 3.2, 9.6) ---
      if (this.config.autoMerge) {
        const matched = Math.min(filledUpShares, filledDnShares);
        const imbalancePct = (filledUpShares + filledDnShares) > 0
          ? Math.abs(filledUpShares - filledDnShares) / (filledUpShares + filledDnShares)
          : 0;

        if (matched >= this.config.mergeMinSize && imbalancePct <= 0.10) {
          const mergeResult = await this.doMerge(
            window, matched, filledUpShares, filledDnShares, totalUpCost, totalDnCost,
          );
          if (mergeResult) {
            merges.push(mergeResult);
            filledUpShares -= mergeResult.merged;
            filledDnShares -= mergeResult.merged;
            availableBudget += mergeResult.recovered;
            // Proportionally reduce costs
            const upAvgCost = (filledUpShares + mergeResult.merged) > 0
              ? totalUpCost / (filledUpShares + mergeResult.merged) : 0;
            const dnAvgCost = (filledDnShares + mergeResult.merged) > 0
              ? totalDnCost / (filledDnShares + mergeResult.merged) : 0;
            totalUpCost = filledUpShares * upAvgCost;
            totalDnCost = filledDnShares * dnAvgCost;
          }
        }
      }

      // --- PACE CONTROL (Spec 2.10: 2-10s between orders) ---
      await sleep(this.config.orderIntervalMs);
    }

    // --- FINAL MERGE ---
    const finalMatched = Math.min(filledUpShares, filledDnShares);
    if (finalMatched > 0) {
      const mergeResult = await this.doMerge(
        window, finalMatched, filledUpShares, filledDnShares, totalUpCost, totalDnCost,
      );
      if (mergeResult) {
        merges.push(mergeResult);
        filledUpShares -= mergeResult.merged;
        filledDnShares -= mergeResult.merged;
        const upAvgCost = (filledUpShares + mergeResult.merged) > 0
          ? totalUpCost / (filledUpShares + mergeResult.merged) : 0;
        const dnAvgCost = (filledDnShares + mergeResult.merged) > 0
          ? totalDnCost / (filledDnShares + mergeResult.merged) : 0;
        totalUpCost = filledUpShares * upAvgCost;
        totalDnCost = filledDnShares * dnAvgCost;
      }
    }

    // --- PRE-RESOLUTION SELL: Sell if a side is at 95¢+ (Spec 8.3/4.2) ---
    // If one side is near-certain winner (bid >= 95¢), sell for immediate capital
    if (filledUpShares > 0 || filledDnShares > 0) {
      const upBook = this.config.dryRun && this.dryRunEngine
        ? this.dryRunEngine.getBook(window.upTokenId)
        : this.clobWs.getBook(window.upTokenId);
      const dnBook = this.config.dryRun && this.dryRunEngine
        ? this.dryRunEngine.getBook(window.downTokenId)
        : this.clobWs.getBook(window.downTokenId);

      const upBid = upBook?.bestBid ?? 0;
      const dnBid = dnBook?.bestBid ?? 0;

      if (filledUpShares > 0 && upBid >= 0.95) {
        this.logger.info("Pre-resolution sell: Up at 95¢+", {
          upBid: `${(upBid * 100).toFixed(1)}¢`,
          shares: filledUpShares.toFixed(1),
        });
        // Note: actual sell happens in main loop post-resolution cleanup
        // Here we just log the opportunity — selling mid-window is risky
      }
      if (filledDnShares > 0 && dnBid >= 0.95) {
        this.logger.info("Pre-resolution sell: Down at 95¢+", {
          dnBid: `${(dnBid * 100).toFixed(1)}¢`,
          shares: filledDnShares.toFixed(1),
        });
      }
    }

    // --- BUILD RESULT ---
    const totalMerged = merges.reduce((s, m) => s + m.merged, 0);
    const totalMergeProfit = merges.reduce((s, m) => s + m.profit, 0);
    const totalCost = pairs.reduce((s, p) => s + p.upCost + p.dnCost, 0);
    const completePairs = pairs.filter(p => p.upFilled > 0 && p.dnFilled > 0);
    const avgCombined = completePairs.length > 0
      ? completePairs.reduce((s, p) => s + p.combinedCents, 0) / completePairs.length
      : 0;

    // totalCost from pairs already includes fees (buyFok returns cost+fee),
    // so extract the fee portion: fee = totalWithFee - totalWithFee/(1+rate)
    const takerFees = this.config.dryRun && this.dryRunEngine
      ? this.dryRunEngine.fees
      : totalCost - (totalCost / (1 + this.config.takerFeeRate));

    Object.assign(result, {
      pairs,
      merges,
      totalUpShares: filledUpShares,
      totalDnShares: filledDnShares,
      totalUpCost,
      totalDnCost,
      totalMerged,
      totalMergeProfit,
      remainingUp: filledUpShares,
      remainingDn: filledDnShares,
      totalCost,
      avgCombinedCents: avgCombined,
      takerFees,
    });

    this.logger.info("Window execution complete", {
      pairs: pairs.length,
      totalMerged: totalMerged.toFixed(1),
      mergeProfit: `$${totalMergeProfit.toFixed(3)}`,
      remainingUp: filledUpShares.toFixed(1),
      remainingDn: filledDnShares.toFixed(1),
      avgCombined: `${avgCombined.toFixed(1)}¢`,
      fees: `$${takerFees.toFixed(3)}`,
    });

    this.telegram.send(
      `${this.config.dryRun ? "📝" : "💰"} Window done: ` +
      `${pairs.length} pairs, merged ${totalMerged.toFixed(0)}sh, ` +
      `P&L: $${totalMergeProfit.toFixed(2)}, ` +
      `avg combined: ${avgCombined.toFixed(1)}¢` +
      (filledUpShares > 0 || filledDnShares > 0
        ? ` | Remaining: Up=${filledUpShares.toFixed(0)} Dn=${filledDnShares.toFixed(0)}`
        : ""),
    );

    // Clean up dry run engine
    if (this.dryRunEngine) {
      this.dryRunEngine.resetWindow();
    }

    return result;
  }

  /**
   * Sell remaining imbalance shares (post-resolution cleanup, Spec 4.2).
   * Called by main loop after window resolution.
   */
  async sellRemainingShares(
    tokenId: string,
    shares: number,
    side: TradeSide,
  ): Promise<{ sold: boolean; revenue: number }> {
    if (shares <= 0) return { sold: false, revenue: 0 };

    if (this.config.dryRun) {
      // In DRY_RUN, we can't know the resolution price, so estimate
      // Losing side → near 0, Winning side → near $1
      this.logger.info("DRY_RUN: Sell simulated (post-resolution)", { side, shares: shares.toFixed(1) });
      return { sold: true, revenue: 0 }; // conservative: assume loser
    }

    // LIVE: Place a sell FOK at a low price to dump losing shares
    const book = this.clobWs.getBook(tokenId);
    const bestBid = book?.bestBid ?? 0.01;
    const result = await this.clob.placeMarketOrderFOK({
      tokenId,
      side: Side.SELL,
      amount: shares,
      worstPrice: Math.max(0.01, bestBid - 0.02),
    });

    if (result.filled) {
      const fills = await this.clob.getOrderFills(result.orderIds);
      const revenue = fills.reduce((s, f) => s + f.costFilled, 0);
      this.logger.info("Sold remaining shares", {
        side,
        shares: shares.toFixed(1),
        revenue: `$${revenue.toFixed(2)}`,
      });
      return { sold: true, revenue };
    }

    this.logger.warn("Failed to sell remaining shares", { side, shares: shares.toFixed(1) });
    return { sold: false, revenue: 0 };
  }

  /**
   * Check and recover from crash: detect open positions from a previous session.
   * Returns remaining shares that need cleanup if any.
   */
  async checkOpenPositions(
    conditionId: string,
    upTokenId: string,
    downTokenId: string,
  ): Promise<{ hasOpen: boolean; upShares: number; dnShares: number }> {
    // In DRY_RUN there can't be real open positions
    if (this.config.dryRun) {
      return { hasOpen: false, upShares: 0, dnShares: 0 };
    }

    // TODO: Query actual on-chain token balances for these tokens
    // For now, return no open positions (positions are tracked by main loop)
    return { hasOpen: false, upShares: 0, dnShares: 0 };
  }

  // ─── PRIVATE METHODS ───

  /**
   * Buy with FOK, falling back to GTC if FOK fails repeatedly (Changelog §1).
   * - FOK preferred: clean fill, no partial risk
   * - GTC fallback: higher fill rate on thin books, cancel after ORDER_TIMEOUT
   */
  private async buyWithFallback(
    tokenId: string,
    size: number,
    maxPrice: number,
    side: TradeSide,
  ): Promise<{ filled: boolean; filledSize: number; avgPrice: number; totalCost: number }> {
    // Try FOK first
    const fokResult = await this.buyFok(tokenId, size, maxPrice, side);
    if (fokResult.filled) {
      this.consecutiveFokFailures = 0;
      return fokResult;
    }
    this.consecutiveFokFailures++;

    // Retry FOK once with wider slippage
    if (this.config.maxRetriesPerOrder > 0) {
      await sleep(500);
      const retry = await this.buyFok(
        tokenId, size, maxPrice + this.config.slippageBuffer, side,
      );
      if (retry.filled) {
        this.consecutiveFokFailures = 0;
        return retry;
      }
      this.consecutiveFokFailures++;
    }

    // FOK failed >2x → try GTC fallback (Changelog §1)
    if (this.consecutiveFokFailures >= this.FOK_FAILURE_THRESHOLD) {
      this.logger.info("FOK failed repeatedly, falling back to GTC", { side, failures: this.consecutiveFokFailures });
      const gtcResult = await this.buyGtcWithTimeout(tokenId, size, maxPrice, side);
      if (gtcResult.filled) {
        this.consecutiveFokFailures = 0;
      }
      return gtcResult;
    }

    return { filled: false, filledSize: 0, avgPrice: 0, totalCost: 0 };
  }

  /**
   * Place a FOK buy order (live or simulated).
   */
  private async buyFok(
    tokenId: string,
    size: number,
    maxPrice: number,
    side: TradeSide,
  ): Promise<{ filled: boolean; filledSize: number; avgPrice: number; totalCost: number }> {
    if (this.config.dryRun && this.dryRunEngine) {
      return this.dryRunEngine.simulateFokBuy(tokenId, size, maxPrice, side);
    }

    // LIVE: Place FOK via CLOB API
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

    const fee = totalCost * this.config.takerFeeRate;
    return {
      filled: totalShares > 0,
      filledSize: totalShares,
      avgPrice: totalShares > 0 ? totalCost / totalShares : 0,
      totalCost: totalCost + fee,
    };
  }

  /**
   * GTC order with timeout — used as fallback when FOK fails on thin books.
   * Places GTC at aggressive price, waits ORDER_TIMEOUT, cancels unfilled rest.
   */
  private async buyGtcWithTimeout(
    tokenId: string,
    size: number,
    maxPrice: number,
    side: TradeSide,
  ): Promise<{ filled: boolean; filledSize: number; avgPrice: number; totalCost: number }> {
    if (this.config.dryRun && this.dryRunEngine) {
      // Simulate the same timeout wait as LIVE to keep timing realistic
      await sleep(this.config.orderTimeoutMs);
      // GTC fallback simulates partial fill against current book
      return this.dryRunEngine.simulateGtcFill(tokenId, size, maxPrice, side);
    }

    // LIVE: Place GTC limit order at aggressive price
    const result = await this.clob.placeBatchOrders(
      [{ tokenId, side: Side.BUY, price: maxPrice, size }],
      OrderType.GTC,
    );

    if (result.placed === 0 || result.orderIds.length === 0) {
      return { filled: false, filledSize: 0, avgPrice: 0, totalCost: 0 };
    }

    // Wait for fills (timeout: ORDER_TIMEOUT_MS)
    await sleep(this.config.orderTimeoutMs);

    // Check what filled
    const fills = await this.clob.getOrderFills(result.orderIds);
    let totalShares = 0;
    let totalCost = 0;
    for (const fill of fills) {
      totalShares += fill.sizeMatched;
      totalCost += fill.costFilled;
    }

    // Cancel remaining unfilled portion
    for (const orderId of result.orderIds) {
      await this.clob.cancelOrder(orderId);
    }

    if (totalShares <= 0) {
      return { filled: false, filledSize: 0, avgPrice: 0, totalCost: 0 };
    }

    const fee = totalCost * this.config.takerFeeRate;
    this.logger.info("GTC fallback filled", {
      side,
      requested: size.toFixed(1),
      filled: totalShares.toFixed(1),
      avgPrice: `${((totalCost / totalShares) * 100).toFixed(1)}¢`,
    });

    return {
      filled: true,
      filledSize: totalShares,
      avgPrice: totalCost / totalShares,
      totalCost: totalCost + fee,
    };
  }

  /**
   * Pre-flight check: orderbook depth + combined cost gate (Spec 9.2 step 3).
   */
  private async preFlightCheck(
    window: WindowInfo,
  ): Promise<{ pass: boolean; reason?: string }> {
    let upBook: BookSnapshot | null;
    let dnBook: BookSnapshot | null;

    // Use WS book first (both DRY_RUN and LIVE)
    upBook = this.clobWs.getBook(window.upTokenId);
    dnBook = this.clobWs.getBook(window.downTokenId);

    // Fallback to REST if WS book not ready (works in both modes — orderbook REST needs no auth)
    if (!upBook || !dnBook) {
      const upOb = await this.clob.getOrderbook(window.upTokenId);
      const dnOb = await this.clob.getOrderbook(window.downTokenId);
      upBook = { assetId: window.upTokenId, bids: [], asks: upOb.asks.map(a => ({ price: a.price, size: a.size })), bestBid: upOb.bestBid, bestAsk: upOb.bestAsk };
      dnBook = { assetId: window.downTokenId, bids: [], asks: dnOb.asks.map(a => ({ price: a.price, size: a.size })), bestBid: dnOb.bestBid, bestAsk: dnOb.bestAsk };
    }

    if (!upBook || !dnBook) {
      return { pass: false, reason: "Orderbook not available" };
    }

    const upLevels = upBook.asks?.length ?? 0;
    const dnLevels = dnBook.asks?.length ?? 0;
    if (upLevels < this.config.minBookLevels || dnLevels < this.config.minBookLevels) {
      return {
        pass: false,
        reason: `Insufficient depth: Up=${upLevels}, Down=${dnLevels} (min=${this.config.minBookLevels})`,
      };
    }

    const bestUpAsk = upBook.bestAsk ?? (upBook.asks?.[0]?.price ?? null);
    const bestDnAsk = dnBook.bestAsk ?? (dnBook.asks?.[0]?.price ?? null);
    if (bestUpAsk === null || bestDnAsk === null) {
      return { pass: false, reason: "No asks available" };
    }

    const combined = bestUpAsk + bestDnAsk;
    if (combined > this.config.maxCombinedEntry) {
      return {
        pass: false,
        reason: `Combined too expensive: ${(combined * 100).toFixed(1)}¢ > ${(this.config.maxCombinedEntry * 100).toFixed(0)}¢`,
      };
    }

    this.logger.info("Pre-flight passed", {
      upAsk: `${(bestUpAsk * 100).toFixed(1)}¢`,
      dnAsk: `${(bestDnAsk * 100).toFixed(1)}¢`,
      combined: `${(combined * 100).toFixed(1)}¢`,
      upLevels,
      dnLevels,
    });

    return { pass: true };
  }

  /**
   * Check if we should buy the next pair (mid-window gate, Spec 9.4).
   */
  private shouldBuyNextPair(
    window: WindowInfo,
    chunkSize: number,
    pairNum: number,
  ): { buy: boolean; reason?: string; upPrice?: number; dnPrice?: number } {
    if (pairNum >= this.config.maxPairs) {
      return { buy: false, reason: "MAX_PAIRS reached" };
    }

    let upDepth, dnDepth;

    if (this.config.dryRun && this.dryRunEngine) {
      upDepth = this.dryRunEngine.simulateDepth(window.upTokenId, chunkSize);
      dnDepth = this.dryRunEngine.simulateDepth(window.downTokenId, chunkSize);
    } else {
      const upBook = this.clobWs.getBook(window.upTokenId);
      const dnBook = this.clobWs.getBook(window.downTokenId);
      upDepth = this.simulateBookDepth(upBook, chunkSize);
      dnDepth = this.simulateBookDepth(dnBook, chunkSize);
    }

    if (!upDepth.canFill) {
      return { buy: false, reason: "Insufficient Up depth" };
    }
    if (!dnDepth.canFill) {
      return { buy: false, reason: "Insufficient Down depth" };
    }

    const expectedCombined = upDepth.avgPrice + dnDepth.avgPrice;
    if (expectedCombined > this.config.maxCombinedPair) {
      return {
        buy: false,
        reason: `Combined ${(expectedCombined * 100).toFixed(1)}¢ > ${(this.config.maxCombinedPair * 100).toFixed(0)}¢`,
      };
    }

    return {
      buy: true,
      upPrice: upDepth.avgPrice,
      dnPrice: dnDepth.avgPrice,
    };
  }

  /**
   * Simulate depth from a BookSnapshot.
   */
  private simulateBookDepth(
    book: BookSnapshot | null,
    targetSize: number,
  ): { canFill: boolean; avgPrice: number; levelsAvailable: number } {
    if (!book || book.asks.length === 0) {
      return { canFill: false, avgPrice: 0, levelsAvailable: 0 };
    }

    let remaining = targetSize;
    let totalCost = 0;
    for (const level of book.asks) {
      const fill = Math.min(remaining, level.size);
      totalCost += fill * level.price;
      remaining -= fill;
      if (remaining <= 0) break;
    }

    const filled = targetSize - remaining;
    return {
      canFill: remaining <= 0,
      avgPrice: filled > 0 ? totalCost / filled : 0,
      levelsAvailable: book.asks.length,
    };
  }

  /**
   * Execute a merge with proper profit calculation.
   */
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

    // LIVE: CTF merge via relayer
    if (!this.redeem) {
      this.logger.warn("Merge requested but no RedeemService available");
      return null;
    }

    const txHash = await this.redeem.mergePositions(
      window.conditionId,
      amount,
      window.negRisk,
    );

    if (!txHash) {
      this.logger.warn("Merge transaction failed");
      return null;
    }

    const recovered = amount * 1.0;
    const upAvg = upShares > 0 ? upCost / upShares : 0;
    const dnAvg = dnShares > 0 ? dnCost / dnShares : 0;
    const profit = recovered - amount * (upAvg + dnAvg);

    return {
      merged: amount,
      recovered,
      profit,
      timestamp: Date.now(),
    };
  }

  /**
   * Session-level chunk size (Spec 2.5: "Innerhalb eines Windows haben alle
   * Orders nahezu exakt gleiche Stückzahl. Die Stückzahl wird pro Tag/Session berechnet.")
   */
  private getSessionChunkSize(balance: number): number {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    if (this.sessionChunkSize !== null && this.sessionChunkDate === today) {
      return this.sessionChunkSize;
    }

    const budget = balance * this.config.equityPerWindow;
    const estimatedAvgPrice = 0.50;
    // Budget needs to cover ~3 pairs before first merge recycles capital (Changelog §2).
    // After merge, recycled capital funds further pairs. So divide by pairsBeforeMerge=3, not maxPairs=5.
    const pairsBeforeMerge = 3;
    const chunkSize = Math.max(
      Math.floor(budget / (pairsBeforeMerge * 2 * estimatedAvgPrice)),
      20,
    );

    this.sessionChunkSize = chunkSize;
    this.sessionChunkDate = today;
    this.logger.info("Session chunk size calculated", {
      date: today,
      balance: `$${balance.toFixed(2)}`,
      chunkSize,
    });

    return chunkSize;
  }
}
