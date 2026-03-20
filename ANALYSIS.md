# HolyPoly — Vollständige Code-Analyse

## TL;DR

HolyPoly ist ein automatisierter Trading-Bot für Polymarket's 5-Minuten BTC Up/Down Prediction Markets. Er nutzt die zeitliche Verzögerung zwischen Binance BTC-Preisen (~100ms) und Polymarket-Orderbook-Reaktionen (Sekunden bis Minuten), um unterbewertete Seiten zu kaufen und anschließend via Arb-Completion die Gewinne zu sichern.

**Codename**: "PurpleDeer Clone" — reverse-engineered von einem Trader der $27k+ Profit gemacht hat.

---

## 1. Architektur-Überblick

```
                    ┌──────────────────────────────┐
                    │         index.ts              │
                    │  (Main Loop + Orchestration)  │
                    └──────────┬───────────────────┘
                               │
            ┌──────────────────┼──────────────────┐
            ▼                  ▼                   ▼
    ┌───────────────┐  ┌──────────────┐   ┌──────────────┐
    │  DATA LAYER   │  │ SIGNAL LAYER │   │ EXEC LAYER   │
    │               │  │              │   │              │
    │ binance-ws    │  │ fair-value   │   │ arb-manager  │
    │ rtds-ws       │  │ edge-detect  │   │ arb-complete │
    │ clob-ws       │  │ volatility   │   │ window-mgr   │
    │ clob (REST)   │  │ lookup-table │   │              │
    │ gamma         │  │ window-mem   │   │              │
    │ data-api      │  │              │   │              │
    │ redeem        │  │              │   │              │
    └───────────────┘  └──────────────┘   └──────────────┘
            │                  │                   │
            └──────────────────┼───────────────────┘
                               ▼
                    ┌──────────────────────┐
                    │   INFRA / SUPPORT    │
                    │                      │
                    │  config.ts           │
                    │  risk/limits.ts      │
                    │  db.ts (PostgreSQL)  │
                    │  telegram.ts         │
                    │  logger.ts           │
                    │  types.ts            │
                    │  utils.ts            │
                    └──────────────────────┘
```

**Technologie-Stack**: TypeScript/Node.js, PostgreSQL, 3 WebSockets (Binance, RTDS, CLOB), Polymarket CLOB API

---

## 2. Strategie im Detail

### 2.1 Kernidee: Temporal Pricing Arbitrage

```
Zeitachse eines 5-Min Windows:

0s   ─── Window startet, Opening Price gespeichert (Chainlink)
         │
30s  ─── Entry Delay vorbei, Edge Scanning beginnt
         │
         ├─ Binance BTC-Preis vs. Opening Price → Fair Value
         ├─ Fair Value vs. Polymarket Orderbook → Edge?
         ├─ Edge ≥ Threshold? ────── JA ──→ STEP 1: Winner kaufen (FOK)
         │                                        │
         │                                   STEP 2: Arb Completion
         │                                   ├─ Phase 1 (0-5s): Fill @ <92¢ pair
         │                                   ├─ Phase 2 (5-20s): Fill @ ≤96¢ pair
         │                                   └─ Phase 3 (20s+): Naked halten
         │
270s ─── Keine neuen Entries mehr (<30s übrig)
         │
300s ─── Settlement (Chainlink Oracle)
         ├─ Balanced Pairs → $1.00 Payout (garantiert)
         └─ Naked Shares → Gewinn/Verlust je nach Outcome
```

### 2.2 Der Ablauf pro Trade

1. **Edge Detection** (`edge-detector.ts`):
   - Binance-Preis holen (schnellster Feed)
   - Fair Value berechnen via Lookup Table (104.754 historische Windows)
   - Edge = Fair Value - Market Price (in Cents)
   - Adaptiver Threshold: Low vol = 6.5¢, Normal = 5¢, High vol = 3.5¢
   - Zusätzlich: Momentum-Filter, Orderbook-Depth-Confirmation, Confidence-Scaling

2. **Winner Entry** (`index.ts`, Zeile 496-555):
   - FOK (Fill or Kill) Market Order → füllt sofort oder gar nicht
   - Kein Risiko von stale fills nach Edge-Verlust
   - Tatsächliche Fill-Preise werden von API abgefragt (nicht Limit-Preise)

3. **Arb Completion** (`arb-completion.ts`):
   - 3 Phasen mit steigenden Pair-Cost-Limits
   - WS-driven (reagiert auf jeden Orderbook-Update) + 2s Safety Timer
   - Cross-Check: WS vs REST bei >5¢ Abweichung
   - Bei Timeout: Naked halten (positive EV durch Edge)

### 2.3 Fair Value Engine

Zwei Quellen:

1. **Empirische Lookup Table** (primär):
   - 104.754 echte BTC 5-Min Windows
   - 17 Delta-Buckets × 7 Time-Buckets
   - Bilineare Interpolation + Confidence aus Sample Counts
   - Momentum-Adjustment: ±1-3¢ bei starker BTC-Bewegung
   - Cross-Window Continuation Bias aus `window-memory.ts`

2. **Z-Score Model** (Fallback):
   - `z = delta / (vol * sqrt(timeRemaining/300))`
   - Normal CDF → Wahrscheinlichkeit
   - Wird nur genutzt wenn Lookup Table nicht anwendbar

---

## 3. Modul-für-Modul Analyse

### 3.1 Data Layer

| Modul | Zeilen | Funktion | WebSocket? |
|-------|--------|----------|------------|
| `binance-ws.ts` | ~80 | Direkter Binance BTC Feed, schnellster Preis (~100ms) | Ja |
| `rtds-ws.ts` | ~120 | Polymarket RTDS: Chainlink Settlement-Preis | Ja |
| `clob-ws.ts` | ~150 | CLOB Orderbook Updates (bid/ask real-time) | Ja |
| `clob.ts` | ~460 | REST API: Orders, Fills, Balance, Orderbook | Nein |
| `gamma.ts` | ~100 | Market Discovery: Aktive 5-Min Markets finden | Nein |
| `data-api.ts` | ~60 | Positionen abfragen (für Redeem) | Nein |
| `redeem.ts` | ~150 | Gewinnende Shares einlösen (On-Chain TX) | Nein |

### 3.2 Signal Layer

| Modul | Zeilen | Funktion |
|-------|--------|----------|
| `fair-value.ts` | ~148 | Fair Value Berechnung (Lookup + Z-Score Fallback) |
| `edge-detector.ts` | ~353 | Edge-Erkennung mit adaptiven Thresholds, Depth-Confirmation |
| `lookup-table.ts` | ~112 | Empirische Lookup Table mit Confidence Scores |
| `volatility.ts` | ~184 | EMA-geglättete Volatilität, Regime-Erkennung, Momentum |
| `window-memory.ts` | ~80 | Cross-Window Continuation Bias (Streak-Tracking) |

### 3.3 Execution Layer

| Modul | Zeilen | Funktion |
|-------|--------|----------|
| `arb-manager.ts` | ~213 | Position State: Shares, Cost, Round-Trips, Exposure |
| `arb-completion.ts` | ~446 | 3-Phasen Loser-Side Filling (WS-driven + REST fallback) |
| `window-manager.ts` | ~100 | Window-Lifecycle, Market-Transition-Detection |

### 3.4 Risk/Infra

| Modul | Zeilen | Funktion |
|-------|--------|----------|
| `risk/limits.ts` | ~210 | Balance-%, Daily/Weekly Loss Limits, Losing Streak |
| `config.ts` | ~323 | 50+ Env-Vars mit Defaults, Validation |
| `db.ts` | ~300 | PostgreSQL: Windows, P&L, Snapshots, Streaks |
| `telegram.ts` | ~100 | Trade-Alerts, Errors, Daily Summary |
| `logger.ts` | ~50 | Structured JSON Logger |

---

## 4. Stärken

### 4.1 Solide Architektur
- Klare Trennung: Data → Signal → Execution → Risk
- Alle Module sind lose gekoppelt und testbar
- Config über Environment Variables mit sinnvollen Defaults

### 4.2 Empirische Basis
- Lookup Table aus 104.754 echten Windows (nicht theoretisch)
- Confidence Scores pro Zelle — dünne Datenpunkte = kleinere Positionen
- Sample Counts gehen bis ~15.000 in den dichtesten Bereichen

### 4.3 Robustes Risk Management
- Prozentbasiert (skaliert automatisch mit Balance)
- 3-stufig: Tägliches Limit, Wöchentliches Limit, Losing Streak Pause
- Circuit Breaker bei Flash Crashes ($500+ Vol)
- Unhedged Exposure Limit (11% der Balance)
- Tiered Sizing: Reduziert %-Anteil bei steigender Balance (Liquidity-Schutz)

### 4.4 Execution Quality
- FOK Orders für Winner Entry → kein Risiko von stale fills
- WS-driven Arb Completion → reagiert in Millisekunden auf Preisänderungen
- Cross-Validation: WS vs REST bei Preis-Divergenz
- Tatsächliche Fill-Preise aus Trades API (nicht Order-Preise)

### 4.5 Defensive Programmierung
- Orderbook Sanity Check (askSum > 105¢ = broken)
- Depth-Capping: Max 40% einer Orderbook-Level nehmen
- Balance Floor: Kein Trading unter $50
- Graceful Shutdown mit Signal Handlers

---

## 5. Schwächen & Risiken

### 5.1 Kritische Probleme

**Fee-Berechnung inkonsistent**:
- `arb-completion.ts` Zeile 33-38: `PHASE1_MAX_PAIR_CENTS = 92` (4¢ Profit nach ~4¢ Fees)
- Aber die Settlement-Logik in `index.ts` Zeile 193 verwendet pauschale 2% auf totalCost
- Die Arb-Completion rechnet korrekt mit Fee auf BEIDEN Seiten
- Settlement-Logik fehlt die Granularität (Fee pro Fill, nicht pauschal auf Gesamtkosten)

**Kein Retry-Mechanismus für kritische Operationen**:
- FOK Order fehlschlag → skip (OK, defensive)
- Aber: Settlement DB-Write fehlt → kein Retry, nur Warn-Log (`index.ts` Zeile 275-280)
- Redeem-Fehler werden geloggt aber nicht aggressiv retried

**Balance-Race-Condition**:
- `getBalance()` cached für 5s (`limits.ts` Zeile 36)
- Zwischen Edge Detection und Order Placement kann sich Balance ändern
- Könnte zu Over-Exposure führen wenn mehrere Windows schnell hintereinander traden

### 5.2 Strukturelle Schwächen

**Keine Tests**:
- Kein einziger Test im gesamten Repo
- Kritisch bei: Fair Value Berechnung, Fee-Logik, Arb Manager State-Machine
- Lookup Table Interpolation ungetestet

**Kein Backtest-Framework**:
- Historische Daten nur für Lookup Table genutzt
- Keine Möglichkeit, Strategie-Änderungen gegen historische Daten zu testen
- STRATEGY.md erwähnt Backtesting als Phase 2, aber kein Code dafür

**Single Point of Failure**:
- Nur ein Prozess, kein Health-Check-Endpoint
- WebSocket-Disconnects: Binance hat Auto-Reconnect, aber bei gleichzeitigem Disconnect aller 3 WS kein Failover
- Kein Heartbeat/Watchdog

**Dry Run Divergenz**:
- Dry Run Settlement (`index.ts` Zeile 217-243) berechnet P&L anders als Live
- Dry Run simuliert FOK-Fills als 100% gefüllt (unrealistisch)
- Kein Orderbook-Slippage in Dry Run

### 5.3 Potentielle Verbesserungen

**Edge Threshold Floor zu hoch?**:
- `edge-detector.ts` Zeile 257: `Math.max(7, base)` — absoluter Floor bei 7¢
- Kommentar sagt "2¢ taker fee + 5¢ minimum profit margin"
- Aber: Fee ist 2% * Preis (z.B. 2% * 60¢ = 1.2¢), nicht pauschal 2¢
- Bei 60¢ Winner + 35¢ Loser = 95¢ pair → Fee = 0.02*(60+35) = 1.9¢ → Profit = 3.1¢
- Der 7¢ Floor blockt möglicherweise profitable Trades

**askSum Gate überflüssig?**:
- `config.ts` Zeile 194: `maxEntryAskSumCents` Default = 100
- `edge-detector.ts` Zeile 93: Blockiert wenn askSum > 100¢
- Aber die Strategie kauft Winner JETZT und Loser SPÄTER → askSum bei Entry ist irrelevant
- Der Kommentar in Zeile 91-92 sagt genau das, aber der Gate bleibt trotzdem aktiv
- Könnte profitable Trades blocken wenn askSum = 101¢ aber Loser in 5s auf 35¢ fällt

**Window Memory Bias fragwürdig**:
- `fair-value.ts` Zeile 85-93: Continuation Bias aus letzten 5 Windows
- Annahme: "Markt underestimates streaks" — nicht empirisch validiert
- Könnte Fair Value systematisch verzerren

---

## 6. Konfigurationsanalyse

### Defaults (aus `config.ts`):

| Parameter | Default | Bewertung |
|-----------|---------|-----------|
| `BUY_AMOUNT_PCT` | 4% | Konservativ — gut für Start |
| `EDGE_THRESHOLD_CENTS` | 5¢ | OK, aber Floor von 7¢ überschreibt dies |
| `MAX_ENTRY_PRICE_CENTS` | 92¢ | Sinnvoll — blockt Overpaying |
| `MIN_ENTRY_PRICE_CENTS` | 40¢ | Schließt billige "Lotterietickets" aus |
| `ARB_COMPLETION_TIMEOUT_MS` | 60s | Wird von BAILOUT_AFTER_MS=20s überschrieben |
| `MIN_PROFIT_CENTS` | 4¢ | Konservativ — sichert Fee-Coverage |
| `MAX_ROUND_TRIPS_PER_WINDOW` | 3 | Limitiert Overtrading |
| `SCAN_INTERVAL_MS` | 2000ms | Eher langsam — alle 2s statt 500ms wie in STRATEGY.md |
| `ENTRY_DELAY_SECONDS` | 30s | Konsistent mit Briefing |
| `VOLATILITY_LOOKBACK_SECONDS` | 120s | 2 Min Lookback für Vol-Berechnung |

### Inkonsistenzen:
- `ARB_COMPLETION_TIMEOUT_MS` (Config Default: 60s) vs `BAILOUT_AFTER_MS` (Hardcoded: 20s in arb-completion.ts)
- `SCAN_INTERVAL_MS` Default 2000ms, aber STRATEGY.md sagt 500ms
- `MIN_PROFIT_CENTS` Config Default 4¢, aber STRATEGY.md sagt 2¢

---

## 7. Geldfluss-Analyse

```
  Wallet (USDC on Polygon)
      │
      ├─→ Winner Buy (FOK) ──→ Polymarket CLOB
      │     Cost: buyAmountPct% × Balance
      │     Fee: 2% Taker auf Fill
      │
      ├─→ Loser Buy (Limit/GTC) ──→ Polymarket CLOB
      │     Cost: loserPrice × winnerShares
      │     Fee: 2% Taker auf Fill
      │
      └─── Settlement (5 Min) ─────→
            ├─ Balanced: $1.00 × balanced_shares → USDC (via Redeem)
            │   Profit = $1.00 × shares - total_cost - fees
            │
            └─ Naked: Winner settles at $1 or $0
                Win: +($1 × shares - cost - fees)
                Loss: -(cost + fees)
```

### Gebührenstruktur:
- **Taker Fee**: 2% auf jede gefüllte Seite
- **Gas**: ~$0.001-0.01 pro TX (nur Redeem, Orders sind gasfrei)
- **Spread**: Implizit durch Orderbook-Crossing

### Break-Even Beispiel:
```
Winner @ 55¢ + Loser @ 40¢ = 95¢ pair
Fee: 0.02 × (55 + 40) = 1.9¢
Net Profit: 100¢ - 95¢ - 1.9¢ = 3.1¢ pro Share-Pair
Bei 200 Shares: $6.20 Profit
```

---

## 8. Zusammenfassung

**Was der Bot gut macht**:
- Empirisch fundierte Fair Value Engine (nicht nur Theorie)
- Robustes 3-Phasen Arb Completion System
- Defensive Execution (FOK, Depth-Checks, Cross-Validation)
- Skalierbare Risk Management (prozentbasiert + tiered)

**Was fehlt / verbessert werden sollte**:
1. **Tests** — absolut kritisch, besonders für Fee-Logik und Fair Value
2. **Backtest-Framework** — Strategie-Änderungen validieren
3. **Config-Inkonsistenzen** beheben (Timeout, Scan-Interval)
4. **Edge Floor** von 7¢ überprüfen (möglicherweise zu restriktiv)
5. **Monitoring** — Health-Check Endpoint, Metrics (Prometheus/Grafana)
6. **Dry Run** Realismus erhöhen (Slippage-Simulation)

**Risiko-Einschätzung**:
- Markt-Risiko: Edges können schrumpfen wenn mehr Bots konkurrieren
- Tech-Risiko: Keine Tests, Single PoF, Fee-Inkonsistenzen
- Operationelles Risiko: WebSocket-Stabilität, Nonce-Management bei Redeem
