import { normalCdf } from "../utils.js";
import { VolatilityCalculator } from "./volatility.js";
import { lookupFairUp } from "./lookup-table.js";

/**
 * Fair value engine for 5-minute BTC Up/Down markets.
 *
 * Uses an empirical lookup table (based on observed BTC microstructure)
 * with normal CDF as fallback for extreme values.
 *
 * The lookup table accounts for:
 * - Fat tails (BTC moves more extremely than normal distribution)
 * - Short-term momentum (moves tend to continue in 5-min windows)
 * - Purpledeer's observed sweet spot (50-65¢ entries, ~60% win rate)
 */
export class FairValueEngine {
  constructor(private volatilityCalc: VolatilityCalculator) {}

  /**
   * Calculate fair value for the "Up" side in cents (0-100).
   */
  calculateFairUp(
    currentPrice: number,
    openingPrice: number,
    timeRemainingSeconds: number
  ): number {
    const delta = currentPrice - openingPrice;
    const volatility = this.volatilityCalc.getVolatility();

    // Edge case: at settlement time, it's deterministic
    if (timeRemainingSeconds <= 0) {
      return delta >= 0 ? 99 : 1;
    }

    // Normalize delta by volatility (vol-adjusted move size)
    const normalizedDelta = volatility > 0.01 ? delta / volatility : (delta >= 0 ? 3 : -3);

    // Use empirical lookup table for the normal trading range
    if (timeRemainingSeconds >= 10 && timeRemainingSeconds <= 240 &&
        normalizedDelta >= -3 && normalizedDelta <= 3) {
      return lookupFairUp(normalizedDelta, timeRemainingSeconds);
    }

    // Fallback to z-score for extreme values or edge time ranges
    const timeFraction = timeRemainingSeconds / 300;
    const remainingVol = volatility * Math.sqrt(timeFraction);

    if (remainingVol < 0.01) {
      return delta >= 0 ? 95 : 5;
    }

    const z = delta / remainingVol;
    const probability = normalCdf(z);
    return Math.max(2, Math.min(98, Math.round(probability * 100)));
  }

  /**
   * Calculate fair value for "Down" side in cents.
   */
  calculateFairDown(
    currentPrice: number,
    openingPrice: number,
    timeRemainingSeconds: number
  ): number {
    return 100 - this.calculateFairUp(currentPrice, openingPrice, timeRemainingSeconds);
  }

  /**
   * Calculate edge: difference between fair value and market price.
   * Positive edge = market is underpriced (buy opportunity).
   */
  calculateEdge(
    currentPrice: number,
    openingPrice: number,
    timeRemainingSeconds: number,
    marketUpPriceCents: number,
    marketDownPriceCents: number
  ): { upEdge: number; downEdge: number; fairUp: number; bestSide: "Up" | "Down"; bestEdge: number } {
    const fairUp = this.calculateFairUp(currentPrice, openingPrice, timeRemainingSeconds);
    const fairDown = 100 - fairUp;

    const upEdge = fairUp - marketUpPriceCents;
    const downEdge = fairDown - marketDownPriceCents;

    const bestSide = upEdge >= downEdge ? "Up" as const : "Down" as const;
    const bestEdge = Math.max(upEdge, downEdge);

    return { upEdge, downEdge, fairUp, bestSide, bestEdge };
  }
}
