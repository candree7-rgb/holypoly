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

  async init(): Promise<void> {
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
