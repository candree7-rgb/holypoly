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
 * MergeArbExecutor V5: Maker Strategy — post limit bids, 0% fee.
 *
 * KEY INSIGHT: Maker fee = 0% on Polymarket crypto markets.
 * V1-V4 were TAKERS (hit the ask) → paid 1-1.5% fee → edge destroyed.
 * V5 posts limit BUY orders BELOW the ask (maker) → 0% fee + rebates.
 *
 * Strategy:
 * 1. Post GTC BUY on Up at (bestAsk - MAKER_OFFSET)
 * 2. Post GTC BUY on Down at (bestAsk - MAKER_OFFSET)
 * 3. Combined bid < 100¢ (we control the prices!)
 * 4. Wait for fills — BTC oscillation causes ask to cross our bids
 * 5. Update quotes as prices move (cancel + repost)
 * 6. Merge matched shares at end → profit
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
    // PHASE 1: ACCUMULATE — Maker Quoting (V5)
    // Post limit BUY orders BELOW the ask on both sides.
    // Maker fee = 0% (vs 1-1.5% taker fee that killed V1-V4).
    // We choose the prices → combined < 100¢ → merge for profit.
    // BTC oscillation causes ask to cross down to our bids → fills.
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

    const stopBuyingTime = window.endTime - this.config.stopBuyingBeforeEndS * 1000;
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
      Date.now() < stopBuyingTime
    ) {
      // --- READ BOTH BOOKS (live WS) ---
      const upBook = this.config.dryRun && this.dryRunEngine
        ? this.dryRunEngine.getBookView(window.upTokenId)
        : this.clobWs.getBook(window.upTokenId);
      const dnBook = this.config.dryRun && this.dryRunEngine
        ? this.dryRunEngine.getBookView(window.downTokenId)
        : this.clobWs.getBook(window.downTokenId);

      if (!upBook?.asks?.length || !dnBook?.asks?.length) {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= 20) {
          this.logger.warn("Too many no-book ticks, stopping");
          break;
        }
        await sleep(this.config.quoteUpdateMs);
        continue;
      }
      this.consecutiveFailures = 0;

      const upBestAsk = upBook.asks[0].price;
      const dnBestAsk = dnBook.asks[0].price;

      // --- CALCULATE MAKER BID PRICES ---
      // Bid below the ask → maker order (0% fee)
      // makerOffset ¢ below ask gives us edge per side
      let upBid = Math.max(0.01, upBestAsk - makerOffset);
      let dnBid = Math.max(0.01, dnBestAsk - makerOffset);

      // Round to cents (Polymarket tick = 0.01)
      upBid = Math.round(upBid * 100) / 100;
      dnBid = Math.round(dnBid * 100) / 100;

      // Ensure we're maker (strictly below ask)
      if (upBid >= upBestAsk) upBid = Math.max(0.01, upBestAsk - 0.01);
      if (dnBid >= dnBestAsk) dnBid = Math.max(0.01, dnBestAsk - 0.01);

      const combinedBid = (upBid + dnBid) * 100;

      // --- DRY_RUN: CHECK FOR FILLS ON ACTIVE BIDS ---
      if (this.config.dryRun && this.dryRunEngine) {
        // A maker bid fills when the ask crosses down to our bid price.
        // In real life: someone sells into our resting bid.
        if (activeUpOrderId && upBestAsk <= activeUpPrice) {
          const fillCost = chunkSize * activeUpPrice; // 0% MAKER FEE!
          filledUpShares += chunkSize;
          totalUpCost += fillCost;
          availableBudget -= fillCost;
          this.dryRunEngine.recordMakerFill("Up", chunkSize, activeUpPrice);
          orderFills.push({
            orderNum: orderCount, side: "Up", filledSize: chunkSize,
            avgPrice: activeUpPrice, totalCost: fillCost,
            fee: 0, timestamp: Date.now(),
          });
          orderCount++;
          this.logger.info("V5 maker fill", {
            side: "Up", price: `${(activeUpPrice * 100).toFixed(1)}¢`,
            fee: "0¢ (maker)", upSh: filledUpShares.toFixed(0), dnSh: filledDnShares.toFixed(0),
          });
          activeUpOrderId = null;
          activeUpPrice = 0;
        }

        if (activeDnOrderId && dnBestAsk <= activeDnPrice) {
          const fillCost = chunkSize * activeDnPrice;
          filledDnShares += chunkSize;
          totalDnCost += fillCost;
          availableBudget -= fillCost;
          this.dryRunEngine.recordMakerFill("Down", chunkSize, activeDnPrice);
          orderFills.push({
            orderNum: orderCount, side: "Down", filledSize: chunkSize,
            avgPrice: activeDnPrice, totalCost: fillCost,
            fee: 0, timestamp: Date.now(),
          });
          orderCount++;
          this.logger.info("V5 maker fill", {
            side: "Down", price: `${(activeDnPrice * 100).toFixed(1)}¢`,
            fee: "0¢ (maker)", upSh: filledUpShares.toFixed(0), dnSh: filledDnShares.toFixed(0),
          });
          activeDnOrderId = null;
          activeDnPrice = 0;
        }

        // Post/update virtual bids (balance: don't over-accumulate one side)
        // CRITICAL: Only requote DOWNWARD (cheaper). Never chase the ask upward!
        // If ask goes up → our old bid is further from ask → keep it (it's cheaper).
        // If ask goes down → requote to stay at ask-offset (tighter, still maker).
        if (!activeUpOrderId && filledUpShares <= filledDnShares + chunkSize) {
          activeUpOrderId = `dry-up-${Date.now()}`;
          activeUpPrice = upBid;
        } else if (activeUpOrderId && upBid < activeUpPrice - 0.005) {
          // Ask went DOWN → our bid should also go down (stay cheap)
          activeUpOrderId = `dry-up-${Date.now()}`;
          activeUpPrice = upBid;
        }
        // If upBid > activeUpPrice: ask went UP → DON'T requote up (keep cheap bid)

        if (!activeDnOrderId && filledDnShares <= filledUpShares + chunkSize) {
          activeDnOrderId = `dry-dn-${Date.now()}`;
          activeDnPrice = dnBid;
        } else if (activeDnOrderId && dnBid < activeDnPrice - 0.005) {
          // Ask went DOWN → requote down
          activeDnOrderId = `dry-dn-${Date.now()}`;
          activeDnPrice = dnBid;
        }
        // If dnBid > activeDnPrice: ask went UP → DON'T requote up
      } else {
        // === LIVE MODE: Manage real GTC maker orders ===

        // Check fills on active orders
        if (activeUpOrderId) {
          const filled = await this.clob.getFilledShares(activeUpOrderId);
          if (filled > 0) {
            const fillCost = filled * activeUpPrice; // 0% maker fee
            filledUpShares += filled;
            totalUpCost += fillCost;
            availableBudget -= fillCost;
            orderFills.push({
              orderNum: orderCount, side: "Up", filledSize: filled,
              avgPrice: activeUpPrice, totalCost: fillCost,
              fee: 0, timestamp: Date.now(),
            });
            orderCount++;
            this.logger.info("V5 maker fill (LIVE)", {
              side: "Up", filled: filled.toFixed(1), price: `${(activeUpPrice * 100).toFixed(1)}¢`,
            });
            await this.clob.cancelOrder(activeUpOrderId); // cancel remainder
            activeUpOrderId = null;
            activeUpPrice = 0;
          } else if (upBid < activeUpPrice - 0.005) {
            // Ask went DOWN → requote down (stay cheap). Never up!
            await this.clob.cancelOrder(activeUpOrderId);
            activeUpOrderId = null;
          }
        }

        if (activeDnOrderId) {
          const filled = await this.clob.getFilledShares(activeDnOrderId);
          if (filled > 0) {
            const fillCost = filled * activeDnPrice;
            filledDnShares += filled;
            totalDnCost += fillCost;
            availableBudget -= fillCost;
            orderFills.push({
              orderNum: orderCount, side: "Down", filledSize: filled,
              avgPrice: activeDnPrice, totalCost: fillCost,
              fee: 0, timestamp: Date.now(),
            });
            orderCount++;
            this.logger.info("V5 maker fill (LIVE)", {
              side: "Down", filled: filled.toFixed(1), price: `${(activeDnPrice * 100).toFixed(1)}¢`,
            });
            await this.clob.cancelOrder(activeDnOrderId);
            activeDnOrderId = null;
            activeDnPrice = 0;
          } else if (dnBid < activeDnPrice - 0.005) {
            // Ask went DOWN → requote down. Never up!
            await this.clob.cancelOrder(activeDnOrderId);
            activeDnOrderId = null;
          }
        }

        // Post new maker bids where needed (balance both sides)
        // CRITICAL: Only requote DOWNWARD. Never chase the ask upward!
        // Post new bids where needed
        if (!activeUpOrderId && filledUpShares <= filledDnShares + chunkSize) {
          const result = await this.clob.placeBatchOrders(
            [{ tokenId: window.upTokenId, side: Side.BUY, price: upBid, size: chunkSize }],
            OrderType.GTC,
          );
          if (result.placed > 0 && result.orderIds.length > 0) {
            activeUpOrderId = result.orderIds[0];
            activeUpPrice = upBid;
            this.logger.debug("Posted Up maker bid", { price: `${(upBid * 100).toFixed(1)}¢` });
          }
        } else if (activeUpOrderId && upBid < activeUpPrice - 0.005) {
          // Ask went DOWN → requote our bid down (stay cheap)
          await this.clob.cancelOrder(activeUpOrderId);
          const result = await this.clob.placeBatchOrders(
            [{ tokenId: window.upTokenId, side: Side.BUY, price: upBid, size: chunkSize }],
            OrderType.GTC,
          );
          if (result.placed > 0 && result.orderIds.length > 0) {
            activeUpOrderId = result.orderIds[0];
            activeUpPrice = upBid;
          } else {
            activeUpOrderId = null;
          }
        }
        // If upBid > activeUpPrice: ask went UP → keep old cheap bid

        if (!activeDnOrderId && filledDnShares <= filledUpShares + chunkSize) {
          const result = await this.clob.placeBatchOrders(
            [{ tokenId: window.downTokenId, side: Side.BUY, price: dnBid, size: chunkSize }],
            OrderType.GTC,
          );
          if (result.placed > 0 && result.orderIds.length > 0) {
            activeDnOrderId = result.orderIds[0];
            activeDnPrice = dnBid;
            this.logger.debug("Posted Dn maker bid", { price: `${(dnBid * 100).toFixed(1)}¢` });
          }
        } else if (activeDnOrderId && dnBid < activeDnPrice - 0.005) {
          // Ask went DOWN → requote our bid down
          await this.clob.cancelOrder(activeDnOrderId);
          const result = await this.clob.placeBatchOrders(
            [{ tokenId: window.downTokenId, side: Side.BUY, price: dnBid, size: chunkSize }],
            OrderType.GTC,
          );
          if (result.placed > 0 && result.orderIds.length > 0) {
            activeDnOrderId = result.orderIds[0];
            activeDnPrice = dnBid;
          } else {
            activeDnOrderId = null;
          }
        }
        // If dnBid > activeDnPrice: ask went UP → keep old cheap bid
      }

      // --- RUNNING STATS ---
      const matched = Math.min(filledUpShares, filledDnShares);
      if (matched > 0 && orderCount % 2 === 0) {
        const runningCombined = ((totalUpCost + totalDnCost) / matched) * 100;
        this.logger.info("Maker progress", {
          orders: orderCount, matched: `${matched.toFixed(0)}sh`,
          avgCombined: `${runningCombined.toFixed(1)}¢`,
          budget: `$${availableBudget.toFixed(0)}`,
          upBid: `${(activeUpPrice * 100).toFixed(0)}¢`,
          dnBid: `${(activeDnPrice * 100).toFixed(0)}¢`,
        });
      }

      // --- MID-MERGE RECYCLING ---
      const matched2 = Math.min(filledUpShares, filledDnShares);
      if (
        availableBudget < chunkSize * 2 &&
        matched2 >= this.config.mergeMinSize &&
        Date.now() < stopBuyingTime - 30_000
      ) {
        this.logger.info("Mid-merge recycling: budget low", {
          budget: `$${availableBudget.toFixed(0)}`,
          merging: `${matched2.toFixed(0)}sh`,
        });
        const mergeResult = await this.doMerge(
          window, matched2, filledUpShares, filledDnShares, totalUpCost, totalDnCost,
        );
        if (mergeResult) {
          merges.push(mergeResult);
          totalMergedInWindow += mergeResult.merged;
          const origUp = filledUpShares;
          const origDn = filledDnShares;
          filledUpShares -= mergeResult.merged;
          filledDnShares -= mergeResult.merged;
          availableBudget += mergeResult.recovered;
          totalUpCost = origUp > 0 ? totalUpCost * (filledUpShares / origUp) : 0;
          totalDnCost = origDn > 0 ? totalDnCost * (filledDnShares / origDn) : 0;
        }
      }

      await sleep(this.config.quoteUpdateMs);
    }

    // Cancel remaining active orders
    if (!this.config.dryRun) {
      if (activeUpOrderId) await this.clob.cancelOrder(activeUpOrderId);
      if (activeDnOrderId) await this.clob.cancelOrder(activeDnOrderId);
    }

    // ═══════════════════════════════════════════════════
    // PHASE 2: FINAL MERGE (T+260-280s)
    // ═══════════════════════════════════════════════════
    const finalMatched = Math.min(filledUpShares, filledDnShares);
    if (finalMatched >= this.config.mergeMinSize) {
      // Wait until merge time if needed
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
        // Reduce costs proportionally
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
