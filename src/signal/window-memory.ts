/**
 * Cross-Window Memory: Tracks recent window outcomes to detect
 * continuation patterns that the market might underestimate.
 *
 * If last 3+ windows all resolved "Up", the market might still
 * price the next window at 50/50 while reality shows a trend.
 * This gives us an extra 1-3¢ edge on the confidence adjustment.
 */

import type { TradeSide } from "../types.js";
import type { Logger } from "../logger.js";

interface WindowOutcome {
  timestamp: number;
  winner: TradeSide;
  btcDelta: number; // how much BTC moved in that window
}

export class WindowMemory {
  private outcomes: WindowOutcome[] = [];
  private readonly maxHistory = 50; // keep last 50 windows

  constructor(private logger: Logger) {}

  /**
   * Record a window outcome after settlement.
   */
  recordOutcome(winner: TradeSide, btcDelta: number): void {
    this.outcomes.push({
      timestamp: Date.now(),
      winner,
      btcDelta,
    });

    // Prune old entries
    if (this.outcomes.length > this.maxHistory) {
      this.outcomes = this.outcomes.slice(-this.maxHistory);
    }
  }

  /**
   * Get continuation bias: how many of the last N windows went the same direction.
   * Returns { side, streak, bias } where bias is a confidence adjustment in cents.
   *
   * Example: last 4 windows all "Up" → streak=4, bias=+2¢ toward Up
   */
  getContinuationBias(lookback: number = 5): {
    side: TradeSide | null;
    streak: number;
    biasCents: number;
  } {
    if (this.outcomes.length < 2) {
      return { side: null, streak: 0, biasCents: 0 };
    }

    const recent = this.outcomes.slice(-lookback);
    const lastWinner = recent[recent.length - 1].winner;

    // Count consecutive same-direction wins from the end
    let streak = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].winner === lastWinner) {
        streak++;
      } else {
        break;
      }
    }

    // Bias calculation: streak of 2 = 0¢, 3 = 1¢, 4 = 2¢, 5+ = 3¢
    let biasCents = 0;
    if (streak >= 3) biasCents = Math.min(3, streak - 2);

    return { side: lastWinner, streak, biasCents };
  }

  /**
   * Get recent win rate for a specific side.
   * Useful for detecting persistent trend environments.
   */
  getSideWinRate(side: TradeSide, lookback: number = 20): number {
    const recent = this.outcomes.slice(-lookback);
    if (recent.length === 0) return 0.5;

    const wins = recent.filter((o) => o.winner === side).length;
    return wins / recent.length;
  }

  /**
   * Get average BTC movement magnitude over recent windows.
   * Higher = more volatile session = potentially more edge opportunities.
   */
  getAvgMoveMagnitude(lookback: number = 10): number {
    const recent = this.outcomes.slice(-lookback);
    if (recent.length === 0) return 0;

    return recent.reduce((sum, o) => sum + Math.abs(o.btcDelta), 0) / recent.length;
  }

  get totalOutcomes(): number {
    return this.outcomes.length;
  }
}
