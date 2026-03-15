import type { Config } from "../config.js";
import type { Database } from "../db.js";
import type { Logger } from "../logger.js";

export interface RiskCheck {
  allowed: boolean;
  reason: string;
  /** Current balance-adjusted buy amount in USD */
  buyAmountUsd: number;
}

const dayKeyUtc = (date = new Date()): string => {
  const y = date.getUTCFullYear();
  const m = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const d = `${date.getUTCDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const weekKeyUtc = (date = new Date()): string => {
  const y = date.getUTCFullYear();
  const start = new Date(date);
  start.setUTCDate(date.getUTCDate() - date.getUTCDay());
  const m = `${start.getUTCMonth() + 1}`.padStart(2, "0");
  const d = `${start.getUTCDate()}`.padStart(2, "0");
  return `${y}-W${m}${d}`;
};

/**
 * Risk manager with percentage-based limits and PostgreSQL persistence.
 * All sizing scales with wallet balance for automatic compounding.
 */
export class RiskManager {
  private cachedBalance: number = 0;
  private lastBalanceFetch: number = 0;
  private balanceCacheTtlMs = 60000; // refresh balance every 60s

  constructor(
    private config: Config,
    private db: Database,
    private logger: Logger,
    private fetchBalance: () => Promise<number>
  ) {}

  /**
   * Get current wallet balance (cached for 60s).
   */
  async getBalance(): Promise<number> {
    const now = Date.now();
    if (now - this.lastBalanceFetch < this.balanceCacheTtlMs && this.cachedBalance > 0) {
      return this.cachedBalance;
    }
    this.cachedBalance = await this.fetchBalance();
    this.lastBalanceFetch = now;
    return this.cachedBalance;
  }

  /**
   * Calculate buy amount in USD from current balance.
   * BUY_AMOUNT_PCT=2 + balance=$1000 → $20 per order
   */
  async calculateBuyAmount(): Promise<number> {
    const balance = await this.getBalance();
    return balance * (this.config.buyAmountPct / 100);
  }

  /**
   * Check all risk conditions before placing orders.
   */
  async check(): Promise<RiskCheck> {
    const balance = await this.getBalance();
    const buyAmountUsd = balance * (this.config.buyAmountPct / 100);

    const noTrade = (reason: string): RiskCheck => ({
      allowed: false,
      reason,
      buyAmountUsd: 0,
    });

    // Absolute floor check
    if (balance < this.config.minBalanceFloorUsd) {
      return noTrade(`Balance $${balance.toFixed(2)} below floor $${this.config.minBalanceFloorUsd}`);
    }

    // Check pause (from losing streak)
    const pauseUntil = await this.db.getPauseUntil();
    if (pauseUntil > Date.now()) {
      const remaining = Math.ceil((pauseUntil - Date.now()) / 60000);
      return noTrade(`Paused for ${remaining} more minutes (losing streak)`);
    }
    // Pause served → reset streak so bot can trade normally again
    if (pauseUntil > 0) {
      this.logger.info("Losing streak pause served, resetting streak counter");
      await this.db.setLosingStreak(0);
      await this.db.setPauseUntil(0);
    }

    // Daily loss limit (%-based)
    const today = dayKeyUtc();
    const daily = await this.db.ensureDailySnapshot(today, balance);
    const dailyLossLimit = daily.startingBalance * (this.config.dailyLossLimitPct / 100);
    if (daily.totalPnl <= -dailyLossLimit) {
      return noTrade(
        `Daily loss limit: $${daily.totalPnl.toFixed(2)} <= -$${dailyLossLimit.toFixed(2)} (${this.config.dailyLossLimitPct}% of $${daily.startingBalance.toFixed(2)})`
      );
    }

    // Weekly loss limit (%-based)
    const week = weekKeyUtc();
    const weekly = await this.db.ensureWeeklySnapshot(week, balance);
    const weeklyLossLimit = weekly.startingBalance * (this.config.weeklyLossLimitPct / 100);
    if (weekly.totalPnl <= -weeklyLossLimit) {
      return noTrade(
        `Weekly loss limit: $${weekly.totalPnl.toFixed(2)} <= -$${weeklyLossLimit.toFixed(2)} (${this.config.weeklyLossLimitPct}%)`
      );
    }

    // Losing streak
    const losingStreak = await this.db.getLosingStreak();
    if (losingStreak >= this.config.losingStreakPause) {
      const pauseMinutes = losingStreak >= 10 ? 120 : 30;
      await this.db.setPauseUntil(Date.now() + pauseMinutes * 60 * 1000);
      this.logger.warn("Losing streak pause triggered", { streak: losingStreak, pauseMinutes });
      return noTrade(`Losing streak (${losingStreak} consecutive) — pausing ${pauseMinutes} min`);
    }

    return {
      allowed: true,
      reason: "OK",
      buyAmountUsd,
    };
  }

  /**
   * Record a window result and update streaks.
   */
  async recordResult(pnl: number): Promise<void> {
    const today = dayKeyUtc();
    const week = weekKeyUtc();
    const won = pnl > 0;

    await this.db.updateDailyPnl(today, pnl, won);
    await this.db.updateWeeklyPnl(week, pnl);

    if (won) {
      await this.db.setLosingStreak(0);
    } else {
      const streak = await this.db.getLosingStreak();
      await this.db.setLosingStreak(streak + 1);
    }

    // Invalidate balance cache after trade
    this.lastBalanceFetch = 0;
  }

  /**
   * Get today's stats for notifications.
   */
  async getDailyStats(): Promise<{ totalPnl: number; wins: number; losses: number }> {
    const balance = await this.getBalance();
    const today = dayKeyUtc();
    const daily = await this.db.ensureDailySnapshot(today, balance);
    return { totalPnl: daily.totalPnl, wins: daily.wins, losses: daily.losses };
  }

  /**
   * Log current risk status.
   */
  async logStatus(): Promise<void> {
    const balance = await this.getBalance();
    const today = dayKeyUtc();
    const week = weekKeyUtc();
    const daily = await this.db.ensureDailySnapshot(today, balance);
    const weekly = await this.db.ensureWeeklySnapshot(week, balance);
    const streak = await this.db.getLosingStreak();

    this.logger.info("Risk status", {
      balance: `$${balance.toFixed(2)}`,
      buyAmount: `$${(balance * this.config.buyAmountPct / 100).toFixed(2)} (${this.config.buyAmountPct}%)`,
      dailyPnl: `$${daily.totalPnl.toFixed(2)}`,
      dailyTrades: daily.windowsTraded,
      dailyWinRate: daily.windowsTraded > 0
        ? `${((daily.wins / daily.windowsTraded) * 100).toFixed(1)}%`
        : "N/A",
      weeklyPnl: `$${weekly.totalPnl.toFixed(2)}`,
      losingStreak: streak,
    });
  }
}
