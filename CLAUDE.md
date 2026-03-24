# HolyPoly

Polymarket merge-arb trading bot for BTC 5-minute Up/Down binary markets.

## Strategy: Regime-Adaptive V9 (`STRATEGY_MODE=signal-taker`) — FINAL

### Kern-Insight

BTC-Abstand zum Window-Open-Price bestimmt das **Regime** — und das Regime bestimmt die Buy-Reihenfolge.
Polymarket-Trader sehen nur Orderbook-Preise. Wir sehen den **Live-BTC-Kurs via Binance** und wissen *warum* sich die Preise bewegen. Das ist unser Edge.

**Das ist KEINE simultane Orderbook-Arbitrage.** Wir finden KEIN fertiges Paar unter 100¢ im Buch.
Das ist **Dynamic Oscillation-Based Pair Construction** — zeitversetzt, abwechselnd, durch Mikro-Volatilität ein günstiges Paar KONSTRUIEREN, sodass der gewichtete Combined-Durchschnitt unter 100¢ liegt.

### Warum V9 (und nicht V1-V8)

| Version | Problem |
|---------|---------|
| V1-V5 | Kauften Up+Down gleichzeitig → Combined ≈101¢ → Verlust |
| V6 | Signal-basiert, aber keine strikte Alternation → Imbalance |
| V7 | EMA-Timing + Alternation, aber kein Trend-Filter → nackte Verluste bei Trends |
| V8 | Price-Momentum statt EMA, aber: kein Regime-Erkennung, kein Maker, cheapThreshold zu restriktiv |
| **V9** | **Regime-Erkennung + Maker/Limit Orders + adaptive Buy-Reihenfolge + Observation Phase + Circuit Breaker** |

---

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

---

### Order Execution: Limit-First + FOK Fallback

**Jeder Kauf folgt dem Limit-First Prinzip:**

```
1. GTC Limit Order posten bei bestAsk - MAKER_OFFSET (z.B. 1-2¢ unter Ask)
   → 0% Maker Fee!
2. Warten bis zu MAKER_TIMEOUT_MS (1500ms)
3. Wenn gefüllt → perfekt, 0% Fee, bester Preis
4. Wenn nicht gefüllt → Cancel, sofort FOK bei bestAsk + SLIPPAGE_BUFFER
   → Taker Fee (~0.3-1.5%), aber guaranteed fill
```

**Warum Limit-First kritisch ist:**
- Spart 1-1.5% Fee auf ~40-60% der Fills
- Bei 50¢ Preis: 1.56% Fee gespart = 0.78¢ pro Share
- Über 100 Shares pro Window: **$0.78 gespart pro Window nur durch Fee-Reduktion**
- Hochgerechnet: **+20-40% EV** vs. reines FOK

**Wann Limit funktioniert vs. FOK nötig ist:**
- Limit funktioniert gut bei: stabiler Preis, genug Tiefe, keine schnelle Bewegung
- FOK nötig bei: schnelle Preisbewegung, Rebalance (Zeitdruck), dünnes Buch
- Regel: **Erster Leg immer Limit versuchen. Zweiter Leg / Balancing: Limit wenn möglich, FOK wenn nötig.**

**Kein Leg 2 ohne Leg 1 Fill:**
- Wir kaufen die zweite Seite NUR wenn die erste Seite tatsächlich gefüllt wurde
- Kein Fill auf Seite 1 → kein Kauf auf Seite 2 → kein Risiko

---

### Observation Phase

**Die ersten 15 Sekunden nach Window-Open: nur beobachten, NICHT kaufen.**

Zweck:
1. BTC-Richtung und Amplitude messen
2. Regime bestimmen (Oscillation / Trend / Skip)
3. Erste Reversal abwarten (bestätigt Oszillation)
4. Orderbook-Qualität prüfen (Tiefe, Spread, Refill-Verhalten)

Wenn nach 15s kein Reversal erkannt → wahrscheinlich Trend → Regime entsprechend setzen.
Wenn nach 15s Abstand >0.10% → Skip.

---

### Adaptive Buy-Reihenfolge (Kern von V9)

```
Regime erkannt:

OSCILLATION:
  1. Günstigere Seite kaufen (beim Dip) — per LIMIT
  2. Erst wenn Leg 1 gefüllt → Gegenseite kaufen (Limit, FOK Fallback)
  3. Strikte Alternation (immer die Seite mit weniger Shares)
  4. Momentum-Timing: kaufe Up wenn BTC fällt, Down wenn BTC steigt

TREND:
  1. Teurere Seite ZUERST kaufen (bevor sie noch teurer wird!) — per LIMIT
  2. Erst wenn gefüllt → auf Pullback warten → günstige Seite nachkaufen
  3. Wenn kein Pullback nach 60s → in Richtung Skip wechseln (stoppen)

REGIME-WECHSEL:
  Regime wird alle 10s neu evaluiert. Trend→Oscillation wenn BTC zum Open zurückkehrt.
```

---

### 4-Phase Flow (V9)

#### Phase 0: OBSERVE (T+0s → T+15s)
- BTC-Preis tracken, Regime bestimmen
- Kein Trading, nur Datensammlung
- Orderbook-Tiefe und Spread prüfen (Pre-Flight)
- Refill-Verhalten beobachten (füllt sich das Buch nach?)

#### Phase 1: ACCUMULATE (T+15s → T+260s)
- Regime-adaptive Käufe (siehe oben)
- **Limit-First + FOK Fallback** auf jedem Kauf
- Binance BTCUSDT via WebSocket (real-time, ~100ms updates)
- Regime wird alle 10s re-evaluiert (kann wechseln!)
- Strict alternation: immer die Seite kaufen die weniger hat
- Kein Leg 2 ohne Leg 1 Fill
- Projected Combined Check: nur kaufen wenn es Combined verbessert
- Dynamic intervals: 1.5s-12s basierend auf Abstand zum Target
- Budget-reserve: max 50% budget auf einer Seite bis andere ≥1 fill hat
- **Circuit Breaker: Stopp wenn combined >102¢ nach 5+ Fills**
- Safety cap: nie mehr als CHEAP_THRESHOLD pro Seite zahlen
- **Incremental Sizing:** Erste Probe-Orders klein, erst bei bestätigter Oszillation hochskalieren

#### Phase 2: REBALANCE (T+260s)
- Short side kaufen mit dynamischem Cap — **FOK hier, kein Limit (Zeitdruck!)**
- Dynamic cap: breakeven + 3¢ (= 1.00 - avgLongSidePrice + 0.03)
- Hard safety max: 99¢
- Emergency retry nach 1.5s wenn erster Versuch scheitert
- Wenn Ask > Cap → **naked lassen** (besser 50/50 Gamble als garantierter Verlust)

#### Phase 3: MERGE (T+270s)
- Merge matched shares → $1.00 per pair
- Exponential backoff retries (1s, 2s, 4s, 8s)
- Profit = $1.00 × matched - (costUp + costDn)

---

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
| No-Leg-2-Without-Leg-1 | Gegenseite NUR kaufen wenn erste Seite gefüllt | **NEU** |
| Max Naked Duration | Max 30s ungehedged auf einer Seite | **NEU** |
| Dynamic Cap Rebal. | breakeven + 3¢, max 99¢ | Gleich |
| Stop Buying Timer | 40s vor Window-Ende aufhören | Gleich |

---

### DO NOT TRADE Bedingungen

**Nur harte Ausschlüsse — wir wollen ~85-90% der Windows traden!**

Window wird geskippt NUR wenn:

1. **Ultra-starker Trend:** BTC >0.10% vom Open nach 15s Observation → Skip
2. **Leeres Orderbook:** Weniger als 3 Ask-Levels auf einer Seite → kein Handel möglich
3. **Combined driftet hoch:** Combined >102¢ nach 5+ Fills → Circuit Breaker → sofort stoppen

**Weiche Signale (kein Skip, aber Vorsicht):**
- Breiter Spread (>5¢): Kleinere Chunks, nicht skippen
- Kein Refill nach Fill: Vorsichtiger weiter, nicht skippen
- Trend (0.03-0.10%): Teurere Seite zuerst, NICHT skippen
- Wenig Oszillation: Probing Phase klein halten, abwarten

---

### Oszillationsqualität vs. reine Volatilität

**Nicht jede Volatilität hilft.** Wir brauchen **zweiseitiges Repricing**, nicht einseitigen Momentum.

Gute Oszillation:
- BTC pendelt um Open-Preis → beide Seiten werden abwechselnd günstig
- Mehrere Reversals pro Minute → viele Kaufgelegenheiten
- Beide Seiten des Orderbuchs werden aktiv gehandelt

Schlechte Volatilität:
- BTC bewegt sich stark in EINE Richtung → nur eine Seite wird günstig
- Hohe Volatilität aber keine Reversals → Trend, nicht Oszillation
- Eine Seite des Orderbuchs trocknet aus (MMs ziehen sich zurück)

**Messung:** Anzahl der Richtungswechsel (Reversals >0.015%) in der Observation Phase.
- 0-1 Reversals in 15s → wahrscheinlich Trend → vorsichtig oder Skip
- 2+ Reversals in 15s → gute Oszillation → aggressiv accumulieren

---

### Orderbook-Tiefe und Fillability

**Angezeigte Preise ≠ executable Preise.** Was zählt:

1. **Depth at Best Ask:** Mindestens 50 Shares bei bestAsk, sonst Chunk verkleinern
2. **Levels:** Mindestens 3 Ask-Levels pro Seite
3. **Spread:** bestAsk - bestBid < 5¢ (sonst zu teuer)
4. **Refill-Verhalten:** Nach einem Fill — kommt neues Volumen nach?
   - Gutes Zeichen: Neues Level innerhalb von 1-2s nach Fill
   - Schlechtes Zeichen: Buch bleibt leer → MMs abwesend → gefährlich
5. **Chunk-Sizing:** Nie mehr als 50% der angezeigten Tiefe pro Order kaufen

---

### Naked Exposure Management

**Nackte Positionen sind das größte Risiko. Strikte Regeln:**

1. **Max Naked Duration:** Wenn eine Seite >30s ohne Gegenseite ist → aggressive FOK auf Gegenseite
2. **Max Imbalance Ratio:** 2:1 hart. Bei 2:1 → sofort Gegenseite kaufen (auch FOK)
3. **Budget Reserve:** Max 50% Budget auf einer Seite bis andere ≥1 Fill hat
4. **Emergency Hedge:** Wenn Regime zu Skip wechselt und Position offen → sofort FOK Rebalance
5. **Lieber klein nackt als groß nackt:** Erste Orders klein halten (Incremental Sizing)

**Controlled Imbalance Bands:**
- 1:1 bis 1.5:1 → normal, kein Eingriff
- 1.5:1 bis 2:1 → Warnung, nächster Kauf MUSS Gegenseite sein
- >2:1 → SOFORT Gegenseite kaufen (FOK, höheres Slippage-Budget)
- Temporäre Imbalance OK wenn Regime = Oscillation (Reversal kommt)
- Temporäre Imbalance NICHT OK wenn Regime = Trend (kann sich verschlimmern)

---

### Incremental Sizing

**Nicht sofort All-In. Langsam hochskalieren:**

```
Phase 1a (T+15s → T+45s): PROBING
  - Chunk = 25% des normalen Chunk-Size
  - Maximal 2-3 kleine Orders
  - Zweck: Oszillation bestätigen, Fillability testen

Phase 1b (T+45s → T+260s): FULL ACCUMULATION
  - Chunk = voller Chunk-Size
  - Aggressives Accumulating wenn Oszillation bestätigt
  - Regime wird weiterhin alle 10s re-evaluiert
```

Warum: Wenn die ersten kleinen Orders Probleme zeigen (keine Fills, kein Refill, einseitig), können wir früh abbrechen mit minimalem Verlust.

---

### Reversal-Erkennung: Oszillation vs. Trend

**Der kritische Indikator: Wann kommt eine Gegenbewegung?**

```
Rolling Window (letzte 4s = 8 Samples bei 500ms):
  - rollingHigh = max(priceHistory)
  - rollingLow = min(priceHistory)
  - dipFromHigh = (rollingHigh - btcNow) / rollingHigh
  - bounceFromLow = (btcNow - rollingLow) / rollingLow

Reversal erkannt wenn:
  - dipFromHigh > 0.015% (BTC fällt von Recent High → Down wird billiger)
  - bounceFromLow > 0.015% (BTC steigt von Recent Low → Up wird billiger)

Trend erkannt wenn:
  - Kein Reversal seit >30s
  - BTC bewegt sich monoton in eine Richtung
  - |btcNow - btcOpen| / btcOpen steigt kontinuierlich

Schwelle für Re-Oszillation (Trend→Oscillation):
  - BTC kehrt zurück Richtung Open (Abstand sinkt unter 0.03%)
  - Oder: erste Reversal nach längerem Trend
```

---

### Remaining Time Effects

**Zeit bis Resolution beeinflusst alles:**

| Verbleibende Zeit | Effekt |
|---|---|
| >4 min | Viel Oszillation möglich, ideal für Pair-Building |
| 3-4 min | Noch gut, aber weniger Chancen für Averaging |
| 2-3 min | Hauptsächlich Rebalancing, kaum neue Pairs |
| 1-2 min | Nur Emergency Hedge, kein neues Accumulating |
| <1 min | MMs ziehen Quotes, Spreads explodieren, NICHT traden |
| <40s | STOP_BUYING_BEFORE_END_S → Phase 2 Rebalance beginnt |

---

### Key Parameters

```
# Regime Detection
OBSERVATION_PERIOD_S: 15        # Sekunden beobachten vor erstem Kauf
OSCILLATION_THRESHOLD: 0.0003   # <0.03% vom Open → Oscillation
TREND_THRESHOLD: 0.001          # >0.10% vom Open → Skip
REGIME_REEVAL_S: 10             # Regime alle 10s re-evaluieren

# Maker / Limit Orders
MAKER_OFFSET_CENTS: 2           # Limit-Preis = bestAsk - 2¢
MAKER_TIMEOUT_MS: 1500          # Max 1.5s warten auf Limit Fill
MAKER_FEE_RATE: 0.00            # 0% Maker Fee auf Polymarket

# Momentum / Timing
BTC_MOVE_THRESHOLD: 0.0005      # 0.05% Reversal für Buy-Signal
SIGNAL_CHECK_INTERVAL_MS: 500   # Check alle 500ms
REVERSAL_THRESHOLD: 0.00015     # 0.015% von rolling extreme

# Risk / Caps
CHEAP_THRESHOLD: 0.55           # safety cap — nie mehr als 55¢ pro Seite
TARGET_COMBINED_CENTS: 97       # aufhören wenn combined ≤ 97¢
CIRCUIT_BREAKER_CENTS: 102      # stopp wenn combined > 102¢
MAX_IMBALANCE_RATIO: 2          # max 2:1 zwischen Seiten
BUDGET_RESERVE_PCT: 0.50        # max 50% budget auf einer Seite
MAX_NAKED_DURATION_S: 30        # max 30s ohne Gegenseite
MAX_SPREAD_CENTS: 5             # skip wenn Spread > 5¢

# Sizing
EQUITY_PER_WINDOW: 0.30         # 30% des Balances pro Window
MAX_ORDERS_PER_WINDOW: 30
MAX_CHUNK_SIZE: 200
MERGE_MIN_SIZE: 10
PROBE_CHUNK_PCT: 0.25           # 25% Chunk-Size in Probing-Phase
PROBE_PHASE_END_S: 30           # Probing-Phase endet 30s nach Start

# Timing
STOP_BUYING_BEFORE_END_S: 40
SLIPPAGE_BUFFER: 0.02           # +2¢ over ask for FOK fallback

# Rebalance
REBALANCE_MAX_PRICE: 0.99       # hard safety cap
REBALANCE_OVERPAY: 0.03         # max 3¢ over breakeven
```

---

### Erwarteter EV (realistisch)

**Mit Maker Orders (V9):**

| Window-Typ | Häufigkeit | Erwarteter P&L |
|------------|-----------|----------------|
| Gute Oszillation (6+ Reversals) | 20% | +$12-18 |
| Mittlere Oszillation (3-4 Reversals) | 30% | +$3-7 |
| Trend + Recovery (teurere zuerst) | 25% | +$1-3 |
| Trend vorsichtig (kleine Probes) | 10% | -$1-3 |
| Geskippt (ultra-Trend/leeres Buch) | 10% | $0 |
| Schlechter Trend (naked) | 4% | -$15-25 |
| Worst Case (starker Trend) | 1% | -$50-75 |

**~90% Participation Rate.** Nur ultra-klare Trends und leere Bücher werden geskippt.
**Gewichteter EV: ~$1.00-1.50 pro Window → $60-120/Tag auf $500 Balance**

Fee-Einsparung durch Maker: ~40-60% der Fills als Maker (0% Fee) statt Taker (~1.3% Fee).
Das sind ~0.5-1.0¢ gespart pro Share → bei 100+ Shares/Window: **$0.50-1.00 extra pro Window**.

---

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
- Limit orders simulated (fill wenn ask ≤ limit price innerhalb timeout)
- FOK buys simulated gegen live orderbook depth
- Taker fees applied via Polymarket crypto fee curve (Maker = 0%)
- Merges simulated mit correct P&L math
- Virtual balance, positions, und P&L tracked throughout

### Fee Model

```
Taker: fee = shares × price × 0.25 × (price × (1 - price))²
Maker: fee = 0 (0% auf Polymarket)
```

| Preis | Taker Fee | Maker Fee |
|-------|-----------|-----------|
| 25¢ | ~0.88% | **0%** |
| 35¢ | ~1.29% | **0%** |
| 40¢ | ~1.44% | **0%** |
| 50¢ | ~1.56% (Max) | **0%** |

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
