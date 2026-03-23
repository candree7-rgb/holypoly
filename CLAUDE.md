# HolyPoly

Polymarket merge-arb trading bot for BTC 5-minute Up/Down binary markets.

## Strategy: Adaptive Signal-Taker V7 (`STRATEGY_MODE=signal-taker`) — AKTIV

**Kern-Insight:** Beide Seiten ABWECHSELND kaufen, getimed durch BTC-EMA-Crossover.
Nur kaufen wenn es den Combined-Preis VERBESSERT. Aufhören bei Target (97¢).

### Warum V7 funktioniert (und V1-V6 nicht)
- V1-V5: Kauften Up+Down gleichzeitig → Combined ≈101¢ → Verlust.
- V6: Kaufte bei BTC-Signal, aber keine strikte Alternation → Imbalance, Rebalance-Cap blockiert.
- V7: Strikte Alternation + EMA-Timing + Combined-Tracking → Adaptiv, nur profitable Buys.

### Adaptive Logik
1. **EMA Crossover**: Fast-EMA (5s) vs Slow-EMA (30s) erkennt Dips/Bounces
   - BTC dippt (fast < slow) → Up wird billig → kaufe Up
   - BTC bounct (fast > slow) → Down wird billig → kaufe Down
2. **Strikte Alternation**: Nie dieselbe Seite doppelt. Immer ausgleichen.
3. **Projected Combined Check**: Nur kaufen wenn es Combined verbessert (oder bei Target hält)
4. **Dynamic Intervals**: Weit vom Target → aggressiv (1.5s). Nah → vorsichtig (8-12s).
5. **Trend Detection**: EMA-Divergenz > 0.15% → Pause (kein Edge bei Trend)
6. **Auto-Stop**: Wenn Combined ≤ Target erreicht, Intervall verlängern (selektiver)

### 3-Phase Flow
1. **Phase 1 ACCUMULATE (T+5s→T+260s):** Adaptive EMA-getimte Käufe
   - Monitor Binance BTCUSDT via WebSocket (real-time, ~100ms updates)
   - EMA-Crossover bestimmt optimalen Kaufzeitpunkt
   - Strict alternation: immer die Seite kaufen die weniger hat (oder abwechseln bei Gleichstand)
   - Nur kaufen wenn projected combined sich verbessert
   - Dynamic intervals: 1.5s-12s basierend auf Abstand zum Target
   - Budget-reserve: max 50% budget auf einer Seite bis andere ≥1 fill hat
   - Safety cap: nie mehr als CHEAP_THRESHOLD pro Seite zahlen
2. **Phase 2 REBALANCE (T+260s):** Short side kaufen mit dynamischem Cap
   - Dynamic cap: breakeven + 3¢ (= 1.00 - avgLongSidePrice + 0.03)
   - Hard safety max: 99¢
3. **Phase 3 MERGE (T+270s):** Merge matched shares → $1.00 per pair

### Key Parameters
- BTC_MOVE_THRESHOLD: 0.0005 (0.05% EMA-Crossover für Buy-Signal)
- CHEAP_THRESHOLD: 0.55 (safety cap — nie mehr als 55¢ pro Seite)
- TARGET_COMBINED_CENTS: 97 (aufhören wenn combined ≤ 97¢)
- SIGNAL_CHECK_INTERVAL_MS: 500 (EMA-Update alle 500ms)
- BUDGET_RESERVE_PCT: 0.50 (max 50% budget auf einer Seite bis andere ≥1 fill)
- REBALANCE_MAX_PRICE: 0.99 (hard safety cap für Rebalance)
- EQUITY_PER_WINDOW: 30% (conservative start, scale up later)
- MAX_ORDERS_PER_WINDOW: 30
- MERGE_MIN_SIZE: 10 shares
- STOP_BUYING_BEFORE_END_S: 40
- MAX_CHUNK_SIZE: 200 shares
- SLIPPAGE_BUFFER: 0.02 (+2¢ over ask for FOK)

### Architecture
- `src/execution/signal-taker-executor.ts` — V7 Core: adaptive EMA-based accumulation
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
