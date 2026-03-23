# HolyPoly v4 — DEFINITIVE Strategy Spec (Oscillation DCA)

## DIESES DOKUMENT ERSETZT ALLE VORHERIGEN SPECS (inkl. V3)

Basierend auf: 295.911 API-Einträge + Live-Screenshot-Analyse der aktuellen Stargate5-Activity (23. März 2026) + V3 DRY_RUN-Ergebnisse die IMMER ~101¢ Combined zeigten.

V3 hatte einen **fundamentalen Fehler**: blindes Alternieren Up→Down→Up→Down kauft jedes Paar zum selben Zeitpunkt, und Up+Down = ~101¢ zu JEDEM Zeitpunkt. Ergebnis: garantierter Verlust.

---

## 1. Die Strategie in einem Absatz

Der Bot überwacht auf Polymarket 5-Min BTC Up/Down-Märkten **beide Orderbücher gleichzeitig** via WebSocket. Er kauft **jede Seite NUR wenn sie gerade billig ist** — Up wenn BTC gerade gefallen ist (Up-Ask niedrig), Down wenn BTC gerade gestiegen ist (Down-Ask niedrig). Da BTC innerhalb von 5 Minuten oscilliert, treffen die Tiefpunkte beider Seiten zu **verschiedenen Zeitpunkten** ein. Über 2-4 Minuten sammelt der Bot die Dips beider Seiten ein. Der **gewichtete Durchschnittspreis** (Up + Down) über ALLE Orders landet unter 100¢ weil jede Seite nur bei ihrem Tiefpunkt gekauft wurde. Am Ende des Windows merged er alle matched Shares zu je $1 zurück. Profit = $1 × matched_shares − total_cost.

**KEY INSIGHT:** Up + Down = ~101¢ zu JEDEM einzelnen Zeitpunkt. Aber Up-Tiefpunkt ≠ Down-Tiefpunkt zeitlich. Die Tiefpunkte beider Seiten zu VERSCHIEDENEN Zeitpunkten einsammeln = Combined < 100¢.

---

## 2. Was V3 FALSCH hatte (und V4 korrigiert)

| V3 (FALSCH) | V4 (RICHTIG) |
|-------------|--------------|
| Blind alternierend Up→Down→Up→Down | Kaufe jede Seite NUR bei ihrem Dip |
| Jedes Up+Down Paar = ~101¢ (gleicher Zeitpunkt) | Up-Dip und Down-Dip zu verschiedenen Zeitpunkten → Combined < 100¢ |
| Fester 2s Takt: kaufe was auch immer dran ist | Monitor alle 500ms, kaufe NUR wenn günstig |
| "Preisoszillation über viele Orders mittelt unter 100¢" | FALSCH — wenn du beide Seiten gleichzeitig kaufst, ist die Summe IMMER ~101¢ |
| Kein Preisziel pro Seite | Target = Midpoint × DIP_THRESHOLD (z.B. 92% = 8% unter Durchschnitt) |

---

## 3. Was Stargate5 WIRKLICH macht (Re-Interpretation)

Die V3-Analyse sah blindes Alternieren — aber das ist NICHT der Edge. Der Edge kommt daher dass **jede Seite nur gekauft wird wenn sie gerade billig ist**:

### Beispiel: Oscillation-DCA in einem Window

```
T+0:    BTC fällt stark → Up=15¢ (BILLIG!) Down=86¢ (teuer)
        → BOT KAUFT UP bei 15¢              (Down wird NICHT gekauft)

T+30s:  BTC erholt sich → Up=45¢ (fair) Down=56¢ (fair)
        → NICHTS KAUFEN (keine Seite ist billig genug)

T+60s:  BTC steigt weiter → Up=70¢ (teuer) Down=31¢ (BILLIG!)
        → BOT KAUFT DOWN bei 31¢            (Up wird NICHT gekauft)

T+90s:  BTC fällt wieder → Up=25¢ (BILLIG!) Down=76¢ (teuer)
        → BOT KAUFT UP bei 25¢

T+120s: BTC steigt → Up=65¢ (teuer) Down=36¢ (BILLIG!)
        → BOT KAUFT DOWN bei 36¢

...usw. über 2-4 Minuten...

Ergebnis:
  Up gekauft bei: 15¢, 25¢, 20¢, 18¢    → avg Up = ~19.5¢
  Down gekauft bei: 31¢, 36¢, 28¢, 33¢  → avg Down = ~32¢
  Combined: 19.5 + 32 = 51.5¢ ← WEIT UNTER 100¢!

  Merge 720 shares × ($1.00 - $0.515) = ~$349 Profit
```

**WARUM das funktioniert:**
- Up-Tiefpunkte (BTC fällt) und Down-Tiefpunkte (BTC steigt) passieren zu VERSCHIEDENEN Zeitpunkten
- Wenn Up billig ist (15¢), ist Down teuer (86¢) → wir kaufen NUR Up
- Wenn Down billig ist (31¢), ist Up teuer (70¢) → wir kaufen NUR Down
- Über Zeit sammeln wir die TIEFPUNKTE beider Seiten ein
- Combined = avg(Up-Tiefpunkte) + avg(Down-Tiefpunkte) < 100¢

**WARUM V3 (blind alternierend) NICHT funktionierte:**
- V3 kauft Up bei 15¢ dann SOFORT Down bei 86¢ → Paar = 101¢ → Verlust
- Egal wie viele Paare: jedes Paar ist zum SELBEN Zeitpunkt → immer ~101¢

---

## 4. Warum es funktioniert: Selektives Dip-Buying

**FAKT: Up + Down = ~101¢ zu JEDEM einzelnen Zeitpunkt.**

Das heißt: Wenn du BEIDE Seiten zum gleichen Zeitpunkt kaufst, verlierst du IMMER ~1¢ pro Share (plus Fees).

**Der Edge kommt aus ZEITLICHER TRENNUNG:**

```
Zeitpunkt 1 (BTC fällt):   Up=15¢ ←kaufen  Down=86¢ ←ignorieren
Zeitpunkt 2 (BTC steigt):  Up=70¢ ←ignorieren  Down=31¢ ←kaufen
```

- Zeitpunkt 1: Wir kaufen EINE Seite (Up) bei 15¢
- Zeitpunkt 2: Wir kaufen die ANDERE Seite (Down) bei 31¢
- Unser Combined: 15 + 31 = 46¢ (WEIT unter 100¢!)

**Warum funktioniert das nicht bei gleichzeitigem Kauf?**
- Zeitpunkt 1: Up=15¢ + Down=86¢ = 101¢ → Verlust
- Zeitpunkt 2: Up=70¢ + Down=31¢ = 101¢ → Verlust

**Der Algorithmus:**
1. Beobachte beide Orderbücher alle 500ms
2. Berechne laufenden Durchschnittspreis (Midpoint) für jede Seite
3. Kaufe eine Seite NUR wenn ihr Ask < Midpoint × 0.92 (8% unter Durchschnitt)
4. Wenn keine Seite günstig ist → WARTEN (nicht kaufen!)
5. Über 2-4 Minuten: BTC oscilliert, beide Seiten werden bei ihren Dips gekauft
6. Am Ende: Combined aus Up-Dips + Down-Dips < 100¢ → Merge → Profit

---

## 5. Definitive Parameter (V4)

### 5.1 Orders pro Window

| Parameter | Wert | Quelle |
|-----------|------|--------|
| Min Orders | 4 (2 pro Seite) | Minimum für sinnvollen Durchschnitt |
| Typisch | 10-20 | Abhängig von BTC-Volatilität |
| Max Orders | 30 | Hard cap |

**WICHTIG:** Anders als V3 gibt es KEIN fixes Alternieren. Orders kommen opportunistisch wenn eine Seite billig ist. In ruhigen Phasen (keine Oscillation) kommen weniger Orders.

### 5.2 Chunk-Size

Wie V3 — ~180 Shares pro Order, berechnet aus Balance.

### 5.3 Timing

| Parameter | Wert |
|-----------|------|
| Market Discovery | VOR Window-Open |
| Monitor-Start | T+5s (ENTRY_DELAY) |
| Monitor-Intervall | **500ms** (beide Bücher checken) |
| Order-Intervall | 2s (nach erfolgtem Kauf, nicht pro Tick) |
| Letzte Order | Spätestens T+260s |
| Merge | T+270-290s |

### 5.4 Dip-Detection Parameter

| Parameter | Wert | Erklärung |
|-----------|------|-----------|
| DIP_THRESHOLD_PCT | 0.92 | Kaufe wenn Ask < Midpoint × 0.92 (8% unter Durchschnitt) |
| MONITOR_INTERVAL_MS | 500 | Wie oft beide Bücher gecheckt werden |
| Adaptive Relaxation | +0.2%/tick, max +5% | Wenn zu lange nichts gekauft wird, Threshold lockern |

**Tuning:**
- DIP_THRESHOLD_PCT zu niedrig (0.80) → zu wenige Orders, viel Imbalance
- DIP_THRESHOLD_PCT zu hoch (0.98) → zu viele Orders, kauft quasi alles (wie V3)
- Sweet Spot: 0.88-0.95, abhängig von BTC-Volatilität

### 5.5 Fees

**NICHT flat 2%.** Polymarket Crypto Fee Curve:

```javascript
function calculateFee(shares, price) {
  const feeRate = 0.25;
  const exponent = 2;
  const pq = price * (1 - price);
  return shares * price * feeRate * Math.pow(pq, exponent);
}
```

| Preis | Effektive Fee-Rate |
|-------|-------------------|
| 10¢ | ~0.20% |
| 25¢ | ~0.88% |
| 50¢ | ~1.56% |
| 75¢ | ~0.88% |
| 90¢ | ~0.20% |

**Extreme Preise = fast keine Fee.** Das verstärkt den Edge bei biased Markets.

### 5.6 Order-Typ

Polymarket CLOB hat keine Market Orders. Alles sind Limit Orders.

| Typ | Verwendung |
|-----|-----------|
| **GTC** | Primär — Preis am/über Ask setzen für sofortigen Fill |
| **FOK** | Alternative — Fill-or-Kill für saubere Fills |

Preis-Strategie: `order_price = best_ask + 1-2¢ Slippage Buffer`

### 5.7 Position Sizing

| Stufe | EQUITY_PER_WINDOW | Wann |
|-------|-------------------|------|
| Test | 30% | Erste Tage |
| Normal | 50% | Nach Validierung |
| Aggressiv | 80% | Nach 1 Woche profitabel |

Worst case pro Window bei 80%: ~2.5% der Balance (alle Paare bei 105¢).

---

## 6. Core Loop (V4 — DEFINITIV)

```
STARTUP:
  Connect to Polymarket CLOB WebSocket
  Discover current + next 5-min BTC market

MAIN LOOP (alle 5 Minuten):

  ═══════════════════════════════════════════════════
  PHASE 0: PRE-WINDOW (T-30s bis T+0)
  ═══════════════════════════════════════════════════

  - Discovery: Finde conditionId + tokenIds für NÄCHSTES Window
  - Berechne chunk_size aus aktueller Balance
  - Subscribe to orderbook WebSocket für beide tokens
  - Warte auf Window-Open

  ═══════════════════════════════════════════════════
  PHASE 1: ACCUMULATE — Oscillation DCA (T+5s bis T+260s)
  ═══════════════════════════════════════════════════

  filled_up = 0, filled_dn = 0
  cost_up = 0, cost_dn = 0
  up_price_history = [], dn_price_history = []
  ticks_without_buy = 0

  WHILE time < window_end - 40s AND budget > min_cost AND orders < max:

    // === LESE BEIDE BÜCHER (Live WS, nicht REST!) ===
    up_ask = get_ws_book(up_token).asks[0].price
    dn_ask = get_ws_book(dn_token).asks[0].price

    up_price_history.push(up_ask)
    dn_price_history.push(dn_ask)

    // === BERECHNE LAUFENDEN MIDPOINT ===
    up_mid = avg(up_price_history)
    dn_mid = avg(dn_price_history)

    // === DIP DETECTION ===
    // Adaptive: wenn lange nichts gekauft, Threshold lockern
    adaptive_relax = min(ticks_without_buy * 0.002, 0.05)
    threshold = DIP_THRESHOLD_PCT + adaptive_relax

    up_is_cheap = (up_ask < up_mid * threshold)
    dn_is_cheap = (dn_ask < dn_mid * threshold)

    // === ENTSCHEIDUNG ===
    if up_is_cheap AND dn_is_cheap:
      // Beide billig → kaufe die Seite mit weniger Shares (Balance)
      side = filled_up <= filled_dn ? "Up" : "Down"
    else if up_is_cheap:
      side = "Up"
    else if dn_is_cheap:
      side = "Down"
    else:
      // KEINE Seite billig genug → WARTEN!
      ticks_without_buy++
      wait(MONITOR_INTERVAL_MS)  // 500ms
      continue  // ← DAS IST DER ENTSCHEIDENDE UNTERSCHIED ZU V3!

    // === KAUFEN ===
    order = submit_buy(side, chunk_size, best_ask + SLIPPAGE_BUFFER)
    if order.filled:
      update_shares_and_costs(side, order)
      ticks_without_buy = 0
      wait(ORDER_INTERVAL_MS)  // 2s nach Kauf
    else:
      ticks_without_buy++
      wait(MONITOR_INTERVAL_MS)  // 500ms bei Fehlschlag

    // === MID-MERGE wenn Budget knapp ===
    if budget < chunk_size * 2 AND matched > MERGE_MIN_SIZE:
      merge(matched)
      budget += matched

  END WHILE
  
  ═══════════════════════════════════════════════════
  PHASE 2: MERGE (T+260-290s)
  ═══════════════════════════════════════════════════
  
  matched = min(filled_up_shares, filled_dn_shares)
  
  if matched >= MERGE_MIN_SIZE:
    merge_result = submit_merge(conditionId, matched)
    
    if merge_result.success:
      recovered = matched * 1.00
      total_cost = total_up_cost + total_dn_cost
      profit = recovered - total_cost
      
      log("MERGED ${matched}sh → $${recovered}, cost $${total_cost}, profit $${profit}")
    else:
      log("MERGE FAILED — will redeem after resolution")
  
  ═══════════════════════════════════════════════════
  PHASE 3: CLEANUP (nach Resolution, T+300s+)
  ═══════════════════════════════════════════════════
  
  // Übrige Imbalance
  remaining_up = filled_up_shares - matched
  remaining_dn = filled_dn_shares - matched
  
  if remaining_up > 0 or remaining_dn > 0:
    // Nach Resolution: eine Seite ist $1, andere ist $0
    // Redeem holt das Geld für die Gewinnerseite
    redeem_all()
    log("REDEEMED remaining: Up=${remaining_up}, Dn=${remaining_dn}")
  
  ═══════════════════════════════════════════════════
  PHASE 4: LOG & NEXT
  ═══════════════════════════════════════════════════
  
  update_balance()
  recalculate_chunk_size()
  discover_next_market()
  // → zurück zu Phase 0
```

---

## 7. CONFIG (V4 FINAL)

```javascript
const CONFIG = {
  // === CORE ===
  EQUITY_PER_WINDOW: 0.80,         // 80% der Balance pro Window
  CHUNK_SIZE_MIN: 20,              // Minimum Shares pro Order
  CHUNK_SIZE_MAX: 200,             // Maximum (schützt Orderbuch)
  MERGE_MIN_SIZE: 10,              // Min Shares für Merge

  // === V4: DIP DETECTION (NEU!) ===
  DIP_THRESHOLD_PCT: 0.92,         // Kaufe wenn Ask < Midpoint × 0.92 (8% unter Durchschnitt)
  MONITOR_INTERVAL_MS: 500,        // Beide Bücher alle 500ms checken
  // Adaptive: wenn ticks_without_buy > 0, Threshold += 0.2%/tick (max +5%)

  // === TIMING ===
  ENTRY_DELAY_MS: 5000,            // 5s nach Window-Open
  ORDER_INTERVAL_MS: 2000,         // 2s nach erfolgtem Kauf (nicht pro Tick!)
  STOP_BUYING_BEFORE_END_S: 40,    // Aufhören 40s vor Window-Ende
  MERGE_BEFORE_END_S: 20,          // Merge 20s vor Window-Ende

  // === ORDER TYPE ===
  PRIMARY_ORDER_TYPE: 'GTC',
  FALLBACK_ORDER_TYPE: 'FOK',
  SLIPPAGE_BUFFER: 0.02,           // +2¢ über Ask
  ORDER_TIMEOUT_MS: 3000,

  // === SAFETY NETS ===
  MAX_ORDERS_PER_WINDOW: 30,
  SKIP_IF_BEST_COMBINED_GT: 1.10,
  MIN_BOOK_LEVELS: 3,

  // === FEES ===
  FEE_MODEL: 'curve',              // NICHT flat!
  FEE_RATE: 0.25,
  FEE_EXPONENT: 2,

  // === EXIT ===
  AUTO_MERGE_BEFORE_RESOLUTION: true,
  AUTO_REDEEM_AFTER_RESOLUTION: true,
};
```

---

## 8. Market Discovery (MUSS VOR Window-Open passieren)

```javascript
// KRITISCH: Market für das NÄCHSTE Window finden BEVOR es startet
// Nicht erst wenn es schon läuft!

async function discoverNextMarket() {
  const now = Date.now();
  const currentWindowStart = Math.floor(now / 300000) * 300000; // Round to 5min
  const nextWindowStart = currentWindowStart + 300000;
  
  // Suche Market der bei nextWindowStart startet
  const markets = await fetchMarkets({
    type: 'btc-updown-5m',
    startTime: nextWindowStart,
  });
  
  if (markets.length === 0) {
    // Fallback: suche über Slug-Pattern
    const slug = `btc-updown-5m-${Math.floor(nextWindowStart / 1000)}`;
    const market = await fetchMarketBySlug(slug);
    return market;
  }
  
  return markets[0];
}

// Timeline:
// T-30s: discoverNextMarket()
// T-10s: subscribe to orderbook websocket
// T+0:   Window opens
// T+5s:  First buy order
// T+260s: Last buy order
// T+280s: Merge
// T+300s: Window resolves
// T+310s: Redeem remaining
```

---

## 9. Fee-Berechnung (RICHTIG)

```javascript
// Polymarket Crypto Fee Curve
// NICHT flat 2%!
function calculatePolymarketFee(shares, price) {
  const feeRate = 0.25;
  const exponent = 2;
  const pq = price * (1 - price);  // max bei 50¢ (= 0.25), min bei Extremen
  const fee = shares * price * feeRate * Math.pow(pq, exponent);
  return fee;
}

// Beispiele:
// 180sh × 10¢: fee = 180 × 0.10 × 0.25 × (0.09)² = $0.036 (0.20%)
// 180sh × 50¢: fee = 180 × 0.50 × 0.25 × (0.25)² = $1.406 (1.56%)
// 180sh × 90¢: fee = 180 × 0.90 × 0.25 × (0.09)² = $0.328 (0.20%)

// KEY INSIGHT: Extreme Preise (10¢, 90¢) haben FAST KEINE Fee
// Das verstärkt den Edge bei biased Markets!
```

---

## 10. Merge-Implementierung

```javascript
// Merge = On-Chain TX auf CTF Contract
// Burns gleiche Menge Up + Down tokens → gibt USDC zurück ($1 pro pair)

async function executeMerge(conditionId, amount) {
  // amount = min(up_shares, down_shares)
  
  const tx = await ctfContract.mergePositions(
    USDC_ADDRESS,           // collateralToken
    '0x' + '0'.repeat(64),  // parentCollectionId (root)
    conditionId,            // market condition ID  
    [1, 2],                 // partition (binary: outcome 0 and 1)
    parseUnits(amount, 6)   // amount in USDC decimals
  );
  
  await tx.wait();
  
  return {
    success: true,
    recovered: amount,  // $1 per share
    txHash: tx.hash,
  };
}
```

---

## 11. Error Handling

```
SZENARIO: Order nicht gefüllt (timeout)
→ Cancel order
→ Nächste Order versuchen
→ NICHT Panik, einfach weitermachen

SZENARIO: Partial Fill
→ Akzeptieren, als filled_size tracken
→ Nächste Order: NICHT die Gegenseite anpassen
→ Am Ende: Imbalance wird durch Merge automatisch gehandelt
   (merge nur min(up, down), rest → redeem)

SZENARIO: Merge fehlschlägt
→ Retry 1x
→ Wenn nochmal fehlschlägt: Positionen halten
→ Nach Resolution: Redeem (Gewinnerseite = $1, Verlierer = $0)
→ Expected Value = ~50¢ pro Share (break-even minus Fees)

SZENARIO: Bot startet mitten im Window
→ Check: wie viel Zeit ist noch übrig?
→ Wenn >120s: normal traden (aber weniger Orders)
→ Wenn <120s: Window skippen, auf nächstes warten

SZENARIO: Bot crash / restart
→ Auf Startup: check alle offenen Positionen
→ Für jede Position: ist sie schon merged/resolved?
→ Wenn nicht: merge wenn möglich, sonst auf Resolution warten
→ NIEMALS naked Positionen ignorieren
```

---

## 12. Warum die vorherigen Versionen nicht funktioniert haben

### Problem 0 (V3, FUNDAMENTAL): Blindes Alternieren = IMMER 101¢
- **DER GRÖSSTE FEHLER:** V3 kaufte Up→Down→Up→Down blind abwechselnd
- Up + Down = ~101¢ zu JEDEM einzelnen Zeitpunkt
- Egal wie viele Orders, egal welcher Preis — die Summe eines gleichzeitigen Paares ist IMMER ~101¢
- V3 dachte "der Durchschnitt über viele Paare wird unter 100¢ landen" — FALSCH
- Jedes einzelne Paar (Up bei T, Down bei T+2s) hat Combined ~101¢
- Der Durchschnitt von lauter 101¢-Paaren ist... 101¢

### Problem 1: 3 Minuten zu spät (V1/V2)
- Bot fand den Market WÄHREND des Windows statt VORHER
- Billige Levels (7-20¢) waren schon weg

### Problem 2: Buy-Merge-Buy-Merge Cycle (V1/V2)
- Bot merged nach jedem Paar statt einmal am Ende

### Problem 3: Flat 2% Fee (V1/V2)
- Echte Fee ist 0.2-1.5% (Kurve)

### Problem 4: MAX_PAIRS = 5 (V1/V2)
- Zu wenig Orders für sinnvolle Statistik

### V4 Lösung
**Nicht beide Seiten gleichzeitig kaufen.** Jede Seite NUR bei ihrem Tiefpunkt kaufen. Up und Down haben ihre Tiefpunkte zu VERSCHIEDENEN Zeitpunkten (weil BTC oscilliert). So wird Combined = avg(Up-Dips) + avg(Down-Dips) < 100¢.

---

## 13. Erwartete Performance

| Metrik | Stargate5 (real) | HolyPoly (projected) |
|--------|-----------------|---------------------|
| Orders/Window | 16-24 | 16-24 |
| Chunk-Size | ~180sh | ~180sh |
| Avg Combined | 98.5¢ | ~98.5¢ (gleiche Strategie) |
| Merged Shares/Window | 800-1800 | 800-1800 |
| Profit/Window | ~$10-15 | ~$10-15 |
| Windows/Tag | 140 | 140 |
| Daily Profit | ~$1,400 | ~$1,400 |
| Monthly Profit | ~$35,000 | Skaliert mit Bankroll |

**Disclaimer:** Projected. Echte Performance hängt ab von Competition, Liquidität, Timing-Qualität.

---

## 14. Implementation Checklist

### PHASE 1: Infrastructure
- [ ] Polymarket CLOB API Authentication (EIP-712)
- [ ] WebSocket Connections (CLOB + optional Binance)
- [ ] Market Discovery (vor Window-Open!)
- [ ] Orderbook Subscription
- [ ] Order Placement (GTC/FOK)
- [ ] Fill Tracking

### PHASE 2: Core Strategy
- [ ] Window Scheduler (5-min alignment)
- [ ] Pre-Window Market Discovery (T-30s)
- [ ] Buy Loop (alternating Up/Down, chunk_size)
- [ ] Running Balance Tracker (filled_up, filled_dn, costs)
- [ ] Fee Calculation (curve, not flat!)
- [ ] Merge Execution (CTF contract)
- [ ] Cleanup (Redeem after Resolution)

### PHASE 3: Safety
- [ ] Balance Management (chunk_size from balance)
- [ ] Error Recovery (failed orders, failed merges)
- [ ] Crash Recovery (startup position check)
- [ ] Logging (every order, every merge, P&L per window)
- [ ] Telegram Alerts

### PHASE 4: Optimize
- [ ] Entry Timing < 5s nach Window-Open
- [ ] Order Interval Tuning (2s vs 4s)
- [ ] Chunk-Size Optimization
- [ ] Mid-Window Merge für Kapital-Recycling (wenn Budget knapp)

---

## 15. Quick Reference Card

```
╔══════════════════════════════════════════════════════╗
║          HOLYPOLY OSCILLATION-DCA BOT v4             ║
╠══════════════════════════════════════════════════════╣
║ WHAT:  Buy Up at its dip, Down at its dip, Merge    ║
║ WHEN:  Every 5-min BTC window, monitor from T+5s    ║
║ HOW:   Monitor both books every 500ms                ║
║        Buy a side ONLY when its ask < mid × 0.92     ║
║        Wait if nothing is cheap (DON'T buy blindly)  ║
║        Merge ALL matched shares at T+280s            ║
║ WHY:   Up dip ≠ Down dip in time → combined < 100¢  ║
║ EDGE:  BTC oscillation → each side dips separately   ║
║ RISK:  ~2-3% max per window (hedged position)        ║
╠══════════════════════════════════════════════════════╣
║ CRITICAL: NEVER buy both sides at the same time!     ║
║ CRITICAL: Up + Down = ~101¢ always at any moment!    ║
║ CRITICAL: Buy each side only at its CHEAPEST point!  ║
║ CRITICAL: Wait for dips — patience is the edge!      ║
╚══════════════════════════════════════════════════════╝
```

---

## 16. V4 Amendments (23. März 2026)

### 16.1 FUNDAMENTALE ÄNDERUNG: Von blindem Alternieren zu Oscillation-DCA

V3 ging davon aus dass "der Durchschnitt über viele alternierend gekaufte Paare unter 100¢ landen wird".
Das war FALSCH. Up + Down = ~101¢ zu jedem Zeitpunkt. Blind alternierend kaufen = jedes Paar ~101¢ = Verlust.

V4 kauft jede Seite **NUR wenn sie billig ist** (Dip-Detection via Running Midpoint).
Up und Down haben ihre Dips zu verschiedenen Zeitpunkten (BTC oscilliert).
Combined aus Up-Dips + Down-Dips < 100¢.

### 16.2 WebSocket Book Updates (price_change)

`price_change` Events updaten jetzt die vollständigen `asks[]`/`bids[]` Arrays (nicht nur `bestBid`/`bestAsk`).
Das ist kritisch damit `simulateFokBuy()` im DRY_RUN gegen das AKTUELLE Orderbuch simuliert.

### 16.3 Mid-Merge Recycling

Unverändert von V3: Nur wenn Budget knapp wird.

### 16.4 BTC-Preisoszillation ist der KERN des Edge

Schon **0.1% BTC-Bewegung** reicht damit Up von 40¢ auf 60¢ springt und Down von 60¢
auf 40¢ fällt. V4 WARTET auf diese Moves und kauft NUR bei den Dips.

**Risiko: Flat BTC** — Wenn BTC 5 Minuten lang nicht oscilliert (Up=50¢, Down=51¢ die ganze Zeit),
gibt es keine Dips zum Kaufen. Der Bot kauft wenig/nichts. Das ist KORREKT — kein Edge = kein Trade.
