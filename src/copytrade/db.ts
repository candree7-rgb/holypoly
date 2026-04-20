import pg from "pg";
import type { Logger } from "../logger.js";

const { Pool } = pg;

export interface LeaderStats {
  leaderAddress: string;
  copies: number;
  filled: number;
  totalSpentUsd: number;
  totalProceedsUsd: number;
  realizedPnl: number;
  winRate: number; // 0-1
  openPositionsUsd: number;
}

/**
 * Lightweight DB for copytrade bot — records every copy attempt.
 * Schema v2: per-leader attribution + resolved PNL tracking.
 * Optional: only active if DATABASE_URL is set.
 */
export class CopyTradeDB {
  private pool: pg.Pool;
  private logger: Logger;

  constructor(databaseUrl: string, logger: Logger) {
    this.logger = logger;
    this.pool = new Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false },
      max: 3,
    });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS copy_trades (
        id SERIAL PRIMARY KEY,
        order_id TEXT,
        trade_id TEXT NOT NULL,
        leader_address TEXT,
        side TEXT NOT NULL,
        market_title TEXT,
        outcome TEXT,
        condition_id TEXT,
        token_id TEXT,
        price_cents NUMERIC,
        requested_shares NUMERIC,
        requested_usd NUMERIC,
        filled_shares NUMERIC DEFAULT 0,
        filled_usd NUMERIC DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'placed',
        leader_price_cents NUMERIC,
        leader_usd NUMERIC,
        leader_shares NUMERIC,
        source TEXT,
        latency_ms INT,
        dry_run BOOLEAN DEFAULT false,
        resolved_at TIMESTAMPTZ,
        resolution_outcome TEXT,
        payout_usd NUMERIC,
        realized_pnl NUMERIC,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        filled_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_copy_trades_status ON copy_trades(status);
      CREATE INDEX IF NOT EXISTS idx_copy_trades_created ON copy_trades(created_at);
      CREATE INDEX IF NOT EXISTS idx_copy_trades_leader ON copy_trades(leader_address);
      CREATE INDEX IF NOT EXISTS idx_copy_trades_condition ON copy_trades(condition_id);
      CREATE INDEX IF NOT EXISTS idx_copy_trades_resolved ON copy_trades(resolved_at) WHERE resolved_at IS NULL;
    `);

    // Migrations for existing databases (idempotent)
    for (const [col, type] of [
      ["leader_address", "TEXT"],
      ["resolved_at", "TIMESTAMPTZ"],
      ["resolution_outcome", "TEXT"],
      ["payout_usd", "NUMERIC"],
      ["realized_pnl", "NUMERIC"],
    ] as const) {
      await this.pool.query(`ALTER TABLE copy_trades ADD COLUMN IF NOT EXISTS ${col} ${type};`);
    }

    this.logger.info("CopyTrade DB initialized");
  }

  async recordPlacement(params: {
    orderId?: string;
    tradeId: string;
    leaderAddress: string;
    side: string;
    marketTitle: string;
    outcome: string;
    conditionId: string;
    tokenId: string;
    priceCents: number;
    requestedShares: number;
    requestedUsd: number;
    leaderPriceCents?: number;
    leaderUsd?: number;
    leaderShares?: number;
    source: string;
    latencyMs: number;
    dryRun: boolean;
  }): Promise<number> {
    const result = await this.pool.query(
      `INSERT INTO copy_trades (order_id, trade_id, leader_address, side, market_title, outcome, condition_id, token_id,
        price_cents, requested_shares, requested_usd, leader_price_cents, leader_usd, leader_shares,
        source, latency_ms, dry_run, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id`,
      [
        params.orderId || null, params.tradeId, params.leaderAddress, params.side, params.marketTitle,
        params.outcome, params.conditionId, params.tokenId, params.priceCents,
        params.requestedShares, params.requestedUsd, params.leaderPriceCents ?? null,
        params.leaderUsd ?? null, params.leaderShares ?? null, params.source,
        params.latencyMs, params.dryRun, params.dryRun ? "dry_run" : "placed",
      ],
    );
    return result.rows[0].id;
  }

  async recordSkip(params: {
    tradeId: string;
    leaderAddress: string;
    side: string;
    marketTitle: string;
    outcome: string;
    reason: string;
    source: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO copy_trades (trade_id, leader_address, side, market_title, outcome, source, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [params.tradeId, params.leaderAddress, params.side, params.marketTitle, params.outcome, params.source, `skipped:${params.reason}`],
    );
  }

  async recordFill(orderId: string, filledShares: number, filledUsd: number): Promise<void> {
    await this.pool.query(
      `UPDATE copy_trades SET status = 'filled', filled_shares = $2, filled_usd = $3, filled_at = NOW()
       WHERE order_id = $1 AND status = 'placed'`,
      [orderId, filledShares, filledUsd],
    );
  }

  async recordUnfilled(orderId: string, filledShares: number, cancelled: boolean): Promise<void> {
    const status = cancelled ? "cancelled" : "expired";
    await this.pool.query(
      `UPDATE copy_trades SET status = $2, filled_shares = $3
       WHERE order_id = $1 AND status = 'placed'`,
      [orderId, status, filledShares],
    );
  }

  async recordFailed(tradeId: string, leaderAddress: string, side: string, marketTitle: string, reason: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO copy_trades (trade_id, leader_address, side, market_title, status)
       VALUES ($1,$2,$3,$4,$5)`,
      [tradeId, leaderAddress, side, marketTitle, `failed:${reason}`],
    );
  }

  /**
   * Get filled BUY trades with unresolved markets (for the resolution worker).
   * Returns distinct (conditionId, tokenId, outcome) with aggregated shares.
   */
  async getUnresolvedFilledTrades(limit = 100): Promise<Array<{
    id: number;
    leaderAddress: string;
    conditionId: string;
    tokenId: string;
    outcome: string;
    filledShares: number;
    filledUsd: number;
    side: string;
  }>> {
    const result = await this.pool.query(
      `SELECT id, leader_address, condition_id, token_id, outcome, filled_shares, filled_usd, side
       FROM copy_trades
       WHERE status = 'filled'
         AND resolved_at IS NULL
         AND condition_id IS NOT NULL
         AND filled_shares > 0
         AND dry_run = false
       ORDER BY filled_at ASC NULLS LAST
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((r) => ({
      id: r.id,
      leaderAddress: r.leader_address || "",
      conditionId: r.condition_id,
      tokenId: r.token_id,
      outcome: r.outcome,
      filledShares: parseFloat(r.filled_shares) || 0,
      filledUsd: parseFloat(r.filled_usd) || 0,
      side: r.side,
    }));
  }

  /**
   * Mark a trade as resolved with payout and realized PNL.
   */
  async recordResolution(id: number, winningOutcome: string, payoutUsd: number, realizedPnl: number): Promise<void> {
    await this.pool.query(
      `UPDATE copy_trades
       SET resolved_at = NOW(), resolution_outcome = $2, payout_usd = $3, realized_pnl = $4
       WHERE id = $1`,
      [id, winningOutcome, payoutUsd, realizedPnl],
    );
  }

  /**
   * Aggregate stats per leader. Includes both closed (resolved) and open
   * (filled but not yet resolved) positions.
   */
  async getLeaderStats(sinceHoursAgo?: number): Promise<LeaderStats[]> {
    const sinceClause = sinceHoursAgo
      ? `AND created_at > NOW() - INTERVAL '${Math.floor(sinceHoursAgo)} hours'`
      : "";
    const result = await this.pool.query(`
      SELECT
        COALESCE(leader_address, 'unknown') AS leader_address,
        COUNT(*) FILTER (WHERE status IN ('placed','filled','cancelled','expired')) AS copies,
        COUNT(*) FILTER (WHERE status = 'filled') AS filled,
        COALESCE(SUM(filled_usd) FILTER (WHERE status = 'filled' AND side = 'BUY'), 0) AS total_spent_usd,
        COALESCE(SUM(filled_usd) FILTER (WHERE status = 'filled' AND side = 'SELL'), 0) AS total_proceeds_usd,
        COALESCE(SUM(realized_pnl) FILTER (WHERE resolved_at IS NOT NULL), 0) AS realized_pnl,
        COUNT(*) FILTER (WHERE resolved_at IS NOT NULL AND realized_pnl > 0) AS wins,
        COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) AS resolved_count,
        COALESCE(SUM(filled_usd) FILTER (WHERE status = 'filled' AND side = 'BUY' AND resolved_at IS NULL), 0)
          - COALESCE(SUM(filled_usd) FILTER (WHERE status = 'filled' AND side = 'SELL' AND resolved_at IS NULL), 0)
          AS open_positions_usd
      FROM copy_trades
      WHERE leader_address IS NOT NULL ${sinceClause}
      GROUP BY leader_address
      ORDER BY realized_pnl DESC
    `);
    return result.rows.map((r) => {
      const resolved = parseInt(r.resolved_count) || 0;
      const wins = parseInt(r.wins) || 0;
      return {
        leaderAddress: r.leader_address,
        copies: parseInt(r.copies) || 0,
        filled: parseInt(r.filled) || 0,
        totalSpentUsd: parseFloat(r.total_spent_usd) || 0,
        totalProceedsUsd: parseFloat(r.total_proceeds_usd) || 0,
        realizedPnl: parseFloat(r.realized_pnl) || 0,
        winRate: resolved > 0 ? wins / resolved : 0,
        openPositionsUsd: parseFloat(r.open_positions_usd) || 0,
      };
    });
  }

  async getStats(): Promise<{ total: number; filled: number; skipped: number; failed: number; totalUsd: number }> {
    const result = await this.pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'filled') as filled,
        COUNT(*) FILTER (WHERE status LIKE 'skipped:%') as skipped,
        COUNT(*) FILTER (WHERE status LIKE 'failed:%' OR status = 'cancelled' OR status = 'expired') as failed,
        COALESCE(SUM(filled_usd) FILTER (WHERE status = 'filled'), 0) as total_usd
      FROM copy_trades
    `);
    const row = result.rows[0];
    return {
      total: parseInt(row.total),
      filled: parseInt(row.filled),
      skipped: parseInt(row.skipped),
      failed: parseInt(row.failed),
      totalUsd: parseFloat(row.total_usd),
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
