'use client'

import { useEffect, useState, useMemo } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'
import { format } from 'date-fns'
import { formatCurrency } from '@/lib/utils'
import { TimeRange, TIME_RANGES } from './time-range-selector'
import type { DailySnapshot } from '@/lib/db'

interface Props {
  timeRange: TimeRange
}

export default function EquityChart({ timeRange }: Props) {
  const [snapshots, setSnapshots] = useState<DailySnapshot[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchData() {
      try {
        const params = new URLSearchParams()
        const range = TIME_RANGES.find(r => r.value === timeRange)
        if (range?.days) params.append('days', range.days.toString())

        const res = await fetch(`/api/equity?${params.toString()}`)
        if (res.ok) setSnapshots(await res.json())
      } catch (error) {
        console.error('Failed to fetch equity:', error)
      } finally {
        setLoading(false)
      }
    }

    setLoading(true)
    fetchData()
    const interval = setInterval(fetchData, 30000)
    return () => clearInterval(interval)
  }, [timeRange])

  const chartData = useMemo(() => {
    let cumPnl = 0
    return snapshots.map(s => {
      cumPnl += Number(s.total_pnl)
      return {
        date: format(new Date(s.date), 'MMM dd'),
        pnl: cumPnl,
        balance: Number(s.starting_balance) + Number(s.total_pnl),
        dailyPnl: Number(s.total_pnl),
      }
    })
  }, [snapshots])

  if (loading) {
    return (
      <div className="bg-card border border-border rounded-lg p-6 animate-pulse">
        <div className="h-4 bg-muted rounded w-1/4 mb-4"></div>
        <div className="h-64 bg-muted rounded"></div>
      </div>
    )
  }

  if (chartData.length === 0) {
    return (
      <div className="bg-card border border-border rounded-lg p-6">
        <h3 className="text-lg font-semibold mb-4">P&L Curve</h3>
        <p className="text-muted-foreground text-center py-12">No data yet</p>
      </div>
    )
  }

  const totalPnl = chartData[chartData.length - 1]?.pnl ?? 0

  return (
    <div className="bg-card border border-border rounded-lg p-6">
      <div className="flex items-baseline justify-between mb-4">
        <h3 className="text-lg font-semibold">P&L Curve</h3>
        <div className="text-right">
          <div className={`text-2xl font-bold ${totalPnl >= 0 ? 'text-success' : 'text-danger'}`}>
            {totalPnl >= 0 ? '+' : ''}{formatCurrency(totalPnl)}
          </div>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={chartData}>
          <defs>
            <linearGradient id="pnlGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(216 34% 17%)" />
          <XAxis dataKey="date" tick={{ fontSize: 12 }} stroke="hsl(215 16% 47%)" />
          <YAxis tick={{ fontSize: 12 }} stroke="hsl(215 16% 47%)" tickFormatter={(v) => `$${v}`} />
          <Tooltip
            contentStyle={{
              backgroundColor: 'hsl(224 71% 4%)',
              border: '1px solid hsl(216 34% 17%)',
              borderRadius: '8px',
            }}
            formatter={(value: number, name: string) => [
              formatCurrency(value),
              name === 'pnl' ? 'Cumulative P&L' : name === 'dailyPnl' ? 'Daily P&L' : name,
            ]}
          />
          <Area type="monotone" dataKey="pnl" stroke="#22c55e" fill="url(#pnlGradient)" strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
