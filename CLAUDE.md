# HolyPoly

Polymarket merge-arb trading bot for BTC 5-minute Up/Down binary markets.

## Strategy: Merge-Arb (`STRATEGY_MODE=merge-arb`)

Stargate5-style richtungsneutrale Arbitrage:
1. Bot kauft **beide Seiten** (Up UND Down) alternierend mit FOK Orders
2. Sobald Shares balanced → **Merge** zu $1/Share (sofortiger Profit wenn Combined < $1)
3. Recyceltes Kapital wird für weitere Paare verwendet
4. MAX_PAIRS = 5 ist der Hauptfilter (erste Fills = profitabelste)
5. Nach Resolution: Redeem übrige Imbalance

### Kern-Edge
Die Polymarket CLOB-Orderbücher für 5-min-BTC-Märkte haben eine strukturelle Ineffizienz:
Die Summe der Ask-Preise (Up + Down) liegt im Durchschnitt unter $1.00. Die ersten
Fills sweepen die billigsten Levels wo Combined oft 85-95¢ ist.

### Key Parameters
- EQUITY_PER_WINDOW: 20% (Start), bis 80% nach Validierung
- MAX_PAIRS: 5 (hard stop, DER Filter)
- MERGE_MIN_SIZE: 10 shares
- ENTRY_DELAY: 3s nach Window-Open
- ORDER_INTERVAL: 2s zwischen Orders
- SLIPPAGE_BUFFER: +2¢ über Best Ask
- MAX_COMBINED_ENTRY: 105¢ (Window-Gate, selten)
- MAX_COMBINED_PAIR: 103¢ (Pair-Gate, selten)
- Taker Fee: 2% (alle Orders sind FOK/Taker)

### Architecture
- `src/execution/merge-arb-executor.ts` — Core strategy: FOK buy cycle + dynamic merge
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
- FOK fills are simulated against live ask depth (DryRunEngine)
- Consumed liquidity is tracked (subsequent orders see less depth)
- Merges are simulated with correct P&L math
- Taker fees (2%) applied to all simulated fills
- Virtual balance, positions, and P&L tracked throughout

### WebSocket Notes
- Polymarket CLOB WS requires subscription message immediately after connect
- CLOB WS only connects when `subscribe()` is called with tokens
- Market channel: client sends `PING` every 5s, server responds `PONG`
- No auth required for market channel (orderbook data)

### Specs
- `HOLYPOLY_STRATEGY_SPEC.md` — Full strategy specification (Stargate5 analysis)
- `HOLYPOLY_CHANGELOG.md` — Additions & updates (takes precedence on conflicts)
