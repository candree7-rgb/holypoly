import { Side } from "@polymarket/clob-client";
import type { Config } from "../config.js";
import type { ClobService, OrderbookSnapshot } from "../data/clob.js";
import type { Logger } from "../logger.js";
import type { GridOrder, TradeSide, WindowInfo } from "../types.js";
import { FairValueEngine } from "./fair-value.js";

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
    private logger: Logger
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

    // Check minimum delta threshold (skip flat markets)
    const absDelta = Math.abs(currentBtcPrice - window.openingPrice);
    if (absDelta < this.config.minDeltaThresholdUsd && marketUpCents >= 45 && marketUpCents <= 55) {
      return noTrade(`BTC flat (delta=$${absDelta.toFixed(2)}) and market near 50/50`);
    }

    // Skip when primary side outside sweet spot (purpledeer: 50-65¢)
    const primaryAskCents = edge.bestSide === "Up" ? marketUpCents : marketDownCents;
    if (primaryAskCents < this.config.minEntryPriceCents) {
      return noTrade(`Primary ${edge.bestSide} too cheap (${primaryAskCents}¢ < ${this.config.minEntryPriceCents}¢ — contrarian bet)`);
    }
    if (primaryAskCents > this.config.maxEntryPriceCents) {
      return noTrade(`Primary ${edge.bestSide} too expensive (${primaryAskCents}¢ > ${this.config.maxEntryPriceCents}¢)`);
    }

    // Build grid orders
    const orders = this.buildGridOrders(
      window,
      edge.bestSide,
      edge.fairUp,
      upBook,
      downBook,
      buyAmountUsd
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
      reason: `Edge: ${edge.bestEdge.toFixed(1)}¢ on ${edge.bestSide} (fair=${edge.fairUp}¢)`,
    };
  }

  /**
   * Build grid of limit orders at different price levels.
   * Primary side: 3-5 orders at ask levels up to fair value + 5¢
   * Hedge side: 1-2 orders at cheap levels (< hedgeMaxPriceCents)
   */
  private buildGridOrders(
    window: WindowInfo,
    primarySide: TradeSide,
    fairUp: number,
    upBook: OrderbookSnapshot,
    downBook: OrderbookSnapshot,
    buyAmountUsd: number
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
      .slice(0, this.config.maxBuysPerSide);

    for (const level of primaryLevels) {
      const size = buyAmountUsd / level.price; // shares = USD / price
      orders.push({
        side: primarySide,
        tokenId: primaryTokenId,
        price: level.price * 100, // store as cents for logging
        amount: buyAmountUsd,
      });
    }

    // If no ask levels available, place at best ask
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

    // Hedge side: only if we have primary orders (never hedge without a primary bet)
    if (orders.length > 0) {
      const hedgeMaxPrice = this.config.hedgeMaxPriceCents / 100;
      const hedgeLevels = hedgeBook.asks
        .filter((a) => a.price <= hedgeMaxPrice)
        .slice(0, 2);

      for (const level of hedgeLevels) {
        orders.push({
          side: hedgeSide,
          tokenId: hedgeTokenId,
          price: level.price * 100,
          amount: buyAmountUsd,
        });
      }
    }

    // Cap total orders
    return orders.slice(0, this.config.maxBuysPerWindow);
  }
}
