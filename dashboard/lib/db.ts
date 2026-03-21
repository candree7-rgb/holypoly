import { Pool } from 'pg'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  ssl: process.env.DATABASE_URL?.includes('railway')
    ? { rejectUnauthorized: false }
    : undefined,
})

// ---- Types ----

export interface CopyTrade {
  id: number
  order_id: string | null
  trade_id: string
  side: string
  market_title: string
  outcome: string
  condition_id: string
  token_id: string
  price_cents: number
  requested_shares: number
  requested_usd: number
  filled_shares: number
  filled_usd: number
  status: string
  leader_price_cents: number | null
  leader_usd: number | null
  leader_shares: number | null
  source: string
  latency_ms: number
  dry_run: boolean
  created_at: string
  filled_at: string | null
}

// Keep old type for backwards compat
export type WindowTrade = CopyTrade

export interface DailySnapshot {
  date: string
  starting_balance: number
  ending_balance: number | null
  total_pnl: number
  windows_traded: number
  wins: number
  losses: number
}

export interface Stats {
  total_trades: number
  wins: number
  losses: number
  win_rate: number
  total_pnl: number
  avg_pnl: number
  best_trade: number
  worst_trade: number
  current_balance: number
  today_pnl: number
  today_trades: number
  losing_streak: number
}

// ---- Query helpers ----

function buildDateFilter(
  params: { days?: string },
  dateColumn: string,
  values: unknown[],
): string {
  if (params.days) {
    values.push(parseInt(params.days))
    return `AND ${dateColumn} >= NOW() - ($${values.length} || ' days')::interval`
  }
  return ''
}

// ---- Stats (aggregated from copy_trades) ----

export async function getStats(opts?: { days?: string }): Promise<Stats> {
  const client = await pool.connect()
  try {
    const values: unknown[] = []
    const dateFilter = buildDateFilter(
      { days: opts?.days },
      'created_at',
      values,
    )

    // Trade stats from copy_trades
    const { rows: [tradeStats] } = await client.query(`
      SELECT
        COUNT(*)::int AS total_trades,
        COUNT(*) FILTER (WHERE status = 'filled')::int AS wins,
        COUNT(*) FILTER (WHERE status IN ('cancelled', 'expired', 'placed'))::int AS pending,
        COUNT(*) FILTER (WHERE status LIKE 'skipped:%' OR status LIKE 'failed:%')::int AS losses,
        COALESCE(SUM(filled_usd), 0)::float AS total_filled_usd,
        COALESCE(SUM(requested_usd), 0)::float AS total_requested_usd,
        COALESCE(AVG(filled_usd) FILTER (WHERE status = 'filled'), 0)::float AS avg_fill_usd,
        COALESCE(MAX(filled_usd), 0)::float AS best_trade,
        COUNT(*) FILTER (WHERE status = 'filled' OR status = 'placed' OR status = 'dry_run')::int AS filled_count
      FROM copy_trades
      WHERE 1=1 ${dateFilter}
    `, values)

    // Today's trades
    const { rows: todayRows } = await client.query(`
      SELECT
        COUNT(*)::int AS today_trades,
        COALESCE(SUM(filled_usd) FILTER (WHERE status = 'filled'), 0)::float AS today_filled_usd
      FROM copy_trades
      WHERE created_at >= CURRENT_DATE
    `)

    // Fill rate as "win rate"
    const total = tradeStats.total_trades || 0
    const filled = tradeStats.filled_count || 0
    const winRate = total > 0 ? (filled / total) * 100 : 0

    return {
      total_trades: total,
      wins: filled,
      losses: tradeStats.losses || 0,
      win_rate: winRate,
      total_pnl: tradeStats.total_filled_usd || 0,
      avg_pnl: tradeStats.avg_fill_usd || 0,
      best_trade: tradeStats.best_trade || 0,
      worst_trade: 0,
      current_balance: 0, // Will be fetched from CLOB at runtime
      today_pnl: todayRows[0]?.today_filled_usd ?? 0,
      today_trades: todayRows[0]?.today_trades ?? 0,
      losing_streak: 0,
    }
  } finally {
    client.release()
  }
}

// ---- Trades ----

export async function getTrades(opts?: {
  limit?: number
  days?: string
}): Promise<CopyTrade[]> {
  const client = await pool.connect()
  try {
    const values: unknown[] = []
    const dateFilter = buildDateFilter(
      { days: opts?.days },
      'created_at',
      values,
    )
    const limit = opts?.limit || 100
    values.push(limit)

    const { rows } = await client.query(
      `SELECT * FROM copy_trades
       WHERE 1=1 ${dateFilter}
       ORDER BY created_at DESC LIMIT $${values.length}`,
      values,
    )
    return rows
  } finally {
    client.release()
  }
}

// ---- Equity (daily snapshots) ----

export async function getEquitySnapshots(opts?: {
  days?: string
}): Promise<DailySnapshot[]> {
  const client = await pool.connect()
  try {
    const values: unknown[] = []
    const dateFilter = opts?.days
      ? (() => {
          values.push(parseInt(opts.days!))
          return `WHERE date >= (CURRENT_DATE - ($${values.length} || ' days')::interval)::text`
        })()
      : ''

    const { rows } = await client.query(
      `SELECT * FROM daily_snapshots ${dateFilter} ORDER BY date ASC LIMIT 365`,
      values,
    )
    return rows
  } finally {
    client.release()
  }
}
