import type { Config } from "../config.js";
import type { ClobService, OrderbookSnapshot } from "../data/clob.js";
import type { Logger } from "../logger.js";
import type { TradeSide, WindowInfo } from "../types.js";
import { FairValueEngine } from "./fair-value.js";
import type { VolatilityCalculator, VolatilityRegime } from "./volatility.js";

export interface TradeDecision {
  shouldTrade: boolean;
  /** Side to buy (winner side) */
  primarySide: TradeSide;
  /** Token ID of the winner side */
  winnerTokenId: string;
  /** Token ID of the loser side */
  loserTokenId: string;
  /** Fair value of Up in cents */
  fairUp: number;
  /** Edge = fairValue - marketAsk (cents) */
  bestEdge: number;
  /** Market ask price for winner in cents */
  winnerAskCents: number;
  /** Market ask price for loser in cents */
  loserAskCents: number;
  /** Confidence 0-1 */
  confidence: number;
  /** Volatility regime */
  regime: VolatilityRegime;
  /** USD amount to buy */
  buyAmountUsd: number;
  /** Normalized delta (sigma) */
  normalizedDelta: number;
  /** Reason for decision */
  reason: string;
}

/**
 * Edge Detector for Convergence Arb Strategy.
 *
 * Entry criteria:
 * 1. Time remaining: 30-100s (configurable)
 * 2. Normalized delta >= 0.7σ (strong directional move)
 * 3. Edge >= 2¢ (fairValue - marketAsk)
 * 4. No spike (momentum10s/momentum30s < 3.0)
 * 5. No adverse momentum
 * 6. Sufficient orderbook depth
 *
 * Single FOK entry on the winner side. No grid, no loser at entry time.
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
      primarySide: "Up",
      winnerTokenId: window.upTokenId,
      loserTokenId: window.downTokenId,
      fairUp: 50,
      bestEdge: 0,
      winnerAskCents: 0,
      loserAskCents: 0,
      confidence: 0,
      regime: "normal",
      buyAmountUsd: 0,
      normalizedDelta: 0,
      reason,
    });

    // 1. Time-remaining window check
    if (timeRemainingSeconds > this.config.maxEntryTimeRemaining) {
      return noTrade(`Too early (${timeRemainingSeconds.toFixed(0)}s > ${this.config.maxEntryTimeRemaining}s remaining)`);
    }
    if (timeRemainingSeconds < this.config.minEntryTimeRemaining) {
      return noTrade(`Too late (${timeRemainingSeconds.toFixed(0)}s < ${this.config.minEntryTimeRemaining}s remaining)`);
    }

    // 2. Need opening price
    if (window.openingPrice === 0) {
      return noTrade("No opening price yet");
    }

    // 3. Normalized delta check
    const delta = currentBtcPrice - window.openingPrice;
    const volatility = this.volatilityCalc.getVolatility();
    const normalizedDelta = volatility > 0.01 ? Math.abs(delta) / volatility : 0;

    if (normalizedDelta < this.config.minNormalizedDelta) {
      return noTrade(`Delta too small (${normalizedDelta.toFixed(2)}σ < ${this.config.minNormalizedDelta}σ)`);
    }

    // 4. Spike detection: reject if recent move is disproportionately fast
    const momentum10s = this.volatilityCalc.getRecentMomentum(10);
    const momentum30s = this.volatilityCalc.getRecentMomentum(30);
    if (momentum10s !== null && momentum30s !== null && Math.abs(momentum30s) > 1) {
      const spikeRatio = Math.abs(momentum10s) / Math.abs(momentum30s);
      if (spikeRatio > this.config.spikeRatioThreshold) {
        return noTrade(`Spike detected (ratio=${spikeRatio.toFixed(1)} > ${this.config.spikeRatioThreshold})`);
      }
    }

    // 5. Adverse momentum filter
    if (this.config.maxAdverseMomentumUsd > 0 && momentum30s !== null) {
      const bestSide: TradeSide = delta > 0 ? "Up" : "Down";
      const isAdverse =
        (bestSide === "Up" && momentum30s < -this.config.maxAdverseMomentumUsd) ||
        (bestSide === "Down" && momentum30s > this.config.maxAdverseMomentumUsd);
      if (isAdverse) {
        return noTrade(`Adverse momentum: $${momentum30s.toFixed(0)} vs ${bestSide}`);
      }
    }

    // 6. Get orderbook
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

    // Sanity: reject broken books
    const marketUpCents = Math.round(upBook.bestAsk * 100);
    const marketDownCents = Math.round(downBook.bestAsk * 100);
    const askSum = marketUpCents + marketDownCents;
    if (askSum > 105) {
      return noTrade(`Orderbook broken: askSum=${askSum}¢`);
    }

    // 7. Calculate edge using fair value engine
    const edge = this.fairValueEngine.calculateEdge(
      currentBtcPrice,
      window.openingPrice,
      timeRemainingSeconds,
      marketUpCents,
      marketDownCents,
    );

    const primarySide = edge.bestSide;
    const winnerAskCents = primarySide === "Up" ? marketUpCents : marketDownCents;
    const loserAskCents = primarySide === "Up" ? marketDownCents : marketUpCents;
    const winnerTokenId = primarySide === "Up" ? window.upTokenId : window.downTokenId;
    const loserTokenId = primarySide === "Up" ? window.downTokenId : window.upTokenId;
    const winnerBook = primarySide === "Up" ? upBook : downBook;

    this.logger.debug("Edge evaluation", {
      delta: `$${delta.toFixed(2)}`,
      normalizedDelta: `${normalizedDelta.toFixed(2)}σ`,
      fairUp: edge.fairUp,
      marketUp: marketUpCents,
      marketDown: marketDownCents,
      bestSide: edge.bestSide,
      bestEdge: `${edge.bestEdge.toFixed(1)}¢`,
      confidence: edge.confidence.toFixed(2),
      regime: edge.regime,
      timeLeft: `${timeRemainingSeconds.toFixed(0)}s`,
    });

    // 8. Edge threshold check
    if (edge.bestEdge < this.config.edgeThresholdCents) {
      return noTrade(`Edge too small (${edge.bestEdge.toFixed(1)}¢ < ${this.config.edgeThresholdCents}¢)`);
    }

    // 9. Depth check: don't enter if orderbook is too thin
    const depthCappedAmount = Math.min(buyAmountUsd, winnerBook.askDepthUsd * 0.4);
    if (depthCappedAmount < 5 || depthCappedAmount < buyAmountUsd * 0.3) {
      return noTrade(`Orderbook too thin: $${winnerBook.askDepthUsd.toFixed(2)} ask depth`);
    }

    return {
      shouldTrade: true,
      primarySide,
      winnerTokenId,
      loserTokenId,
      fairUp: edge.fairUp,
      bestEdge: edge.bestEdge,
      winnerAskCents,
      loserAskCents,
      confidence: edge.confidence,
      regime: edge.regime,
      buyAmountUsd: depthCappedAmount,
      normalizedDelta,
      reason: `Edge: ${edge.bestEdge.toFixed(1)}¢ on ${primarySide} (fair=${edge.fairUp}¢, delta=${normalizedDelta.toFixed(2)}σ, ${edge.regime} vol)`,
    };
  }
}
