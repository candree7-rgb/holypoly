import { NextRequest, NextResponse } from 'next/server'
import { getEquitySnapshots } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const days = searchParams.get('days') || undefined

    const snapshots = await getEquitySnapshots({ days })
    return NextResponse.json(snapshots)
  } catch (error) {
    console.error('Equity API error:', error)
    return NextResponse.json({ error: 'Failed to fetch equity data' }, { status: 500 })
  }
}
