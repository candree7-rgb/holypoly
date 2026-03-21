'use client'

import { useEffect, useState } from 'react'
import { formatCurrency, formatDate } from '@/lib/utils'
import { TimeRange, TIME_RANGES } from './time-range-selector'
import type { CopyTrade } from '@/lib/db'

interface Props {
  timeRange: TimeRange
}

export default function TradesTable({ timeRange }: Props) {
  const [trades, setTrades] = useState<CopyTrade[]>([])
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

  const statusColor = (status: string) => {
    if (status === 'filled' || status === 'dry_run') return 'bg-success/20 text-success'
    if (status === 'placed') return 'bg-yellow-500/20 text-yellow-400'
    if (status.startsWith('skipped') || status.startsWith('failed') || status === 'cancelled' || status === 'expired')
      return 'bg-danger/20 text-danger'
    return 'bg-muted text-muted-foreground'
  }

  const statusLabel = (status: string) => {
    if (status === 'filled') return 'FILLED'
    if (status === 'dry_run') return 'DRY'
    if (status === 'placed') return 'PENDING'
    if (status === 'cancelled') return 'CANCELLED'
    if (status === 'expired') return 'EXPIRED'
    if (status.startsWith('skipped:')) return status.replace('skipped:', '').toUpperCase()
    if (status.startsWith('failed:')) return 'FAILED'
    return status.toUpperCase()
  }

  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <div className="p-4 border-b border-border">
        <h3 className="text-lg font-semibold">Copy Trade History</h3>
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
                <th className="text-left p-3">Market</th>
                <th className="text-left p-3">Side</th>
                <th className="text-right p-3">Price</th>
                <th className="text-right p-3">Shares</th>
                <th className="text-right p-3">USD</th>
                <th className="text-right p-3">Latency</th>
                <th className="text-center p-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id} className="border-b border-border/50 hover:bg-muted/30">
                  <td className="p-3 text-muted-foreground text-xs">{formatDate(t.created_at)}</td>
                  <td className="p-3 max-w-[200px] truncate" title={t.market_title}>
                    {t.outcome && <span className="text-muted-foreground">{t.outcome} · </span>}
                    {t.market_title?.slice(0, 40)}
                  </td>
                  <td className={`p-3 font-medium ${t.side === 'BUY' ? 'text-success' : 'text-danger'}`}>
                    {t.side}
                  </td>
                  <td className="p-3 text-right">{Number(t.price_cents || 0).toFixed(0)}¢</td>
                  <td className="p-3 text-right">
                    {t.status === 'filled'
                      ? Number(t.filled_shares || 0).toFixed(1)
                      : Number(t.requested_shares || 0).toFixed(1)}
                  </td>
                  <td className="p-3 text-right">
                    {t.status === 'filled'
                      ? formatCurrency(Number(t.filled_usd || 0))
                      : formatCurrency(Number(t.requested_usd || 0))}
                  </td>
                  <td className="p-3 text-right text-muted-foreground">
                    {t.latency_ms ? `${t.latency_ms}ms` : '-'}
                  </td>
                  <td className="p-3 text-center">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${statusColor(t.status)}`}>
                      {statusLabel(t.status)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
