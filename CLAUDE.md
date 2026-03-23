# HolyPoly

Polymarket merge-arb trading bot for BTC 5-minute Up/Down binary markets.

## Strategy: Merge-Arb V3 (`STRATEGY_MODE=merge-arb`)

Stargate5-style richtungsneutrale Arbitrage (V3 accumulate-then-merge):
1. Bot kauft **beide Seiten** (Up UND Down) alternierend über 2-4 Minuten (10-25 Orders)
2. Einzelpaare KÖNNEN über 100¢ sein — der GESAMTDURCHSCHNITT über alle Orders zählt
3. **Merge EINMAL am Ende** (T+260-280s), nicht nach jedem Paar
4. Mid-Merge Recycling NUR wenn Budget ausgeht
5. Nach Resolution: Redeem übrige Imbalance

### Kern-Edge
BTC-Preisoszillation innerhalb 5 Minuten verursacht schwankende Up/Down Preise.
Über viele Orders mittelt sich der Combined-Preis unter 100¢.
Extreme Preise (10-20¢) haben fast keine Fee (Curve-Fee).

### Key Parameters
- EQUITY_PER_WINDOW: 80%
- MAX_ORDERS_PER_WINDOW: 30 (Stargate5 macht 10-25)
- MERGE_MIN_SIZE: 10 shares
- ENTRY_DELAY: 5s nach Window-Open
- ORDER_INTERVAL: 2s zwischen Orders
- STOP_BUYING_BEFORE_END_S: 40s vor Window-Ende
- MERGE_BEFORE_END_S: 20s vor Window-Ende
- SLIPPAGE_BUFFER: +2¢ über Best Ask
- SKIP_IF_BEST_COMBINED_GT: 110¢ (nur komplett kaputtes Buch)
- MAX_CHUNK_SIZE: 200 shares
- Fee: Polymarket Crypto Curve (NOT flat 2%)

### Architecture
- `src/execution/merge-arb-executor.ts` — V3 Core: accumulate loop + final merge
- `src/execution/dry-run-engine.ts` — Realistic orderbook-based fill simulation
- `src/data/clob-ws.ts` — CLOB WebSocket (orderbook data, PING/PONG every 5s)
- `src/data/clob.ts` — CLOB REST API (orders, fills, balance)
- `src/data/redeem.ts` — CTF merge + redeem via relayer
- `src/data/gamma.ts` — Market discovery (slug-based)
- `src/config.ts` — All configuration parameters
- `src/index.ts` — Main loop (merge-arb / edge / webhook modes)

### DRY_RUN Mode
`DRY_RUN=true` (default) runs the **identical strategy code** but:
- CLOB WebSocket connects normally (no auth needed) → real orderbook data
- Fills are simulated against live ask depth (DryRunEngine)
- Consumed liquidity is tracked (subsequent orders see less depth)
- Merges are simulated with correct P&L math
- Polymarket crypto fee curve applied to all simulated fills
- Virtual balance, positions, and P&L tracked throughout
- Risk limits (losing streak, daily/weekly loss) skipped in DRY_RUN

### Fee Model
Polymarket crypto fee curve (NOT flat 2%):
```
fee = shares × price × 0.25 × (price × (1 - price))²
```
Max ~1.56% at 50¢, ~0.2% at extremes (10¢/90¢).

### WebSocket Notes
- Polymarket CLOB WS requires subscription message immediately after connect
- CLOB WS only connects when `subscribe()` is called with tokens
- Market channel: client sends `PING` every 5s, server responds `PONG`
- No auth required for market channel (orderbook data)

### Specs
- `HOLYPOLY_V3_DEFINITIVE.md` — V3 strategy specification (DEFINITIV, ersetzt alle vorherigen)
- `HOLYPOLY_STRATEGY_SPEC.md` — Original strategy specification (veraltet)
- `HOLYPOLY_CHANGELOG.md` — Additions & updates
