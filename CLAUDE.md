# HolyPoly

Polymarket merge-arb trading bot for BTC 5-minute Up/Down binary markets.

## Strategy: Maker V5 (`STRATEGY_MODE=merge-arb`)

**CRITICAL: Maker fee = 0% on Polymarket crypto markets. Taker fee = 1-1.5%. This IS the edge.**

V5 Maker Strategy (replaces V1-V4 taker approaches):
1. Bot posts **GTC limit BUY orders BELOW the ask** on BOTH Up and Down (= maker, sits in book)
2. Maker fee = **0%** (taker was 1-1.5% which destroyed ALL previous strategies)
3. We **control the prices** → combined bid = upBid + dnBid < 100¢
4. BTC oscillation causes asks to **cross down to our bids** → fills happen
5. If prices move: **cancel + repost** (quote-update loop every 1s)
6. **Merge EINMAL am Ende** (T+260-280s)
7. Maker rebates on top of merge profit

### Kern-Edge
**0% maker fee.** V1-V4 waren TAKER (hitten den Ask) → zahlten 1-1.5% Fee → Combined ≥ 101¢ + Fee = Verlust.
V5 postet Limit-Orders UNTER dem Ask (Maker) → 0% Fee → Combined < 100¢ weil WIR die Preise wählen.

**WARUM V1-V4 (Taker) NICHT funktionierten:**
- Taker hit den Ask → zahlt 1-1.5% Fee
- Up+Down Asks = ~101¢ zu jedem Zeitpunkt
- Combined als Taker: 101¢ + ~1.5¢ Fee = ~102.5¢ → garantierter Verlust
- Kein Oscillation/DCA/Dip-Detection kann das fixen — die Fee frisst den Edge

### Key Parameters
- MAKER_OFFSET_CENTS: 2 (bid 2¢ unter Best Ask pro Seite → maker, nicht taker)
- QUOTE_UPDATE_MS: 1000ms (quotes updaten / fills checken)
- EQUITY_PER_WINDOW: 80%
- MAX_ORDERS_PER_WINDOW: 30
- MERGE_MIN_SIZE: 10 shares
- ENTRY_DELAY: 5s nach Window-Open
- STOP_BUYING_BEFORE_END_S: 40s vor Window-Ende
- MERGE_BEFORE_END_S: 20s vor Window-Ende
- MAX_CHUNK_SIZE: 200 shares
- Fee: **0% (Maker)** — NOT the 1-1.5% taker curve

### Architecture
- `src/execution/merge-arb-executor.ts` — V5 Core: maker quoting loop + final merge
- `src/execution/dry-run-engine.ts` — Maker fill simulation (ask crosses bid = fill, 0% fee)
- `src/data/clob-ws.ts` — CLOB WebSocket (orderbook data, price_change updates asks/bids)
- `src/data/clob.ts` — CLOB REST API (orders, fills, balance, GTC limit orders)
- `src/data/redeem.ts` — CTF merge + redeem via relayer
- `src/data/gamma.ts` — Market discovery (slug-based)
- `src/config.ts` — All configuration parameters
- `src/index.ts` — Main loop (merge-arb / edge / webhook modes)

### DRY_RUN Mode
`DRY_RUN=true` (default) runs the **identical strategy code** but:
- CLOB WebSocket connects normally (no auth needed) → real orderbook data
- WebSocket `price_change` events update full asks[]/bids[] arrays
- Maker bids are virtual; fill simulated when bestAsk ≤ our bid price
- Maker fills: **0% fee** (recorded via `recordMakerFill()`)
- Merges are simulated with correct P&L math
- Virtual balance, positions, and P&L tracked throughout

### Fee Model
**Maker: 0% fee.** This is the entire edge.

Taker fee (for reference, NOT used in V5):
```
fee = shares × price × 0.25 × (price × (1 - price))²
```
Max ~1.56% at 50¢, ~0.2% at extremes.

### WebSocket Notes
- Polymarket CLOB WS requires subscription message immediately after connect
- CLOB WS only connects when `subscribe()` is called with tokens
- Market channel: client sends `PING` every 5s, server responds `PONG`
- No auth required for market channel (orderbook data)
- `price_change` events update individual price levels in asks[]/bids[] arrays
- `best_bid_ask` events update only bestBid/bestAsk (fastest)
- `book` events provide full snapshot (on subscribe)

### Specs
- `HOLYPOLY_V3_DEFINITIVE.md` — V5 strategy specification (DEFINITIV, ersetzt alle vorherigen)
- `HOLYPOLY_STRATEGY_SPEC.md` — Original strategy specification (veraltet)
- `HOLYPOLY_CHANGELOG.md` — Additions & updates
