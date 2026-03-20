import { NextRequest, NextResponse } from 'next/server'
import { getStats } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders })
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const days = searchParams.get('days') || undefined

    const stats = await getStats({ days })
    return NextResponse.json(stats, { headers: corsHeaders })
  } catch (error) {
    console.error('Stats API error:', error)
    return NextResponse.json({ error: 'Failed to fetch stats' }, { status: 500 })
  }
}
