import { Side } from "@polymarket/clob-client";
import type { Config } from "../config.js";
import type { ClobService, OrderbookSnapshot } from "../data/clob.js";
import type { Logger } from "../logger.js";
import type { GridOrder, TradeSide, WindowInfo } from "../types.js";
import { FairValueEngine } from "./fair-value.js";
import { VolatilityCalculator } from "./volatility.js";

export interface TradeDecision {
  shouldTrade: boolean;
  orders: GridOrder[];
  primarySide: TradeSide;
  fairUp: number;
  bestEdge: number;
  reason: string;
}

/**
 * Edge detector: combines fair value, market prices, and config
 * to produce a batch of grid orders for a window.
 */
export class EdgeDetector {
  constructor(
    private fairValueEngine: FairValueEngine,
    private clob: ClobService,
    private config: Config,
    private logger: Logger,
    private volatilityCalc?: VolatilityCalculator
  ) {}

  /**
   * Evaluate the current window and decide whether/what to trade.
   * @param buyAmountUsd - Dynamic buy amount (calculated from balance %)
   */
  async evaluate(
    window: WindowInfo,
    currentBtcPrice: number,
    timeRemainingSeconds: number,
    buyAmountUsd: number = this.config.buyAmountPct
  ): Promise<TradeDecision> {
    const noTrade = (reason: string): TradeDecision => ({
      shouldTrade: false,
      orders: [],
      primarySide: "Up",
      fairUp: 50,
      bestEdge: 0,
      reason,
    });

    // Skip if too late in the window (< 30s left = too risky)
    if (timeRemainingSeconds < 30) {
      return noTrade("Too late in window");
    }

    // Get orderbook for both sides
    let upBook: OrderbookSnapshot;
    let downBook: OrderbookSnapshot;
    try {
      [upBook, downBook] = await Promise.all([
        this.clob.getOrderbook(window.upTokenId),
        this.clob.getOrderbook(window.downTokenId),
      ]);
    } catch (err) {
      return noTrade(`Orderbook fetch failed: ${(err as Error).message}`);
    }

    // Need valid ask prices
    if (upBook.bestAsk === null || downBook.bestAsk === null) {
      return noTrade("No asks available");
    }

    // Market prices in cents (Polymarket prices are 0-1, convert to 0-100)
    const marketUpCents = Math.round(upBook.bestAsk * 100);
    const marketDownCents = Math.round(downBook.bestAsk * 100);

    // Calculate edge
    const edge = this.fairValueEngine.calculateEdge(
      currentBtcPrice,
      window.openingPrice,
      timeRemainingSeconds,
      marketUpCents,
      marketDownCents
    );

    this.logger.debug("Edge evaluation", {
      delta: (currentBtcPrice - window.openingPrice).toFixed(2),
      fairUp: edge.fairUp,
      marketUp: marketUpCents,
      marketDown: marketDownCents,
      upEdge: edge.upEdge.toFixed(1),
      downEdge: edge.downEdge.toFixed(1),
      bestSide: edge.bestSide,
      bestEdge: edge.bestEdge.toFixed(1),
      timeLeft: timeRemainingSeconds,
    });

    // Check minimum edge threshold
    if (edge.bestEdge < this.config.edgeThresholdCents) {
      return noTrade(`Edge too small (${edge.bestEdge.toFixed(1)}¢ < ${this.config.edgeThresholdCents}¢)`);
    }

    // Momentum filter: skip if BTC is moving against our predicted direction
    if (this.volatilityCalc && this.config.maxAdverseMomentumUsd > 0) {
      const momentum = this.volatilityCalc.getRecentMomentum(this.config.momentumLookbackSeconds);
      if (momentum !== null) {
        const isAdverse =
          (edge.bestSide === "Up" && momentum < -this.config.maxAdverseMomentumUsd) ||
          (edge.bestSide === "Down" && momentum > this.config.maxAdverseMomentumUsd);
        if (isAdverse) {
          return noTrade(
            `Adverse momentum: BTC moved $${momentum.toFixed(0)} in ${this.config.momentumLookbackSeconds}s vs ${edge.bestSide}`
          );
        }
      }
    }

    // Check minimum delta threshold (skip flat markets)
    const absDelta = Math.abs(currentBtcPrice - window.openingPrice);
    if (absDelta < this.config.minDeltaThresholdUsd && marketUpCents >= 45 && marketUpCents <= 55) {
      return noTrade(`BTC flat (delta=$${absDelta.toFixed(2)}) and market near 50/50`);
    }

    // Skip when primary side outside entry range (purpledeer: 81% of buys at 40-90¢)
    const primaryAskCents = edge.bestSide === "Up" ? marketUpCents : marketDownCents;
    if (primaryAskCents < this.config.minEntryPriceCents) {
      return noTrade(`Primary ${edge.bestSide} too cheap (${primaryAskCents}¢ < ${this.config.minEntryPriceCents}¢)`);
    }
    if (primaryAskCents > this.config.maxEntryPriceCents) {
      return noTrade(`Primary ${edge.bestSide} too expensive (${primaryAskCents}¢ > ${this.config.maxEntryPriceCents}¢)`);
    }

    // Determine number of primary orders based on edge strength
    const numPrimary = this.scalePrimaryOrders(edge.bestEdge);

    // Determine hedge: only at lower edge levels (purpledeer hedges ~31% of windows)
    const shouldHedge = this.shouldHedge(edge.bestEdge);

    // Build grid orders
    const orders = this.buildGridOrders(
      window,
      edge.bestSide,
      edge.fairUp,
      upBook,
      downBook,
      buyAmountUsd,
      numPrimary,
      shouldHedge
    );

    if (orders.length === 0) {
      return noTrade("No viable order levels found");
    }

    return {
      shouldTrade: true,
      orders,
      primarySide: edge.bestSide,
      fairUp: edge.fairUp,
      bestEdge: edge.bestEdge,
      reason: `Edge: ${edge.bestEdge.toFixed(1)}¢ on ${edge.bestSide} (fair=${edge.fairUp}¢, ${numPrimary}P${shouldHedge ? "+½H" : ""})`,
    };
  }

  /**
   * Scale number of primary orders with edge strength.
   * Based on purpledeer's data: avg 2.3 buys/window, 44% are single-buy.
   */
  private scalePrimaryOrders(edgeCents: number): number {
    const { edgeTier2Cents, edgeTier3Cents, edgeTier4Cents, maxBuysPerSide } = this.config;

    let target: number;
    if (edgeCents >= edgeTier4Cents) {
      // 15+: very strong signal, go big (4-5)
      target = 4 + (edgeCents >= edgeTier4Cents + 5 ? 1 : 0);
    } else if (edgeCents >= edgeTier3Cents) {
      // 12-15: strong signal
      target = 3;
    } else if (edgeCents >= edgeTier2Cents) {
      // 8-12: medium signal
      target = 2;
    } else {
      // 5-8: weak signal, minimal position
      target = 1;
    }

    return Math.min(target, maxBuysPerSide);
  }

  /**
   * Dynamic hedge decision based on edge strength.
   * Disabled when hedgeMonitorEnabled=true (reactive hedge replaces upfront hedge).
   * Only hedge at medium conviction (8-12¢). No hedge for weak or strong edges.
   */
  private shouldHedge(edgeCents: number): boolean {
    if (this.config.hedgeMonitorEnabled) return false;
    return edgeCents >= this.config.edgeTier2Cents && edgeCents < this.config.hedgeEdgeThresholdCents;
  }

  /**
   * Build grid of limit orders at different price levels.
   * Primary orders scale with edge. Hedge is conditional (31% of windows).
   */
  private buildGridOrders(
    window: WindowInfo,
    primarySide: TradeSide,
    fairUp: number,
    upBook: OrderbookSnapshot,
    downBook: OrderbookSnapshot,
    buyAmountUsd: number,
    numPrimary: number,
    shouldHedge: boolean
  ): GridOrder[] {
    const orders: GridOrder[] = [];
    const hedgeSide: TradeSide = primarySide === "Up" ? "Down" : "Up";

    const primaryBook = primarySide === "Up" ? upBook : downBook;
    const hedgeBook = hedgeSide === "Up" ? upBook : downBook;
    const primaryTokenId = primarySide === "Up" ? window.upTokenId : window.downTokenId;
    const hedgeTokenId = hedgeSide === "Up" ? window.upTokenId : window.downTokenId;

    const fairPrimary = primarySide === "Up" ? fairUp : 100 - fairUp;

    // Primary side: buy at ask levels up to fairValue + 5¢
    const primaryMaxPrice = (fairPrimary + 5) / 100; // convert cents to decimal
    const primaryLevels = primaryBook.asks
      .filter((a) => a.price <= primaryMaxPrice)
      .slice(0, numPrimary); // scaled by edge, NOT always maxBuysPerSide

    for (const level of primaryLevels) {
      orders.push({
        side: primarySide,
        tokenId: primaryTokenId,
        price: level.price * 100, // store as cents for logging
        amount: buyAmountUsd,
      });
    }

    // If no ask levels available, place at best ask (still respect numPrimary)
    if (orders.length === 0 && primaryBook.bestAsk !== null) {
      if (primaryBook.bestAsk <= primaryMaxPrice) {
        orders.push({
          side: primarySide,
          tokenId: primaryTokenId,
          price: primaryBook.bestAsk * 100,
          amount: buyAmountUsd,
        });
      }
    }

    // Hedge side: only when edge is low enough AND opposite side is cheap
    if (shouldHedge && orders.length > 0) {
      const hedgeMaxPrice = this.config.hedgeMaxPriceCents / 100; // 45¢
      const hedgeLevels = hedgeBook.asks
        .filter((a) => a.price <= hedgeMaxPrice)
        .slice(0, 1); // max 1 hedge order (purpledeer avg)

      const hedgeAmount = buyAmountUsd * 0.5; // half-size hedge
      for (const level of hedgeLevels) {
        orders.push({
          side: hedgeSide,
          tokenId: hedgeTokenId,
          price: level.price * 100,
          amount: hedgeAmount,
        });
      }
    }

    // Cap total orders (hard ceiling)
    return orders.slice(0, this.config.maxBuysPerWindow);
  }
}
