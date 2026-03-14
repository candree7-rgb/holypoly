'use client'

import { useEffect, useState } from 'react'
import { formatCurrency, formatDate } from '@/lib/utils'
import { TimeRange, TIME_RANGES } from './time-range-selector'
import type { WindowTrade } from '@/lib/db'

interface Props {
  timeRange: TimeRange
}

export default function TradesTable({ timeRange }: Props) {
  const [trades, setTrades] = useState<WindowTrade[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchData() {
      try {
        const params = new URLSearchParams()
        const range = TIME_RANGES.find(r => r.value === timeRange)
        if (range?.days) params.append('days', range.days.toString())
        params.append('limit', '100')

        const res = await fetch(`/api/trades?${params.toString()}`)
        if (res.ok) setTrades(await res.json())
      } catch (error) {
        console.error('Failed to fetch trades:', error)
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
      <div className="bg-card border border-border rounded-lg p-6 animate-pulse">
        <div className="h-4 bg-muted rounded w-1/4 mb-4"></div>
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-10 bg-muted rounded"></div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <div className="p-4 border-b border-border">
        <h3 className="text-lg font-semibold">Trade History</h3>
      </div>
      {trades.length === 0 ? (
        <div className="p-6 text-center text-muted-foreground">
          No trades yet
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="text-left p-3">Time</th>
                <th className="text-left p-3">Side</th>
                <th className="text-right p-3">Orders</th>
                <th className="text-right p-3">Balance</th>
                <th className="text-right p-3">P&L</th>
                <th className="text-center p-3">Winner</th>
                <th className="text-center p-3">Result</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => {
                const pnl = Number(t.pnl)
                const won = pnl > 0
                return (
                  <tr key={t.id} className="border-b border-border/50 hover:bg-muted/30">
                    <td className="p-3 text-muted-foreground">{formatDate(t.created_at)}</td>
                    <td className="p-3 font-medium">{t.primary_side}</td>
                    <td className="p-3 text-right">{t.fill_count}</td>
                    <td className="p-3 text-right text-muted-foreground">
                      {formatCurrency(Number(t.balance_before))}
                    </td>
                    <td className={`p-3 text-right font-medium ${won ? 'text-success' : 'text-danger'}`}>
                      {pnl >= 0 ? '+' : ''}{formatCurrency(pnl)}
                    </td>
                    <td className="p-3 text-center text-muted-foreground">
                      {t.winner}
                    </td>
                    <td className="p-3 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        won
                          ? 'bg-success/20 text-success'
                          : 'bg-danger/20 text-danger'
                      }`}>
                        {won ? 'WIN' : 'LOSS'}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
