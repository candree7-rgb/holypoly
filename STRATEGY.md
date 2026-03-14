# HolyPoly — Strategie Übersicht

## Was handeln wir?

Polymarket 5-Minuten BTC Up/Down Prediction Markets.
Jedes 5-Minuten-Fenster hat eine Frage: "Wird BTC in 5 Minuten höher oder tiefer sein als der Eröffnungspreis?"

- **Up-Token**: Zahlt $1 wenn BTC über Eröffnungspreis endet, sonst $0
- **Down-Token**: Zahlt $1 wenn BTC unter Eröffnungspreis endet, sonst $0
- **Settlement**: Chainlink Oracle bestimmt den Gewinner

---

## Kernstrategie: Temporal Pricing Arbitrage

**Die Idee:** Polymarket-Preise reagieren LANGSAMER auf BTC-Bewegungen als der echte BTC-Preis.

### Ablauf pro 5-Minuten-Window:

```
Sekunde 0:    Window startet, Eröffnungspreis wird gespeichert (Chainlink)
Sekunde 0-30: WARTEN (Entry Delay — zu früh ist zu riskant)
Sekunde 30:   Entry Phase beginnt
              → Bot checkt: Wie weit hat sich BTC seit Opening bewegt?
              → Bot berechnet: Was ist die FAIRE Wahrscheinlichkeit für Up/Down?
              → Bot vergleicht: Fair Value vs. Polymarket Marktpreis
              → Wenn Edge > 5¢ → KAUFEN
Sekunde 270+: Zu spät zum Einsteigen (< 30s übrig)
Sekunde 300:  Settlement — Chainlink bestimmt Gewinner
```

### Beispiel:

```
Opening Price:  $70,000
BTC jetzt:      $70,050  (BTC ist $50 gestiegen)
Zeit übrig:     4 Minuten

→ Fair Value "Up":  ~65¢  (BTC ist oben, wird wahrscheinlich oben bleiben)
→ Marktpreis "Up":  52¢   (Polymarket hat noch nicht reagiert!)
→ Edge:             13¢   (65¢ - 52¢ = unterbewerteter Up-Token)
→ Aktion:           KAUFE Up bei 52¢

Wenn Up gewinnt:  Zahlt $1 pro Share → Profit: $1 - $0.52 = $0.48 pro Share
Wenn Up verliert: Zahlt $0 → Verlust: $0.52 pro Share
```

---

## Fair Value Berechnung

Basiert auf Geometric Brownian Motion:

```
z = (BTC_aktuell - BTC_opening) / (Volatilität × √(Zeit_übrig / 300))
P(Up gewinnt) = Φ(z)    ← Normal-Verteilung CDF
```

- **Große positive Bewegung + wenig Zeit** → P(Up) nahe 100% → Up-Token sollte teuer sein
- **Kleine Bewegung + viel Zeit** → P(Up) nahe 50% → Kaum Edge
- **Volatilität** wird live aus Binance-Trades berechnet (Rolling Std Dev)

---

## Order-Strategie: Grid Orders

### Primäre Seite (die Seite mit Edge):
- Kauft bis zu **3 Orders** (MAX_BUYS_PER_SIDE) an verschiedenen Ask-Levels
- Nur Orders wo Preis ≤ Fair Value + 5¢
- Jede Order: $5.00 (BUY_AMOUNT_PCT=5% von Balance)

### Hedge Seite (Gegenseite):
- Kauft **1-2 Orders** NUR wenn die Gegenseite BILLIG ist (< 40¢ = HEDGE_MAX_PRICE_CENTS)
- Zweck: Wenn BTC sich umkehrt, verlieren wir weniger

### Maximal pro Window:
- **5 Orders total** (MAX_BUYS_PER_WINDOW=5)
- Das heisst z.B.: 3 Primary + 2 Hedge, oder 3 Primary + 0 Hedge

### Wichtig zum Hedge:
Der Bot kauft NICHT 50/50 auf beide Seiten! Das Hedge ist optional und nur bei billigen Preisen:
- Wenn Up Edge hat und Down bei 35¢ zu kaufen ist → 2× Up + 1× Down
- Wenn Up Edge hat aber Down bei 55¢ steht → 3× Up + 0× Down (kein Hedge, zu teuer)
- Der Profit kommt primär von der Hauptseite, der Hedge reduziert nur das Worst-Case-Risiko

---

## Wann wird NICHT gehandelt?

1. **Edge zu klein** — Differenz Fair Value vs. Markt < 5¢ (EDGE_THRESHOLD_CENTS)
2. **BTC flat** — Delta < $10 UND Markt nahe 50/50 (kein klarer Trend)
3. **Zu spät** — Weniger als 30 Sekunden übrig im Window
4. **Chainlink stale** — Oracle-Daten > 60s alt (Settlement-Risiko)
5. **Risk Limits erreicht:**
   - Daily Loss > 10% der Tages-Startbalance
   - Weekly Loss > 20% der Wochen-Startbalance
   - Balance unter $50 Floor
   - 5+ Verluste in Folge → 30min Pause, 10+ → 2h Pause

---

## Datenquellen (3 WebSockets)

| Quelle | Zweck | Latenz |
|--------|-------|--------|
| **Binance WS** | Schnellster BTC-Preis für Fair Value Berechnung | ~100ms |
| **Chainlink/RTDS WS** | Settlement-Referenzpreis (was wirklich zählt) | ~1-5s |
| **CLOB WS** | Polymarket Orderbook (Marktpreise) | ~200ms |

Der Geschwindigkeitsvorteil: Binance reagiert in Millisekunden, Polymarket-Preise brauchen Sekunden bis Minuten um sich anzupassen.

---

## P&L Berechnung

Für jede Order:
- **Gewonnen**: `Profit = Einsatz × (100/Kaufpreis - 1)`
  - Kaufe bei 60¢ für $5 → 8.33 Shares → Gewinne $8.33 → Profit: +$3.33
- **Verloren**: `Verlust = -Einsatz`
  - Kaufe bei 60¢ für $5 → Token wertlos → Verlust: -$5.00

### Erwartungswert bei Edge:
Wenn Fair Value = 65¢ und wir kaufen bei 55¢:
- 65% Chance auf Gewinn: +$5 × (100/55 - 1) = +$4.09
- 35% Chance auf Verlust: -$5.00
- **EV = 0.65 × $4.09 - 0.35 × $5.00 = +$0.91 pro Trade**

---

## Sizing & Compounding

- **BUY_AMOUNT_PCT=5%** → Bei $100 Balance = $5 pro Order
- Automatisches Compounding: Balance wächst → Orders werden grösser
- Balance wird alle 60s von Polymarket abgefragt
- Max Exposure pro Window: 3 Orders × $5 = $15 (15% der Balance)

---

## Config Übersicht

| Parameter | Wert | Beschreibung |
|-----------|------|-------------|
| BUY_AMOUNT_PCT | 5% | Pro Order als % der Balance |
| EDGE_THRESHOLD_CENTS | 5 | Mindest-Edge in Cents |
| MAX_BUYS_PER_WINDOW | 5 | Max Orders pro 5-Min Window |
| MAX_BUYS_PER_SIDE | 3 | Max Primary-Orders pro Seite (+ bis zu 2 Hedge) |
| ENTRY_DELAY_SECONDS | 30 | Warten nach Window-Start |
| HEDGE_MAX_PRICE_CENTS | 40 | Hedge nur kaufen wenn < 40¢ |
| MIN_DELTA_THRESHOLD_USD | 10 | Min BTC-Bewegung bei 50/50 Markt |
| DAILY_LOSS_LIMIT_PCT | 10% | Max Tagesverlust |
| WEEKLY_LOSS_LIMIT_PCT | 20% | Max Wochenverlust |
| MIN_BALANCE_FLOOR_USD | 50 | Absoluter Stop |
| DRY_RUN | true | Simuliert Trades ohne echte Orders |
