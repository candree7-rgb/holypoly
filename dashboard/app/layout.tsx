import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'HolyPoly | Trading Dashboard',
  description: 'BTC 5-min up/down trading bot dashboard',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body className="font-sans">{children}</body>
    </html>
  )
}
