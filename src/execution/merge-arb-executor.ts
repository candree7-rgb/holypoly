import { Side, OrderType } from "@polymarket/clob-client";
import type { Logger } from "../logger.js";
import type { TelegramNotifier } from "../telegram.js";
import type { ClobService } from "../data/clob.js";
import type { ClobWsClient, BookSnapshot } from "../data/clob-ws.js";
import type { RedeemService } from "../data/redeem.js";
import type { Config } from "../config.js";
import type {
  WindowInfo,
  OrderFill,
  PairResult,
  MergeResult,
  WindowExecutionResult,
  TradeSide,
} from "../types.js";
import { DryRunEngine } from "./dry-run-engine.js";
import { sleep, polymarketCryptoFee } from "../utils.js";

/**
 * MergeArbExecutor V5: 3-Phase Maker Strategy.
 *
 * KEY INSIGHT: Maker fee = 0% on Polymarket crypto markets.
 * V1-V4 were TAKERS → paid 1-1.5% fee → edge destroyed.
 *
 * 3-Phase Flow:
 * Phase 1 (MAKER, T+5s→T+240s): Post GTC BUY below ask on both sides.
 *   0% fee, only requote downward, wait for fills via oscillation.
 * Phase 2 (ASSESS+REBALANCE, T+240s→T+270s): Cancel unfilled orders.
 *   If imbalance: buy the short side as TAKER (1% fee) to eliminate
 *   naked directional exposure. Only ~5-10% of shares are taker.
 * Phase 3 (MERGE, T+270s→T+290s): Merge all matched shares for $1.
 */
export class MergeArbExecutor {
  private dryRunEngine: DryRunEngine | null = null;
  /** Session-level chunk size (calculated once per session/day) */
  private sessionChunkSize: number | null = null;
  private sessionChunkDate: string | null = null;
  /** Track consecutive failures to abort early */
  private consecutiveFailures = 0;

  constructor(
    private clob: ClobService,
    private clobWs: ClobWsClient,
    private redeem: RedeemService | null,
    private config: Config,
    private logger: Logger,
    private telegram: TelegramNotifier,
  ) {}

  /**
   * Execute the V3 merge-arb strategy for one 5-minute window.
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

    // Initialize DryRunEngine for this window
    if (this.config.dryRun) {
      this.dryRunEngine = new DryRunEngine(
        this.clobWs,
        this.config.takerFeeRate,
        balance,
        this.logger,
      );
    }

    this.consecutiveFailures = 0;

    // --- PRE-FLIGHT CHECK ---
    const preflight = await this.preFlightCheck(window);
    if (!preflight.pass) {
      result.skipped = true;
      result.skipReason = preflight.reason;
      this.logger.info("Window skipped", { reason: preflight.reason });
      this.telegram.send(`⏭️ Window skipped: ${preflight.reason}`);
      return result;
    }

    // --- CALCULATE CHUNK SIZE (session-level, V3 Spec 5.2) ---
    const chunkSize = this.getSessionChunkSize(balance);

    const budget = balance * this.config.equityPerWindow;
    this.logger.info("Starting V5 maker execution", {
      window: new Date(window.startTime).toISOString(),
      balance: `$${balance.toFixed(2)}`,
      budget: `$${budget.toFixed(2)}`,
      chunkSize,
      makerOffset: `${this.config.makerOffsetCents}¢`,
      maxOrders: this.config.maxOrdersPerWindow,
      dryRun: this.config.dryRun,
    });

    this.telegram.send(
      `${this.config.dryRun ? "📝 DRY_RUN" : "💰 LIVE"} V5 Maker start: ` +
      `${new Date(window.startTime).toISOString().slice(11, 19)} | ` +
      `Budget: $${budget.toFixed(0)} | Chunk: ${chunkSize}sh | Offset: ${this.config.makerOffsetCents}¢`,
    );

    // ═══════════════════════════════════════════════════
    // PHASE 1: MAKER QUOTING (T+5s to T+240s)
    // Post limit BUY orders BELOW the ask on both sides.
    // Maker fee = 0%. We choose prices → combined < 100¢.
    // BTC oscillation causes ask to cross our bids → fills.
    // Only requote DOWNWARD — never chase ask upward!
    // ═══════════════════════════════════════════════════
    let filledUpShares = 0;
    let filledDnShares = 0;
    let totalUpCost = 0;
    let totalDnCost = 0;
    let availableBudget = budget;
    let orderCount = 0;
    const orderFills: OrderFill[] = [];
    const merges: MergeResult[] = [];
    let totalMergedInWindow = 0;

    const makerPhaseEnd = window.endTime - this.config.makerPhaseEndS * 1000;
    const minOrderCost = chunkSize * 0.05;
    const makerOffset = this.config.makerOffsetCents / 100;

    // Active maker order tracking
    let activeUpOrderId: string | null = null;
    let activeUpPrice = 0;
    let activeDnOrderId: string | null = null;
    let activeDnPrice = 0;

    while (
      orderCount < this.config.maxOrdersPerWindow &&
      availableBudget > minOrderCost &&
      Date.now() < makerPhaseEnd
    ) {
      const upBook = this.getBook(window.upTokenId);
      const dnBook = this.getBook(window.downTokenId);

      if (!upBook?.asks?.length || !dnBook?.asks?.length) {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= 20) break;
        await sleep(this.config.quoteUpdateMs);
        continue;
      }
      this.consecutiveFailures = 0;

      const upBestAsk = upBook.asks[0].price;
      const dnBestAsk = dnBook.asks[0].price;

      // Calculate maker bid prices (below ask = maker, 0% fee)
      let upBid = Math.max(0.01, Math.round((upBestAsk - makerOffset) * 100) / 100);
      let dnBid = Math.max(0.01, Math.round((dnBestAsk - makerOffset) * 100) / 100);
      if (upBid >= upBestAsk) upBid = Math.max(0.01, upBestAsk - 0.01);
      if (dnBid >= dnBestAsk) dnBid = Math.max(0.01, dnBestAsk - 0.01);

      // --- CHECK FOR FILLS & MANAGE ORDERS ---
      if (this.config.dryRun && this.dryRunEngine) {
        // DRY_RUN: fill when bestAsk crosses down to our bid
        if (activeUpOrderId && upBestAsk <= activeUpPrice) {
          const fillCost = chunkSize * activeUpPrice; // 0% MAKER FEE!
          filledUpShares += chunkSize;
          totalUpCost += fillCost;
          availableBudget -= fillCost;
          this.dryRunEngine.recordMakerFill("Up", chunkSize, activeUpPrice);
          orderFills.push({ orderNum: orderCount, side: "Up", filledSize: chunkSize,
            avgPrice: activeUpPrice, totalCost: fillCost, fee: 0, timestamp: Date.now() });
          orderCount++;
          this.logger.info("Maker fill", { side: "Up", price: `${(activeUpPrice * 100).toFixed(1)}¢`,
            upSh: filledUpShares.toFixed(0), dnSh: filledDnShares.toFixed(0) });
          activeUpOrderId = null; activeUpPrice = 0;
        }
        if (activeDnOrderId && dnBestAsk <= activeDnPrice) {
          const fillCost = chunkSize * activeDnPrice;
          filledDnShares += chunkSize;
          totalDnCost += fillCost;
          availableBudget -= fillCost;
          this.dryRunEngine.recordMakerFill("Down", chunkSize, activeDnPrice);
          orderFills.push({ orderNum: orderCount, side: "Down", filledSize: chunkSize,
            avgPrice: activeDnPrice, totalCost: fillCost, fee: 0, timestamp: Date.now() });
          orderCount++;
          this.logger.info("Maker fill", { side: "Down", price: `${(activeDnPrice * 100).toFixed(1)}¢`,
            upSh: filledUpShares.toFixed(0), dnSh: filledDnShares.toFixed(0) });
          activeDnOrderId = null; activeDnPrice = 0;
        }
        // Post/update virtual bids — only requote DOWNWARD, never chase up
        if (!activeUpOrderId && filledUpShares <= filledDnShares + chunkSize) {
          activeUpOrderId = `dry-up-${Date.now()}`; activeUpPrice = upBid;
        } else if (activeUpOrderId && upBid < activeUpPrice - 0.005) {
          activeUpOrderId = `dry-up-${Date.now()}`; activeUpPrice = upBid;
        }
        if (!activeDnOrderId && filledDnShares <= filledUpShares + chunkSize) {
          activeDnOrderId = `dry-dn-${Date.now()}`; activeDnPrice = dnBid;
        } else if (activeDnOrderId && dnBid < activeDnPrice - 0.005) {
          activeDnOrderId = `dry-dn-${Date.now()}`; activeDnPrice = dnBid;
        }
      } else {
        // LIVE: manage real GTC orders
        if (activeUpOrderId) {
          const filled = await this.clob.getFilledShares(activeUpOrderId);
          if (filled > 0) {
            filledUpShares += filled; totalUpCost += filled * activeUpPrice; availableBudget -= filled * activeUpPrice;
            orderFills.push({ orderNum: orderCount, side: "Up", filledSize: filled,
              avgPrice: activeUpPrice, totalCost: filled * activeUpPrice, fee: 0, timestamp: Date.now() });
            orderCount++;
            await this.clob.cancelOrder(activeUpOrderId); activeUpOrderId = null; activeUpPrice = 0;
          } else if (upBid < activeUpPrice - 0.005) {
            await this.clob.cancelOrder(activeUpOrderId); activeUpOrderId = null;
          }
        }
        if (activeDnOrderId) {
          const filled = await this.clob.getFilledShares(activeDnOrderId);
          if (filled > 0) {
            filledDnShares += filled; totalDnCost += filled * activeDnPrice; availableBudget -= filled * activeDnPrice;
            orderFills.push({ orderNum: orderCount, side: "Down", filledSize: filled,
              avgPrice: activeDnPrice, totalCost: filled * activeDnPrice, fee: 0, timestamp: Date.now() });
            orderCount++;
            await this.clob.cancelOrder(activeDnOrderId); activeDnOrderId = null; activeDnPrice = 0;
          } else if (dnBid < activeDnPrice - 0.005) {
            await this.clob.cancelOrder(activeDnOrderId); activeDnOrderId = null;
          }
        }
        // Post new maker bids — only requote downward
        if (!activeUpOrderId && filledUpShares <= filledDnShares + chunkSize) {
          const r = await this.clob.placeBatchOrders([{ tokenId: window.upTokenId, side: Side.BUY, price: upBid, size: chunkSize }], OrderType.GTC);
          if (r.placed > 0 && r.orderIds.length > 0) { activeUpOrderId = r.orderIds[0]; activeUpPrice = upBid; }
        } else if (activeUpOrderId && upBid < activeUpPrice - 0.005) {
          await this.clob.cancelOrder(activeUpOrderId);
          const r = await this.clob.placeBatchOrders([{ tokenId: window.upTokenId, side: Side.BUY, price: upBid, size: chunkSize }], OrderType.GTC);
          if (r.placed > 0 && r.orderIds.length > 0) { activeUpOrderId = r.orderIds[0]; activeUpPrice = upBid; } else { activeUpOrderId = null; }
        }
        if (!activeDnOrderId && filledDnShares <= filledUpShares + chunkSize) {
          const r = await this.clob.placeBatchOrders([{ tokenId: window.downTokenId, side: Side.BUY, price: dnBid, size: chunkSize }], OrderType.GTC);
          if (r.placed > 0 && r.orderIds.length > 0) { activeDnOrderId = r.orderIds[0]; activeDnPrice = dnBid; }
        } else if (activeDnOrderId && dnBid < activeDnPrice - 0.005) {
          await this.clob.cancelOrder(activeDnOrderId);
          const r = await this.clob.placeBatchOrders([{ tokenId: window.downTokenId, side: Side.BUY, price: dnBid, size: chunkSize }], OrderType.GTC);
          if (r.placed > 0 && r.orderIds.length > 0) { activeDnOrderId = r.orderIds[0]; activeDnPrice = dnBid; } else { activeDnOrderId = null; }
        }
      }

      // Running stats
      const matched = Math.min(filledUpShares, filledDnShares);
      if (matched > 0 && orderCount % 2 === 0) {
        const rc = ((totalUpCost + totalDnCost) / matched) * 100;
        this.logger.info("Maker progress", { orders: orderCount, matched: `${matched.toFixed(0)}sh`,
          avgCombined: `${rc.toFixed(1)}¢`, budget: `$${availableBudget.toFixed(0)}` });
      }

      // Mid-merge recycling
      const matched2 = Math.min(filledUpShares, filledDnShares);
      if (availableBudget < chunkSize * 2 && matched2 >= this.config.mergeMinSize && Date.now() < makerPhaseEnd - 30_000) {
        const mr = await this.doMerge(window, matched2, filledUpShares, filledDnShares, totalUpCost, totalDnCost);
        if (mr) {
          merges.push(mr); totalMergedInWindow += mr.merged;
          const oU = filledUpShares, oD = filledDnShares;
          filledUpShares -= mr.merged; filledDnShares -= mr.merged; availableBudget += mr.recovered;
          totalUpCost = oU > 0 ? totalUpCost * (filledUpShares / oU) : 0;
          totalDnCost = oD > 0 ? totalDnCost * (filledDnShares / oD) : 0;
        }
      }

      await sleep(this.config.quoteUpdateMs);
    }

    // Cancel remaining active maker orders
    if (!this.config.dryRun) {
      if (activeUpOrderId) await this.clob.cancelOrder(activeUpOrderId);
      if (activeDnOrderId) await this.clob.cancelOrder(activeDnOrderId);
    }

    // ═══════════════════════════════════════════════════
    // PHASE 2: ASSESS + TAKER REBALANCE (T+240s to T+270s)
    // If one side has more fills → buy the short side as TAKER.
    // Yes, taker costs 1-1.5% fee — but only on the rebalance
    // portion, not on the 90%+ that was filled as maker (0%).
    // This eliminates naked directional exposure.
    // ═══════════════════════════════════════════════════
    const imbalance = Math.abs(filledUpShares - filledDnShares);
    if (imbalance > 0 && availableBudget > 0) {
      const shortSide: TradeSide = filledUpShares > filledDnShares ? "Down" : "Up";
      const shortToken = shortSide === "Up" ? window.upTokenId : window.downTokenId;
      const sharesToRebalance = Math.min(imbalance, this.config.maxTakerRebalanceShares);

      this.logger.info("Phase 2: Taker rebalance", {
        imbalance: imbalance.toFixed(0),
        shortSide,
        rebalancing: sharesToRebalance.toFixed(0),
        maxAllowed: this.config.maxTakerRebalanceShares,
      });

      if (sharesToRebalance > 0) {
        const book = this.getBook(shortToken);
        const bestAsk = book?.asks?.[0]?.price ?? 0.50;

        // Dynamic price cap: max_taker_price = (1.00 - avg_maker_price_other_side) - 0.01
        // Guarantees combined < 100¢ after rebalance (always profitable merge)
        const longSide: TradeSide = shortSide === "Up" ? "Down" : "Up";
        const longShares = longSide === "Up" ? filledUpShares : filledDnShares;
        const longCost = longSide === "Up" ? totalUpCost : totalDnCost;
        const avgLongPrice = longShares > 0 ? longCost / longShares : 0.50;
        const dynamicMaxPrice = (1.00 - avgLongPrice) - 0.01;

        if (bestAsk > dynamicMaxPrice) {
          this.logger.warn("Rebalance skipped — would make combined > 99¢", {
            side: shortSide,
            bestAsk: `${(bestAsk * 100).toFixed(1)}¢`,
            avgLongPrice: `${(avgLongPrice * 100).toFixed(1)}¢`,
            dynamicCap: `${(dynamicMaxPrice * 100).toFixed(1)}¢`,
            imbalance: sharesToRebalance.toFixed(0),
          });
          this.telegram.send(
            `⚠️ Rebalance SKIPPED: ${shortSide} ask ${(bestAsk * 100).toFixed(1)}¢ > dynamic cap ${(dynamicMaxPrice * 100).toFixed(1)}¢ ` +
            `(${longSide} avg ${(avgLongPrice * 100).toFixed(1)}¢) — holding ${sharesToRebalance.toFixed(0)}sh imbalance`,
          );
        } else {
          const rebalancePrice = bestAsk + this.config.slippageBuffer;

          // Execute taker buy for rebalance
          const fill = await this.buyOrder(shortToken, sharesToRebalance, rebalancePrice, shortSide);
          if (fill.filled) {
            const fee = polymarketCryptoFee(fill.filledSize, fill.avgPrice);
            if (shortSide === "Up") {
              filledUpShares += fill.filledSize;
              totalUpCost += fill.totalCost;
            } else {
              filledDnShares += fill.filledSize;
              totalDnCost += fill.totalCost;
            }
            availableBudget -= fill.totalCost;
            orderFills.push({
              orderNum: orderCount, side: shortSide, filledSize: fill.filledSize,
              avgPrice: fill.avgPrice, totalCost: fill.totalCost, fee, timestamp: Date.now(),
            });
            orderCount++;

            this.logger.info("Taker rebalance filled", {
              side: shortSide, size: fill.filledSize.toFixed(0),
              price: `${(fill.avgPrice * 100).toFixed(1)}¢`,
              fee: `$${fee.toFixed(2)}`,
              dynamicCap: `${(dynamicMaxPrice * 100).toFixed(1)}¢`,
              newBalance: `Up=${filledUpShares.toFixed(0)} Dn=${filledDnShares.toFixed(0)}`,
            });
            this.telegram.send(
              `⚖️ Rebalance: bought ${fill.filledSize.toFixed(0)}sh ${shortSide} as taker ` +
              `at ${(fill.avgPrice * 100).toFixed(1)}¢ (fee: $${fee.toFixed(2)}) [cap: ${(dynamicMaxPrice * 100).toFixed(1)}¢]`,
            );
          } else {
            this.logger.warn("Taker rebalance failed — will have imbalance at merge");
          }
        }
      }
    }

    // ═══════════════════════════════════════════════════
    // PHASE 3: FINAL MERGE (T+270-290s)
    // ═══════════════════════════════════════════════════
    const finalMatched = Math.min(filledUpShares, filledDnShares);
    if (finalMatched >= this.config.mergeMinSize) {
      const mergeTime = window.endTime - this.config.mergeBeforeEndS * 1000;
      const waitForMerge = mergeTime - Date.now();
      if (waitForMerge > 0 && waitForMerge < 60_000) {
        this.logger.info("Waiting for merge time", { waitMs: waitForMerge });
        await sleep(waitForMerge);
      }

      const mergeResult = await this.doMerge(
        window, finalMatched, filledUpShares, filledDnShares, totalUpCost, totalDnCost,
      );
      if (mergeResult) {
        merges.push(mergeResult);
        totalMergedInWindow += mergeResult.merged;
        filledUpShares -= mergeResult.merged;
        filledDnShares -= mergeResult.merged;
        const upAvg = totalUpCost / (filledUpShares + mergeResult.merged);
        const dnAvg = totalDnCost / (filledDnShares + mergeResult.merged);
        totalUpCost = filledUpShares * upAvg;
        totalDnCost = filledDnShares * dnAvg;
      }
    }

    // ═══════════════════════════════════════════════════
    // BUILD RESULT
    // ═══════════════════════════════════════════════════
    const totalMergeProfit = merges.reduce((s, m) => s + m.profit, 0);
    const totalCost = orderFills.reduce((s, f) => s + f.totalCost, 0);
    const totalFees = orderFills.reduce((s, f) => s + f.fee, 0);

    // Calculate running combined average (for reporting)
    const matched = totalMergedInWindow > 0 ? totalMergedInWindow : Math.min(
      orderFills.filter(f => f.side === "Up").reduce((s, f) => s + f.filledSize, 0),
      orderFills.filter(f => f.side === "Down").reduce((s, f) => s + f.filledSize, 0),
    );
    const upTotalCostAll = orderFills.filter(f => f.side === "Up").reduce((s, f) => s + f.totalCost, 0);
    const dnTotalCostAll = orderFills.filter(f => f.side === "Down").reduce((s, f) => s + f.totalCost, 0);
    const avgCombined = matched > 0 ? ((upTotalCostAll + dnTotalCostAll) / matched) * 100 : 0;

    // Build legacy PairResult for DB compatibility (group consecutive Up+Down into pairs)
    const pairs: PairResult[] = [];
    for (let i = 0; i < orderFills.length - 1; i += 2) {
      const a = orderFills[i];
      const b = orderFills[i + 1];
      if (!a || !b) break;
      const up = a.side === "Up" ? a : b;
      const dn = a.side === "Down" ? a : b;
      pairs.push({
        pairNum: pairs.length,
        upFilled: up.filledSize,
        upCost: up.totalCost,
        upPrice: up.avgPrice,
        dnFilled: dn.filledSize,
        dnCost: dn.totalCost,
        dnPrice: dn.avgPrice,
        combinedCents: (up.avgPrice + dn.avgPrice) * 100,
        imbalance: Math.abs(up.filledSize - dn.filledSize),
      });
    }

    Object.assign(result, {
      orderFills,
      pairs,
      merges,
      totalUpShares: filledUpShares,
      totalDnShares: filledDnShares,
      totalUpCost,
      totalDnCost,
      totalMerged: totalMergedInWindow,
      totalMergeProfit,
      remainingUp: filledUpShares,
      remainingDn: filledDnShares,
      totalCost,
      avgCombinedCents: avgCombined,
      takerFees: totalFees,
    });

    this.logger.info("Window execution complete", {
      orders: orderFills.length,
      totalMerged: totalMergedInWindow.toFixed(0),
      mergeProfit: `$${totalMergeProfit.toFixed(3)}`,
      remainingUp: filledUpShares.toFixed(0),
      remainingDn: filledDnShares.toFixed(0),
      avgCombined: `${avgCombined.toFixed(1)}¢`,
      fees: `$${totalFees.toFixed(3)}`,
    });

    this.telegram.send(
      `${this.config.dryRun ? "📝" : "💰"} V5 Maker done: ` +
      `${orderFills.length} fills (0% fee), merged ${totalMergedInWindow.toFixed(0)}sh, ` +
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
   * Sell remaining imbalance shares (post-resolution cleanup).
   */
  async sellRemainingShares(
    tokenId: string,
    shares: number,
    side: TradeSide,
  ): Promise<{ sold: boolean; revenue: number }> {
    if (shares <= 0) return { sold: false, revenue: 0 };

    if (this.config.dryRun) {
      this.logger.info("DRY_RUN: Sell simulated (post-resolution)", { side, shares: shares.toFixed(1) });
      return { sold: true, revenue: 0 };
    }

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
      this.logger.info("Sold remaining shares", { side, shares: shares.toFixed(1), revenue: `$${revenue.toFixed(2)}` });
      return { sold: true, revenue };
    }

    this.logger.warn("Failed to sell remaining shares", { side, shares: shares.toFixed(1) });
    return { sold: false, revenue: 0 };
  }

  /**
   * Crash recovery: check for open positions and clean up.
   */
  async crashRecovery(
    dataApi: import("../data/data-api.js").DataApiClient,
    profileAddress: string,
  ): Promise<void> {
    if (this.config.dryRun) {
      this.logger.info("DRY_RUN: Skipping crash recovery (no real positions)");
      return;
    }

    this.logger.info("Checking for open positions from previous session...");

    try {
      const positions = await dataApi.getPositions(profileAddress);
      if (positions.length === 0) {
        this.logger.info("No open positions found — clean startup");
        return;
      }

      const byCondition: Map<string, { up: number; dn: number; conditionId: string; negRisk: boolean }> = new Map();
      for (const pos of positions) {
        if (pos.size <= 0) continue;
        const key = pos.conditionId;
        let group = byCondition.get(key);
        if (!group) {
          group = { up: 0, dn: 0, conditionId: key, negRisk: pos.negativeRisk ?? false };
          byCondition.set(key, group);
        }
        if (pos.outcome === "Up" || pos.outcomeIndex === 0) {
          group.up += pos.size;
        } else {
          group.dn += pos.size;
        }
      }

      for (const [conditionId, group] of byCondition) {
        const matched = Math.min(group.up, group.dn);
        if (matched > 0 && this.redeem) {
          this.logger.info("Crash recovery: merging leftover positions", {
            conditionId: conditionId.slice(0, 12) + "...",
            upShares: group.up.toFixed(1),
            dnShares: group.dn.toFixed(1),
            merging: matched.toFixed(1),
          });
          const txHash = await this.redeem.mergePositions(conditionId, matched, group.negRisk);
          if (txHash) {
            this.logger.info("Crash recovery: merge successful", { txHash });
          } else {
            this.logger.warn("Crash recovery: merge failed, will rely on redeemLoop");
          }
        }

        const remainingUp = group.up - matched;
        const remainingDn = group.dn - matched;
        if (remainingUp > 0 || remainingDn > 0) {
          this.logger.info("Crash recovery: remaining imbalance", {
            conditionId: conditionId.slice(0, 12) + "...",
            remainingUp: remainingUp.toFixed(1),
            remainingDn: remainingDn.toFixed(1),
          });
        }
      }

      this.telegram.send(
        `Crash recovery: checked ${byCondition.size} markets, merged what was possible.`,
      );
    } catch (err) {
      this.logger.error("Crash recovery failed", { error: (err as Error).message });
    }
  }

  // ─── PRIVATE METHODS ───

  /** Get orderbook — uses DryRunEngine in DRY_RUN, WS otherwise */
  private getBook(tokenId: string): BookSnapshot | null {
    if (this.config.dryRun && this.dryRunEngine) {
      return this.dryRunEngine.getBookView(tokenId);
    }
    return this.clobWs.getBook(tokenId);
  }

  /**
   * Buy order: GTC primary with 3s cancel, FOK fallback.
   * V3: GTC at aggressive price → wait 3s → cancel if unfilled → next.
   */
  private async buyOrder(
    tokenId: string,
    size: number,
    maxPrice: number,
    side: TradeSide,
  ): Promise<{ filled: boolean; filledSize: number; avgPrice: number; totalCost: number }> {
    // DRY_RUN: simulate against live orderbook
    if (this.config.dryRun && this.dryRunEngine) {
      return this.dryRunEngine.simulateFokBuy(tokenId, size, maxPrice, side);
    }

    // LIVE: GTC primary with 3s timeout
    const gtcResult = await this.buyGtcWithCancel(tokenId, size, maxPrice, side, 3000);
    if (gtcResult.filled) return gtcResult;

    // Fallback: FOK with wider slippage
    if (this.config.maxRetriesPerOrder > 0) {
      await sleep(500);
      return this.buyFok(tokenId, size, maxPrice + this.config.slippageBuffer, side);
    }

    return { filled: false, filledSize: 0, avgPrice: 0, totalCost: 0 };
  }

  /**
   * GTC order with quick cancel — V3 primary order type.
   * Place GTC at aggressive price, wait cancelTimeoutMs, cancel unfilled rest.
   */
  private async buyGtcWithCancel(
    tokenId: string,
    size: number,
    maxPrice: number,
    side: TradeSide,
    cancelTimeoutMs: number,
  ): Promise<{ filled: boolean; filledSize: number; avgPrice: number; totalCost: number }> {
    const result = await this.clob.placeBatchOrders(
      [{ tokenId, side: Side.BUY, price: maxPrice, size }],
      OrderType.GTC,
    );

    if (result.placed === 0 || result.orderIds.length === 0) {
      return { filled: false, filledSize: 0, avgPrice: 0, totalCost: 0 };
    }

    // Wait for fills (3s — tempo is key)
    await sleep(cancelTimeoutMs);

    // Check what filled
    const fills = await this.clob.getOrderFills(result.orderIds);
    let totalShares = 0;
    let totalCost = 0;
    for (const fill of fills) {
      totalShares += fill.sizeMatched;
      totalCost += fill.costFilled;
    }

    // Cancel remaining
    for (const orderId of result.orderIds) {
      await this.clob.cancelOrder(orderId);
    }

    if (totalShares <= 0) {
      return { filled: false, filledSize: 0, avgPrice: 0, totalCost: 0 };
    }

    const avgPrice = totalCost / totalShares;
    const fee = polymarketCryptoFee(totalShares, avgPrice);

    return {
      filled: true,
      filledSize: totalShares,
      avgPrice,
      totalCost: totalCost + fee,
    };
  }

  /**
   * FOK buy order (fallback).
   */
  private async buyFok(
    tokenId: string,
    size: number,
    maxPrice: number,
    side: TradeSide,
  ): Promise<{ filled: boolean; filledSize: number; avgPrice: number; totalCost: number }> {
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

  /**
   * Pre-flight check: only skip for truly broken books (V3 Spec: very loose).
   */
  private async preFlightCheck(
    window: WindowInfo,
  ): Promise<{ pass: boolean; reason?: string }> {
    let upBook: BookSnapshot | null;
    let dnBook: BookSnapshot | null;

    upBook = this.clobWs.getBook(window.upTokenId);
    dnBook = this.clobWs.getBook(window.downTokenId);

    // Fallback to REST
    if (!upBook || !dnBook) {
      const upOb = await this.clob.getOrderbook(window.upTokenId);
      const dnOb = await this.clob.getOrderbook(window.downTokenId);
      upBook = { assetId: window.upTokenId, bids: upOb.bids.map(b => ({ price: b.price, size: b.size })), asks: upOb.asks.map(a => ({ price: a.price, size: a.size })), bestBid: upOb.bestBid, bestAsk: upOb.bestAsk };
      dnBook = { assetId: window.downTokenId, bids: dnOb.bids.map(b => ({ price: b.price, size: b.size })), asks: dnOb.asks.map(a => ({ price: a.price, size: a.size })), bestBid: dnOb.bestBid, bestAsk: dnOb.bestAsk };
    }

    if (!upBook || !dnBook) {
      return { pass: false, reason: "No orderbook (WS not connected or no data yet)" };
    }

    // Log orderbook snapshot
    const top5Up = (upBook.asks ?? []).slice(0, 5);
    const top5Dn = (dnBook.asks ?? []).slice(0, 5);
    const formatLevels = (levels: { price: number; size: number }[]) =>
      levels.map(l => `${(l.price * 100).toFixed(1)}¢×${l.size}`).join(" | ");
    this.logger.info("📊 Orderbook snapshot", {
      upAsks: formatLevels(top5Up),
      dnAsks: formatLevels(top5Dn),
      upLevels: upBook.asks?.length ?? 0,
      dnLevels: dnBook.asks?.length ?? 0,
    });
    this.telegram.send(
      `📊 Book: Up[${formatLevels(top5Up.slice(0, 3))}] Dn[${formatLevels(top5Dn.slice(0, 3))}]`,
    );

    // Only check minimum book depth (very loose)
    const upLevels = upBook.asks?.length ?? 0;
    const dnLevels = dnBook.asks?.length ?? 0;
    if (upLevels < this.config.minBookLevels || dnLevels < this.config.minBookLevels) {
      return {
        pass: false,
        reason: `Insufficient depth: Up=${upLevels} asks, Down=${dnLevels} asks (min=${this.config.minBookLevels})`,
      };
    }

    // V3: Only skip if book is COMPLETELY broken (110¢+)
    const bestUpAsk = upBook.bestAsk ?? (upBook.asks?.[0]?.price ?? null);
    const bestDnAsk = dnBook.bestAsk ?? (dnBook.asks?.[0]?.price ?? null);
    if (bestUpAsk !== null && bestDnAsk !== null) {
      const combined = bestUpAsk + bestDnAsk;
      if (combined > this.config.skipIfBestCombinedGt) {
        return {
          pass: false,
          reason: `Combined ${(combined * 100).toFixed(1)}¢ > skip gate ${(this.config.skipIfBestCombinedGt * 100).toFixed(0)}¢`,
        };
      }
    }

    this.logger.info("Pre-flight passed", {
      upAsk: bestUpAsk !== null ? `${(bestUpAsk * 100).toFixed(1)}¢` : "N/A",
      dnAsk: bestDnAsk !== null ? `${(bestDnAsk * 100).toFixed(1)}¢` : "N/A",
      combined: bestUpAsk !== null && bestDnAsk !== null ? `${((bestUpAsk + bestDnAsk) * 100).toFixed(1)}¢` : "N/A",
      upLevels,
      dnLevels,
    });

    return { pass: true };
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

    let txHash = await this.redeem.mergePositions(window.conditionId, amount, window.negRisk);

    // Retry once on failure
    if (!txHash) {
      this.logger.warn("Merge failed, retrying once...");
      await sleep(1000);
      txHash = await this.redeem.mergePositions(window.conditionId, amount, window.negRisk);
    }

    if (!txHash) {
      this.logger.warn("Merge retry also failed — will hold for resolution + redeem");
      return null;
    }

    const recovered = amount * 1.0;
    const upAvg = upShares > 0 ? upCost / upShares : 0;
    const dnAvg = dnShares > 0 ? dnCost / dnShares : 0;
    const profit = recovered - amount * (upAvg + dnAvg);

    return { merged: amount, recovered, profit, timestamp: Date.now() };
  }

  /**
   * Session-level chunk size (V3 Spec 5.2).
   * Budget for ~10 pairs (20 orders), avg price ~50¢.
   */
  private getSessionChunkSize(balance: number): number {
    const today = new Date().toISOString().slice(0, 10);
    if (this.sessionChunkSize !== null && this.sessionChunkDate === today) {
      return this.sessionChunkSize;
    }

    const budget = balance * this.config.equityPerWindow;
    const estimatedPairs = 10;
    const estimatedAvgPrice = 0.50;
    const rawChunk = Math.floor(budget / (estimatedPairs * 2 * estimatedAvgPrice));
    const chunkSize = Math.min(
      Math.max(rawChunk, 20),
      this.config.maxChunkSize,
    );

    this.sessionChunkSize = chunkSize;
    this.sessionChunkDate = today;
    this.logger.info("Session chunk size calculated", {
      date: today,
      balance: `$${balance.toFixed(2)}`,
      rawChunk,
      chunkSize,
      capped: rawChunk > this.config.maxChunkSize,
    });

    return chunkSize;
  }
}
