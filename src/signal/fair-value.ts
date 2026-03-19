import { normalCdf } from "../utils.js";
import type { VolatilityCalculator, VolatilityRegime } from "./volatility.js";
import { lookupFairUp, type LookupResult } from "./lookup-table.js";

/**
 * Improved Fair Value Engine for 5-minute BTC Up/Down markets.
 *
 * Improvements over v1:
 * - Volatility regime awareness (adjusts confidence by regime)
 * - Momentum-adjusted fair value (trend continuation bias)
 * - Confidence-weighted output for downstream edge decisions
 * - Time-decay: edge shrinks as window approaches settlement
 */

export interface FairValueResult {
  fairUp: number;         // P(Up wins) in cents [2-98]
  confidence: number;     // 0-1 overall confidence
  source: "empirical" | "model";
  regime: VolatilityRegime;
}

export interface EdgeResult {
  upEdge: number;
  downEdge: number;
  fairUp: number;
  bestSide: "Up" | "Down";
  bestEdge: number;
  confidence: number;
  regime: VolatilityRegime;
}

export class FairValueEngine {
  constructor(private volatilityCalc: VolatilityCalculator) {}

  /**
   * Calculate fair value with confidence and regime awareness.
   */
  calculateFairValue(
    currentPrice: number,
    openingPrice: number,
    timeRemainingSeconds: number,
  ): FairValueResult {
    const delta = currentPrice - openingPrice;
    const volatility = this.volatilityCalc.getVolatility();
    const regime = this.volatilityCalc.getRegime();

    // At settlement, it's deterministic
    if (timeRemainingSeconds <= 0) {
      return { fairUp: delta >= 0 ? 99 : 1, confidence: 1, source: "model", regime };
    }

    // Normalize delta by volatility
    const normalizedDelta = volatility > 0.01
      ? delta / volatility
      : (delta >= 0 ? 3 : -3);

    // Try empirical lookup table first
    if (timeRemainingSeconds >= 10 && timeRemainingSeconds <= 240 &&
        normalizedDelta >= -3 && normalizedDelta <= 3) {
      const lookup = lookupFairUp(normalizedDelta, timeRemainingSeconds);

      // Apply momentum adjustment: if BTC is accelerating in a direction,
      // nudge fair value slightly toward continuation (empirically observed)
      let fairUp = lookup.fairUp;
      const momentum = this.volatilityCalc.getRecentMomentum(15);
      if (momentum !== null && Math.abs(momentum) > volatility * 0.1) {
        // Small nudge (1-3¢) toward momentum direction
        const nudge = Math.min(3, Math.abs(momentum) / volatility * 2);
        fairUp = momentum > 0
          ? Math.min(98, fairUp + nudge)
          : Math.max(2, fairUp - nudge);
        fairUp = Math.round(fairUp);
      }

      // Confidence reduction for extreme regimes (lookup table is averaged)
      let confidence = lookup.confidence;
      if (regime === "high") confidence *= 0.8;  // high vol = less predictable
      if (regime === "low") confidence *= 0.9;   // low vol = thinner markets

      return { fairUp, confidence, source: "empirical", regime };
    }

    // Fallback to z-score model
    const timeFraction = timeRemainingSeconds / 300;
    const remainingVol = volatility * Math.sqrt(timeFraction);

    if (remainingVol < 0.01) {
      return { fairUp: delta >= 0 ? 95 : 5, confidence: 0.5, source: "model", regime };
    }

    const z = delta / remainingVol;
    const probability = normalCdf(z);
    const fairUp = Math.max(2, Math.min(98, Math.round(probability * 100)));

    return { fairUp, confidence: 0.5, source: "model", regime };
  }

  /**
   * Calculate edge: difference between fair value and market price.
   * Returns confidence-weighted edge for smarter sizing.
   */
  calculateEdge(
    currentPrice: number,
    openingPrice: number,
    timeRemainingSeconds: number,
    marketUpPriceCents: number,
    marketDownPriceCents: number,
  ): EdgeResult {
    const fv = this.calculateFairValue(currentPrice, openingPrice, timeRemainingSeconds);
    const fairDown = 100 - fv.fairUp;

    const upEdge = fv.fairUp - marketUpPriceCents;
    const downEdge = fairDown - marketDownPriceCents;

    const bestSide = upEdge >= downEdge ? "Up" as const : "Down" as const;
    const bestEdge = Math.max(upEdge, downEdge);

    return {
      upEdge,
      downEdge,
      fairUp: fv.fairUp,
      bestSide,
      bestEdge,
      confidence: fv.confidence,
      regime: fv.regime,
    };
  }
}
