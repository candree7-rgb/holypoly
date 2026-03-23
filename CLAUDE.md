# HolyPoly

Polymarket oscillation-DCA trading bot for BTC 5-minute Up/Down binary markets.

## Strategy: Oscillation-DCA V4 (`STRATEGY_MODE=merge-arb`)

**CRITICAL FACT: Up + Down = ~101¢ at ANY single moment. Never buy both sides simultaneously.**

V4 Oscillation-DCA (replaces V3 blind alternating):
1. Bot monitors **beide Orderbücher gleichzeitig** via WebSocket (alle 500ms)
2. Kauft Up **NUR wenn Up billig ist** (Ask < Running Midpoint × DIP_THRESHOLD)
3. Kauft Down **NUR wenn Down billig ist** (Ask < Running Midpoint × DIP_THRESHOLD)
4. **WARTET wenn nichts billig ist** — kauft NICHT blind!
5. BTC oscilliert → Up-Dips und Down-Dips passieren zu VERSCHIEDENEN Zeitpunkten
6. Combined = avg(Up-Dips) + avg(Down-Dips) < 100¢
7. **Merge EINMAL am Ende** (T+260-280s)
8. Mid-Merge Recycling NUR wenn Budget ausgeht

### Kern-Edge
BTC-Preisoszillation innerhalb 5 Minuten verursacht dass Up und Down ihre Tiefpunkte
zu VERSCHIEDENEN Zeitpunkten haben. Der Bot kauft jede Seite NUR bei ihrem Tiefpunkt.
Combined aus Up-Dips + Down-Dips < 100¢ → Merge für Profit.

**WARUM V3 (blind alternierend) NICHT funktionierte:**
- V3 kaufte Up→Down→Up→Down blind alle 2s
- Wenn Up billig (15¢), ist Down im selben Moment teuer (86¢) → Paar = 101¢
- Der Durchschnitt von lauter 101¢-Paaren ist 101¢ → Verlust

### Key Parameters
- DIP_THRESHOLD_PCT: 0.92 (kaufe wenn Ask 8% unter Running Midpoint)
- MONITOR_INTERVAL_MS: 500ms (beide Bücher checken)
- ORDER_INTERVAL_MS: 2000ms (nach erfolgtem Kauf, nicht pro Tick)
- EQUITY_PER_WINDOW: 80%
- MAX_ORDERS_PER_WINDOW: 30
- MERGE_MIN_SIZE: 10 shares
- ENTRY_DELAY: 5s nach Window-Open
- STOP_BUYING_BEFORE_END_S: 40s vor Window-Ende
- MERGE_BEFORE_END_S: 20s vor Window-Ende
- SLIPPAGE_BUFFER: +2¢ über Best Ask
- MAX_CHUNK_SIZE: 200 shares
- Fee: Polymarket Crypto Curve (NOT flat 2%)

### Architecture
- `src/execution/merge-arb-executor.ts` — V4 Core: oscillation DCA + final merge
- `src/execution/dry-run-engine.ts` — Realistic orderbook-based fill simulation
- `src/data/clob-ws.ts` — CLOB WebSocket (orderbook data, price_change updates asks/bids)
- `src/data/clob.ts` — CLOB REST API (orders, fills, balance)
- `src/data/redeem.ts` — CTF merge + redeem via relayer
- `src/data/gamma.ts` — Market discovery (slug-based)
- `src/config.ts` — All configuration parameters
- `src/index.ts` — Main loop (merge-arb / edge / webhook modes)

### DRY_RUN Mode
`DRY_RUN=true` (default) runs the **identical strategy code** but:
- CLOB WebSocket connects normally (no auth needed) → real orderbook data
- WebSocket `price_change` events update full asks[]/bids[] arrays (not just bestAsk)
- Fills are simulated against live ask depth (DryRunEngine)
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
- `price_change` events update individual price levels in asks[]/bids[] arrays
- `best_bid_ask` events update only bestBid/bestAsk (fastest)
- `book` events provide full snapshot (on subscribe)

### Specs
- `HOLYPOLY_V3_DEFINITIVE.md` — V4 strategy specification (DEFINITIV, ersetzt V3 und alle vorherigen)
- `HOLYPOLY_STRATEGY_SPEC.md` — Original strategy specification (veraltet)
- `HOLYPOLY_CHANGELOG.md` — Additions & updates
