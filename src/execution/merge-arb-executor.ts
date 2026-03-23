import { Side, OrderType } from "@polymarket/clob-client";
import type { Logger } from "../logger.js";
import type { TelegramNotifier } from "../telegram.js";
import type { ClobService } from "../data/clob.js";
import type { ClobWsClient } from "../data/clob-ws.js";
import type { RedeemService } from "../data/redeem.js";
import type { Config } from "../config.js";
import type {
  WindowInfo,
  PairResult,
  MergeResult,
  WindowExecutionResult,
} from "../types.js";
import { DryRunEngine } from "./dry-run-engine.js";
import { sleep } from "../utils.js";

/**
 * MergeArbExecutor: Stargate5-style merge arbitrage.
 *
 * Flow per 5-min window:
 * 1. Pre-flight: orderbook depth + combined cost check
 * 2. Calculate chunk_size from balance × EQUITY_PER_WINDOW
 * 3. Alternating FOK Buy Up → FOK Buy Down (max MAX_PAIRS pairs)
 * 4. Dynamic merge when shares balanced (recycle capital)
 * 5. Final merge + schedule cleanup for post-resolution
 */
export class MergeArbExecutor {
  private dryRunEngine: DryRunEngine | null = null;

  constructor(
    private clob: ClobService,
    private clobWs: ClobWsClient,
    private redeem: RedeemService | null,
    private config: Config,
    private logger: Logger,
    private telegram: TelegramNotifier,
  ) {
    // DryRunEngine is initialized per-window with current balance
  }

  /**
   * Execute the merge-arb strategy for one 5-minute window.
   * This is the main entry point called by the main loop.
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

    // --- PRE-FLIGHT CHECK ---
    const preflight = await this.preFlightCheck(window);
    if (!preflight.pass) {
      result.skipped = true;
      result.skipReason = preflight.reason;
      this.logger.info("Window skipped", { reason: preflight.reason });
      return result;
    }

    // --- CALCULATE CHUNK SIZE ---
    const budget = balance * this.config.equityPerWindow;
    const estimatedAvgPrice = 0.50;
    const chunkSize = Math.max(
      Math.floor(budget / (this.config.maxPairs * 2 * estimatedAvgPrice)),
      20, // minimum 20 shares
    );

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
      availableBudget > chunkSize * estimatedAvgPrice
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

      // --- BUY UP ---
      const upFill = await this.buyFok(
        window.upTokenId,
        chunkSize,
        (pairCheck.upPrice ?? 0.50) + this.config.slippageBuffer,
        "Up",
      );
      tradeCount++;

      if (!upFill.filled) {
        this.logger.warn("Up FOK failed, skipping pair");
        if (this.config.maxRetriesPerOrder > 0) {
          await sleep(500);
          const retry = await this.buyFok(
            window.upTokenId,
            chunkSize,
            (pairCheck.upPrice ?? 0.50) + this.config.slippageBuffer * 2,
            "Up",
          );
          tradeCount++;
          if (!retry.filled) {
            this.logger.warn("Up retry also failed, aborting");
            break;
          }
          filledUpShares += retry.filledSize;
          totalUpCost += retry.totalCost;
          availableBudget -= retry.totalCost;
        } else {
          continue;
        }
      } else {
        filledUpShares += upFill.filledSize;
        totalUpCost += upFill.totalCost;
        availableBudget -= upFill.totalCost;
      }

      const actualUpFilled = upFill.filled ? upFill.filledSize : chunkSize;

      // --- BUY DOWN (matched to actual Up fill) ---
      const dnTargetSize = actualUpFilled;
      const dnFill = await this.buyFok(
        window.downTokenId,
        dnTargetSize,
        (pairCheck.dnPrice ?? 0.50) + this.config.slippageBuffer,
        "Down",
      );
      tradeCount++;

      if (!dnFill.filled) {
        this.logger.warn("Down FOK failed", { nakedUp: actualUpFilled });
        // Retry once
        if (this.config.maxRetriesPerOrder > 0) {
          await sleep(500);
          const retry = await this.buyFok(
            window.downTokenId,
            dnTargetSize,
            (pairCheck.dnPrice ?? 0.50) + this.config.slippageBuffer * 2,
            "Down",
          );
          tradeCount++;
          if (retry.filled) {
            filledDnShares += retry.filledSize;
            totalDnCost += retry.totalCost;
            availableBudget -= retry.totalCost;
          } else {
            this.logger.warn("Down retry also failed, naked Up exposure");
            // Accept imbalance, continue
          }
        }
      } else {
        filledDnShares += dnFill.filledSize;
        totalDnCost += dnFill.totalCost;
        availableBudget -= dnFill.totalCost;
      }

      // --- RECORD PAIR ---
      const upPrice = upFill.filled ? upFill.avgPrice : 0;
      const dnPrice = dnFill.filled ? dnFill.avgPrice : 0;
      const pair: PairResult = {
        pairNum: pairCount,
        upFilled: upFill.filled ? upFill.filledSize : 0,
        upCost: upFill.filled ? upFill.totalCost : 0,
        upPrice,
        dnFilled: dnFill.filled ? dnFill.filledSize : 0,
        dnCost: dnFill.filled ? dnFill.totalCost : 0,
        dnPrice,
        combinedCents: (upPrice + dnPrice) * 100,
        imbalance: Math.abs(
          (upFill.filled ? upFill.filledSize : 0) -
          (dnFill.filled ? dnFill.filledSize : 0),
        ),
      };
      pairs.push(pair);
      pairCount++;

      this.logger.info("Pair completed", {
        pair: pairCount,
        upPrice: `${(upPrice * 100).toFixed(1)}¢`,
        dnPrice: `${(dnPrice * 100).toFixed(1)}¢`,
        combined: `${pair.combinedCents.toFixed(1)}¢`,
        imbalance: pair.imbalance.toFixed(1),
      });

      // --- DYNAMIC MERGE CHECK ---
      if (this.config.autoMerge) {
        const matched = Math.min(filledUpShares, filledDnShares);
        if (matched >= this.config.mergeMinSize) {
          const mergeResult = await this.merge(window, matched);
          if (mergeResult) {
            merges.push(mergeResult);
            filledUpShares -= mergeResult.merged;
            filledDnShares -= mergeResult.merged;
            availableBudget += mergeResult.recovered;
            // Reset costs proportionally
            const upAvg = filledUpShares + mergeResult.merged > 0
              ? totalUpCost / (filledUpShares + mergeResult.merged) : 0;
            const dnAvg = filledDnShares + mergeResult.merged > 0
              ? totalDnCost / (filledDnShares + mergeResult.merged) : 0;
            totalUpCost = filledUpShares * upAvg;
            totalDnCost = filledDnShares * dnAvg;
          }
        }
      }

      // --- PACE CONTROL ---
      await sleep(this.config.orderIntervalMs);
    }

    // --- FINAL MERGE ---
    const finalMatched = Math.min(filledUpShares, filledDnShares);
    if (finalMatched > 0) {
      const mergeResult = await this.merge(window, finalMatched);
      if (mergeResult) {
        merges.push(mergeResult);
        filledUpShares -= mergeResult.merged;
        filledDnShares -= mergeResult.merged;
      }
    }

    // --- BUILD RESULT ---
    const totalMerged = merges.reduce((s, m) => s + m.merged, 0);
    const totalMergeProfit = merges.reduce((s, m) => s + m.profit, 0);
    const totalCost = pairs.reduce((s, p) => s + p.upCost + p.dnCost, 0);
    const totalPairs = pairs.filter(p => p.upFilled > 0 && p.dnFilled > 0).length;
    const avgCombined = totalPairs > 0
      ? pairs
          .filter(p => p.upFilled > 0 && p.dnFilled > 0)
          .reduce((s, p) => s + p.combinedCents, 0) / totalPairs
      : 0;

    const takerFees = this.config.dryRun && this.dryRunEngine
      ? this.dryRunEngine.fees
      : totalCost * this.config.takerFeeRate;

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
      `avg combined: ${avgCombined.toFixed(1)}¢`,
    );

    // Clean up dry run engine
    if (this.dryRunEngine) {
      this.dryRunEngine.resetWindow();
    }

    return result;
  }

  /**
   * Pre-flight check: orderbook depth + combined cost gate.
   */
  private async preFlightCheck(
    window: WindowInfo,
  ): Promise<{ pass: boolean; reason?: string }> {
    let upBook, dnBook;

    if (this.config.dryRun && this.dryRunEngine) {
      // Use WS orderbook
      upBook = this.dryRunEngine.getBook(window.upTokenId);
      dnBook = this.dryRunEngine.getBook(window.downTokenId);
    } else {
      // Fetch from REST API
      upBook = await this.clob.getOrderbook(window.upTokenId);
      dnBook = await this.clob.getOrderbook(window.downTokenId);
    }

    if (!upBook || !dnBook) {
      return { pass: false, reason: "Orderbook not available" };
    }

    // Check depth
    const upLevels = upBook.asks?.length ?? 0;
    const dnLevels = dnBook.asks?.length ?? 0;
    if (upLevels < this.config.minBookLevels || dnLevels < this.config.minBookLevels) {
      return {
        pass: false,
        reason: `Insufficient depth: Up=${upLevels}, Down=${dnLevels} (min=${this.config.minBookLevels})`,
      };
    }

    // Check combined best ask
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
   * Check if we should buy the next pair (mid-window gate).
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
      // Use WS book for real-time data
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
   * Simulate depth from a BookSnapshot (for live mode using WS data).
   */
  private simulateBookDepth(
    book: import("../data/clob-ws.js").BookSnapshot | null,
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
   * Place a FOK buy order (live or simulated).
   */
  private async buyFok(
    tokenId: string,
    size: number,
    maxPrice: number,
    side: "Up" | "Down",
  ): Promise<{ filled: boolean; filledSize: number; avgPrice: number; totalCost: number }> {
    if (this.config.dryRun && this.dryRunEngine) {
      const sim = this.dryRunEngine.simulateFokBuy(tokenId, size, maxPrice, side);
      return {
        filled: sim.filled,
        filledSize: sim.filledSize,
        avgPrice: sim.avgPrice,
        totalCost: sim.totalCost,
      };
    }

    // LIVE: Place FOK via CLOB API
    const amount = size * maxPrice; // USD amount for FOK
    const result = await this.clob.placeMarketOrderFOK({
      tokenId,
      side: Side.BUY,
      amount,
      worstPrice: maxPrice,
    });

    if (!result.filled || result.orderIds.length === 0) {
      return { filled: false, filledSize: 0, avgPrice: 0, totalCost: 0 };
    }

    // Query actual fill data
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
   * Merge matched shares (live or simulated).
   */
  private async merge(
    window: WindowInfo,
    amount: number,
  ): Promise<MergeResult | null> {
    if (this.config.dryRun && this.dryRunEngine) {
      const sim = this.dryRunEngine.simulateMerge(amount);
      if (sim.merged <= 0) return null;
      return {
        merged: sim.merged,
        recovered: sim.recovered,
        profit: sim.profit,
        timestamp: Date.now(),
      };
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
    // We don't know exact cost breakdown here — caller tracks it
    return {
      merged: amount,
      recovered,
      profit: 0, // Caller calculates actual profit
      timestamp: Date.now(),
    };
  }
}
