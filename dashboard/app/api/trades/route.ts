import { NextRequest, NextResponse } from 'next/server'
import { getTrades } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get('limit') || '100')
    const days = searchParams.get('days') || undefined

    const trades = await getTrades({ limit, days })
    return NextResponse.json(trades)
  } catch (error) {
    console.error('Trades API error:', error)
    return NextResponse.json({ error: 'Failed to fetch trades' }, { status: 500 })
  }
}
