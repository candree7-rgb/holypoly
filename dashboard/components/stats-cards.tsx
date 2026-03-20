'use client'

import { useEffect, useState } from 'react'
import { formatCurrency } from '@/lib/utils'
import { TimeRange, TIME_RANGES } from './time-range-selector'
import type { Stats } from '@/lib/db'

interface Props {
  timeRange: TimeRange
}

export default function StatsCards({ timeRange }: Props) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchData() {
      try {
        const params = new URLSearchParams()
        const range = TIME_RANGES.find(r => r.value === timeRange)
        if (range?.days) params.append('days', range.days.toString())

        const res = await fetch(`/api/stats?${params.toString()}`)
        if (res.ok) setStats(await res.json())
      } catch (error) {
        console.error('Failed to fetch stats:', error)
      } finally {
        setLoading(false)
      }
    }

    setLoading(true)
    fetchData()
    const interval = setInterval(fetchData, 30000)
    return () => clearInterval(interval)
  }, [timeRange])

  if (loading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="bg-card border border-border rounded-lg p-4 animate-pulse">
            <div className="h-4 bg-muted rounded w-1/2 mb-2"></div>
            <div className="h-8 bg-muted rounded w-3/4"></div>
          </div>
        ))}
      </div>
    )
  }

  if (!stats || stats.total_trades === 0) {
    return (
      <div className="bg-card border border-border rounded-lg p-6 text-center">
        <p className="text-muted-foreground">No trade data yet. Bot needs to complete some windows first.</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
      <StatCard
        label="Balance"
        value={formatCurrency(stats.current_balance)}
      />
      <StatCard
        label="Today P&L"
        value={formatCurrency(stats.today_pnl)}
        variant={stats.today_pnl >= 0 ? 'success' : 'danger'}
        subValue={`${stats.today_trades} trades today`}
      />
      <StatCard
        label="Total P&L"
        value={formatCurrency(stats.total_pnl)}
        variant={stats.total_pnl >= 0 ? 'success' : 'danger'}
      />
      <StatCard
        label="Win Rate"
        value={`${Number(stats.win_rate || 0).toFixed(1)}%`}
        variant={Number(stats.win_rate || 0) >= 50 ? 'success' : 'danger'}
        subValue={`${stats.wins}W / ${stats.losses}L`}
      />
      <StatCard
        label="Total Trades"
        value={stats.total_trades.toString()}
      />
      <StatCard
        label="Avg P&L"
        value={formatCurrency(stats.avg_pnl)}
        variant={stats.avg_pnl >= 0 ? 'success' : 'danger'}
        subValue="per window"
      />
      <StatCard
        label="Best Trade"
        value={formatCurrency(stats.best_trade)}
        variant="success"
      />
      <StatCard
        label="Losing Streak"
        value={stats.losing_streak.toString()}
        variant={stats.losing_streak >= 3 ? 'danger' : 'default'}
      />
    </div>
  )
}

interface StatCardProps {
  label: string
  value: string
  subValue?: string
  variant?: 'default' | 'success' | 'danger'
}

function StatCard({ label, value, subValue, variant = 'default' }: StatCardProps) {
  let borderClass = 'border-border'
  let textClass = 'text-foreground'

  if (variant === 'success') {
    borderClass = 'border-success/30'
    textClass = 'text-success'
  } else if (variant === 'danger') {
    borderClass = 'border-danger/30'
    textClass = 'text-danger'
  }

  return (
    <div className={`bg-card border ${borderClass} rounded-lg p-4`}>
      <div className="text-sm text-muted-foreground mb-1">{label}</div>
      <div className={`text-2xl font-bold ${textClass}`}>{value}</div>
      {subValue && <div className="text-xs text-muted-foreground mt-1">{subValue}</div>}
    </div>
  )
}
