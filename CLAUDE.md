# HolyPoly

Polymarket merge-arb trading bot for BTC 5-minute Up/Down binary markets.

## Strategy: Signal-Taker V6 (`STRATEGY_MODE=signal-taker`) — AKTIV

**Kern-Insight:** Nie beide Seiten gleichzeitig kaufen (Combined ≈101¢ = Verlust).
Stattdessen: Binance BTC-Preis monitoren, jede Seite EINZELN kaufen wenn sie billig ist.

### Warum V6 funktioniert (und V1-V5 nicht)
V1-V5 kauften immer Up+Down quasi-gleichzeitig → Combined ≈ 101¢ → Verlust.
V6 kauft jede Seite einzeln wenn BTC sich bewegt:
- BTC STEIGT → Down wird billig → KAUF DOWN
- BTC FÄLLT  → Up wird billig → KAUF UP
- BTC FLAT   → nichts kaufen (kein Edge)

Über 2-4 Min BTC-Oszillation sammeln wir beide Seiten billig. Combined < 100¢ → Merge → Profit.

### Fee bei niedrigen Preisen ist kein Problem
```
Polymarket Fee: shares × price × 0.25 × (price × (1-price))²
Bei 30¢: 0.53% → 30.16¢ effektiv
Bei 20¢: 0.32% → 20.06¢ effektiv
Bei 10¢: 0.08% → 10.01¢ effektiv
Bei 50¢: 1.56% → 50.78¢ (worst case)
```

### 3-Phase Flow
1. **Phase 1 ACCUMULATE (T+5s→T+260s):** Signal-based taker buys
   - Monitor Binance BTCUSDT via WebSocket (real-time, ~100ms updates)
   - BTC change > +0.05% → buy Down (cheap side)
   - BTC change < -0.05% → buy Up (cheap side)
   - Only buy if ask < CHEAP_THRESHOLD (45¢)
   - Balance enforcement: max 3 chunks imbalance between sides
   - Per-side pacing: min 10s between orders on same side (wait for BTC to move more)
   - Budget-reserve: max 50% budget on one side until other side has ≥1 fill
2. **Phase 2 REBALANCE (T+260s):** Buy short side as taker
   - Fixed cap: 55¢ (dynamic cap was blocking everything — opposite side always ~96-100¢ after directional move)
3. **Phase 3 MERGE (T+270s):** Merge matched shares → $1.00 per pair

### Key Parameters
- BTC_MOVE_THRESHOLD: 0.0005 (0.05% BTC move triggers buy signal)
- CHEAP_THRESHOLD: 0.45 (only buy when ask < 45¢)
- SIGNAL_CHECK_INTERVAL_MS: 500 (check Binance every 500ms)
- MAX_IMBALANCE_CHUNKS: 3 (max chunks more on one side)
- SAME_SIDE_COOLDOWN_MS: 10000 (10s min between orders on same side)
- BUDGET_RESERVE_PCT: 0.50 (max 50% budget on one side until other has ≥1 fill)
- REBALANCE_MAX_PRICE: 0.55 (fixed 55¢ cap for rebalance buys)
- EQUITY_PER_WINDOW: 30% (conservative start, scale up later)
- MAX_ORDERS_PER_WINDOW: 30
- MERGE_MIN_SIZE: 10 shares
- STOP_BUYING_BEFORE_END_S: 40
- MAX_CHUNK_SIZE: 200 shares
- SLIPPAGE_BUFFER: 0.02 (+2¢ over ask for FOK)

### Architecture
- `src/execution/signal-taker-executor.ts` — V6 Core: signal-based taker accumulation
- `src/execution/merge-arb-executor.ts` — V5 (legacy): 3-phase maker strategy
- `src/execution/dry-run-engine.ts` — FOK fill simulation against live orderbook
- `src/data/binance-ws.ts` — Binance BTCUSDT WebSocket (real-time BTC price)
- `src/data/clob-ws.ts` — CLOB WebSocket (orderbook data, price_change updates)
- `src/data/clob.ts` — CLOB REST API (orders, fills, balance)
- `src/data/redeem.ts` — CTF merge + redeem via relayer
- `src/data/gamma.ts` — Market discovery (slug-based)
- `src/config.ts` — All configuration parameters
- `src/index.ts` — Main loop (signal-taker / merge-arb / edge / webhook modes)

### DRY_RUN Mode
`DRY_RUN=true` (default) runs the **identical strategy code** but:
- Binance WebSocket connects normally → real BTC price data
- CLOB WebSocket connects normally → real orderbook data
- FOK buys simulated against live orderbook depth
- Taker fees applied via Polymarket crypto fee curve
- Merges simulated with correct P&L math
- Virtual balance, positions, and P&L tracked throughout

### Fee Model
```
fee = shares × price × 0.25 × (price × (1 - price))²
```
Max ~1.56% at 50¢, drops toward extremes. At typical buy prices (25-40¢): 0.3-0.8%.

### WebSocket Notes
- Binance: `wss://stream.binance.com:9443/ws/btcusdt@trade` — no auth, ~100ms updates
- Polymarket CLOB WS requires subscription message immediately after connect
- CLOB WS only connects when `subscribe()` is called with tokens
- Market channel: client sends `PING` every 5s, server responds `PONG`
- No auth required for market channel (orderbook data)
- `price_change` events update individual price levels in asks[]/bids[] arrays
- `best_bid_ask` events update only bestBid/bestAsk (fastest)
- `book` events provide full snapshot (on subscribe)

### Specs
- `HOLYPOLY_V3_DEFINITIVE.md` — V5 strategy specification (legacy)
- `HOLYPOLY_STRATEGY_SPEC.md` — Original strategy specification (veraltet)
- `HOLYPOLY_CHANGELOG.md` — Additions & updates
