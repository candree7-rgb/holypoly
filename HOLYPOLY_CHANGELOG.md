# HolyPoly Spec — Changelog / Additions

Dieses Dokument enthält alle Ergänzungen zur Haupt-Spec.
Für Claude Code als zusätzlicher Kontext gedacht.

---

## 1. ORDER-TYP KLARSTELLUNG

Polymarket CLOB hat **keine Market Orders**. Alles sind Limit Orders.
Taker-Verhalten wird erreicht durch aggressive Preissetzung.

### Verfügbare Order-Typen auf Polymarket CLOB

| Typ | Verhalten | Für uns? |
|-----|-----------|----------|
| GTC (Good Till Cancel) | Bleibt im Buch bis gefillt oder gecancelt | **Ja, mit aggressivem Preis** |
| FOK (Fill or Kill) | Alles sofort füllen oder komplett canceln | **Ja, für saubere Fills** |
| GTD (Good Till Date) | Wie GTC mit Ablaufdatum | Nein |

### Unsere Order-Strategie: FOK bevorzugt, GTC als Fallback

```javascript
// BEVORZUGT: FOK — saubere Fills, kein Partial-Risiko
const order = {
  side: "BUY",
  tokenId: upTokenId,
  price: bestAsk + SLIPPAGE_BUFFER,  // z.B. Ask=0.45, wir bieten 0.47
  size: chunkSize,
  type: "FOK",  // Fill or Kill
  // Wenn der Ask sich bewegt hat und wir nicht komplett füllen können:
  // → Order wird gecancelt, kein Partial Fill
  // → Wir können mit neuem Preis nochmal versuchen
};

// FALLBACK: GTC mit aggressivem Preis
// Wenn FOK zu oft failt (dünnes Buch), nutze GTC:
const orderGTC = {
  side: "BUY",
  tokenId: upTokenId,
  price: bestAsk + SLIPPAGE_BUFFER,
  size: chunkSize,
  type: "GTC",
  // Risiko: Partial Fills möglich
  // Vorteil: Höhere Fill-Rate
  // WICHTIG: Nach Timeout (5s) → Cancel Rest-Order
};
```

### Warum FOK besser ist für uns

1. **Keine Partial Fills** → Imbalance-Problem entfällt
2. **Klares Ergebnis** → Entweder gefillt oder nicht
3. **Schneller** → Kein Warten auf Rest-Fill
4. **Down-Order kann exakt auf Up-Fill matchen** → Wenn Up FOK gefillt = 100% der Shares, dann Down = gleiche Menge

### Fallback zu GTC wenn

- FOK failt >2x hintereinander (Buch zu dünn für FOK)
- Dann: GTC mit 5s Timeout → Cancel unfilled Rest → Track actual filled

---

## 2. POSITION SIZING (Neue Section 8A)

### Kernpunkt: Merge-Recycling macht aggressives Sizing safe

```
$1000 Balance, 80% Equity ($800 Budget):

Zeitpunkt  Aktion                    Investiert  Frei    
T+5s       Buy Up  130sh × 50¢       $65        $735
T+7s       Buy Down 130sh × 48¢      $127       $673
T+9s       Buy Up  130sh × 52¢       $195       $605
T+11s      Buy Down 130sh × 46¢      $255       $545
T+13s      MERGE 260 shares           -          $805 (+$5 profit)
T+15s      Buy Up  130sh × 55¢       $72        $733
T+17s      Buy Down 130sh × 44¢      $129       $676
T+19s      Buy Up  130sh × 53¢       $198       $607
T+21s      Buy Down 130sh × 45¢      $257       $548
T+23s      MERGE 260 shares           -          $808 (+$3 profit)
T+25s      Buy Up  130sh × 58¢       $75        $733
T+27s      Buy Down 130sh × 43¢      $131       $677
T+29s      MERGE 130 shares           -          $808 (+$0 profit)

Total: 5 Paare, ~$8 Profit, max $257 gleichzeitig gebunden
Effektive Kapitalnutzung: nur ~32% gleichzeitig locked!
```

### Worst Case Tabelle

| EQUITY_PER_WINDOW | Budget | Max Loss pro Window | % von Balance |
|-------------------|--------|--------------------:|--------------|
| 30% | $300 | -$10 | -1.0% |
| 50% | $500 | -$16 | -1.6% |
| 80% | $800 | -$25 | -2.5% |
| 100% | $1000 | -$32 | -3.2% |

(Worst case = ALLE 5 Paare bei 105¢ Combined, was nur 5.3% der Windows passiert)

### Empfehlung

**Start: 30% → hochskalieren nach Validierung.**

```javascript
// CONFIG
EQUITY_PER_WINDOW: 0.80,  // Target nach Validierung
// Start mit 0.30, erhöhe nach 2-3 profitablen Tagen
```

### Chunk-Size Formel

```javascript
function calculateChunkSize(balance, config) {
  const budget = balance * config.EQUITY_PER_WINDOW;
  const pairsBeforeMerge = 3;  // merge after 2-3 pairs
  const estimatedAvgPrice = 0.50;
  const chunkSize = Math.floor(budget / (pairsBeforeMerge * 2 * estimatedAvgPrice));
  return Math.max(chunkSize, 20);  // minimum 20 shares
}
```

### Skalierungsplan

```
Woche 1: $500, 30% → ~$2-3/Window → ~$300/Tag
Woche 2: $900, 50% → ~$7-8/Window → ~$1000/Tag  
Woche 3: $1900, 80% → ~$20/Window → ~$2800/Tag
Woche 4: $4700, 80% → ~$50/Window → ~$7000/Tag
Limit: Orderbuch-Tiefe (zu große Chunks = du frisst das ganze Buch)
```

---

## 3. FILTER-PHILOSOPHIE (Finalisiert)

### MAX_PAIRS = 5 IST der Filter

Kein Preis-Threshold nötig. Der "Filter" ist: aufhören nach 5 Paaren.

**Warum:**
- Daten beweisen: 2-8 Orders = +$9-15 avg, 21+ Orders = NEGATIV
- Erste Fills sweepen billigste Levels (Combined oft 85-95¢)
- Jedes weitere Paar wird teurer (eigenen Edge auffressen)
- Kein Zeitverlust durch Orderbuch-Analyse

### Minimale Safety-Nets (sehr locker, triggern selten)

```javascript
MAX_COMBINED_ENTRY: 1.05,   // Skip Window nur wenn OFFENSICHTLICH kaputt
MAX_COMBINED_PAIR: 1.03,    // Stop mid-window nur bei extremem Overpay
MIN_BOOK_LEVELS: 3,         // Skip wenn Buch quasi leer
// Das ist alles. MAX_PAIRS = 5 macht den Rest.
```

### Was NICHT implementiert werden soll

- ❌ Kein 97¢ oder 99¢ Window-Gate
- ❌ Kein Running-Average-Stop
- ❌ Kein Binance-Signal
- ❌ Kein Trend-Filter
- ❌ Kein Tageszeit-Filter
- ❌ Kein selektives Window-Skipping

### Was implementiert werden soll

- ✅ MAX_PAIRS = 5 (hard stop)
- ✅ FOK Orders (clean fills)
- ✅ Dynamic Merge (merge wenn balanced, nicht nach Zeitplan)
- ✅ Filled-based Tracking (actual fills, nicht intended)
- ✅ Partial Fill Handling (Down passt sich an Up-Fill an)
- ✅ Speed first (3s Entry Delay, 2s zwischen Orders)
- ✅ Trade JEDES Window (kein Skipping)

---

## 4. UPDATED CONFIG (Final)

```javascript
const CONFIG = {
  // === CORE STRATEGY ===
  EQUITY_PER_WINDOW: 0.80,         // 80% — safe wegen hedged + recycling
  MAX_PAIRS: 5,                    // DER Filter. Nicht mehr, nicht weniger.
  MERGE_MIN_SIZE: 10,              // Min shares für Merge
  
  // === TIMING ===
  ENTRY_DELAY_MS: 3000,            // 3s nach Window-Open
  ORDER_INTERVAL_MS: 2000,         // 2s zwischen Orders
  
  // === ORDER TYPE ===
  ORDER_TYPE: 'FOK',               // Fill-or-Kill bevorzugt
  FALLBACK_ORDER_TYPE: 'GTC',      // GTC als Fallback
  SLIPPAGE_BUFFER: 0.02,           // +2¢ über Ask
  ORDER_TIMEOUT_MS: 5000,          // 5s Cancel für GTC
  
  // === LOOSE SAFETY NETS ===
  MAX_COMBINED_ENTRY: 1.05,        // Skip nur kaputte Bücher
  MAX_COMBINED_PAIR: 1.03,         // Stop bei extremem Overpay
  MIN_BOOK_LEVELS: 3,              // Min Levels pro Seite
  
  // === FILL HANDLING ===
  MAX_IMBALANCE_SHARES: 5,         // Max Imbalance vor Rebalance
  MAX_RETRIES_PER_ORDER: 1,        // 1 Retry bei Fail
  MAX_TRADES_PER_WINDOW: 12,       // Hard limit (5 pairs + retries)
  
  // === MARKET ===
  MARKET_TYPE: 'btc-updown-5m',
  TRADE_EVERY_WINDOW: true,        // Kein selektives Skipping
  
  // === EXIT ===
  AUTO_MERGE: true,                // Merge sofort wenn balanced
  AUTO_REDEEM_AFTER_RESOLUTION: true,
};
```

---

## 5. CORE LOOP FLOW (Vereinfacht)

```
Alle 5 Minuten:
  1. Finde nächsten Market (conditionId, tokenIds)
  2. Warte bis Window öffnet + 3s
  3. Quick Check: Buch hat ≥3 Levels auf beiden Seiten? Best combined < 105¢?
     → Nein: Skip
     → Ja: Weiter
  4. Berechne chunk_size aus Balance
  5. Loop (max 5 Paare):
     a. FOK Buy Up (chunk_size, ask + 2¢)
     b. FOK Buy Down (up_filled_size, ask + 2¢)  ← matched an actual Up fill!
     c. Wenn balanced: MERGE
     d. Warte 2s
  6. Final Merge (was noch übrig ist)
  7. Nach Resolution: Redeem übrige Imbalance
  8. Log P&L, update Balance
```

---

## 6. ERROR RECOVERY (Zusammenfassung)

| Szenario | Aktion |
|----------|--------|
| Up gefillt, Down nicht | Retry Down 1x → wenn nein: Sell Up oder hold für Resolution |
| Partial Fill | Down-Size = Up-actual-fill (nicht geplante Size) |
| Merge fehlschlägt | Retry → wenn nein: hold für Resolution + Redeem |
| API Timeout | Cancel offene Orders, merge was da ist |
| Bot Crash | Startup: Check offene Positions → Merge oder Redeem |
| >2 Fails hintereinander | Abort Window, merge existierende Shares |
