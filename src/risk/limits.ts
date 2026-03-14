import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { ensureDaily, ensureWeekly, type State } from "../state.js";

export interface RiskCheck {
  allowed: boolean;
  reason: string;
}

/**
 * Risk manager: checks daily/weekly loss limits, losing streaks, and wallet balance.
 */
export class RiskManager {
  constructor(
    private config: Config,
    private state: State,
    private logger: Logger
  ) {}

  /**
   * Check all risk conditions before placing orders in a window.
   */
  check(): RiskCheck {
    const now = new Date();
    ensureDaily(this.state, now);
    ensureWeekly(this.state, now);

    // Check pause (from losing streak)
    if (this.state.pauseUntil > Date.now()) {
      const remaining = Math.ceil((this.state.pauseUntil - Date.now()) / 60000);
      return {
        allowed: false,
        reason: `Paused for ${remaining} more minutes (losing streak)`,
      };
    }

    // Check daily loss limit
    if (this.state.dailyPnl.totalPnl <= -this.config.dailyLossLimitUsd) {
      return {
        allowed: false,
        reason: `Daily loss limit hit ($${this.state.dailyPnl.totalPnl.toFixed(2)} <= -$${this.config.dailyLossLimitUsd})`,
      };
    }

    // Check weekly loss limit
    if (this.state.weeklyPnl.totalPnl <= -this.config.weeklyLossLimitUsd) {
      return {
        allowed: false,
        reason: `Weekly loss limit hit ($${this.state.weeklyPnl.totalPnl.toFixed(2)} <= -$${this.config.weeklyLossLimitUsd})`,
      };
    }

    // Check losing streak
    if (this.state.losingStreak >= this.config.losingStreakPause) {
      const pauseMinutes = this.state.losingStreak >= 10 ? 120 : 30;
      this.state.pauseUntil = Date.now() + pauseMinutes * 60 * 1000;
      this.logger.warn("Losing streak pause triggered", {
        streak: this.state.losingStreak,
        pauseMinutes,
      });
      return {
        allowed: false,
        reason: `Losing streak (${this.state.losingStreak} consecutive) — pausing ${pauseMinutes} min`,
      };
    }

    return { allowed: true, reason: "OK" };
  }

  /**
   * Calculate max exposure for the upcoming window based on remaining limits.
   */
  maxWindowExposure(): number {
    ensureDaily(this.state);
    const dailyRemaining = this.config.dailyLossLimitUsd + this.state.dailyPnl.totalPnl;
    const perWindow = this.config.maxBuysPerWindow * this.config.buyAmountUsd;
    return Math.min(perWindow, Math.max(0, dailyRemaining));
  }

  /**
   * Log current risk status.
   */
  logStatus(): void {
    ensureDaily(this.state);
    ensureWeekly(this.state);
    this.logger.info("Risk status", {
      dailyPnl: this.state.dailyPnl.totalPnl.toFixed(2),
      dailyTrades: this.state.dailyPnl.windowsTraded,
      dailyWinRate: this.state.dailyPnl.windowsTraded > 0
        ? `${((this.state.dailyPnl.wins / this.state.dailyPnl.windowsTraded) * 100).toFixed(1)}%`
        : "N/A",
      weeklyPnl: this.state.weeklyPnl.totalPnl.toFixed(2),
      losingStreak: this.state.losingStreak,
    });
  }
}
