# HolyPoly — Hybrid Edge+Arb Strategie

## Was handeln wir?

Polymarket 5-Minuten BTC Up/Down Prediction Markets.

- **Up-Token**: Zahlt $1 wenn BTC über Eröffnungspreis endet, sonst $0
- **Down-Token**: Zahlt $1 wenn BTC unter Eröffnungspreis endet, sonst $0
- **Settlement**: Chainlink Oracle bestimmt den Gewinner
- **Up + Down = $1.00 garantiert** (einer gewinnt immer)

---

## Kernstrategie: Hybrid Edge Detection + Arb Completion

### Die Idee

Binance zeigt BTC-Preisbewegungen ~1-5 Sekunden bevor Polymarket reagiert.
Wir nutzen diesen Vorsprung in **zwei Schritten**:

1. **Edge Detection**: Kaufe die Gewinnerseite bevor Polymarket den Preis anpasst
2. **Arb Completion**: Kaufe die Verliererseite NACHDEM Polymarket repriced hat → Wenn Gesamtkosten < $1.00 → **garantierter Profit**

### Ablauf pro 5-Minuten-Window:

```
Sekunde 0:     Window startet, Eröffnungspreis gespeichert
Sekunde 0-30:  WARTEN (Entry Delay — Preise müssen sich bilden)
Sekunde 30+:   Edge Scanning beginnt (alle 500ms)
               ┌─ Binance-Preis vs. Opening → Fair Value berechnen
               ├─ Fair Value vs. Polymarket-Orderbook → Edge ermitteln
               └─ Edge ≥ Threshold? → SCHRITT 1 starten

SCHRITT 1 — WINNER KAUFEN:
  → Aggressive Limit Order bei best_ask auf der Gewinnerseite
  → ArbManager trackt: Shares, Kosten, Seite

SCHRITT 2 — ARB COMPLETION:
  → ArbCompletion Monitor wartet auf Loser-Seite Repricing (via CLOB WS)
  → Wenn Loser-Preis ≤ Target (100¢ - Winner - 2¢ Mindestprofit):
    → KAUFE Loser → PROFIT GELOCKT!
  → Wenn Timeout (15s) oder BTC Reversal:
    → Emergency Balance (Loser kaufen um Verlust zu begrenzen)
  → Wenn Loser zu teuer für Balance:
    → Naked Position halten (direktionaler Gewinn wenn BTC-These stimmt)

SCHRITT 3 — REPEAT:
  → Nach Balance (gleiche Shares beider Seiten) → Scan für nächsten Edge
  → Bis zu 3 Round-Trips pro Window

Sekunde 270:   Keine neuen Entries mehr (< 30s übrig)
Sekunde 300:   Settlement — Chainlink bestimmt Gewinner
               Balanced Pairs → $1.00 Auszahlung (Profit gelockt)
               Naked Shares → Gewinn oder Verlust je nach Settlement
```

---

## Beispiel: Kompletter Arb-Zyklus

```
Opening Price:  $85,000
BTC bewegt sich: $85,060  (+$60)
Fair Value Up:   ~82¢
Polymarket Up:   55¢ (hat noch nicht reagiert!)
Edge:            27¢ ✓

SCHRITT 1 — Winner kaufen:
  → Kaufe Up @ 55¢ × 200 Shares = $110.00

  [5 Sekunden vergehen — Polymarket repriced]

  Polymarket Up: jetzt 75¢
  Polymarket Down: jetzt 28¢

SCHRITT 2 — Arb Completion:
  → Target: 100 - 55 - 2 = 43¢ max
  → Down @ 28¢ ≤ 43¢ ✓ → KAUFE Down @ 28¢ × 200 Shares = $56.00

ERGEBNIS:
  Total Cost: $110 + $56 = $166.00
  Guaranteed Payout: 200 Shares × $1.00 = $200.00
  LOCKED PROFIT: $34.00 (20.5% Return)

  (Egal ob BTC steigt oder fällt — eine Seite zahlt $1.00)
```

---

## Fair Value Engine

### Empirische Lookup-Table (104.754 echte BTC-Windows)

Statt theoretischer Normalverteilung nutzen wir **echte historische Daten**:

```
Normalized Delta = (BTC_aktuell - BTC_opening) / Volatilität

| Delta  | 240s übrig | 120s | 60s | 30s |
|--------|-----------|------|-----|-----|
| -1.0   | 15¢       | 8¢   | 1¢  | 1¢  |
| -0.5   | 27¢       | 21¢  | 9¢  | 6¢  |
|  0.0   | 50¢       | 50¢  | 49¢ | 50¢ |
| +0.5   | 71¢       | 80¢  | 91¢ | 94¢ |
| +1.0   | 85¢       | 92¢  | 98¢ | 99¢ |
```

### Verbesserungen v2:
- **Confidence Score**: Zellen mit wenig Datenpunkten = geringere Confidence → kleinere Position
- **Momentum-Adjustment**: Wenn BTC beschleunigt, wird Fair Value leicht in Trendrichtung verschoben
- **Regime-Awareness**: Hohe Volatilität = weniger vorhersagbar = niedrigere Confidence

---

## Adaptive Edge-Schwellwerte

Der Mindest-Edge passt sich dynamisch an:

| Volatilität-Regime | Edge Threshold | Begründung |
|-------------------|---------------|------------|
| **Low** ($25 Vol) | 6.5¢ (+30%) | Enge Märkte, braucht größeren Edge |
| **Normal** ($25-80) | 5¢ (Basis) | Standard |
| **High** ($80+ Vol) | 3.5¢ (-30%) | Edges erscheinen und verschwinden schnell |

### Zeit-Decay:
- Bei 240s Restzeit: voller Threshold
- Bei 60s Restzeit: 80% des Thresholds
- Bei 30s Restzeit: 60% des Thresholds (letzte Chance)

---

## Arb Completion — Das Herzstück

### Target-Preis für Gegenseite:
```
Loser Target = 100¢ - Winner Preis - MIN_PROFIT_CENTS(2¢)

Beispiel: Winner @ 60¢ → Loser muss ≤ 38¢ sein
```

### Timing der Gegenseite:
1. **Sofort checken** (T+0): Manchmal ist Loser schon günstig genug
2. **Reaktiv warten** (T+0 bis T+15s): CLOB WS Preis-Updates beobachten
3. **Emergency** (T+15s): Timeout oder BTC Reversal → Sofort kaufen oder halten

### Fallback-Kaskade:
```
Phase 1: Limit Order bei Target-Preis (Profit locken)
         ↓ 10s timeout, < 50% filled?
Phase 2: Limit bei Target+1¢ (weniger Profit, aber Fill)
         ↓ 15s timeout?
Phase 3: BTC-Richtung checken
         ├─ BTC noch in unsere Richtung → Naked halten (Winner zahlt $1)
         └─ BTC reversed → Emergency Buy bei best ask (Cap Downside)
```

---

## Position Management: ArbManager

### State pro Window:
```
Up Shares:     200    | Down Shares:  200
Up Cost:       $110   | Down Cost:    $56
Balanced:      200 Shares → Locked Profit: $34
Unhedged:      0 Shares → Bereit für nächsten Round-Trip
Round-Trips:   1/3
```

### Regeln für Re-Entry:
- ✅ Nur wenn `unhedged = 0` (vollständig balanced)
- ✅ Nur wenn `roundTrips < 3` (max pro Window)
- ✅ Nur wenn `totalCost < 15% der Balance` (Exposure-Limit)
- ❌ Kein neuer Entry wenn unbalanced (erst Arb completen!)

---

## Datenquellen (3 WebSockets)

| Quelle | Zweck | Latenz | Rolle in Strategie |
|--------|-------|--------|--------------------|
| **Binance WS** | Schnellster BTC-Preis | ~100ms | Edge Detection, Momentum |
| **Chainlink/RTDS WS** | Settlement Oracle | ~1-30s | Opening Price, Settlement |
| **CLOB WS** | Polymarket Orderbook | ~200ms | Arb Completion Trigger, Preise |

---

## Risk Management

### Circuit Breakers:
| Trigger | Aktion | Reset |
|---------|--------|-------|
| Daily Loss > 10% | Halt | Nächster Tag |
| Weekly Loss > 20% | Halt | Nächste Woche |
| 5 Verluste in Folge | 15min Pause | Automatisch |
| Balance < $50 | Halt | Manuell |
| Unhedged > 11% Balance | Keine neuen Entries | Wenn balanced |

### Stop-Loss:
- **Balanced Position**: Kein Stop-Loss nötig (Payout garantiert)
- **Naked Position**: Stop wenn BTC reversed über Opening Price
- **Emergency Balance**: Wenn naked > 15s und BTC adverse

### Exposure-Limits:
| Balance | Max pro Zyklus | Max Unhedged | Max pro Window |
|---------|---------------|-------------|----------------|
| $200 | $55 | $22 (11%) | $30 (15%) |
| $500 | $110 | $55 (11%) | $75 (15%) |
| $1000 | $110 | $110 (11%) | $150 (15%) |

---

## P&L Szenarien

### Arb-Zyklus (balanced):
```
Winner @ 55¢ + Loser @ 40¢ = 95¢ Total → 5¢ Profit/Pair GARANTIERT
Bei 200 Shares: $10.00 Profit, $0 Risiko
```

### Naked Winner (Arb nicht completed):
```
Winner @ 55¢, BTC gewinnt: +$0.45/Share × 200 = +$90
Winner @ 55¢, BTC verliert: -$0.55/Share × 200 = -$110
Bei 65% Winrate: EV = 0.65 × $90 - 0.35 × $110 = +$20.00
```

### Expected Value pro Zyklus (mit Mitigations):
```
Szenario           | Wahrscheinlichkeit | P&L
Clean Arb          | 45%                | +$4-10
Reduzierter Profit | 25%                | +$1-3
Break-even         | 10%                | $0
Abort (kein Fill)  | 12%                | -$4
Reversal           | 5%                 | -$12
Katastrophe        | 0.5%               | -$55
```

---

## Config Übersicht

| Parameter | Default | Beschreibung |
|-----------|---------|-------------|
| **Edge Detection** | | |
| EDGE_THRESHOLD_CENTS | 5 | Mindest-Edge (adaptiv nach Regime) |
| EDGE_TIER2/3/4_CENTS | 8/12/15 | Position-Scaling Schwellen |
| ENTRY_DELAY_SECONDS | 30 | Warten nach Window-Start |
| SCAN_INTERVAL_MS | 500 | Scan-Frequenz für Edge |
| MIN_DELTA_THRESHOLD_USD | 10 | Min BTC-Bewegung bei 50/50 |
| MAX_ADVERSE_MOMENTUM_USD | 50 | Max Gegenwind |
| **Arb Completion** | | |
| MIN_PROFIT_CENTS | 2 | Mindestprofit pro Pair |
| MAX_ROUND_TRIPS_PER_WINDOW | 3 | Max Arb-Zyklen pro Window |
| ARB_COMPLETION_TIMEOUT_MS | 15000 | Timeout für Loser-Entry |
| MAX_UNHEDGED_PCT | 11 | Max Naked-Exposure |
| MAX_WINDOW_EXPOSURE_PCT | 15 | Max Gesamt-Exposure |
| **Risk** | | |
| BUY_AMOUNT_PCT | 3 | % pro Order |
| DAILY_LOSS_LIMIT_PCT | 10 | Max Tagesverlust |
| WEEKLY_LOSS_LIMIT_PCT | 20 | Max Wochenverlust |
| LOSING_STREAK_PAUSE | 5 | Verluste vor Pause |
| MIN_BALANCE_FLOOR_USD | 50 | Absoluter Stop |
