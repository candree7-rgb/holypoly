# HolyPoly

Polymarket merge-arb trading bot for BTC 5-minute Up/Down binary markets.

## Strategy: Regime-Adaptive V9 (`STRATEGY_MODE=signal-taker`) — AKTIV

### Kern-Insight

BTC-Abstand zum Window-Open-Price bestimmt das **Regime** — und das Regime bestimmt die Buy-Reihenfolge.
Polymarket-Trader sehen nur Orderbook-Preise. Wir sehen den **Live-BTC-Kurs via Binance** und wissen *warum* sich die Preise bewegen. Das ist unser Edge.

### Warum V9 (und nicht V1-V8)

| Version | Problem |
|---------|---------|
| V1-V5 | Kauften Up+Down gleichzeitig → Combined ≈101¢ → Verlust |
| V6 | Signal-basiert, aber keine strikte Alternation → Imbalance |
| V7 | EMA-Timing + Alternation, aber kein Trend-Filter → nackte Verluste bei Trends |
| V8 | Price-Momentum statt EMA, aber: kein Regime-Erkennung, kein Maker, cheapThreshold zu restriktiv |
| **V9** | **Regime-Erkennung + adaptive Buy-Reihenfolge + Observation Phase + Circuit Breaker** |

### Die 3 Regimes

BTC-Abstand vom Window-Open bestimmt das Regime. Gemessen als `|btcNow - btcOpen| / btcOpen`.

#### 1. OSCILLATION (Abstand < 0.03%)
BTC ist nah am Open → beide Seiten ~50¢ → klassisches Auf-und-Ab.
- **Buy-Reihenfolge: Günstigere Seite zuerst**
- Dip kauft Up billig, Bounce kauft Down billig
- Strikte Alternation, Combined sinkt stetig
- Bestes Szenario: 4-8 Oszillationen, Combined 85-92¢

#### 2. TREND (Abstand 0.03% - 0.10%)
BTC hat sich bewegt → eine Seite billig (20-35¢), andere teuer (65-80¢).
- **Buy-Reihenfolge: TEURERE Seite zuerst**
- Warum? Die teure Seite wird NOCH teurer wenn der Trend weitergeht
- Die günstige Seite bleibt günstig (oder wird günstiger) → kein Zeitdruck
- Wenn dann ein Pullback kommt → günstige Seite kaufen → guter Combined
- Beispiel: Down@65¢ kaufen, warten auf Pullback, Up@30¢ kaufen → Combined 95¢

#### 3. SKIP (Abstand > 0.10%)
BTC ist ultra-klar in eine Richtung → kein Edge.
- Eine Seite >80¢, andere <20¢
- Kein Pullback zu erwarten in den verbleibenden Minuten
- **Nicht traden. Window skippen.**

### Observation Phase (NEU in V9)

**Die ersten 15 Sekunden nach Window-Open: nur beobachten, NICHT kaufen.**

Zweck:
1. BTC-Richtung und Amplitude messen
2. Regime bestimmen (Oscillation / Trend / Skip)
3. Erste Reversal abwarten (bestätigt Oszillation)

Wenn nach 15s kein Reversal erkannt → wahrscheinlich Trend → Regime entsprechend setzen.
Wenn nach 15s Abstand >0.10% → Skip.

### Adaptive Buy-Reihenfolge (Kern von V9)

```
Regime erkannt:

OSCILLATION:
  1. Günstigere Seite kaufen (beim Dip)
  2. Strikte Alternation (immer die Seite mit weniger Shares)
  3. Momentum-Timing: kaufe Up wenn BTC fällt, Down wenn BTC steigt

TREND:
  1. Teurere Seite ZUERST kaufen (bevor sie noch teurer wird!)
  2. Dann auf Pullback warten → günstige Seite nachkaufen
  3. Wenn kein Pullback nach 60s → in Richtung Skip wechseln (stoppen)

REGIME-WECHSEL:
  Regime wird alle 10s neu evaluiert. Trend→Oscillation wenn BTC zum Open zurückkehrt.
```

### 4-Phase Flow (V9)

#### Phase 0: OBSERVE (T+0s → T+15s)
- BTC-Preis tracken, Regime bestimmen
- Kein Trading, nur Datensammlung
- Orderbook-Tiefe prüfen (Pre-Flight)

#### Phase 1: ACCUMULATE (T+15s → T+260s)
- Regime-adaptive Käufe (siehe oben)
- Binance BTCUSDT via WebSocket (real-time, ~100ms updates)
- Regime wird alle 10s re-evaluiert (kann wechseln!)
- Strict alternation: immer die Seite kaufen die weniger hat
- Projected Combined Check: nur kaufen wenn es Combined verbessert
- Dynamic intervals: 1.5s-12s basierend auf Abstand zum Target
- Budget-reserve: max 50% budget auf einer Seite bis andere ≥1 fill hat
- **Circuit Breaker: Stopp wenn combined >102¢ nach 5+ Fills** (NEU)
- Safety cap: nie mehr als CHEAP_THRESHOLD pro Seite zahlen

#### Phase 2: REBALANCE (T+260s)
- Short side kaufen mit dynamischem Cap
- Dynamic cap: breakeven + 3¢ (= 1.00 - avgLongSidePrice + 0.03)
- Hard safety max: 99¢
- Emergency retry nach 1.5s wenn erster Versuch scheitert
- Wenn Ask > Cap → **naked lassen** (besser 50/50 Gamble als garantierter Verlust)

#### Phase 3: MERGE (T+270s)
- Merge matched shares → $1.00 per pair
- Exponential backoff retries (1s, 2s, 4s, 8s)
- Profit = $1.00 × matched - (costUp + costDn)

### Safety Guards

| Guard | Beschreibung | V8→V9 Änderung |
|-------|-------------|-----------------|
| Cheap Threshold | Max 55¢ pro Seite | Gleich |
| Imbalance Guard | Max Ratio zwischen Seiten | **3:1 → 2:1** (strenger) |
| Budget Reserve | Max 50% auf eine Seite bis andere ≥1 Fill | Gleich |
| Projected Combined | Nur kaufen wenn Combined sich verbessert | Gleich |
| Circuit Breaker | Stopp bei combined >102¢ nach 5+ Fills | **NEU** |
| Observation Phase | 15s warten vor erstem Kauf | **NEU** |
| Trend-Skip | Window skippen bei BTC >0.10% vom Open | **NEU** |
| Dynamic Cap Rebal. | breakeven + 3¢, max 99¢ | Gleich |
| Stop Buying Timer | 40s vor Window-Ende aufhören | Gleich |

### Key Parameters

```
# Regime Detection (NEU V9)
OBSERVATION_PERIOD_S: 15        # Sekunden beobachten vor erstem Kauf
OSCILLATION_THRESHOLD: 0.0003   # <0.03% vom Open → Oscillation
TREND_THRESHOLD: 0.001          # >0.10% vom Open → Skip
REGIME_REEVAL_S: 10             # Regime alle 10s re-evaluieren

# Momentum / Timing
BTC_MOVE_THRESHOLD: 0.0005      # 0.05% Reversal für Buy-Signal
SIGNAL_CHECK_INTERVAL_MS: 500   # Check alle 500ms
REVERSAL_THRESHOLD: 0.00015     # 0.015% von rolling extreme

# Risk / Caps
CHEAP_THRESHOLD: 0.55           # safety cap — nie mehr als 55¢ pro Seite
TARGET_COMBINED_CENTS: 97       # aufhören wenn combined ≤ 97¢
CIRCUIT_BREAKER_CENTS: 102      # NEU: stopp wenn combined > 102¢
MAX_IMBALANCE_RATIO: 2          # NEU: war 3, jetzt strenger
BUDGET_RESERVE_PCT: 0.50        # max 50% budget auf einer Seite

# Sizing
EQUITY_PER_WINDOW: 0.30         # 30% des Balances pro Window
MAX_ORDERS_PER_WINDOW: 30
MAX_CHUNK_SIZE: 200
MERGE_MIN_SIZE: 10

# Timing
STOP_BUYING_BEFORE_END_S: 40
SLIPPAGE_BUFFER: 0.02           # +2¢ over ask for FOK

# Rebalance
REBALANCE_MAX_PRICE: 0.99       # hard safety cap
REBALANCE_OVERPAY: 0.03         # max 3¢ over breakeven
```

### Erwarteter EV (realistisch)

| Window-Typ | Häufigkeit | Erwarteter P&L |
|------------|-----------|----------------|
| Gute Oszillation (6+ Reversals) | 15% | +$10-15 |
| Mittlere Oszillation (3-4 Reversals) | 25% | +$2-5 |
| Trend + Recovery | 20% | +$1-3 |
| Geskippt (Trend/Skip/Low-Liq) | 30% | $0 |
| Schlechter Trend (naked) | 8% | -$15-25 |
| Worst Case (starker Trend) | 2% | -$50-75 |

**Gewichteter EV: ~$0.50-0.80 pro Window → $30-80/Tag auf $500 Balance**

### Zukünftige Verbesserungen (nicht in V9)

1. **Maker Orders (Limit + FOK Fallback):** Erste Seite als GTC Limit posten (0% Fee), nach 1.5s cancel → FOK. Spart 1-1.5% auf ~50% der Fills → **+20-40% EV**.
2. **Kleinere Chunks für besseres Averaging:** Mehr Fills = bessere Minima-Erfassung
3. **Volatilitäts-Filter:** Nur traden wenn implizierte Vol hoch genug für Oszillation

### Architecture

```
src/
├── execution/
│   ├── signal-taker-executor.ts  — V9 Core: regime-adaptive accumulation
│   ├── merge-arb-executor.ts     — V5 (legacy): 3-phase maker strategy
│   └── dry-run-engine.ts         — FOK fill simulation gegen live orderbook
├── data/
│   ├── binance-ws.ts             — Binance BTCUSDT WebSocket (real-time BTC price)
│   ├── clob-ws.ts                — CLOB WebSocket (orderbook data, price_change)
│   ├── clob.ts                   — CLOB REST API (orders, fills, balance)
│   ├── redeem.ts                 — CTF merge + redeem via relayer
│   └── gamma.ts                  — Market discovery (slug-based)
├── config.ts                     — All configuration parameters
├── index.ts                      — Main loop (signal-taker / merge-arb / edge / webhook)
├── types.ts                      — Type definitions
├── utils.ts                      — Fee calculations, sleep, etc.
├── logger.ts / telegram.ts       — Logging & notifications
└── db.ts                         — PostgreSQL persistence
```

### DRY_RUN Mode

`DRY_RUN=true` (default) runs **identical strategy code** but:
- Binance WebSocket connects normally → real BTC price data
- CLOB WebSocket connects normally → real orderbook data
- FOK buys simulated gegen live orderbook depth
- Taker fees applied via Polymarket crypto fee curve
- Merges simulated mit correct P&L math
- Virtual balance, positions, und P&L tracked throughout

### Fee Model

```
fee = shares × price × 0.25 × (price × (1 - price))²
```

| Preis | Effektive Fee |
|-------|--------------|
| 25¢ | ~0.88% |
| 35¢ | ~1.29% |
| 40¢ | ~1.44% |
| 50¢ | ~1.56% (Max) |

### WebSocket Notes

- **Binance:** `wss://stream.binance.com:9443/ws/btcusdt@trade` — no auth, ~100ms updates
- **CLOB WS:** Requires subscription message after connect, `subscribe()` with token IDs
- **CLOB WS Events:** `book` (full snapshot), `price_change` (level updates), `best_bid_ask` (fastest)
- **Keepalive:** Client sends `PING` every 5s, server responds `PONG`
- No auth required for market channel (orderbook data)

### Legacy Docs

Alte Strategy-Specs sind im `docs/` Ordner archiviert:
- `docs/HOLYPOLY_V3_DEFINITIVE.md` — V5 Maker strategy spec
- `docs/HOLYPOLY_STRATEGY_SPEC.md` — Original spec mit Stargate5-Analyse
- `docs/HOLYPOLY_CHANGELOG.md` — Historische Änderungen
- `docs/plan.md` — Ursprünglicher Implementierungsplan
