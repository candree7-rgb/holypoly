# HolyPoly

Polymarket two-sided inventory engine for BTC Up/Down binary markets (5m + 15m).

## Strategy: V11 Inventory Engine (`STRATEGY_MODE=signal-taker`)

**Source of Truth:** `docs/new_strategy.md` + `docs/executor_spec.md`

### Was ist das?

Ein **schneller, zweiseitiger, merge-zentrierter Inventory-Engine** nach dem Stargate-Modell:
- Kauft beide Seiten (Up + Down) **schnell abwechselnd** in vielen kleinen Fills
- Nutzt BTC-Regime (Oszillation/Trend) um die **erste Seite** zu bestimmen
- Hält Inventory **nah an Balance** (strikte Alternation)
- **Merged** gepaarte Shares zurück in Collateral (Capital Recycling)
- Operiert auf **BTC 5-Minuten und 15-Minuten** Märkten (auto-detect)

**Das ist NICHT:**
- Statische "beide Seiten unter 100¢ gleichzeitig kaufen" Arbitrage
- Immer-günstiger-zuerst Strategie
- Einmal-Kauf + Einmal-Hedge Vereinfachung
- Directional Trading mit spätem Hedge

---

### Kern-Architektur: 7-State Inventory State Machine

```
FLAT → FIRST_LEG_ACQUIRED → BALANCING → NEAR_BALANCED → MERGE_READY
                                                              ↓
                                                        (mid-window merge → capital recycled → FLAT)

Jederzeit → DEFENSIVE_REBALANCE  (Unpaired zu lange, Qualität sinkt)
Jederzeit → STOP_BUILD           (Zeit abgelaufen, TOXIC Qualität)
```

**State-Regeln:**
| State | Darf Long-Side kaufen? | Muss Short-Side priorisieren? | Darf Mergen? |
|---|---|---|---|
| FLAT | Ja | Nein | Nein |
| FIRST_LEG_ACQUIRED | **Nein** | **Ja** | Nein |
| BALANCING | **Nein** | **Ja** | Nein |
| NEAR_BALANCED | Ja | Nein | Ja |
| MERGE_READY | Ja | Nein | **Ja** |
| DEFENSIVE_REBALANCE | **Nein** | **Ja** | Ja |
| STOP_BUILD | **Nein** | Ja | Ja |

---

### 3 Regimes

BTC-Abstand vom Window-Open: `|btcNow - btcOpen| / btcOpen`

| Regime | Bedingung | Erste Seite | Verhalten |
|---|---|---|---|
| OSCILLATION | < 0.03% | Günstigere zuerst | Schnelle Alternation, viele Mikro-Fills |
| TREND | 0.03% - 0.10% | **Teurere zuerst** | Teure Seite sichern, auf Pullback warten |
| SKIP | > 0.10% | — | Window überspringen |

---

### 5 Pair Quality Bands

| Band | Combined | Verhalten |
|---|---|---|
| IDEAL | < 94¢ | Aggressiv weiter accumulieren |
| GOOD | < 97¢ | Normal accumulieren, merge erlaubt |
| ACCEPTABLE | < 100¢ | Merge erlaubt, weiter wenn Window gut |
| DEFENSIVE | < 103¢ | Halbe Chunk-Größe, nur noch hedgen |
| TOXIC | ≥ 103¢ | STOP_BUILD — keine weitere Accumulation |

**Sub-100¢ ist ideal, aber nicht mandatory.** Leicht über 100¢ ist akzeptabel wenn es schlimmere Inventory-Outcomes verhindert.

---

### Order Execution: Limit-First + FOK Fallback

**Jeder Kauf in der Accumulation-Phase:**
1. GTC Limit Order bei `bestAsk - 1¢` (inside spread)
2. Warten bis 1.5s, alle 200ms Fill checken
3. Wenn gefüllt → **0% Maker Fee**, besserer Preis
4. Wenn nicht gefüllt → Cancel → sofort FOK bei `bestAsk + 2¢ slippage`

**Rebalance-Phase:** Nur FOK (Zeitdruck, kein Limit-Warten).

**Warum Limit-First kritisch ist:**
- 0% Maker Fee vs. ~1.5% Taker Fee
- 1¢ besserer Preis pro Fill × 60 Fills = signifikant besserer Combined
- Bei 40-60% Maker-Rate: **$2-3 Fee-Einsparung pro Window**

---

### Execution Flow

#### Phase 0: OBSERVE
- **5m:** 15s | **15m:** 25s
- BTC-Preis + Orderbook beobachten
- Regime klassifizieren (Oscillation / Trend / Skip)
- Hedge-Feasibility prüfen (Tiefe, Spread, Refill-Score)
- Opposite-Side Executability prüfen

#### Phase 1: ACCUMULATE (State-Machine-driven)
- **Micro-Fills:** 0.8-4s Intervals, target 30-60+ Fills pro Window
- **Limit-First** auf jedem Kauf (0% Maker Fee)
- Strikte Alternation: immer die Seite mit weniger Shares
- State Machine steuert: wer darf kaufen, wer wird blockiert
- Momentum-Timing: Up kaufen wenn BTC fällt, Down wenn BTC steigt
- **Mid-Window Merge:** Bei MERGE_READY + GOOD+ Qualität + genug Zeit → merge + capital recyclen
- Probing Phase: erste 30s kleinere Chunks (25%), dann volle Größe
- **Paired Quality Trailing:** Schützt gewonnene Pair-Qualität vor Verschlechterung
- **Pre-Entry Combined Check:** Skip wenn combined > 106¢ (unheidgeable)

#### Phase 2: REBALANCE
- Short Side kaufen mit Dynamic Cap (breakeven + 3¢)
- **FOK only** (Zeitdruck)
- Bis zu 6 Versuche, Soft Cap → Hard Cap (99¢)
- Projected Combined Check verhindert garantierte Verluste

#### Phase 3: MERGE
- Merge matched shares → $1.00 pro Paar
- Exponential backoff retries (1s, 2s, 4s, 8s)
- Profit = $1.00 × matched - (costUp + costDn)

---

### Safety Guards

| Guard | Beschreibung |
|---|---|
| **3-Tier Price Cap** | Entry: 50¢ / Balancing: pair-economics (55-90¢) / Emergency: 99¢ |
| Pre-Entry Combined | Skip wenn combined > 106¢ (unheidgeable Window) |
| Imbalance Guard | Max 2:1 Ratio |
| Budget Reserve | Max 50% auf eine Seite bis andere ≥1 Fill |
| 3-Layer Economics | Projected avg → block nur bei TOXIC (≥103¢), nicht bei jeder Verschlechterung |
| Circuit Breaker | Stopp bei weighted avg > 103¢ nach 5+ Fills |
| Tail Guard | Stopp wenn marginal pair > 108¢ UND weighted avg DEFENSIVE/TOXIC |
| **Paired Quality Trailing** | Trail best paired avg, stop wenn Verschlechterung > Band (3-5¢) |
| Observation Phase | 15/25s warten vor erstem Kauf |
| Trend-Skip | Skip bei BTC > 0.10% vom Open |
| One-Sided Toxicity | Skip wenn eine Seite ≤ 20¢ und andere ≥ 80¢ |
| Hedge Feasibility | Skip wenn Gegenseite nicht executable |
| Opposite-Side Check | Pause wenn Gegenseite im Accumulation austrocknet |
| STOP_BUILD State | State Machine stoppt bei Zeit/Qualitäts-Grenzen |
| Max Spread | Skip wenn Spread > 3¢ |

---

### 5m vs 15m: TimeframeProfile

Ein Engine, zwei Profile — auto-detected aus Window-Dauer.

| Parameter | 5m | 15m |
|---|---|---|
| Observation | 15s | 25s |
| Stop Buying | 40s vor Ende | 100s vor Ende |
| Defensive Unpaired | 20s | 45s |
| Mid-Window Merge ab | >2min übrig | >5min übrig |
| Max Orders | 30 | 70 |
| Merge Min Size | 10 | 15 |
| Probe Phase | 30s | 60s |
| Interval Multiplier | 1.0x | 1.4x |

---

### ENV Konfiguration

```bash
# Required
STRATEGY_MODE=signal-taker
DRY_RUN=true                        # true für Test, false für Live

# Regime Detection (Defaults OK)
OBSERVATION_PERIOD_S=15
OSCILLATION_THRESHOLD=0.0003
TREND_SKIP_THRESHOLD=0.001

# Risk (Defaults OK)
CIRCUIT_BREAKER_CENTS=99
MAX_IMBALANCE_RATIO=2
MAX_NAKED_DURATION_S=30
MAX_SPREAD_CENTS=3
CHEAP_THRESHOLD=0.50
TARGET_COMBINED_CENTS=95

# Sizing (Defaults OK)
EQUITY_PER_WINDOW=0.80
MAX_CHUNK_SIZE=80
PROBE_CHUNK_PCT=0.25
PROBE_PHASE_END_S=30

# Timing (Defaults OK)
STOP_BUYING_BEFORE_END_S=40
SIGNAL_CHECK_INTERVAL_MS=500
SLIPPAGE_BUFFER=0.02

# Rebalance (Defaults OK)
REBALANCE_MAX_PRICE=0.99

# Deprecated (ignored, can be removed)
# SIGNAL_EXPERIMENT_MODE=false
# SIGNAL_EXPERIMENT_VARIANTS=...
```

**V11-Features (State Machine, TimeframeProfile, Mid-Window Merge, Limit-First) brauchen KEINE neuen ENV-Variablen.** Sie sind eingebaut und auto-aktiv.

---

### Architecture

```
src/
├── execution/
│   ├── signal-taker-executor.ts      — V11 Core: state-machine-driven inventory engine
│   ├── inventory-state-machine.ts    — 7-state SM + pair quality bands + decision logging
│   ├── merge-arb-executor.ts         — Legacy V5 (unused)
│   ├── dry-run-engine.ts             — FOK + Limit fill simulation gegen live orderbook
│   └── window-manager.ts             — Window lifecycle
├── data/
│   ├── binance-ws.ts                 — Binance BTCUSDT WebSocket (real-time BTC)
│   ├── clob-ws.ts                    — CLOB WebSocket (orderbook data)
│   ├── clob.ts                       — CLOB REST API (GTC limits, FOK, cancel, fills)
│   ├── redeem.ts                     — CTF merge + redeem via relayer
│   └── gamma.ts                      — Market discovery
├── config.ts                         — Configuration (ENV parsing)
├── index.ts                          — Main loop (signal-taker mode)
├── types.ts                          — Type definitions
├── utils.ts                          — Fee calculations, sleep
├── logger.ts / telegram.ts           — Logging & Telegram notifications
└── db.ts                             — PostgreSQL persistence
```

### DRY_RUN Mode

`DRY_RUN=true` (default) läuft **identischen Strategy Code** aber:
- Binance + CLOB WebSocket verbinden normal → echte Marktdaten
- **Limit Orders** simuliert: Fill wenn ask ≤ limit price innerhalb Timeout (0% Fee)
- **FOK Buys** simuliert gegen live Orderbook Depth (Taker Fee)
- Merges simuliert mit korrekter P&L Math
- Virtual Balance, Positions, P&L durchgehend getrackt

### Fee Model

```
Taker: fee = shares × price × 0.25 × (price × (1 - price))²
Maker: fee = 0 (0% auf Polymarket)
```

| Preis | Taker Fee | Maker Fee |
|---|---|---|
| 25¢ | ~0.88% | **0%** |
| 35¢ | ~1.29% | **0%** |
| 45¢ | ~1.44% | **0%** |
| 50¢ | ~1.56% (Max) | **0%** |

### Logging

Jeder Fill logged:
- **State** (FLAT/FIRST_LEG/BALANCING/...)
- **Side + Reason** (chooseNextSide, sm_priority_short, sm_blocked_long, pair_quality_resolve)
- **Type** (MAKER(0%) / TAKER)
- **Pair Band** (IDEAL/GOOD/ACCEPTABLE/DEFENSIVE/TOXIC)
- **Combined + Marginal Pair Cost**

Window Summary logged:
- Fills (total, maker, taker, makerPct)
- State transitions
- Pair quality band
- Profit + merged shares

### Docs

- `docs/new_strategy.md` — **Stargate reverse-engineered strategy thesis (SOURCE OF TRUTH)**
- `docs/executor_spec.md` — **Executor specification (SOURCE OF TRUTH)**
- `docs/HOLYPOLY_V3_DEFINITIVE.md` — Legacy V5 spec
- `docs/HOLYPOLY_STRATEGY_SPEC.md` — Legacy original spec
- `docs/HOLYPOLY_CHANGELOG.md` — History
