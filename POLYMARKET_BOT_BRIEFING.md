# POLYMARKET 5-MIN BTC PREDICTION BOT — COMPLETE BRIEFING

## Project codename: "PurpleDeer Clone"

---

## 1. EXECUTIVE SUMMARY

Build an automated trading bot that trades Polymarket's "Bitcoin Up or Down" 5-minute prediction markets. The strategy is reverse-engineered from a consistently profitable trader ("purpledeer") who has made $27,000+ since February 2026 with an extremely stable equity curve and minimal drawdown.

The bot exploits a **temporal pricing arbitrage**: Polymarket's Up/Down odds lag behind the real BTC price by seconds to tens of seconds. By reading faster price feeds (Binance via Polymarket's own RTDS) and comparing them to the current market odds, the bot identifies and buys underpriced sides.

---

## 2. HOW POLYMARKET 5-MIN BTC MARKETS WORK

### Market mechanics
- A new "Bitcoin Up or Down" market opens every 5 minutes (e.g., 2:00PM-2:05PM ET, 2:05PM-2:10PM ET)
- At market open, a **"Price to Beat"** is set = BTC/USD price at the start of the window (via Chainlink oracle)
- If BTC price at window end >= Price to Beat → "Up" wins (shares redeem at $1.00)
- If BTC price at window end < Price to Beat → "Down" wins (shares redeem at $1.00)
- Losing shares redeem at $0.00
- Users buy Up or Down shares priced 0-100¢ ($0.00-$1.00 USDC)
- Price reflects implied probability (e.g., Up at 65¢ = market thinks 65% chance BTC goes up)

### Settlement source
- **Chainlink BTC/USD data stream**: `https://data.chain.link/streams/btc-usd`
- This is the ONLY source that matters for resolution
- Chainlink updates every ~10-30 seconds or on 0.5% price deviation
- Settlement uses the Chainlink snapshot at the EXACT window end timestamp

### Blockchain
- All trades happen on **Polygon** (fast, low fees ~$0.01)
- Settlement currency: **USDC**
- Order matching: **CLOB (Central Limit Order Book)** via Polymarket API

---

## 3. THE STRATEGY (Reverse-engineered from purpledeer)

### 3.1 Core concept: Continuous Pricing Arbitrage

The bot does NOT make a single buy decision per window. It makes **4-7 individual $39.60 purchases** spread across the 5-minute window, buying whichever side is currently underpriced relative to the real BTC price.

### 3.2 The edge

Polymarket odds are set by human traders and bots reacting to price movements. There is a **lag** between:
1. BTC price moving on Binance (updates every ~100ms)
2. Chainlink oracle updating (every ~10-30 seconds)
3. Polymarket odds adjusting (depends on traders reacting)

By reading the Binance feed (fastest) and comparing it to the Polymarket odds (slowest), we identify windows where a side is underpriced.

**Example:**
- Window opens, BTC = $80,000, Up = 50¢, Down = 50¢
- 2 minutes in: Binance shows BTC = $80,040 (clearly above opening)
- Polymarket still shows Up = 58¢ (should be ~65¢ based on delta + time remaining)
- Bot buys Up @ 58¢ for $39.60 → gets ~68 shares
- At settlement: Up wins, 68 shares redeem at $1.00 = $68.00
- Profit: $68.00 - $39.60 = $28.40

### 3.3 Execution pattern (from Activity data analysis)

Each 5-minute window, the bot:

1. **Opens with a small position** (~$39.60) on the side that looks favorable based on early BTC price movement
2. **DCA's into the winning side** as the trend becomes clearer, buying additional $39.60 chunks at progressively higher prices (e.g., Up@50¢, Up@62¢, Up@75¢)
3. **Places 1-2 hedges** on the opposite side ($39.60 each) to limit downside if BTC reverses
4. **Scales conviction** via number of buys: 2-3 buys = low conviction, 5-7 buys = high conviction
5. **Holds ALL positions to expiry** — no selling before settlement

### 3.4 Key parameters (proven from 314 closed trades)

| Parameter | Value | Source |
|-----------|-------|--------|
| Base unit per buy | $39.60 USDC | 100% confirmed (63/63 activity buys) |
| Buys per window | 4-7 typical, up to 13 | Activity PDF analysis |
| Straddle ratio | 80% of windows have buys on BOTH sides | Activity PDF |
| Primary:Hedge ratio | ~60-70% primary, 30-40% hedge | Hedge analysis |
| Direction split | 52% Up, 48% Down (no permanent bias) | 314 trades |
| Win rate (all trades) | 64.6% | 314 trades |
| Win rate (single-side windows) | 75.5% | 159 single windows |
| Avg PnL per trade | $9.25 | 314 trades |
| Asset focus | 100% BTC (zero ETH/SOL/XRP) | 314 trades |
| Exit strategy | Hold to expiry, NEVER sell early | Activity (only Buy + Redeem, zero Sells) |
| Entry price sweet spot | 50-80¢ on primary side | Entry price analysis |

### 3.5 Timing rules (FROM ON-CHAIN DATA — 3,420 transactions analyzed)

**CRITICAL CORRECTION**: Earlier analysis suggested he DCA's over 5 minutes. On-chain data proves otherwise: **99.5% of windows have exactly 1 on-chain transaction**. He places ALL orders as a single batch.

| Timing Rule | Evidence (3,420 txs) | Bot Implementation |
|-------------|---------------------|-------------------|
| Buy EARLY, not late | 64% of buys in first 90 seconds, median = 65s | Place batch orders at ~30-90s after window open |
| ONE batch per window | 99.5% of windows = 1 transaction | Single batch of grid limit orders, not sequential DCA |
| Grid orders, not single price | Activity shows multiple prices (23¢-93¢) in same tx | Place 3-7 limit orders at different price levels simultaneously |
| Auto-redeem at ~3:20 | 1,011 txs clustered exactly at 3:20 mark | Schedule redeem call 3:20 after each window settlement |
| Trades ~40-45% of windows | 110 windows/day avg out of 288 possible | Window-skip filter based on BTC movement at entry time |
| 24/7 operation | All hours active (slightly less 13-15 UTC) | No time-of-day filter needed |

**The ACTUAL window lifecycle (corrected):**
```
Min 0:00-0:30 → EVALUATE (read BTC price, compare to opening, check edge)
Min 0:30-1:30 → PLACE BATCH (one call with 3-7 grid limit orders)
                 If no edge detected → SKIP this window entirely
Min 1:30-5:00 → WAIT (all orders placed, nothing to do)
Min 5:00      → SETTLEMENT (Chainlink snapshot determines winner)
Min 5:00+3:20 → AUTO-REDEEM (claim winning shares → USDC back to wallet)
```

**Grid order batch structure** (placed in ONE call):
- Example winning window: Up@55¢×$39.60, Up@65¢×$39.60, Up@80¢×$39.60, Down@35¢×$39.60
- The different prices are NOT different times — they're limit orders at different levels
- Some fill immediately (at market), others may fill if price moves to that level
- Unfilled limit orders expire worthless at settlement

### 3.6 Window skip filter (the "when to trade" decision)

purpledeer trades ~40-45% of available windows (~110/day out of 288).

**Filter logic (to be calibrated in Phase 1):**
1. At ~30s after window opens, read current BTC price vs opening price
2. Calculate `abs(delta)` and current Up/Down market prices
3. If there's an edge (fair value differs from market price by >5¢) → TRADE
4. If BTC is flat and prices are near 50/50 → SKIP
5. Starting estimate: Skip if `abs(delta) < $10-15` AND both sides within 45-55¢

### 3.7 Sizing tiers (Win rate increases with size = good calibration)

| Tier | Size | Trades | Win Rate | PnL |
|------|------|--------|----------|-----|
| 1x | $39.60 | 176 | 57.4% | -$299 |
| 2x | $79.20 | 72 | 68.1% | +$650 |
| 3x | $118.80 | 47 | 76.6% | +$654 |
| 4x | $158.40 | 9 | 88.9% | +$510 |
| 5x+ | $198-237 | 9 | 100% | +$1,668 |

Note: "2x" = 2 individual $39.60 buys on the same side, aggregated in closed view.

---

## 4. DATA SOURCES & APIs

### 4.1 Polymarket RTDS WebSocket (PRIMARY — use this for price data)

Polymarket provides a Real-Time Data Stream that includes BOTH Binance and Chainlink prices. This is the most important data source.

**Connection:** `wss://` (check Polymarket RTDS docs for exact URL)
**Client library:** `https://github.com/Polymarket/real-time-data-client` (TypeScript)

#### Binance feed (fastest BTC price):
```json
{
  "action": "subscribe",
  "subscriptions": [{
    "topic": "crypto_prices",
    "type": "update",
    "filters": "btcusdt"
  }]
}
```
Response: `{ "payload": { "symbol": "btcusdt", "timestamp": 1753314088395, "value": 67234.50 } }`

#### Chainlink feed (settlement price):
```json
{
  "action": "subscribe",
  "subscriptions": [{
    "topic": "crypto_prices_chainlink",
    "type": "*",
    "filters": "{\"symbol\":\"btc/usd\"}"
  }]
}
```
Response: `{ "payload": { "symbol": "btc/usd", "timestamp": 1753314064213, "value": 67230.12 } }`

### 4.2 Polymarket CLOB API (for trading)

- **Docs:** `https://docs.polymarket.com`
- **Order placement:** REST API + Polygon signatures
- **Order book:** WebSocket market channel for real-time bid/ask
- **Market discovery:** Gamma API for finding active 5-min BTC markets

### 4.3 Polymarket Gamma API (for market metadata)

Used to find the currently active 5-minute BTC Up/Down market, its condition IDs, token IDs, and the "Price to Beat" (opening price).

### 4.4 Binance WebSocket DIRECT (PRIMARY — fastest BTC price)

Direct connection to Binance, bypasses Polymarket's relay. ~5-20ms faster than RTDS.

```
// Fastest: Individual trade stream (~100ms updates, no API key needed)
wss://stream.binance.com:9443/ws/btcusdt@trade

// Also useful: 1-second klines (for volatility calculation)
wss://stream.binance.com:9443/ws/btcusdt@kline_1s
```

**Use both Binance direct AND Polymarket RTDS:**
- Binance direct = PRIMARY signal (fastest BTC price available)
- RTDS `crypto_prices` = FALLBACK if direct Binance WS drops
- RTDS `crypto_prices_chainlink` = SETTLEMENT reference (always needed)

Why bother with ~20ms advantage? Over 425 buys/day, being 20ms faster means better fill prices — the difference between getting the ask price or having another bot snipe it first.

### 4.5 Authentication & Wallet Setup

**CRITICAL: Polymarket uses proxy wallets (Magic EOA)**

```env
# Wallet configuration
PRIVATE_KEY=0x...           # Your EOA private key
SIGNATURE_TYPE=1            # 1 = Polymarket proxy wallet (Magic EOA)
                            # 0 = Direct EOA (alternative, requires separate approval flow)
POLYMARKET_API_KEY=...      # From Polymarket developer settings
POLYMARKET_API_SECRET=...   # From Polymarket developer settings
POLYMARKET_PASSPHRASE=...   # From Polymarket developer settings
```

**Proxy wallet flow (SIGNATURE_TYPE=1):**
- Your private key signs orders via Polymarket's Magic proxy system
- Orders are submitted through Polymarket's relayer
- No direct on-chain transactions for order placement (gas-free orders!)
- On-chain transactions only for: deposits, withdrawals, and redemptions

**Setup steps:**
1. Create Polymarket account (browser)
2. Export your Magic EOA private key (from Polymarket account settings or browser)
3. Generate API credentials (Polymarket developer dashboard)
4. Fund your Polymarket account with USDC (deposit via UI or bridge)
5. The bot uses the API credentials + private key to sign/submit orders

---

## 5. BOT ARCHITECTURE

### 5.1 Overview

```
┌─────────────────────────────────────────────────┐
│               DATA LAYER                         │
│                                                   │
│  Binance WebSocket DIRECT (PRIMARY):              │
│  └─ btcusdt@trade (~100ms, fastest BTC price)     │
│                                                   │
│  Polymarket RTDS WebSocket:                       │
│  ├─ crypto_prices (Binance relay, FALLBACK)       │
│  └─ crypto_prices_chainlink (Settlement, ~10-30s) │
│                                                   │
│  Polymarket CLOB WebSocket:                       │
│  └─ Market channel (Up/Down bid/ask realtime)     │
│                                                   │
│  Polymarket Gamma API:                            │
│  └─ Active 5min markets + opening price           │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│              SIGNAL ENGINE                        │
│                                                   │
│  Every second:                                    │
│  1. current_btc = Binance price                   │
│  2. opening_btc = Window opening price            │
│  3. delta = current_btc - opening_btc             │
│  4. time_left = seconds until window end          │
│  5. fair_up = calculate_fair_value(delta, time,   │
│               volatility)                         │
│  6. market_up = current Polymarket Up price       │
│  7. edge = fair_up - market_up                    │
│                                                   │
│  If edge > threshold → BUY underpriced side       │
│  Position sizing via number of $39.60 buys        │
│  Hedge rule: buy opposite side for DD reduction   │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│            EXECUTION LAYER                        │
│                                                   │
│  → Polymarket CLOB API (limit orders)             │
│  → Fixed $39.60 per buy                           │
│  → Hold to expiry (no sells)                      │
│  → Auto-redeem winning shares                     │
└─────────────────────────────────────────────────┘
```

### 5.2 Signal engine: Fair value calculation

The core of the bot. Given:
- `delta` = current BTC price - opening BTC price (from Binance)
- `time_remaining` = seconds until window end (0-300)
- `volatility` = rolling std dev of BTC price changes (from recent Binance ticks)

Calculate the probability that BTC will finish above opening:

**Simple version (start here):**
```
z_score = delta / (volatility * sqrt(time_remaining / 300))
fair_up = normal_cdf(z_score) * 100  // in cents

// time_remaining adjustment: as time decreases, same delta = higher probability
// With 4 minutes left, +$30 might be 55% Up
// With 30 seconds left, +$30 is probably 80% Up
```

**Better version (iterate toward this):**
```
// Use historical 5-min BTC candle data to build an empirical lookup table
// For each (delta_bucket, time_remaining_bucket) → observed win rate
// This accounts for non-normal BTC distributions (fat tails, momentum)
```

### 5.3 Trade decision logic (BATCH — one decision per window)

```pseudocode
on_new_window(opening_price, window_end):
  traded_this_window = false
  
  // Wait ~30-60 seconds for price to develop
  wait_until(window_start + 30_seconds)

evaluate_entry():  // called at ~30-60s into window
  current_btc = get_binance_price()  // from DIRECT Binance WS (fastest)
  chainlink_btc = get_chainlink_price()  // from RTDS (settlement reference)
  opening_btc = get_window_opening_price()
  delta = current_btc - opening_btc
  time_left = window_end - now()
  
  // === SKIP FILTER ===
  fair_up = calculate_fair_value(delta, time_left, volatility)
  market_up = get_polymarket_up_ask()
  market_down = get_polymarket_down_ask()
  
  edge_up = fair_up - market_up
  edge_down = (100 - fair_up) - market_down
  best_edge = max(edge_up, edge_down)
  
  if best_edge < EDGE_THRESHOLD:  // no edge → skip
    log("Skipping window — no edge (best=" + best_edge + "¢)")
    return
  
  // === BUILD GRID ORDER BATCH ===
  orders = []
  primary_side = "Up" if edge_up > edge_down else "Down"
  hedge_side = "Down" if primary_side == "Up" else "Up"
  
  // Primary side: 3-5 orders at different price levels
  primary_levels = get_orderbook_levels(primary_side, num=4)
  for level in primary_levels:
    if level.price <= fair_value_for_side(primary_side) + 5:
      orders.append({side: primary_side, price: level.price, amount: 39.60})
  
  // Hedge side: 1-2 orders at cheap levels
  hedge_levels = get_orderbook_levels(hedge_side, num=2)
  for level in hedge_levels:
    if level.price <= 40:  // only hedge if cheap
      orders.append({side: hedge_side, price: level.price, amount: 39.60})
  
  // Cap total orders
  if len(orders) > MAX_BUYS_PER_WINDOW:
    orders = orders[:MAX_BUYS_PER_WINDOW]
  
  // === PLACE BATCH ===
  if len(orders) > 0:
    place_batch_orders(orders)  // single API call
    traded_this_window = true
    log("Placed " + len(orders) + " orders: " + summarize(orders))

on_window_settle():
  // Schedule redeem ~3:20 after settlement
  schedule(redeem_winning_positions, delay=200_seconds)
  log_results()
  check_daily_loss_limit()
  check_losing_streak()
```

### 5.4 Parameters to configure (and optimize in paper trading)

| Parameter | Starting Value | Range to Test |
|-----------|---------------|---------------|
| `BUY_AMOUNT` | $39.60 | Fixed (matches purpledeer) |
| `EDGE_THRESHOLD` | 5¢ | 3-10¢ |
| `MAX_BUYS_PER_WINDOW` | 7 | 4-10 |
| `MAX_BUYS_PER_SIDE` | 5 | 3-7 |
| `HEDGE_MAX_PRICE` | 40¢ | 30-50¢ (only hedge if cheap) |
| `ENTRY_DELAY_SECONDS` | 30 | 15-90 (wait before placing batch) |
| `REDEEM_DELAY_SECONDS` | 200 | 180-240 (auto-redeem after settlement) |
| `MIN_DELTA_THRESHOLD` | $10 | $5-25 (window skip filter) |
| `VOLATILITY_LOOKBACK` | 300s (5min) | 60-600s |
| `LOSING_STREAK_PAUSE` | 5 consecutive | 3-7 |
| `DAILY_LOSS_LIMIT` | -$500 | -$300 to -$700 |
| `WEEKLY_LOSS_LIMIT` | -$2,000 | -$1,000 to -$3,000 |

---

## 6. TECHNICAL IMPLEMENTATION

### 6.1 Language & Runtime
- **TypeScript/Node.js** — Polymarket provides official TS clients
- Alternative: Python (if preferred, but TS has better Polymarket SDK support)

### 6.2 Key dependencies
- `@polymarket/clob-client` — Official Polymarket trading client
- `@polymarket/real-time-data-client` — RTDS WebSocket client
- `ethers` or `viem` — Polygon wallet interactions
- `ws` — WebSocket connections

### 6.3 Deployment
- **Railway.app** or **VPS** in **US-East** (closest to Polymarket infrastructure)
- Needs persistent WebSocket connections
- Needs a funded Polygon wallet with USDC
- Environment variables: PRIVATE_KEY, POLYMARKET_API_KEY, etc.

### 6.4 Wallet setup
- Generate a Polygon wallet
- Fund with USDC on Polygon
- Approve USDC spending for Polymarket contracts
- Set up Polymarket API credentials (follow their docs)

### 6.5 Critical implementation notes
- **Orders are GAS-FREE with proxy wallet** — using SIGNATURE_TYPE=1 (Magic EOA), order placement goes through Polymarket's relayer, no Polygon gas needed for orders. Gas only for deposits/withdrawals/redemptions.
- **All buys are LIMIT orders** — place at current ask price or 1-2¢ above for faster fill
- **All amounts are EXACTLY $39.60** — purpledeer never deviates, this is the atomic unit
- **Never sell** — only buy and redeem at expiry
- **Redeeming** must be called explicitly via `redeemPositions()` after each window settles. Winning shares → USDC back to wallet. Losing shares → $0 (no action needed).
- **State management**: Track buys per window to avoid over-trading after restarts. Write state to local file after each buy.
- **Error handling**: If a buy fails, retry up to 3 times with 1s delay, then skip
- **Window transitions**: Detect when a new 5-min window opens via Gamma API polling or time-based calculation, then reset all counters
- **Nonce management**: For on-chain txs (redeem), use local nonce counter to avoid stuck transactions

---

## 7. RISK MANAGEMENT

### 7.1 Position limits
- Max exposure per window: 7 × $39.60 = $277.20
- Max daily loss: -$500 circuit breaker (stops trading for the day)
- Max weekly loss: -$2,000 circuit breaker (stops trading for the week)
- Min wallet balance: $500+ USDC to handle losing streaks
- Balance check: Before EVERY buy, verify USDC balance >= $40

### 7.2 Losing streak protection
- After 5 consecutive losing WINDOWS: pause for 30 minutes
- After 10 consecutive: pause for 2 hours
- Send alert (Telegram/Discord webhook) on any pause trigger

### 7.3 Data integrity guards
- **Chainlink stale**: If Chainlink timestamp > 60s old → SKIP window (oracle might be stuck)
- **RTDS disconnect**: If WebSocket drops → STOP all buys immediately, reconnect with exponential backoff, NO orders without live price data
- **Polymarket API error**: Retry order up to 3 times, then skip that buy
- **Nonce management**: Track nonce locally for Polygon transactions, don't rely on `getTransactionCount()` (race conditions)

### 7.4 State persistence
- Save current window state (buys placed, sides, amounts) to a local file every buy
- On bot restart: read state file, determine if current window is still active
- If mid-window: don't re-enter (positions will settle on their own)
- If between windows: resume normally

### 7.5 Gas management
- Polygon gas is cheap (~$0.001-0.01 per tx)
- ~85 windows/day × 7 txs × $0.005 = ~$3/day gas = negligible
- BUT: Monitor gas price, skip window if gas spikes >$0.05/tx

### 7.6 Expected performance (based on purpledeer data)
- Avg PnL per window traded: ~$10-25
- Windows traded per day: ~70-85 (30% of 288 available)
- Expected daily profit: ~$700-$1,500
- Expected max daily drawdown: ~$200-$400
- Monthly target: ~$15,000-$30,000

### 7.7 Risks
- **Oracle changes**: Polymarket could change their oracle or market structure
- **Liquidity drying up**: If too many bots compete, edges shrink
- **Smart contract risk**: Polymarket on Polygon, bugs possible
- **Latency spikes**: Slow connection = missed edges
- **BTC flash crashes**: Extreme volatility = unexpected losses
- **Polymarket downtime**: API/chain outages = stuck positions (but they settle anyway)

---

## 8. DEVELOPMENT PHASES

### Phase 1: Data Collection (1-2 days)
- Connect to Polymarket RTDS WebSocket
- Log Binance prices, Chainlink prices, and Polymarket Up/Down odds every second
- Collect data for 24-48 hours across multiple windows
- Verify: Do we see the pricing lag that creates the edge?

### Phase 2: Backtesting (2-3 days)
- Use collected data to simulate the strategy
- Test different edge thresholds, buy counts, hedge ratios
- Calculate simulated PnL, win rate, max drawdown
- Compare with purpledeer's actual results

### Phase 3: Paper Trading (3-5 days)
- Run the bot live but with SIMULATED orders (no real USDC)
- Log what the bot WOULD have bought and track hypothetical PnL
- Validate signal quality and execution timing
- Fine-tune parameters

### Phase 4: Live Trading - Small (1 week)
- Start with $39.60 per buy (same as purpledeer's base unit)
- Trade 10-20 windows per day (not all)
- Monitor closely, compare with paper trading results
- Fix any execution issues

### Phase 5: Scale Up
- If Phase 4 is profitable, trade every available window
- Consider adding ETH/SOL markets for diversification
- Consider increasing buy size if edge persists

---

## 9. FILE STRUCTURE (suggested)

```
polymarket-bot/
├── src/
│   ├── index.ts              // Main entry point, window lifecycle
│   ├── data/
│   │   ├── binance-ws.ts     // Direct Binance WS (PRIMARY price feed)
│   │   ├── rtds.ts           // RTDS WebSocket (Chainlink + Binance fallback)
│   │   ├── clob.ts           // CLOB WebSocket (orderbook)
│   │   └── gamma.ts          // Gamma API (market discovery)
│   ├── signal/
│   │   ├── fair-value.ts     // Fair value calculation engine
│   │   ├── edge-detector.ts  // Compare fair value vs market price
│   │   ├── window-filter.ts  // Skip/trade decision (volatility filter)
│   │   └── volatility.ts     // Rolling volatility calculator
│   ├── execution/
│   │   ├── order-manager.ts  // Place/track $39.60 buys (SIGNATURE_TYPE=1)
│   │   ├── position-tracker.ts // Track buys per window per side
│   │   └── redeemer.ts       // Auto-redeem winning positions
│   ├── risk/
│   │   ├── limits.ts         // Max buys, daily/weekly loss limit, streak breaker
│   │   └── hedge-logic.ts    // When to hedge opposite side
│   └── utils/
│       ├── logger.ts         // Structured logging
│       ├── config.ts         // Environment variables + parameters
│       ├── state.ts          // State persistence (save/load per window)
│       ├── alerts.ts         // Telegram/Discord webhook alerts
│       └── window-manager.ts // Detect 5-min window transitions + timing phases
├── data/                     // Logged data for analysis
├── .env                      // Secrets (PRIVATE_KEY, API keys, SIGNATURE_TYPE=1)
├── package.json
└── tsconfig.json
```

---

## 10. KEY REFERENCE LINKS

- Binance WebSocket Streams: `wss://stream.binance.com:9443/ws/btcusdt@trade`
- Binance WS API Docs: `https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams`
- Polymarket CLOB Docs: `https://docs.polymarket.com/developers/CLOB/introduction`
- Polymarket RTDS Docs: `https://docs.polymarket.com/developers/RTDS/RTDS-overview`
- Polymarket RTDS Crypto Prices: `https://docs.polymarket.com/developers/RTDS/RTDS-crypto-prices`
- Polymarket Gamma API: `https://docs.polymarket.com/developers/gamma-markets-api/overview`
- RTDS TypeScript Client: `https://github.com/Polymarket/real-time-data-client`
- CLOB TypeScript Client: `https://github.com/Polymarket/clob-client`
- Chainlink BTC/USD Stream: `https://data.chain.link/streams/btc-usd`
- Polymarket 5min BTC Market Page: `https://polymarket.com/crypto/5M`
- Polymarket WebSocket Docs: `https://docs.polymarket.com/developers/CLOB/websocket/wss-overview`

---

## 11. RESOLVED & REMAINING QUESTIONS

### Resolved by on-chain analysis (3,420 transactions):
| Question | Answer | Evidence |
|----------|--------|----------|
| DCA or batch? | **BATCH** — 99.5% of windows = 1 tx | 3,289/3,307 windows = exactly 1 transaction |
| When does he enter? | **EARLY** — median 65s after window open | 64% of buys within first 90 seconds |
| What is the 3:20 spike? | **Auto-redeem** from previous window | 1,011 txs at exactly 3:20, too precise for trading |
| How often does he trade? | **~40-45%** of windows (~110/day) | Daily counts: 83-137 windows |
| Time between buys in batch? | **0-6s** (same block or adjacent) | Median gap = 0s between batch items |
| 24/7 operation? | **Yes** | All 24 hours covered in distribution |

### Remaining questions (resolve in Phase 1-2):
| Question | Confidence | How to resolve |
|----------|-----------|----------------|
| Window skip filter threshold | 60% | Phase 1 data collection |
| Fair value formula calibration | 40% | Phase 2 backtesting with historical BTC data |
| Optimal grid order price levels | 50% | Phase 2 backtesting |
| Exact straddle ratio per window | 70% | Phase 1 observation |

### Wallet address (verified on-chain)
`0x79a67a08cba29ab262025124f4b43ba3e1bb7477`
Primary operator: `0x05c0204a0323f7af21...` (3,420/3,436 transactions)

---

## 12. APPENDIX: PURPLEDEER TRADE DATA SUMMARY

### From 314 closed trades (March 12-14, 2026):
- Total PnL: $2,905
- Win rate: 64.6% (203 wins, 111 losses)
- Avg trade: $9.25 profit
- Best trade: +$432.84 (Down@31.4¢, massive underpricing)
- Worst trade: -$277.20 (wrong side, big size)

### Entry price zones performance:
- <30¢: 15 trades, 13.3% WR → AVOID (lottery tickets)
- 30-50¢: 57 trades, 45.6% WR → CAUTIOUS (early entries)
- 50-65¢: 97 trades, 57.7% WR → GOOD (core DCA zone)
- 65-80¢: 99 trades, 81.8% WR → BEST (sweet spot)
- 80-100¢: 46 trades, 82.6% WR → SAFE but low payout

### Single-trade windows (no straddle):
- 159 windows, 75.5% WR, +$3,503 PnL
- These are high-conviction trades where he sees a clear signal

### Straddle windows (both sides):
- 77 windows, 32.5% net WR, -$598 PnL
- These REDUCE DRAWDOWN even though they cost money
- Max loss per straddle window is limited vs max loss on single-side

---

*This briefing was generated from: 3,420 on-chain transactions with sekundengenaue timestamps (Polygonscan CSV), 314 closed trades (Polymarket Closed PDF), 87 closed trades (scraper CSV), ~63 individual activity buys across 10+ windows (Activity PDF), Polymarket API documentation, Chainlink oracle specifications, and comparison with 4 other profitable traders. The execution mechanics (timing, batch ordering, frequency) are proven from blockchain data with high confidence. The signal logic (fair value calculation, edge threshold) requires calibration through live data collection and paper trading. Start with paper trading before risking real capital.*
