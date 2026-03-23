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
 * SignalTakerExecutor V6: Binance-Signal Taker Strategy.
 *
 * KEY INSIGHT: Don't buy both sides simultaneously (combined ≈101¢ = loss).
 * Instead, use Binance BTC price to buy each side INDIVIDUALLY when cheap.
 *
 * BTC steigt → Down wird billig → KAUF DOWN
 * BTC fällt  → Up wird billig  → KAUF UP
 * BTC flat   → nichts kaufen (kein Edge)
 *
 * Over 2-4 minutes of BTC oscillation, we accumulate both sides cheaply.
 * Combined avg < 100¢ → Merge → Profit.
 *
 * Balance enforcement: max N chunks imbalance between sides.
 */
export class SignalTakerExecutor {
  private dryRunEngine: DryRunEngine | null = null;
  private sessionChunkSize: number | null = null;
  private sessionChunkDate: string | null = null;

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
   * Execute V6 signal-taker strategy for one 5-minute window.
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
    const windowOpenPrice = this.binance.price;
    if (!windowOpenPrice) {
      this.logger.warn("No Binance price available, skipping window");
      result.skipped = true;
      result.skipReason = "No Binance BTC price";
      return result;
    }

    const chunkSize = this.getSessionChunkSize(balance);
    const budget = balance * this.config.equityPerWindow;
    let availableBudget = budget;

    let filledUpShares = 0;
    let filledDnShares = 0;
    let totalUpCost = 0;
    let totalDnCost = 0;
    let orderCount = 0;
    const orderFills: OrderFill[] = [];
    let totalTakerFees = 0;

    this.logger.info("=== V6 Signal-Taker Window Start ===", {
      window: new Date(window.startTime).toISOString().slice(11, 19),
      btcPrice: `$${windowOpenPrice.toFixed(0)}`,
      budget: `$${budget.toFixed(2)}`,
      chunkSize,
      cheapThreshold: `${(this.config.cheapThreshold * 100).toFixed(0)}¢`,
      btcMoveThreshold: `${(this.config.btcMoveThreshold * 100).toFixed(3)}%`,
    });
    this.telegram.send(
      `🎯 V6 Window: BTC $${windowOpenPrice.toFixed(0)} | budget $${budget.toFixed(0)} | chunk ${chunkSize}`,
    );

    // ═══════════════════════════════════════════════════
    // PHASE 1: SIGNAL-BASED ACCUMULATION (T+5s → T+260s)
    // Monitor Binance BTC price. Buy the CHEAP side when
    // BTC moves enough to create a price dislocation.
    // ═══════════════════════════════════════════════════
    const stopBuyingTime = window.endTime - this.config.stopBuyingBeforeEndS * 1000;

    while (Date.now() < stopBuyingTime && availableBudget > chunkSize * 0.20 && orderCount < this.config.maxOrdersPerWindow) {
      const currentBtcPrice = this.binance.price;
      if (!currentBtcPrice) {
        await sleep(this.config.signalCheckIntervalMs);
        continue;
      }

      const btcChange = (currentBtcPrice - windowOpenPrice) / windowOpenPrice;

      // Determine which side to buy based on BTC movement
      let buySignal: TradeSide | null = null;

      if (btcChange > this.config.btcMoveThreshold) {
        // BTC rising → Down is cheap → buy Down
        // But only if we don't have too much Down already
        if (filledDnShares <= filledUpShares + chunkSize * this.config.maxImbalanceChunks) {
          buySignal = "Down";
        }
      } else if (btcChange < -this.config.btcMoveThreshold) {
        // BTC falling → Up is cheap → buy Up
        // But only if we don't have too much Up already
        if (filledUpShares <= filledDnShares + chunkSize * this.config.maxImbalanceChunks) {
          buySignal = "Up";
        }
      }
      // BTC flat → no signal → wait

      if (buySignal) {
        const tokenId = buySignal === "Up" ? window.upTokenId : window.downTokenId;
        const book = this.getBook(tokenId);
        const bestAsk = book?.asks?.[0]?.price ?? 1.0;

        // Only buy if the ask is below our cheap threshold
        if (bestAsk < this.config.cheapThreshold) {
          const buyPrice = bestAsk + this.config.slippageBuffer;
          const fill = await this.buyOrder(tokenId, chunkSize, buyPrice, buySignal);

          if (fill.filled) {
            const fee = polymarketCryptoFee(fill.filledSize, fill.avgPrice);
            totalTakerFees += fee;

            if (buySignal === "Up") {
              filledUpShares += fill.filledSize;
              totalUpCost += fill.totalCost;
            } else {
              filledDnShares += fill.filledSize;
              totalDnCost += fill.totalCost;
            }
            availableBudget -= fill.totalCost;
            orderFills.push({
              orderNum: orderCount,
              side: buySignal,
              filledSize: fill.filledSize,
              avgPrice: fill.avgPrice,
              totalCost: fill.totalCost,
              fee,
              timestamp: Date.now(),
            });
            orderCount++;

            this.logger.info("Signal fill", {
              side: buySignal,
              btcChange: `${(btcChange * 100).toFixed(3)}%`,
              price: `${(fill.avgPrice * 100).toFixed(1)}¢`,
              size: fill.filledSize.toFixed(0),
              fee: `$${fee.toFixed(3)}`,
              balance: `Up=${filledUpShares.toFixed(0)} Dn=${filledDnShares.toFixed(0)}`,
            });
            this.telegram.send(
              `📈 ${buySignal}: ${fill.filledSize.toFixed(0)}sh @ ${(fill.avgPrice * 100).toFixed(1)}¢ ` +
              `(BTC ${btcChange > 0 ? "+" : ""}${(btcChange * 100).toFixed(3)}%) ` +
              `[Up=${filledUpShares.toFixed(0)} Dn=${filledDnShares.toFixed(0)}]`,
            );
          }
        } else {
          this.logger.debug("Signal but ask too expensive", {
            side: buySignal,
            bestAsk: `${(bestAsk * 100).toFixed(1)}¢`,
            threshold: `${(this.config.cheapThreshold * 100).toFixed(0)}¢`,
          });
        }
      }

      await sleep(this.config.signalCheckIntervalMs);
    }

    // ═══════════════════════════════════════════════════
    // PHASE 2: TAKER REBALANCE (T+260s)
    // If imbalanced, buy the short side as taker.
    // Dynamic cap: max_price = (1.00 - avg_long_price) - 0.01
    // ═══════════════════════════════════════════════════
    const imbalance = Math.abs(filledUpShares - filledDnShares);
    if (imbalance > 0 && availableBudget > 0) {
      const shortSide: TradeSide = filledUpShares > filledDnShares ? "Down" : "Up";
      const shortToken = shortSide === "Up" ? window.upTokenId : window.downTokenId;

      // Dynamic cap based on avg price of long side
      const longShares = shortSide === "Up" ? filledDnShares : filledUpShares;
      const longCost = shortSide === "Up" ? totalDnCost : totalUpCost;
      const avgLongPrice = longShares > 0 ? longCost / longShares : 0.50;
      const dynamicMaxPrice = (1.00 - avgLongPrice) - 0.01;

      this.logger.info("Phase 2: Taker rebalance", {
        imbalance: imbalance.toFixed(0),
        shortSide,
        avgLongPrice: `${(avgLongPrice * 100).toFixed(1)}¢`,
        dynamicCap: `${(dynamicMaxPrice * 100).toFixed(1)}¢`,
      });

      const book = this.getBook(shortToken);
      const bestAsk = book?.asks?.[0]?.price ?? 1.0;

      if (bestAsk <= dynamicMaxPrice) {
        const rebalancePrice = bestAsk + this.config.slippageBuffer;
        const fill = await this.buyOrder(shortToken, imbalance, rebalancePrice, shortSide);

        if (fill.filled) {
          const fee = polymarketCryptoFee(fill.filledSize, fill.avgPrice);
          totalTakerFees += fee;
          if (shortSide === "Up") {
            filledUpShares += fill.filledSize;
            totalUpCost += fill.totalCost;
          } else {
            filledDnShares += fill.filledSize;
            totalDnCost += fill.totalCost;
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
            dynamicCap: `${(dynamicMaxPrice * 100).toFixed(1)}¢`,
            newBalance: `Up=${filledUpShares.toFixed(0)} Dn=${filledDnShares.toFixed(0)}`,
          });
          this.telegram.send(
            `⚖️ Rebalance: ${fill.filledSize.toFixed(0)}sh ${shortSide} @ ${(fill.avgPrice * 100).toFixed(1)}¢ ` +
            `[cap: ${(dynamicMaxPrice * 100).toFixed(1)}¢]`,
          );
        }
      } else {
        this.logger.warn("Rebalance skipped — ask exceeds dynamic cap", {
          shortSide,
          bestAsk: `${(bestAsk * 100).toFixed(1)}¢`,
          dynamicCap: `${(dynamicMaxPrice * 100).toFixed(1)}¢`,
        });
        this.telegram.send(
          `⚠️ Rebalance SKIPPED: ${shortSide} ask ${(bestAsk * 100).toFixed(1)}¢ > dynamic cap ${(dynamicMaxPrice * 100).toFixed(1)}¢`,
        );
      }
    }

    // ═══════════════════════════════════════════════════
    // PHASE 3: MERGE
    // Merge matched Up+Down shares → $1.00 per pair
    // ═══════════════════════════════════════════════════
    const matched = Math.min(filledUpShares, filledDnShares);
    const merges: MergeResult[] = [];

    if (matched >= this.config.mergeMinSize) {
      const avgUpPrice = filledUpShares > 0 ? totalUpCost / filledUpShares : 0;
      const avgDnPrice = filledDnShares > 0 ? totalDnCost / filledDnShares : 0;
      const combinedCents = (avgUpPrice + avgDnPrice) * 100;

      this.logger.info("Phase 3: Merge", {
        matched: matched.toFixed(0),
        avgUp: `${(avgUpPrice * 100).toFixed(1)}¢`,
        avgDn: `${(avgDnPrice * 100).toFixed(1)}¢`,
        combined: `${combinedCents.toFixed(1)}¢`,
      });

      const mergeResult = await this.doMerge(
        window, matched, filledUpShares, filledDnShares, totalUpCost, totalDnCost,
      );
      if (mergeResult) {
        merges.push(mergeResult);
        this.telegram.send(
          `🔀 Merged ${mergeResult.merged.toFixed(0)}sh → profit $${mergeResult.profit.toFixed(3)} ` +
          `(combined ${combinedCents.toFixed(1)}¢)`,
        );
      }
    } else if (matched > 0) {
      this.logger.info("Matched shares below merge minimum", {
        matched: matched.toFixed(0),
        min: this.config.mergeMinSize,
      });
    }

    // --- RESULT ---
    const totalMerged = merges.reduce((s, m) => s + m.merged, 0);
    const totalMergeProfit = merges.reduce((s, m) => s + m.profit, 0);
    const avgUp = filledUpShares > 0 ? totalUpCost / filledUpShares : 0;
    const avgDn = filledDnShares > 0 ? totalDnCost / filledDnShares : 0;

    result.orderFills = orderFills;
    result.merges = merges;
    result.totalUpShares = filledUpShares;
    result.totalDnShares = filledDnShares;
    result.totalUpCost = totalUpCost;
    result.totalDnCost = totalDnCost;
    result.totalMerged = totalMerged;
    result.totalMergeProfit = totalMergeProfit;
    result.remainingUp = filledUpShares - totalMerged;
    result.remainingDn = filledDnShares - totalMerged;
    result.totalCost = totalUpCost + totalDnCost;
    result.avgCombinedCents = (avgUp + avgDn) * 100;
    result.takerFees = totalTakerFees;

    this.logger.info("=== V6 Window Summary ===", {
      fills: orderCount,
      upShares: filledUpShares.toFixed(0),
      dnShares: filledDnShares.toFixed(0),
      avgUp: `${(avgUp * 100).toFixed(1)}¢`,
      avgDn: `${(avgDn * 100).toFixed(1)}¢`,
      combined: `${((avgUp + avgDn) * 100).toFixed(1)}¢`,
      merged: totalMerged.toFixed(0),
      profit: `$${totalMergeProfit.toFixed(3)}`,
      fees: `$${totalTakerFees.toFixed(3)}`,
      remainingUp: result.remainingUp.toFixed(0),
      remainingDn: result.remainingDn.toFixed(0),
    });
    this.telegram.send(
      `📊 V6 Summary: ${orderCount} fills | ` +
      `Up=${filledUpShares.toFixed(0)}@${(avgUp * 100).toFixed(1)}¢ ` +
      `Dn=${filledDnShares.toFixed(0)}@${(avgDn * 100).toFixed(1)}¢ | ` +
      `combined ${((avgUp + avgDn) * 100).toFixed(1)}¢ | ` +
      `merged ${totalMerged.toFixed(0)} → $${totalMergeProfit.toFixed(3)}`,
    );

    return result;
  }

  // ─── PRIVATE METHODS ───

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

    let txHash = await this.redeem.mergePositions(window.conditionId, amount, window.negRisk);
    if (!txHash) {
      this.logger.warn("Merge failed, retrying...");
      await sleep(1000);
      txHash = await this.redeem.mergePositions(window.conditionId, amount, window.negRisk);
    }
    if (!txHash) {
      this.logger.warn("Merge retry failed — holding for resolution");
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
    // V6: more conservative chunks (30% equity, more fills expected)
    const estimatedFills = 8; // ~4 per side
    const estimatedAvgPrice = 0.35; // buying cheap side
    const rawChunk = Math.floor(budget / (estimatedFills * estimatedAvgPrice));
    const chunkSize = Math.min(Math.max(rawChunk, 20), this.config.maxChunkSize);

    this.sessionChunkSize = chunkSize;
    this.sessionChunkDate = today;
    this.logger.info("Session chunk size", { balance: `$${balance.toFixed(2)}`, chunkSize });

    return chunkSize;
  }
}
