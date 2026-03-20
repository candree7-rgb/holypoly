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

export interface WindowTrade {
  id: number
  window_start: string
  condition_id: string
  traded: boolean
  primary_side: string
  orders: Array<{ side: string; price: number; amount: number }>
  fill_count: number
  pnl: number | null
  winner: string | null
  balance_before: number
  balance_after: number | null
  created_at: string
}

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

// ---- Stats (aggregated) ----

export async function getStats(opts?: { days?: string }): Promise<Stats> {
  const client = await pool.connect()
  try {
    const values: unknown[] = []
    const dateFilter = buildDateFilter(
      { days: opts?.days },
      'created_at',
      values,
    )

    // Trade stats
    const { rows: [tradeStats] } = await client.query(`
      SELECT
        COUNT(*)::int AS total_trades,
        COUNT(*) FILTER (WHERE pnl > 0)::int AS wins,
        COUNT(*) FILTER (WHERE pnl <= 0)::int AS losses,
        CASE WHEN COUNT(*) > 0
          THEN COUNT(*) FILTER (WHERE pnl > 0)::float / COUNT(*)::float * 100
          ELSE 0
        END AS win_rate,
        COALESCE(SUM(pnl), 0)::float AS total_pnl,
        COALESCE(AVG(pnl), 0)::float AS avg_pnl,
        COALESCE(MAX(pnl), 0)::float AS best_trade,
        COALESCE(MIN(pnl), 0)::float AS worst_trade
      FROM window_trades
      WHERE traded = true AND pnl IS NOT NULL ${dateFilter}
    `, values)

    // Today's snapshot
    const today = new Date().toISOString().slice(0, 10)
    const { rows: todayRows } = await client.query(
      'SELECT total_pnl, windows_traded FROM daily_snapshots WHERE date = $1',
      [today],
    )

    // Current balance (latest trade's balance_before or starting_balance)
    const { rows: balanceRows } = await client.query(
      'SELECT balance_before FROM window_trades ORDER BY created_at DESC LIMIT 1',
    )

    // Losing streak from bot_state
    const { rows: streakRows } = await client.query(
      "SELECT value FROM bot_state WHERE key = 'losing_streak'",
    )

    return {
      ...tradeStats,
      current_balance: balanceRows[0]?.balance_before ?? 0,
      today_pnl: todayRows[0]?.total_pnl ?? 0,
      today_trades: todayRows[0]?.windows_traded ?? 0,
      losing_streak: streakRows[0]?.value ?? 0,
    }
  } finally {
    client.release()
  }
}

// ---- Trades ----

export async function getTrades(opts?: {
  limit?: number
  days?: string
}): Promise<WindowTrade[]> {
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
      `SELECT * FROM window_trades
       WHERE traded = true AND pnl IS NOT NULL ${dateFilter}
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
