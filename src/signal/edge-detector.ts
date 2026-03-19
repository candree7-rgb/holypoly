import type { Config } from "../config.js";
import type { ClobService, OrderbookSnapshot } from "../data/clob.js";
import type { Logger } from "../logger.js";
import type { GridOrder, TradeSide, WindowInfo } from "../types.js";
import { FairValueEngine } from "./fair-value.js";
import type { VolatilityCalculator, VolatilityRegime } from "./volatility.js";

export interface TradeDecision {
  shouldTrade: boolean;
  orders: GridOrder[];
  primarySide: TradeSide;
  fairUp: number;
  bestEdge: number;
  confidence: number;
  regime: VolatilityRegime;
  reason: string;
  /** Orderbook depth imbalance signal (>1 = depth confirms our side) */
  depthConfirmation: number;
}

/**
 * Improved Edge Detector v2.
 *
 * Key improvements over v1:
 * - Dynamic edge thresholds based on volatility regime
 *   (lower threshold in high-vol = more opportunities, higher in low-vol = better odds)
 * - Confidence-weighted position sizing (scale with data quality)
 * - Latency-aware entry: considers time needed to fill orders
 * - Acceleration filter: prefer trades where BTC is moving in our direction
 * - Better grid order construction with spread-aware pricing
 */
export class EdgeDetector {
  constructor(
    private fairValueEngine: FairValueEngine,
    private clob: ClobService,
    private config: Config,
    private logger: Logger,
    private volatilityCalc: VolatilityCalculator,
  ) {}

  async evaluate(
    window: WindowInfo,
    currentBtcPrice: number,
    timeRemainingSeconds: number,
    buyAmountUsd: number,
  ): Promise<TradeDecision> {
    const noTrade = (reason: string): TradeDecision => ({
      shouldTrade: false,
      orders: [],
      primarySide: "Up",
      fairUp: 50,
      bestEdge: 0,
      confidence: 0,
      regime: "normal",
      reason,
      depthConfirmation: 1,
    });

    // Skip if too late (need time for order fills + settlement buffer)
    if (timeRemainingSeconds < 20) {
      return noTrade("Too late in window (<20s)");
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

    if (upBook.bestAsk === null || downBook.bestAsk === null) {
      return noTrade("No asks available");
    }

    const marketUpCents = Math.round(upBook.bestAsk * 100);
    const marketDownCents = Math.round(downBook.bestAsk * 100);

    // Sanity check: in a binary market, Up ask + Down ask should be ~100¢
    // If sum > 105¢, orderbook is broken/stale — don't trade
    const askSum = marketUpCents + marketDownCents;
    if (askSum > 105) {
      return noTrade(`Orderbook broken: Up ${marketUpCents}¢ + Down ${marketDownCents}¢ = ${askSum}¢ (>105¢)`);
    }

    // Calculate edge with confidence
    const edge = this.fairValueEngine.calculateEdge(
      currentBtcPrice,
      window.openingPrice,
      timeRemainingSeconds,
      marketUpCents,
      marketDownCents,
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
      confidence: edge.confidence.toFixed(2),
      regime: edge.regime,
      timeLeft: timeRemainingSeconds,
    });

    // Dynamic edge threshold based on volatility regime
    const effectiveThreshold = this.getAdaptiveThreshold(edge.regime, timeRemainingSeconds);

    if (edge.bestEdge < effectiveThreshold) {
      return noTrade(
        `Edge too small (${edge.bestEdge.toFixed(1)}¢ < ${effectiveThreshold.toFixed(1)}¢ [${edge.regime}])`,
      );
    }

    // Momentum filter: skip if BTC moving against our side
    if (this.config.maxAdverseMomentumUsd > 0) {
      const momentum = this.volatilityCalc.getRecentMomentum(this.config.momentumLookbackSeconds);
      if (momentum !== null) {
        const isAdverse =
          (edge.bestSide === "Up" && momentum < -this.config.maxAdverseMomentumUsd) ||
          (edge.bestSide === "Down" && momentum > this.config.maxAdverseMomentumUsd);
        if (isAdverse) {
          return noTrade(
            `Adverse momentum: $${momentum.toFixed(0)} in ${this.config.momentumLookbackSeconds}s vs ${edge.bestSide}`,
          );
        }
      }
    }

    // Skip flat markets near 50/50
    const absDelta = Math.abs(currentBtcPrice - window.openingPrice);
    if (absDelta < this.config.minDeltaThresholdUsd && marketUpCents >= 45 && marketUpCents <= 55) {
      return noTrade(`BTC flat (delta=$${absDelta.toFixed(2)}) and market near 50/50`);
    }

    // Price bounds check
    const primaryAskCents = edge.bestSide === "Up" ? marketUpCents : marketDownCents;
    const loserAskCents = edge.bestSide === "Up" ? marketDownCents : marketUpCents;
    if (primaryAskCents < this.config.minEntryPriceCents) {
      return noTrade(`Primary ${edge.bestSide} too cheap (${primaryAskCents}¢ < ${this.config.minEntryPriceCents}¢)`);
    }
    if (primaryAskCents > this.config.maxEntryPriceCents) {
      return noTrade(`Primary ${edge.bestSide} too expensive (${primaryAskCents}¢ > ${this.config.maxEntryPriceCents}¢)`);
    }

    // === ORDERBOOK DEPTH CONFIRMATION ===
    // If buying Up: we want primary (Up) ask side thin (easy to buy) + loser (Down) bid depth high
    // Imbalance > 1 on primary = more buy pressure = confirms our direction
    const primaryBook = edge.bestSide === "Up" ? upBook : downBook;
    const depthConfirmation = primaryBook.depthImbalance;

    // Boost confidence when depth confirms, reduce when depth contradicts
    let depthAdjustedConfidence = edge.confidence;
    if (depthConfirmation > 2.0) {
      // Strong depth confirmation — boost confidence by up to 15%
      depthAdjustedConfidence = Math.min(1, edge.confidence * 1.15);
    } else if (depthConfirmation < 0.5) {
      // Depth contradicts our side — reduce confidence by 20%
      depthAdjustedConfidence = edge.confidence * 0.8;
    }

    this.logger.debug("Depth analysis", {
      side: edge.bestSide,
      bidDepth: `$${primaryBook.bidDepthUsd.toFixed(2)}`,
      askDepth: `$${primaryBook.askDepthUsd.toFixed(2)}`,
      imbalance: depthConfirmation.toFixed(2),
      confidenceAdj: `${(edge.confidence * 100).toFixed(0)}% → ${(depthAdjustedConfidence * 100).toFixed(0)}%`,
    });

    // Scale position by edge strength AND depth-adjusted confidence
    const numPrimary = this.scalePrimaryOrders(edge.bestEdge, depthAdjustedConfidence);

    // Scale buy amount by confidence (reduce exposure when data is thin)
    const confidenceScaledAmount = buyAmountUsd * Math.max(0.5, depthAdjustedConfidence);

    // === DEPTH-AWARE SIZING ===
    // Cap buy amount to 40% of available ask depth (prevent market impact)
    const depthCappedAmount = Math.min(
      confidenceScaledAmount,
      primaryBook.askDepthUsd * 0.4,
    );
    if (depthCappedAmount < confidenceScaledAmount * 0.5) {
      this.logger.debug("Depth cap active — reducing position size", {
        wanted: `$${confidenceScaledAmount.toFixed(2)}`,
        available: `$${primaryBook.askDepthUsd.toFixed(2)}`,
        capped: `$${depthCappedAmount.toFixed(2)}`,
      });
    }
    // Don't enter if available depth is too thin (< $5 or < 30% of desired)
    if (depthCappedAmount < 5 || depthCappedAmount < confidenceScaledAmount * 0.3) {
      return noTrade(`Orderbook too thin: $${primaryBook.askDepthUsd.toFixed(2)} ask depth vs $${confidenceScaledAmount.toFixed(2)} wanted`);
    }

    // Build orders (directional — no hedge needed)
    const orders = this.buildGridOrders(
      window,
      edge.bestSide,
      edge.fairUp,
      upBook,
      downBook,
      depthCappedAmount,
      numPrimary,
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
      confidence: depthAdjustedConfidence,
      regime: edge.regime,
      depthConfirmation,
      reason: `Edge: ${edge.bestEdge.toFixed(1)}¢ on ${edge.bestSide} (fair=${edge.fairUp}¢, conf=${(depthAdjustedConfidence * 100).toFixed(0)}%, depth=${depthConfirmation.toFixed(1)}x, ${numPrimary} orders, ${edge.regime} vol)`,
    };
  }

  /**
   * Adaptive edge threshold by volatility regime and time remaining.
   *
   * High vol → lower threshold (edges appear and vanish quickly, take them)
   * Low vol → higher threshold (markets are tight, need bigger edge to overcome spread)
   * Late in window → lower threshold (less time for edge to evaporate)
   */
  private getAdaptiveThreshold(regime: VolatilityRegime, timeRemaining: number): number {
    let base = this.config.edgeThresholdCents;

    // Regime adjustment
    if (regime === "high") base *= 0.7;      // -30% for high vol
    if (regime === "low") base *= 1.3;       // +30% for low vol

    // Time decay: reduce threshold as window approaches end
    // At 240s: full threshold. At 30s: 60% of threshold.
    if (timeRemaining < 120) {
      const decay = 0.6 + 0.4 * (timeRemaining / 120);
      base *= decay;
    }

    return Math.max(3, base); // absolute floor: 3¢
  }

  /**
   * Scale orders by edge strength and confidence.
   * Confidence < 0.7 caps at 2 orders (thin data = smaller position).
   */
  private scalePrimaryOrders(edgeCents: number, confidence: number): number {
    const { edgeTier2Cents, edgeTier3Cents, edgeTier4Cents, maxBuysPerSide } = this.config;

    let target: number;
    if (edgeCents >= edgeTier4Cents) {
      target = 4 + (edgeCents >= edgeTier4Cents + 5 ? 1 : 0);
    } else if (edgeCents >= edgeTier3Cents) {
      target = 3;
    } else if (edgeCents >= edgeTier2Cents) {
      target = 2;
    } else {
      target = 1;
    }

    // Cap by confidence
    if (confidence < 0.5) target = Math.min(target, 1);
    else if (confidence < 0.7) target = Math.min(target, 2);

    return Math.min(target, maxBuysPerSide);
  }

  private buildGridOrders(
    window: WindowInfo,
    primarySide: TradeSide,
    fairUp: number,
    upBook: OrderbookSnapshot,
    downBook: OrderbookSnapshot,
    buyAmountUsd: number,
    numPrimary: number,
  ): GridOrder[] {
    const orders: GridOrder[] = [];

    const primaryBook = primarySide === "Up" ? upBook : downBook;
    const primaryTokenId = primarySide === "Up" ? window.upTokenId : window.downTokenId;

    const fairPrimary = primarySide === "Up" ? fairUp : 100 - fairUp;

    // Primary side: buy at ask levels up to fairValue + 5¢
    // SPREAD-AWARE: Cap each order to available depth at that level
    const primaryMaxPrice = (fairPrimary + 5) / 100;
    const primaryLevels = primaryBook.asks
      .filter((a) => a.price <= primaryMaxPrice)
      .slice(0, numPrimary);

    for (const level of primaryLevels) {
      // Cap order amount to what's available at this level (avoid slippage)
      const availableUsd = level.size * level.price;
      const cappedAmount = Math.min(buyAmountUsd, availableUsd * 0.8); // take max 80% of level

      if (cappedAmount < buyAmountUsd * 0.3) {
        this.logger.debug("Skipping thin ask level", {
          price: `${(level.price * 100).toFixed(1)}¢`,
          available: `$${availableUsd.toFixed(2)}`,
          wanted: `$${buyAmountUsd.toFixed(2)}`,
        });
        continue; // skip if less than 30% of our wanted size available
      }

      orders.push({
        side: primarySide,
        tokenId: primaryTokenId,
        price: level.price * 100,
        amount: cappedAmount,
      });
    }

    // Fallback: place at best ask if no levels match (thin book warning)
    if (orders.length === 0 && primaryBook.bestAsk !== null) {
      if (primaryBook.bestAsk <= primaryMaxPrice) {
        const bestAskSize = primaryBook.asks[0]?.size ?? 0;
        const availableUsd = bestAskSize * primaryBook.bestAsk;
        const cappedAmount = Math.min(buyAmountUsd, Math.max(availableUsd * 0.8, buyAmountUsd * 0.3));

        this.logger.debug("Using fallback best ask (thin book)", {
          available: `$${availableUsd.toFixed(2)}`,
          capped: `$${cappedAmount.toFixed(2)}`,
        });

        orders.push({
          side: primarySide,
          tokenId: primaryTokenId,
          price: primaryBook.bestAsk * 100,
          amount: cappedAmount,
        });
      }
    }

    return orders.slice(0, this.config.maxBuysPerWindow);
  }
}
