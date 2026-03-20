/**
 * Improved rolling volatility calculator using Binance trade ticks.
 *
 * Improvements over v1:
 * - EMA-smoothed volatility (reacts faster to regime changes)
 * - Volatility regime detection (low/normal/high)
 * - Momentum tracking with configurable lookback
 * - Price velocity (rate of change) for trend detection
 */
export type VolatilityRegime = "low" | "normal" | "high";

export class VolatilityCalculator {
  private prices: Array<{ price: number; timestamp: number }> = [];
  private lookbackMs: number;
  private emaVol: number | null = null;
  private readonly emaAlpha = 0.1; // EMA smoothing factor (higher = more reactive)

  // Regime thresholds (calibrated for BTC 5-min windows)
  private readonly lowVolThreshold = 25; // $25 expected 5-min move
  private readonly highVolThreshold = 80; // $80 expected 5-min move

  constructor(lookbackSeconds: number) {
    this.lookbackMs = lookbackSeconds * 1000;
  }

  addPrice(price: number, timestamp: number): void {
    this.prices.push({ price, timestamp });
    this.prune(timestamp);

    // Update EMA volatility on each tick for responsiveness
    if (this.prices.length >= 10) {
      const rawVol = this.computeRawVolatility();
      if (this.emaVol === null) {
        this.emaVol = rawVol;
      } else {
        this.emaVol = this.emaAlpha * rawVol + (1 - this.emaAlpha) * this.emaVol;
      }
    }
  }

  /**
   * Get EMA-smoothed volatility scaled to 5-minute horizon.
   * More responsive to regime changes than raw std-dev.
   */
  getVolatility(): number {
    if (this.emaVol !== null) return Math.max(this.emaVol, 5);
    if (this.prices.length < 10) return 50;
    return Math.max(this.computeRawVolatility(), 5);
  }

  /**
   * Detect current volatility regime for adaptive thresholds.
   */
  getRegime(): VolatilityRegime {
    const vol = this.getVolatility();
    if (vol <= this.lowVolThreshold) return "low";
    if (vol >= this.highVolThreshold) return "high";
    return "normal";
  }

  /**
   * Get BTC price change over the last N seconds.
   */
  getRecentMomentum(lookbackSeconds: number): number | null {
    if (this.prices.length < 2) return null;

    const now = this.prices[this.prices.length - 1].timestamp;
    const cutoff = now - lookbackSeconds * 1000;
    const currentPrice = this.prices[this.prices.length - 1].price;

    let pastPrice: number | null = null;
    for (const p of this.prices) {
      if (p.timestamp <= cutoff) {
        pastPrice = p.price;
      } else {
        break;
      }
    }

    if (pastPrice === null) {
      if (this.prices.length >= 10) {
        pastPrice = this.prices[0].price;
      } else {
        return null;
      }
    }

    return currentPrice - pastPrice;
  }

  /**
   * Get price velocity: rate of change in $/second over recent window.
   * Useful for detecting accelerating moves (trend strength).
   */
  getPriceVelocity(lookbackSeconds: number = 30): number | null {
    if (this.prices.length < 5) return null;

    const now = this.prices[this.prices.length - 1].timestamp;
    const cutoff = now - lookbackSeconds * 1000;
    const currentPrice = this.prices[this.prices.length - 1].price;

    let pastPrice: number | null = null;
    let pastTime: number | null = null;
    for (const p of this.prices) {
      if (p.timestamp <= cutoff) {
        pastPrice = p.price;
        pastTime = p.timestamp;
      } else {
        break;
      }
    }

    if (pastPrice === null || pastTime === null) return null;

    const elapsed = (now - pastTime) / 1000;
    if (elapsed < 1) return null;

    return (currentPrice - pastPrice) / elapsed;
  }

  /**
   * Check if price is accelerating in a direction (move getting stronger).
   * Compares recent velocity vs. slightly older velocity.
   */
  isAccelerating(direction: "up" | "down"): boolean {
    const recentVel = this.getPriceVelocity(10);
    const olderVel = this.getPriceVelocity(30);
    if (recentVel === null || olderVel === null) return false;

    if (direction === "up") {
      return recentVel > olderVel && recentVel > 0;
    } else {
      return recentVel < olderVel && recentVel < 0;
    }
  }

  get currentPrice(): number | null {
    if (this.prices.length === 0) return null;
    return this.prices[this.prices.length - 1].price;
  }

  private computeRawVolatility(): number {
    const sampled = this.sampleAtInterval(1000);
    if (sampled.length < 5) return 50;

    const changes: number[] = [];
    for (let i = 1; i < sampled.length; i++) {
      changes.push(sampled[i] - sampled[i - 1]);
    }

    const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
    const variance =
      changes.reduce((sum, c) => sum + (c - mean) ** 2, 0) / changes.length;
    const stdDev1s = Math.sqrt(variance);

    // Scale to 5-minute horizon
    return stdDev1s * Math.sqrt(300);
  }

  private sampleAtInterval(intervalMs: number): number[] {
    if (this.prices.length === 0) return [];

    const result: number[] = [];
    let nextTime = this.prices[0].timestamp;
    let lastPrice = this.prices[0].price;

    for (const p of this.prices) {
      while (p.timestamp >= nextTime) {
        result.push(lastPrice);
        nextTime += intervalMs;
      }
      lastPrice = p.price;
    }

    return result;
  }

  private prune(now: number): void {
    const cutoff = now - this.lookbackMs;
    while (this.prices.length > 0 && this.prices[0].timestamp < cutoff) {
      this.prices.shift();
    }
  }
}
