# HolyPoly v3 — DEFINITIVE Strategy Spec

## DIESES DOKUMENT ERSETZT ALLE VORHERIGEN SPECS

Basierend auf: 295.911 API-Einträge + Live-Screenshot-Analyse der aktuellen Stargate5-Activity (23. März 2026).

Die vorherigen Specs hatten fundamentale Fehler im Execution-Modell. Dieses Dokument korrigiert sie.

---

## 1. Die Strategie in einem Absatz

Der Bot kauft auf Polymarket 5-Min BTC Up/Down-Märkten **beide Seiten** über die gesamte Window-Dauer mit vielen kleinen Orders (~180 Shares). Er alterniert Up-Down-Up-Down, nimmt was das Orderbuch gerade hergibt, über 2-4 Minuten verteilt. Die Preise schwanken innerhalb des Windows weil sich der BTC-Preis bewegt — manchmal ist Up billig (10-30¢), manchmal Down billig (10-30¢). Über 10-25 Orders akkumuliert er gleiche Mengen auf beiden Seiten. Der **gewichtete Durchschnittspreis** (Up + Down) über ALLE Orders landet unter 100¢. Am Ende des Windows merged er alle matched Shares zu je $1 zurück. Profit = $1 × matched_shares − total_cost.

---

## 2. Was die vorherigen Specs FALSCH hatten

| Vorher (FALSCH) | Jetzt (RICHTIG) |
|-----------------|-----------------|
| Buy pair → merge → buy pair → merge (interleaved) | Buy 10-25 Orders → merge EINMAL am Ende |
| MAX_PAIRS = 5 (10 Orders) | 10-25+ Orders pro Window |
| Merge nach jedem Batch | Merge am Schluss (T+240-280s) |
| Erste Fills sind die profitabelsten | Profit kommt aus dem DURCHSCHNITT über viele Preise |
| Combined <100¢ pro Einzelpaar nötig | Einzelpaare KÖNNEN über 100¢ sein, Gesamtdurchschnitt zählt |
| Pre-trade combined check pro Paar | Kein Per-Pair-Check, einfach kaufen |
| Flat 2% Fee | Kurven-Fee: ~0.3-1.5% je nach Preis |
| Entry nach 3-5s | Entry MUSS innerhalb 5-10s passieren |

---

## 3. Stargate5's exakter Flow (aus Live-Screenshots verifiziert)

### Window 5:30-5:35 AM ET (stark biased, Up billig)

```
T+5s   Buy Up    7¢  × 179.1sh   $12.37
T+7s   Buy Down 75¢  × 177.7sh   $134.80
T+10s  Buy Up   27¢  × 177.6sh   $48.51
T+12s  Buy Down 65¢  × 177.0sh   $116.50
T+15s  Buy Up   40¢  × 176.7sh   $71.48
T+17s  Buy Down 63¢  × 176.9sh   $112.96
T+20s  Buy Up   34¢  × 177.0sh   $60.96
T+22s  Buy Down 75¢  × 177.7sh   $134.66
T+25s  Buy Up   30¢  × 177.3sh   $53.51
T+27s  Buy Down 71¢  × 177.4sh   $127.30
T+30s  Buy Up   34¢  × 177.0sh   $60.96
T+32s  Buy Down 61¢  × 176.8sh   $109.17
T+35s  Buy Up   45¢  × 176.6sh   $80.69
T+37s  Buy Down 50¢  × 176.5sh   $89.65
... (insgesamt 14-20 Orders)
T+280s MERGE 1,240 shares         → $1,240 returned

Up avg:  ~35¢ (über 7-10 Orders)
Down avg: ~63¢ (über 7-10 Orders)
Combined avg: ~98¢
Profit: ~$25 auf 1,240 shares (2¢ × 1,240)
```

### Window 5:15-5:20 AM ET (noch stärker biased)

```
Up prices: 14¢, 16¢, 9¢, 23¢, 25¢, 35¢, 41¢, 45¢, 55¢, 81¢, 88¢, 89¢
Down prices: 87¢, 90¢, 90¢, 75¢, 71¢, 66¢, 65¢, 54¢, 47¢, 17¢, 16¢, 13¢

Up avg: ~43¢
Down avg: ~56¢
Combined avg: ~99¢
Shares: ~1,446 (merged)
```

### Window 5:10-5:15 AM ET (wenige Orders, kleines Window)

```
Nur 3 Orders:
  Buy Up   14¢ × 181.5sh
  Buy Down 87¢ × 181.6sh
  Buy Up   16¢ × 181.4sh
MERGE 544.8 shares

Combined: (14+87)/2 ≈ 50.5¢ per side → 101¢
Aber: der dritte Buy (Up 16¢) hat keinen Down-Partner
→ kleineres Window, weniger Tiefe
```

### Key Observations aus den Screenshots

1. **Er kauft VIELE Orders** (10-25 pro Window, nicht 5)
2. **Die Preise variieren extrem** (Up von 7¢ bis 89¢ im selben Window)
3. **Er merged EINMAL am Ende**, nicht zwischendurch
4. **Merge-Size = Gesamtmenge matched Shares** (716, 1240, 1446, 1621, 1800, 1968 Shares)
5. **Er alterniert strikt Up-Down-Up-Down**
6. **Chunk-Size ist quasi konstant** pro Window (~179-182 Shares)
7. **Er startet sofort nach Window-Open** und kauft bis ca. T+240-280s
8. **Manchmal 2 Merges pro Window** (ein großer + ein kleiner für Rest)

---

## 4. Warum es funktioniert: Die Preisoszillation

Das Orderbuch für BTC Up/Down spiegelt den aktuellen BTC-Preis wider. Innerhalb von 5 Minuten bewegt sich BTC → die Preise oscillieren:

```
Sekunde 0:   BTC steigt → Up=70¢ (teuer), Down=25¢ (billig)
Sekunde 30:  BTC fällt  → Up=30¢ (billig), Down=65¢ (teuer)  
Sekunde 60:  BTC steigt → Up=80¢ (teuer), Down=15¢ (billig)
Sekunde 90:  BTC flat   → Up=50¢ (fair),  Down=50¢ (fair)
Sekunde 120: BTC fällt  → Up=25¢ (billig), Down=70¢ (teuer)
```

Wenn du zu jedem dieser Zeitpunkte Up+Down kaufst:
- Sek 0: 70+25 = 95¢ ✓
- Sek 30: 30+65 = 95¢ ✓
- Sek 60: 80+15 = 95¢ ✓
- Sek 90: 50+50 = 100¢ ✗
- Sek 120: 25+70 = 95¢ ✓

Durchschnitt: ~96¢ → 4¢ Profit pro Share!

**Der Edge entsteht weil das Orderbuch NICHT perfekt effizient ist.** An den Extremen (wenn eine Seite sehr billig ist, 5-20¢) ist die Summe am niedrigsten. In der Mitte (50/50) ist sie am höchsten. Über viele Orders mittelt sich das unter 100¢.

---

## 5. Definitive Parameter

### 5.1 Orders pro Window

| Parameter | Wert | Quelle |
|-----------|------|--------|
| Min Orders | 4 (2 Paare) | Kleinste Windows in Daten |
| Typisch | 16-24 (8-12 Paare) | Median aus 295k Einträgen |
| Max Orders | 40+ | Vereinzelt bei sehr tiefen Büchern |

**KEIN MAX_PAIRS Limit.** Kaufe so viele Paare wie das Orderbuch hergibt und das Budget erlaubt, bis ca. T+260s (40 Sekunden vor Window-Ende).

### 5.2 Chunk-Size

| Parameter | Wert |
|-----------|------|
| Pro Order | ~180 Shares (Stargate5 aktuell) |
| Innerhalb eines Windows | Quasi konstant (Std: <3 Shares) |
| Zwischen Tagen | Variiert mit Bankroll (36-193 Shares) |
| MAX_CHUNK_SIZE | 200 (um Orderbuch nicht zu sprengen) |

Berechnung:
```javascript
function calculateChunkSize(balance, equityPerWindow) {
  const budget = balance * equityPerWindow;
  // Budget für ca. 10 Paare (20 Orders), avg price ~50¢
  const estimatedPairs = 10;
  const estimatedAvgPrice = 0.50;
  const rawChunk = Math.floor(budget / (estimatedPairs * 2 * estimatedAvgPrice));
  return Math.min(Math.max(rawChunk, 20), 200); // min 20, max 200
}
```

### 5.3 Timing

| Parameter | Wert |
|-----------|------|
| Market Discovery | VOR Window-Open (während vorheriges Window läuft) |
| Erster Buy nach Window-Open | 5-10 Sekunden (KRITISCH!) |
| Intervall zwischen Orders | 2-4 Sekunden |
| Letzte Order | Spätestens T+260s (40s vor Resolution) |
| Merge | T+270-290s (10-30s vor Resolution) |

### 5.4 Entry-Timing ist ALLES

**Die billigsten Levels existieren nur in den ersten 30 Sekunden.**

Aus den Daten (Window 5:30-5:35):
- T+5s: Up 7¢ (combined ~82¢ → 18¢ Profit)
- T+120s: Up 45¢ (combined ~95¢ → 5¢ Profit)
- T+240s: Up 55¢ (combined ~102¢ → Verlust)

**Wenn du nach 3 Minuten einsteigst, sind nur noch die 100¢+ Levels übrig. Game over.**

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

## 6. Core Loop (DEFINITIV)

```
STARTUP:
  Connect to Polymarket CLOB WebSocket
  Connect to Binance WS (für BTC-Preis Monitoring, optional)
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
  PHASE 1: ACCUMULATE (T+5s bis T+260s)
  ═══════════════════════════════════════════════════
  
  filled_up_shares = 0
  filled_dn_shares = 0
  total_up_cost = 0
  total_dn_cost = 0
  order_count = 0
  
  WHILE time < window_end - 40s AND budget_remaining > min_order_cost:
    
    // Entscheide welche Seite zuerst (alternierend)
    if order_count is even:
      first_side = "Up"
      second_side = "Down"
    else:
      first_side = "Down" 
      second_side = "Up"
    
    // === BUY FIRST SIDE ===
    book = get_orderbook(first_side)
    best_ask = book.asks[0].price
    
    order = submit_buy(
      token: first_side_token,
      size: chunk_size,
      price: best_ask + SLIPPAGE_BUFFER,
      type: "GTC"  // oder "FOK"
    )
    
    wait_for_fill(order, timeout: 5s)
    
    if order.filled:
      if first_side == "Up":
        filled_up_shares += order.filled_size
        total_up_cost += order.filled_cost + fee
      else:
        filled_dn_shares += order.filled_size
        total_dn_cost += order.filled_cost + fee
      order_count++
    else:
      cancel(order)
      // Retry einmal oder skip
    
    // === BUY SECOND SIDE ===
    book = get_orderbook(second_side)
    best_ask = book.asks[0].price
    
    order = submit_buy(
      token: second_side_token,
      size: chunk_size,  // GLEICHE Size wie first side
      price: best_ask + SLIPPAGE_BUFFER,
      type: "GTC"
    )
    
    wait_for_fill(order, timeout: 5s)
    
    if order.filled:
      if second_side == "Up":
        filled_up_shares += order.filled_size
        total_up_cost += order.filled_cost + fee
      else:
        filled_dn_shares += order.filled_size
        total_dn_cost += order.filled_cost + fee
      order_count++
    else:
      cancel(order)
    
    // === RUNNING STATS (nur logging, kein Stop) ===
    matched = min(filled_up_shares, filled_dn_shares)
    if matched > 0:
      running_combined = (total_up_cost + total_dn_cost) / matched
      log("Orders: ${order_count}, Matched: ${matched}sh, Avg combined: ${running_combined}")
    
    // === OPTIONAL: ZWISCHEN-MERGE (für Kapital-Recycling) ===
    // NUR wenn Budget knapp wird UND genug matched ist
    if budget_remaining < chunk_size * 2 AND matched > MERGE_MIN_SIZE:
      submit_merge(matched)
      budget_remaining += matched  // $1 per share zurück
      filled_up_shares -= matched
      filled_dn_shares -= matched
      // Proportional costs reduzieren
      cost_ratio = total_up_cost / (total_up_cost + total_dn_cost)
      total_up_cost -= matched * running_combined * cost_ratio
      total_dn_cost -= matched * running_combined * (1 - cost_ratio)
      log("MID-MERGE: ${matched}sh, freed $${matched}")
    
    // === PACING ===
    wait(ORDER_INTERVAL_MS)  // 2-4 Sekunden
  
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

## 7. CONFIG (FINAL)

```javascript
const CONFIG = {
  // === CORE ===
  EQUITY_PER_WINDOW: 0.80,         // 80% der Balance pro Window
  CHUNK_SIZE_MIN: 20,              // Minimum Shares pro Order
  CHUNK_SIZE_MAX: 200,             // Maximum (schützt Orderbuch)
  MERGE_MIN_SIZE: 10,              // Min Shares für Merge
  
  // === TIMING (KRITISCH) ===
  ENTRY_DELAY_MS: 5000,            // 5s nach Window-Open (Stargate5: 5-9s)
  ORDER_INTERVAL_MS: 2000,         // 2s zwischen Orders
  STOP_BUYING_BEFORE_END_S: 40,    // Aufhören 40s vor Window-Ende
  MERGE_BEFORE_END_S: 20,          // Merge 20s vor Window-Ende
  
  // === ORDER TYPE ===
  PRIMARY_ORDER_TYPE: 'GTC',       // GTC mit aggressivem Preis
  FALLBACK_ORDER_TYPE: 'FOK',      // FOK als Alternative
  SLIPPAGE_BUFFER: 0.02,           // +2¢ über Ask
  ORDER_TIMEOUT_MS: 3000,          // Cancel nach 3s wenn nicht gefüllt (Tempo > perfekte Fills)
  
  // === SAFETY NETS (sehr locker) ===
  MAX_ORDERS_PER_WINDOW: 30,       // Hard stop (Stargate5 macht 10-25)
  SKIP_IF_BEST_COMBINED_GT: 1.10,  // Skip nur wenn KOMPLETT kaputtes Buch
  MIN_BOOK_LEVELS: 3,              // Skip wenn Buch quasi leer
  
  // === KEIN STOP LOSS PRO PAAR ===
  // Einzelpaare KÖNNEN über 100¢ sein
  // Der GESAMTDURCHSCHNITT muss unter 100¢ liegen
  // Das passiert automatisch über viele Orders bei verschiedenen Preisen
  
  // === FEES ===
  FEE_MODEL: 'curve',              // NICHT flat!
  FEE_RATE: 0.25,                  // Polymarket crypto fee rate
  FEE_EXPONENT: 2,                 // Polymarket crypto fee exponent
  
  // === MARKET ===
  MARKET_TYPE: 'btc-updown-5m',
  
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

## 12. Warum unser vorheriger Bot nicht funktioniert hat

### Problem 1: 3 Minuten zu spät
- Bot fand den Market WÄHREND des Windows statt VORHER
- Billige Levels (7-20¢) waren schon weg
- Nur noch teure Levels (40-80¢) übrig → Combined >100¢

### Problem 2: Buy-Merge-Buy-Merge Cycle
- Bot merged nach jedem Paar
- Das kostet Zeit (Merge TX, Confirmation)
- Und es ist nicht was Stargate5 macht

### Problem 3: Flat 2% Fee
- Echte Fee ist 0.2-1.5% (Kurve)
- Flat 2% machte JEDES Paar unprofitabel in der Simulation
- Dry-Run zeigte nur Verluste → falsche Conclusion

### Problem 4: MAX_PAIRS = 5
- Zu wenig Orders
- Der Edge kommt aus dem Durchschnitt über VIELE Orders
- 5 Paare reichen nicht um die Preisoszillation auszunutzen

### Problem 5: Per-Pair Combined Check (97¢, dann 103¢)
- Einzelne Paare DÜRFEN über 100¢ sein
- Der Gesamtdurchschnitt zählt, nicht das Einzelpaar
- Ein Check pro Paar stoppt den Bot zu früh

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
╔══════════════════════════════════════════════════╗
║          HOLYPOLY MERGE-ARB BOT v3               ║
╠══════════════════════════════════════════════════╣
║ WHAT:  Buy Up + Down, Merge for $1               ║
║ WHEN:  Every 5-min BTC window, start at T+5s     ║
║ HOW:   Alternate Up/Down, ~180sh per order        ║
║        10-25 orders over 2-4 minutes              ║
║        Merge ALL matched shares at T+280s         ║
║ WHY:   Avg combined < 100¢ over many orders       ║
║ EDGE:  Price oscillation + extreme price levels   ║
║ RISK:  ~2-3% max per window (hedged position)     ║
╠══════════════════════════════════════════════════╣
║ CRITICAL: Start within 5-10s of window open!      ║
║ CRITICAL: Fee is CURVE not flat 2%!               ║
║ CRITICAL: NO per-pair combined check!             ║
║ CRITICAL: Discover market BEFORE window opens!    ║
╚══════════════════════════════════════════════════╝
```

---

## 16. Amendments (23. März 2026)

### 16.1 ORDER_TIMEOUT: 3s statt 5s

Wenn ein GTC-Order nach **3 Sekunden** nicht gefüllt ist → Cancel → nächste Order sofort.
Tempo ist wichtiger als perfekte Fills. Nicht retrien auf dem gleichen Level — der Preis
hat sich bewegt, nächster Order ist bei neuem Best Ask.

### 16.2 Competition & Market Maker Replenishment

Das Orderbuch wird von Market Makern **kontinuierlich nachgefüllt**. Wir müssen nicht
der Erste sein (Stargate5 und andere Bots fressen die 7¢-Levels), nur **schnell genug**
(<10s Entry). Selbst wenn die billigsten Levels weg sind:
- 15-25¢ Levels sind immer noch profitabel (Combined ~90-95¢)
- Market Maker stellen nach Sekunden neue Orders rein
- Je mehr Preise wir über das Window samplen, desto besser der Durchschnitt

### 16.3 Mid-Merge Recycling: Präzise Trigger

Mid-Merge ist die **Ausnahme**, nicht die Regel:
```
IF budget_remaining < chunk_size * 2   // Budget reicht nicht für nächstes Paar
   AND matched > merge_min_size         // Genug Shares zum Mergen
   AND time_remaining > 30s             // Genug Zeit um weiterzukaufen
THEN:
   merge(matched)
   budget += matched  // $1/share zurück
   → weiter kaufen mit recyceltem Kapital
ELSE:
   → weiter kaufen (Merge am Ende)
```

**Wenn Budget noch da ist → NICHT mergen, weiterkaufen.** Merge am Ende bleibt der Normalfall.

### 16.4 BTC-Preisoszillation

Schon **0.1% BTC-Bewegung** reicht damit Up von 40¢ auf 60¢ springt und Down von 60¢
auf 40¢ fällt. Das passiert innerhalb von 5 Minuten **ständig**. Nur bei absolut flachem
BTC (selten) bleibt es bei 50/50 = 100¢. Die Strategie profitiert von Volatilität —
und BTC 5-min Markets sind ultra-volatil.
