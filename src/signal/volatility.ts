/**
 * Rolling volatility calculator using Binance trade ticks.
 * Calculates standard deviation of price changes over a lookback window.
 */
export class VolatilityCalculator {
  private prices: Array<{ price: number; timestamp: number }> = [];
  private lookbackMs: number;

  constructor(lookbackSeconds: number) {
    this.lookbackMs = lookbackSeconds * 1000;
  }

  addPrice(price: number, timestamp: number): void {
    this.prices.push({ price, timestamp });
    this.prune(timestamp);
  }

  /**
   * Get current annualized volatility scaled to 5-minute windows.
   * Returns the std dev of price changes in USD over the lookback period,
   * extrapolated to a 5-minute horizon.
   */
  getVolatility(): number {
    if (this.prices.length < 10) return 50; // default: ~$50 expected move in 5 min

    // Sample prices at 1-second intervals for stability
    const sampled = this.sampleAtInterval(1000);
    if (sampled.length < 5) return 50;

    // Calculate returns (price changes)
    const changes: number[] = [];
    for (let i = 1; i < sampled.length; i++) {
      changes.push(sampled[i] - sampled[i - 1]);
    }

    // Standard deviation of 1-second price changes
    const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
    const variance = changes.reduce((sum, c) => sum + (c - mean) ** 2, 0) / changes.length;
    const stdDev1s = Math.sqrt(variance);

    // Scale to 5-minute horizon: vol_5min = vol_1s * sqrt(300)
    const stdDev5m = stdDev1s * Math.sqrt(300);

    return Math.max(stdDev5m, 5); // minimum $5 volatility
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
