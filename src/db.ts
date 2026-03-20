import pg from "pg";
import type { Logger } from "./logger.js";
import type { WindowResult } from "./types.js";

const { Pool } = pg;

export class Database {
  private pool: pg.Pool;

  constructor(databaseUrl: string, private logger: Logger) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false },
      max: 5,
    });
  }

  async init(retries = 5, delayMs = 3000): Promise<void> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await this._initSchema();
      } catch (err) {
        if (attempt === retries) throw err;
        const wait = delayMs * attempt;
        this.logger.info(`DB connect failed (attempt ${attempt}/${retries}), retrying in ${wait}ms…`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  private async _initSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS bot_state (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS window_trades (
        id SERIAL PRIMARY KEY,
        window_start BIGINT NOT NULL,
        condition_id TEXT NOT NULL,
        traded BOOLEAN NOT NULL DEFAULT false,
        primary_side TEXT,
        orders JSONB DEFAULT '[]',
        fill_count INT DEFAULT 0,
        pnl NUMERIC,
        winner TEXT,
        balance_before NUMERIC,
        balance_after NUMERIC,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS daily_snapshots (
        date TEXT PRIMARY KEY,
        starting_balance NUMERIC NOT NULL,
        ending_balance NUMERIC,
        total_pnl NUMERIC DEFAULT 0,
        windows_traded INT DEFAULT 0,
        wins INT DEFAULT 0,
        losses INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS weekly_snapshots (
        week TEXT PRIMARY KEY,
        starting_balance NUMERIC NOT NULL,
        total_pnl NUMERIC DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_window_trades_start ON window_trades(window_start);
      CREATE INDEX IF NOT EXISTS idx_window_trades_condition ON window_trades(condition_id);
    `);

    // One-time cleanup: remove all dry-run data for clean live start
    // TODO: Remove this block after first live deployment
    await this.pool.query("DELETE FROM window_trades");
    await this.pool.query("DELETE FROM daily_snapshots");
    await this.pool.query("DELETE FROM weekly_snapshots");
    await this.pool.query("DELETE FROM bot_state WHERE key LIKE 'redeem:%'");
    this.logger.info("Database cleaned (dry-run data removed)");

    this.logger.info("Database initialized");
  }

  // === Key-Value State ===

  async getState<T>(key: string, defaultValue: T): Promise<T> {
    const result = await this.pool.query(
      "SELECT value FROM bot_state WHERE key = $1",
      [key]
    );
    if (result.rows.length === 0) return defaultValue;
    return result.rows[0].value as T;
  }

  async setState(key: string, value: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO bot_state (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );
  }

  // === Daily Snapshots ===

  async ensureDailySnapshot(date: string, currentBalance: number): Promise<{ startingBalance: number; totalPnl: number; windowsTraded: number; wins: number; losses: number }> {
    // Try insert (only if not exists)
    await this.pool.query(
      `INSERT INTO daily_snapshots (date, starting_balance) VALUES ($1, $2)
       ON CONFLICT (date) DO NOTHING`,
      [date, currentBalance]
    );
    const result = await this.pool.query(
      "SELECT starting_balance, total_pnl, windows_traded, wins, losses FROM daily_snapshots WHERE date = $1",
      [date]
    );
    const row = result.rows[0];
    if (!row) {
      // Race condition or DB issue — return safe defaults
      return { startingBalance: currentBalance, totalPnl: 0, windowsTraded: 0, wins: 0, losses: 0 };
    }
    return {
      startingBalance: parseFloat(row.starting_balance),
      totalPnl: parseFloat(row.total_pnl),
      windowsTraded: row.windows_traded,
      wins: row.wins,
      losses: row.losses,
    };
  }

  async updateDailyPnl(date: string, pnl: number, won: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE daily_snapshots SET
        total_pnl = total_pnl + $2,
        windows_traded = windows_traded + 1,
        wins = wins + $3,
        losses = losses + $4
       WHERE date = $1`,
      [date, pnl, won ? 1 : 0, won ? 0 : 1]
    );
  }

  // === Weekly Snapshots ===

  async ensureWeeklySnapshot(week: string, currentBalance: number): Promise<{ startingBalance: number; totalPnl: number }> {
    await this.pool.query(
      `INSERT INTO weekly_snapshots (week, starting_balance) VALUES ($1, $2)
       ON CONFLICT (week) DO NOTHING`,
      [week, currentBalance]
    );
    const result = await this.pool.query(
      "SELECT starting_balance, total_pnl FROM weekly_snapshots WHERE week = $1",
      [week]
    );
    const row = result.rows[0];
    if (!row) {
      return { startingBalance: currentBalance, totalPnl: 0 };
    }
    return {
      startingBalance: parseFloat(row.starting_balance),
      totalPnl: parseFloat(row.total_pnl),
    };
  }

  async updateWeeklyPnl(week: string, pnl: number): Promise<void> {
    await this.pool.query(
      "UPDATE weekly_snapshots SET total_pnl = total_pnl + $2 WHERE week = $1",
      [week, pnl]
    );
  }

  // === Window Trades ===

  async recordWindow(trade: {
    windowStart: number;
    conditionId: string;
    traded: boolean;
    primarySide: string | null;
    orders: unknown[];
    fillCount: number;
    pnl: number | null;
    winner: string | null;
    balanceBefore: number;
    balanceAfter: number | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO window_trades (window_start, condition_id, traded, primary_side, orders, fill_count, pnl, winner, balance_before, balance_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        trade.windowStart,
        trade.conditionId,
        trade.traded,
        trade.primarySide,
        JSON.stringify(trade.orders),
        trade.fillCount,
        trade.pnl,
        trade.winner,
        trade.balanceBefore,
        trade.balanceAfter,
      ]
    );
  }

  async updateWindowSettlement(
    conditionId: string,
    pnl: number,
    winner: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE window_trades SET pnl = $2, winner = $3
       WHERE condition_id = $1 AND pnl IS NULL`,
      [conditionId, pnl, winner]
    );
  }

  /**
   * Atomic settlement: wraps recordResult + updateWindowSettlement in a transaction.
   * Prevents partial writes (e.g. P&L recorded but settlement not, or vice versa).
   */
  async settleWindowAtomic(params: {
    conditionId: string;
    pnl: number;
    winner: string;
    dailyDate: string;
    weeklyWeek: string;
    won: boolean;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Update window settlement
      await client.query(
        `UPDATE window_trades SET pnl = $2, winner = $3
         WHERE condition_id = $1 AND pnl IS NULL`,
        [params.conditionId, params.pnl, params.winner]
      );

      // Update daily P&L
      await client.query(
        `UPDATE daily_snapshots SET
          total_pnl = total_pnl + $2,
          windows_traded = windows_traded + 1,
          wins = wins + $3,
          losses = losses + $4
         WHERE date = $1`,
        [params.dailyDate, params.pnl, params.won ? 1 : 0, params.won ? 0 : 1]
      );

      // Update weekly P&L
      await client.query(
        "UPDATE weekly_snapshots SET total_pnl = total_pnl + $2 WHERE week = $1",
        [params.weeklyWeek, params.pnl]
      );

      // Update losing streak
      if (params.won) {
        await client.query(
          `INSERT INTO bot_state (key, value, updated_at) VALUES ('losing_streak', '0', NOW())
           ON CONFLICT (key) DO UPDATE SET value = '0', updated_at = NOW()`
        );
      } else {
        await client.query(
          `INSERT INTO bot_state (key, value, updated_at) VALUES ('losing_streak', '0', NOW())
           ON CONFLICT (key) DO UPDATE SET value = to_jsonb((bot_state.value::int + 1)), updated_at = NOW()`
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      this.logger.error("Settlement transaction failed, rolling back", {
        error: (err as Error).message,
      });
      throw err;
    } finally {
      client.release();
    }
  }

  // === Redeem Tracking ===

  async getRedeemAttempt(conditionId: string): Promise<number> {
    const result = await this.pool.query(
      "SELECT value->>'timestamp' as ts FROM bot_state WHERE key = $1",
      [`redeem:${conditionId}`]
    );
    if (result.rows.length === 0) return 0;
    return parseInt(result.rows[0].ts) || 0;
  }

  async markRedeemAttempt(conditionId: string): Promise<void> {
    await this.setState(`redeem:${conditionId}`, { timestamp: Math.floor(Date.now() / 1000) });
  }

  // === Losing Streak ===

  async getLosingStreak(): Promise<number> {
    return this.getState("losing_streak", 0);
  }

  async setLosingStreak(count: number): Promise<void> {
    await this.setState("losing_streak", count);
  }

  async getPauseUntil(): Promise<number> {
    return this.getState("pause_until", 0);
  }

  async setPauseUntil(timestamp: number): Promise<void> {
    await this.setState("pause_until", timestamp);
  }

  // === Stats ===

  async getRecentWindowCount(hours: number): Promise<number> {
    const since = Date.now() - hours * 3600 * 1000;
    const result = await this.pool.query(
      "SELECT COUNT(*) FROM window_trades WHERE window_start > $1 AND traded = true",
      [since]
    );
    return parseInt(result.rows[0].count);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
