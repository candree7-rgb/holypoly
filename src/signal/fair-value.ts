import { normalCdf } from "../utils.js";
import { VolatilityCalculator } from "./volatility.js";

/**
 * Fair value engine for 5-minute BTC Up/Down markets.
 *
 * Calculates the probability that BTC will finish above the opening price
 * based on current price delta, time remaining, and volatility.
 *
 * Uses a geometric Brownian motion / normal CDF approach:
 *   z = delta / (volatility * sqrt(time_remaining / 300))
 *   P(up) = Φ(z)
 */
export class FairValueEngine {
  constructor(private volatilityCalc: VolatilityCalculator) {}

  /**
   * Calculate fair value for the "Up" side in cents (0-100).
   *
   * @param currentPrice - Current BTC price (from Binance)
   * @param openingPrice - BTC price at window open (Price to Beat)
   * @param timeRemainingSeconds - Seconds until window end (0-300)
   * @returns Fair value for "Up" in cents (0-100)
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

    // Very little time left — high conviction either way
    if (timeRemainingSeconds < 5) {
      if (delta > 0) return Math.min(95, 50 + Math.abs(delta) / volatility * 40);
      if (delta < 0) return Math.max(5, 50 - Math.abs(delta) / volatility * 40);
      return 50;
    }

    // Time fraction: how much of the 5-min window remains
    const timeFraction = timeRemainingSeconds / 300;

    // Expected remaining volatility
    const remainingVol = volatility * Math.sqrt(timeFraction);

    // Avoid division by zero
    if (remainingVol < 0.01) {
      return delta >= 0 ? 95 : 5;
    }

    // z-score: how many standard deviations is the current price above opening
    const z = delta / remainingVol;

    // P(BTC finishes above opening) = Φ(z)
    const probability = normalCdf(z);

    // Convert to cents (0-100), clamp to [2, 98]
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
