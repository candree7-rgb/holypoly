# HolyPoly v5 — DEFINITIVE Strategy Spec (Maker)

## DIESES DOKUMENT ERSETZT ALLE VORHERIGEN SPECS (inkl. V3+V4)

V1-V4 waren alle **TAKER**-Strategien (hitten den Ask). Taker-Fee auf Polymarket Crypto = 1-1.5%.
Up+Down Asks = ~101¢ zu jedem Zeitpunkt. 101¢ + 1.5¢ Fee = ~102.5¢ = **garantierter Verlust**.
Kein DCA, kein Oscillation-Timing, kein Dip-Detection kann das fixen.

**V5 ist eine MAKER-Strategie.** Maker-Fee = 0%. Wir posten Limit-Orders UNTER dem Ask.
Wir kontrollieren die Preise. Combined < 100¢. 0% Fee. Profit + Rebates.

---

## 1. Die Strategie in einem Absatz

Der Bot posted auf Polymarket 5-Min BTC Up/Down-Märkten **GTC Limit BUY Orders UNTER dem Ask** auf beiden Seiten (= Maker, 0% Fee). Er wählt die Preise so dass `upBid + dnBid < 100¢`. Wenn BTC oscilliert, sinkt der Ask einer Seite bis zu unserem Bid → Fill. Über 2-4 Minuten füllen sich beide Seiten. Am Ende des Windows merged er alle matched Shares zu je $1 zurück. Profit = $1 × matched_shares − total_cost. **Bei 0% Maker-Fee ist der gesamte Spread Profit.**

**KEY INSIGHT:** Maker-Fee = 0%. Taker-Fee = 1-1.5%. DAS ist der Edge. Nicht Oscillation, nicht DCA, nicht Timing. Die 0% Fee allein macht den Unterschied zwischen Profit und Verlust.

---

## 2. Was V1-V4 FALSCH hatten (und V5 korrigiert)

| V1-V4 (FALSCH) | V5 (RICHTIG) |
|----------------|--------------|
| **TAKER** — hitten den Ask | **MAKER** — posten Limit-Orders unter dem Ask |
| Taker-Fee: 1-1.5% | Maker-Fee: **0%** + Rebates |
| Preis = bestAsk + Slippage (teuer) | Preis = bestAsk - Offset (**wir wählen**) |
| Combined ≥ 101¢ + Fee = ~102.5¢ | Combined < 100¢ (weil wir die Preise setzen) |
| Oscillation/DCA/Dip-Detection | Unnötig — der Maker-Spread IST der Edge |
| Sofortiger Fill (taker) | Warten auf Fill (maker) — BTC muss sich bewegen |

---

## 3. Was Stargate5 WIRKLICH macht (Re-Interpretation #2)

Stargate5 ist ein **MAKER**, nicht ein Taker. Er postet Limit-Orders IM Orderbuch und wartet auf Fills.

### Beispiel: Maker Quoting in einem Window

```
T+5s:   Up bestAsk=48¢, Down bestAsk=54¢
        → Poste GTC BUY Up bei 46¢ (2¢ unter Ask = Maker)
        → Poste GTC BUY Down bei 52¢ (2¢ unter Ask = Maker)
        → Combined Bid: 46 + 52 = 98¢ → 2¢ Profit pro Share wenn filled
        → Fee: 0% (Maker)

T+30s:  BTC fällt → Up bestAsk sinkt auf 45¢
        → Up Ask (45¢) ≤ unserer Up Bid (46¢) → FILL! Up gekauft bei 46¢
        → Down Ask steigt auf 57¢ → kein Fill (57¢ > 52¢)
        → Cancel Down Bid, repost bei 55¢ (2¢ unter 57¢)

T+90s:  BTC steigt zurück → Down bestAsk sinkt auf 53¢
        → Down Ask (53¢) ≤ unserer Down Bid (55¢) → FILL! Down gekauft bei 55¢
        → Repost neue Bids für nächsten Chunk

...über 2-4 Minuten akkumulieren sich Fills auf beiden Seiten...

T+280s: MERGE
  Up gekauft bei: 46¢, 44¢, 47¢, 45¢     → avg Up = 45.5¢
  Down gekauft bei: 55¢, 52¢, 53¢, 54¢   → avg Down = 53.5¢
  Combined: 45.5 + 53.5 = 99¢ → 1¢ Profit pro Share
  Fee: $0 (MAKER!)
  Merged: 740 shares × 1¢ = $7.40 Profit + Rebates
```

**WARUM das funktioniert:**
- Maker Fee = 0% (Taker wäre 1-1.5% → Verlust)
- Wir WÄHLEN die Preise (bid unter Ask) → Combined < 100¢ garantiert
- BTC Oscillation bringt den Ask zu unseren Bids → Fills passieren
- Wenn BTC nicht oscilliert → keine Fills → kein Verlust (sicher)

**WARUM V1-V4 (Taker) NICHT funktionierten:**
- Taker hit den Ask → zahlt 1-1.5% Fee
- Up+Down Asks = ~101¢ → Combined inkl. Fee = ~102.5¢ → Verlust
- KEIN Taker-Ansatz kann profitabel sein bei 101¢ + Fee

---

## 4. Warum es funktioniert: Maker vs Taker

**FAKT: Maker Fee = 0%. Taker Fee = 1-1.5%.**

Das ist der GESAMTE Unterschied:

```
TAKER (V1-V4):
  Hit Up Ask bei 48¢ → Fee: 48¢ × 1.56% = 0.75¢
  Hit Dn Ask bei 54¢ → Fee: 54¢ × 0.88% = 0.47¢
  Combined: 48 + 54 + 0.75 + 0.47 = 103.2¢ → VERLUST

MAKER (V5):
  Post Up Bid bei 46¢ → Fee: 0¢
  Post Dn Bid bei 52¢ → Fee: 0¢
  Combined: 46 + 52 = 98¢ → PROFIT (2¢/share)
```

**Warum Maker funktioniert:**
1. **0% Fee** — kein Abzug vom Edge
2. **Wir wählen die Preise** — bidding UNTER dem Ask garantiert Combined < 100¢
3. **BTC Oscillation** — Preise bewegen sich, Ask sinkt zu unseren Bids → Fills
4. **Rebates** — Tägliche USDC-Rebates obendrauf (funded by taker fees)
5. **Sicher** — Wenn BTC nicht oscilliert, keine Fills → kein Verlust

**Trade-off:**
- Maker: Weniger Fills (müssen warten), aber jeder Fill ist profitabel
- Taker: Sofortige Fills, aber JEDER Fill ist ein Verlust

---

## 5. Definitive Parameter (V5 Maker)

### 5.1 Maker-Spezifische Parameter

| Parameter | Wert | Erklärung |
|-----------|------|-----------|
| MAKER_OFFSET_CENTS | 2 | Bid X¢ unter dem bestAsk (muss ≥1 für Maker-Status) |
| QUOTE_UPDATE_MS | 1000 | Wie oft Quotes updaten und Fills checken |

**Tuning:**
- MAKER_OFFSET_CENTS = 1 → Combined ~99¢, 1¢ Profit/share, mehr Fills (näher am Ask)
- MAKER_OFFSET_CENTS = 2 → Combined ~97¢, 3¢ Profit/share, weniger Fills (default)
- MAKER_OFFSET_CENTS = 3 → Combined ~95¢, 5¢ Profit/share, noch weniger Fills

### 5.2 Chunk-Size & Timing

| Parameter | Wert |
|-----------|------|
| Chunk-Size | ~180 Shares (berechnet aus Balance) |
| Market Discovery | VOR Window-Open |
| Quote-Start | T+5s (ENTRY_DELAY) |
| Quote-Update | Jede 1s |
| Cancel & Repost | Wenn Preis sich ≥2¢ bewegt hat |
| Letzte Order | Spätestens T+260s |
| Merge | T+270-290s |

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

## 6. Core Loop (V5 Maker — DEFINITIV)

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
  PHASE 1: MAKER QUOTING (T+5s bis T+260s)
  ═══════════════════════════════════════════════════

  active_up_order = null
  active_dn_order = null

  WHILE time < window_end - 40s AND budget > min_cost AND orders < max:

    // === LESE BEIDE BÜCHER ===
    up_ask = get_ws_book(up_token).bestAsk
    dn_ask = get_ws_book(dn_token).bestAsk

    // === BERECHNE MAKER BID PREISE ===
    up_bid = up_ask - MAKER_OFFSET_CENTS/100  // z.B. 48¢ - 2¢ = 46¢
    dn_bid = dn_ask - MAKER_OFFSET_CENTS/100  // z.B. 54¢ - 2¢ = 52¢
    // Combined: 46 + 52 = 98¢ → 2¢ Profit pro Share, 0% Fee

    // Ensure we're maker (strictly below ask)
    if up_bid >= up_ask: up_bid = up_ask - 0.01
    if dn_bid >= dn_ask: dn_bid = dn_ask - 0.01

    // === CHECK FILLS AUF AKTIVE ORDERS ===
    if active_up_order AND up_ask <= active_up_order.price:
      // Ask ist zu unserem Bid gesunken → FILL!
      record_fill("Up", chunk_size, active_up_order.price, fee=0)
      active_up_order = null

    if active_dn_order AND dn_ask <= active_dn_order.price:
      record_fill("Down", chunk_size, active_dn_order.price, fee=0)
      active_dn_order = null

    // === POST/UPDATE MAKER BIDS ===
    // Balance: nicht zu viel auf einer Seite akkumulieren
    if !active_up_order AND filled_up <= filled_dn + chunk_size:
      active_up_order = post_gtc_buy(up_token, chunk_size, up_bid)

    if !active_dn_order AND filled_dn <= filled_up + chunk_size:
      active_dn_order = post_gtc_buy(dn_token, chunk_size, dn_bid)

    // === REQUOTE wenn Preis sich bewegt hat ===
    if active_up_order AND |up_bid - active_up_order.price| >= 0.02:
      cancel(active_up_order)
      active_up_order = post_gtc_buy(up_token, chunk_size, up_bid)

    if active_dn_order AND |dn_bid - active_dn_order.price| >= 0.02:
      cancel(active_dn_order)
      active_dn_order = post_gtc_buy(dn_token, chunk_size, dn_bid)

    // === MID-MERGE wenn Budget knapp ===
    if budget < chunk_size * 2 AND matched > MERGE_MIN_SIZE:
      merge(matched)
      budget += matched

    wait(QUOTE_UPDATE_MS)  // 1s

  END WHILE

  // Cancel remaining active orders
  if active_up_order: cancel(active_up_order)
  if active_dn_order: cancel(active_dn_order)
  
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

## 7. CONFIG (V5 Maker FINAL)

```javascript
const CONFIG = {
  // === CORE ===
  EQUITY_PER_WINDOW: 0.80,
  CHUNK_SIZE_MIN: 20,
  CHUNK_SIZE_MAX: 200,
  MERGE_MIN_SIZE: 10,

  // === V5: MAKER STRATEGY ===
  MAKER_OFFSET_CENTS: 2,           // Bid X¢ unter bestAsk (≥1 für Maker-Status)
  QUOTE_UPDATE_MS: 1000,           // Quotes updaten / fills checken jede 1s

  // === TIMING ===
  ENTRY_DELAY_MS: 5000,
  STOP_BUYING_BEFORE_END_S: 40,
  MERGE_BEFORE_END_S: 20,

  // === ORDER TYPE ===
  PRIMARY_ORDER_TYPE: 'GTC',       // Resting limit orders = MAKER
  // Kein FOK fallback — wir WOLLEN maker sein, nicht taker

  // === SAFETY NETS ===
  MAX_ORDERS_PER_WINDOW: 30,
  SKIP_IF_BEST_COMBINED_GT: 1.10,
  MIN_BOOK_LEVELS: 3,

  // === FEES ===
  FEE_MODEL: 'maker',             // 0% maker fee!
  // Taker fee existiert noch im Code für Referenz, wird aber nicht benutzt

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

### DAS EINZIGE PROBLEM (V1-V4): TAKER-FEE

**ALLE V1-V4 waren Taker.** Taker-Fee = 1-1.5%. Up+Down Asks = ~101¢.
Combined als Taker: 101¢ + ~1.5¢ Fee = ~102.5¢ = **VERLUST. IMMER.**

Kein Oscillation-Timing (V4), kein blindes Alternieren (V3), kein DCA, kein Dip-Detection
kann das fixen. Solange wir den Ask HITTEN (Taker), verlieren wir die Fee.

| Version | Ansatz | Warum es scheiterte |
|---------|--------|---------------------|
| V1 | Buy-Merge-Buy-Merge | Taker + zu langsam + flat 2% fee |
| V2 | Schnellere Paare | Taker + immer noch 101¢ + Fee |
| V3 | Blind alternierend | Taker + jedes Paar = 101¢ + Fee |
| V4 | Oscillation DCA | Taker + kaufte nur eine Seite (Dip-Detection broken) |

### V5 Lösung
**Werde MAKER.** Poste Limit-Orders UNTER dem Ask. 0% Fee. Wähle die Preise.
Combined < 100¢ weil WIR die Bid-Preise setzen. Profit + Rebates.

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
╔══════════════════════════════════════════════════════════╗
║              HOLYPOLY MAKER BOT v5                       ║
╠══════════════════════════════════════════════════════════╣
║ WHAT:  Post limit bids on Up+Down, merge for $1         ║
║ WHEN:  Every 5-min BTC window, quote from T+5s          ║
║ HOW:   Post GTC BUY at bestAsk - 2¢ on BOTH sides       ║
║        Combined bid < 100¢ (we choose the prices!)       ║
║        Wait for fills — BTC oscillation crosses our bids ║
║        Update quotes every 1s if price moved ≥2¢         ║
║        Merge ALL matched shares at T+280s                ║
║ WHY:   Maker fee = 0% (taker = 1-1.5% → killed V1-V4)  ║
║ EDGE:  0% fee + we control prices + rebates              ║
║ RISK:  ~2% max per window (hedged position)              ║
╠══════════════════════════════════════════════════════════╣
║ CRITICAL: MAKER not TAKER — post BELOW ask!              ║
║ CRITICAL: Maker fee = 0%, taker fee = 1-1.5%!           ║
║ CRITICAL: combined bid must be < 100¢!                   ║
║ CRITICAL: Cancel + repost when price moves!              ║
╚══════════════════════════════════════════════════════════╝
```

---

## 16. V5 Amendments (23. März 2026)

### 16.1 FUNDAMENTALE ÄNDERUNG: Von Taker zu Maker

V1-V4 waren TAKER — hitten den Ask, zahlten 1-1.5% Fee, verloren IMMER.
V5 ist MAKER — postet Limit-Orders unter dem Ask, 0% Fee, kontrolliert die Preise.

### 16.2 WebSocket Book Updates (price_change)

`price_change` Events updaten die vollständigen `asks[]`/`bids[]` Arrays.
Kritisch für DRY_RUN: Maker-Fill wird erkannt wenn bestAsk ≤ unserer Bid-Preis.

### 16.3 DRY_RUN Maker Simulation

- Virtuelle Bids werden gepostet (kein API call)
- Jeder Tick: check ob bestAsk ≤ unser Bid → simulierter Fill
- Fill-Preis = unser Bid-Preis (nicht der Ask)
- Fee = $0 (Maker)
- `recordMakerFill()` updatet virtuelle Balance/Shares

### 16.4 Risiko: Flat BTC

Wenn BTC nicht oscilliert → Asks sinken nicht zu unseren Bids → keine Fills → kein Trade.
Das ist KORREKT und SICHER — kein Edge = kein Trade = kein Verlust.

### 16.5 Maker Rebates

Polymarket verteilt täglich USDC Rebates an Maker (funded by taker fees).
Top-Performer profitieren "von Rebates allein, nicht mal vom Spread."
Rebates werden NICHT im DRY_RUN simuliert — das ist zusätzlicher Profit on top.
