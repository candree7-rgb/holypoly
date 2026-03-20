'use client'

import { useState } from 'react'
import StatsCards from '@/components/stats-cards'
import EquityChart from '@/components/equity-chart'
import TradesTable from '@/components/trades-table'
import TimeRangeSelector, { TimeRange } from '@/components/time-range-selector'

export default function Dashboard() {
  const [timeRange, setTimeRange] = useState<TimeRange>('7D')

  return (
    <main className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-background sticky top-0 z-40">
        <div className="container mx-auto px-4 py-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <h1 className="text-xl font-bold text-foreground">HolyPoly</h1>
              <p className="text-sm text-muted-foreground">
                BTC 5-min Up/Down &bull; Edge Trading &bull; Live
              </p>
            </div>
            <TimeRangeSelector selected={timeRange} onSelect={setTimeRange} />
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="container mx-auto px-4 py-6 space-y-6">
        {/* Stats Cards */}
        <section>
          <StatsCards timeRange={timeRange} />
        </section>

        {/* P&L Chart */}
        <section>
          <EquityChart timeRange={timeRange} />
        </section>

        {/* Trade History */}
        <section>
          <TradesTable timeRange={timeRange} />
        </section>
      </div>

      {/* Footer */}
      <footer className="border-t border-border py-4 mt-8">
        <div className="container mx-auto px-4 text-center text-sm text-muted-foreground">
          HolyPoly &bull; Auto-refreshes every 30s
        </div>
      </footer>
    </main>
  )
}
