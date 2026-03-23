# HolyPoly Bot — Complete Strategy Specification

## Reverse-Engineering von Stargate5 (Polymarket Merge-Arb Bot)

**Basierend auf:** 295.911 API Activity-Einträge, 13.792 Windows, 103 Tage Daten (11. Dez 2025 – 23. März 2026)

**Wallet:** `0xb4d2499b6cabd0bb93672bb17c5ae47101759ee1`

**Performance:** ~$140.000 Profit in ~4 Monaten, nahezu linearer Equity-Verlauf ohne signifikante Drawdowns.

---

## 1. Strategie-Übersicht

### Was der Bot macht (ein Satz)

Der Bot kauft auf Polymarket 5-Minuten BTC Up/Down-Märkten **beide Seiten** (Up UND Down) mit gleicher Stückzahl und **merged sofort vor Resolution** zu je $1/Share zurück. Der Profit entsteht wenn die Summe der Kaufpreise (Up + Down) unter $1.00 liegt.

### Warum es funktioniert

Die Polymarket CLOB-Orderbücher für 5-Min-BTC-Märkte haben zu Beginn jedes Windows eine **strukturelle Ineffizienz**: Die Summe aller Ask-Preise über die gesamte Orderbuch-Tiefe liegt im Durchschnitt leicht unter $1.00. Der Bot exploitet diesen Edge durch schnelles Sweeping beider Seiten und sofortiges Merging.

### Kernmechanik

```
Für jedes 5-Minuten-Window:
  1. Window öffnet
  2. Bot scannt Orderbuch (beide Seiten)
  3. Bot kauft alternierend Up und Down (Taker-Orders)
  4. Sobald genug matched Shares → MERGE zu $1/Share
  5. Recyceltes Kapital → weitere Paare kaufen
  6. Repeat bis Orderbuch zu dünn oder Window fast vorbei
  7. Übrige Imbalance → Redeem nach Resolution oder Sell
```

---

## 2. Bewiesene Strategie-Parameter

Alle Werte stammen aus der statistischen Analyse von 295.911 Activity-Einträgen.

### 2.1 Order-Typ: 100% Taker

| Evidenz | Wert |
|---------|------|
| MAKER_REBATE Events | 3 von 295.911 (0.001%) |
| Conclusion | **Pure Taker** — er postet keine Limit-Orders |

Der Bot submitted **IOC (Immediate-or-Cancel) oder FOK (Fill-or-Kill) Orders** auf dem CLOB und hit den existierenden Ask. Er wartet nie auf Fills.

### 2.2 Richtungssignal: Keins

| Evidenz | Wert |
|---------|------|
| Share-Allocation Up vs Down | 49.98% Up / 50.02% Down |
| Absolute Share-Bias pro Window | 0.18% median |
| Windows mit <1% Bias | 96.6% |
| Korrelation Markt-Bias → Profit | -0.056 (null) |
| Korrelation Markt-Bias → Num Trades | -0.008 (null) |

**Kein Binance-Feed, kein Trend-Filter, keine Prediction.** Der Bot ist richtungsneutral.

### 2.3 Beide Seiten — Immer

| Evidenz | Wert |
|---------|------|
| Windows mit beiden Seiten | 99.8% (13.768 / 13.792) |
| Share-Balance (min/max ratio) | 99.94% median |
| >99% balanced | 95.5% aller Windows |

### 2.4 Alternierung Up/Down

| Evidenz | Wert |
|---------|------|
| Alternation-Ratio | 0.808 (1.0 = perfekt, 0.5 = random) |
| Erste Seite pro Window | 50.3% Up, 49.7% Down (kein Bias) |
| Teure Seite zuerst | 61.8% |

Der Bot alterniert systematisch Up-Down-Up-Down, startet aber tendenziell mit der teureren Seite.

### 2.5 Chunk-Size (Shares pro Order)

| Eigenschaft | Wert |
|-------------|------|
| Overall median | 79.6 shares |
| Overall mean | 90.8 shares |
| **Innerhalb eines Windows: Std** | **0.37 shares** (quasi identisch) |
| Zwischen Tagen: Range | 36 – 193 shares |
| Zwischen Tagen: abhängig von | Bankroll / Tagesbudget |

**Kritisches Detail:** Innerhalb eines Windows haben alle Orders nahezu **exakt gleiche** Stückzahl. Die Stückzahl wird pro Tag/Session berechnet, wahrscheinlich als:

```
chunk_size = tages_budget / (erwartete_anzahl_paare * erwarteter_avg_preis)
```

#### Chunk-Size Beispiele nach Datum

| Datum | Avg Chunk | Median Chunk |
|-------|-----------|--------------|
| 2. März | 36.2 | 42.0 |
| 6. März | 79.0 | 78.2 |
| 15. März | 184.8 | 184.0 |
| 22. März | 168.7 | 162.8 |
| 23. März | 178.7 | 177.2 |

### 2.6 Entry-Timing

| Parameter | Wert |
|-----------|------|
| Erste Order nach Window-Open | Median: 9 Sekunden |
| 25th Percentile | 5 Sekunden |
| 75th Percentile | 31 Sekunden |
| Median aller Orders | 172 Sekunden |
| Trading-Phase Dauer | ~2-4 Minuten |

**Trend über Zeit:** Der Bot wird schneller.

| Monat | Avg Entry Delay |
|-------|-----------------|
| Dez 2025 | 314s |
| Jan 2026 | 338s |
| Feb 2026 | 239s |
| März 2026 | 121s |

### 2.7 Orders pro Window

| Statistik | Wert |
|-----------|------|
| Median | 16 |
| Mean | 18.7 |
| Mode | 10 |
| Range | 1 – 766 |

Verteilung:

| Anzahl Trades | Häufigkeit |
|---------------|------------|
| 1-2 | 3.9% |
| 3-4 | 5.0% |
| 5-10 | 25.4% |
| 11-20 | 39.2% |
| 21-40 | 22.8% |
| 40+ | 3.8% |

### 2.8 Preise: Orderbook-basiert, nicht fix

| Evidenz | Wert |
|---------|------|
| Preis-Entropy | 96% (quasi uniform über 1-99¢) |
| Preis-Spread innerhalb eines Windows | Median 38.7¢ |
| Feste Preislevel | Nein |

Der Bot nimmt was im Orderbuch steht. Keine fixen Cent-Werte.

#### Preise nach Markt-Bias

| Markt-Situation | Up-Range | Down-Range | Avg Combined |
|-----------------|----------|------------|--------------|
| Balanced (45-55¢) | 29¢ – 69¢ | 28¢ – 68¢ | 99.3¢ |
| Up biased (>70¢) | 60¢ – 91¢ | 7¢ – 35¢ | 97.8¢ |
| Down biased (<30¢) | — | — | 96.0¢ |

**Key Insight:** Der Edge ist am größten wenn der Markt stark biased ist (eine Seite sehr billig).

### 2.9 Price-Gaps zwischen Orders

| Gap (¢) | Häufigkeit |
|---------|------------|
| 0¢ | 23.4% |
| 1¢ | 21.2% |
| 2¢ | 12.3% |
| 3¢ | 8.5% |
| 4¢ | 6.2% |
| 5¢ | 4.7% |

Median Gap: **2¢** — der Bot sweept eng beieinanderliegende Preislevel.

### 2.10 Time-Gaps zwischen Orders

| Gap | Häufigkeit |
|-----|------------|
| 0s (same second) | 13.2% |
| 2s | 16.0% |
| 4s | 9.6% |
| 6s | 7.4% |
| 8s | 6.1% |
| 10s | 5.6% |
| 11-30s | 22.9% |
| 31-120s | 16.3% |

Typischer Rhythmus: eine Order alle **2-10 Sekunden**.

---

## 3. Merge-Mechanik

### 3.1 Merge-Timing

| Parameter | Wert |
|-----------|------|
| Merge VOR Resolution (<300s) | 73.4% |
| Median Merge-Offset | 277s (4:37 min) |
| Zeit: letzter Buy → erster Merge | Median: 8 Sekunden |
| Sofort-Merge (<30s nach letztem Buy) | 57.7% |

**Der Bot merged sofort wenn die Shares balanced sind.** Kein Warten.

### 3.2 Interleaved Merging (Kapital-Recycling)

In 45.4% der Windows kauft er **nach dem ersten Merge weiter**. Der typische Flow:

```
Runde 1: Buy Up → Buy Down → Buy Up → Buy Down → MERGE
Runde 2: Buy Up → Buy Down → Buy Up → Buy Down → MERGE  (mit recyceltem Kapital)
Runde 3: Buy Up → Buy Down → MERGE
Cleanup: REDEEM oder SELL übrige Shares
```

| Merges pro Window | Häufigkeit |
|-------------------|------------|
| 1 | 58.1% |
| 2 | 17.0% |
| 3 | 8.0% |
| 4 | 4.9% |
| 5+ | 12.0% |

### 3.3 Buys vor erstem Merge

| Anzahl Buys | Häufigkeit |
|-------------|------------|
| 2 | 3.7% |
| 4 | 10.8% |
| 6 | 9.5% |
| 8 | 7.6% |
| 10 | 9.5% |
| 12 | 6.1% |
| 16 | 5.8% |
| 18 | 4.2% |
| 22 | 4.4% |

Peaks bei **geraden Zahlen** (logisch — jedes Paar = 2 Orders).

### 3.4 Merge-Größe

| Statistik | Wert |
|-----------|------|
| Mean | 337.9 shares |
| Median | 161.0 shares |
| Match zu akkumulierten Shares | 83.5% exakt |

**In 83.5% der Fälle merged er exakt die matched Shares zu diesem Zeitpunkt.**

---

## 4. Exit-Strategie

### 4.1 Primärer Exit: Merge (vor Resolution)

| Exit-Typ | Häufigkeit |
|----------|------------|
| Nur Merge (clean exit) | 63.5% |
| Merge + Redeem | 22.8% |
| Merge + Sell | 11.7% |
| Merge + Redeem + Sell | 2.0% |

### 4.2 Sells

| Parameter | Wert |
|-----------|------|
| Total Sells | 9.128 (3.5% aller Trades) |
| Sells VOR Resolution | 23.3% |
| Sells NACH Resolution | 76.3% |
| Sell-Preise < 50¢ | 47.3% (Verlierer loswerden) |
| Sell-Preise > 95¢ | 19.5% (Gewinner abräumen) |
| Sell-Seite Up vs Down | 50/50 |

### 4.3 Redeems

| Parameter | Wert |
|-----------|------|
| Total Redeems | 3.410 |
| Mean Redeem Size | 37.8 shares |
| Purpose | Übrige Imbalance nach Resolution einlösen |

---

## 5. Stop Loss / Risk Management

### 5.1 Kein expliziter Stop Loss

| Evidenz | Wert |
|---------|------|
| Windows mit Combined > $1.00 | 31.4% |
| Windows mit Combined > $1.05 | 5.3% |
| Max Verlust einzelnes Window | -$848.47 |
| Korrelation #Trades ↔ Cost | 0.081 (schwach) |

**Er hat keinen Stop Loss.** Er merged alles, auch wenn es Verlust macht.

### 5.2 Profitabilität nach Orderbuch-Tiefe

| Trades pro Window | Avg P&L | Avg % |
|-------------------|---------|-------|
| 2-4 (flach) | **+$15.10** | +9.5% |
| 5-8 | +$9.62 | +3.1% |
| 9-14 | +$7.19 | +1.2% |
| 15-20 | +$0.18 | +0.3% |
| 21-30 | **-$10.27** | -0.5% |
| 31-50 | -$18.17 | -0.7% |

**KRITISCH:** Die ersten paar Fills sind extrem profitabel. Je tiefer ins Buch, desto schlechter. Die optimale Strategie wäre: nur 2-8 Orders pro Window platzieren, nicht 16-20. Stargate5 overtradet wahrscheinlich — seine Profitabilität wird durch die teuren späten Fills reduziert.

### 5.3 Combined-Cost Analyse

| Combined-Cost | % der Windows |
|---------------|---------------|
| < 95¢ | 17.8% |
| < 98¢ | 43.5% |
| < 100¢ | 68.6% |
| ≥ 100¢ | 31.4% |
| ≥ 105¢ | 5.3% |

Gewichteter Avg Combined (über alle Windows): **97.97¢** → ~2¢ Edge pro Share.

### 5.4 Paired-Trade Combined-Preise

Die Combined-Preise der individuellen Paare (Up+Down in Sequenz):

| Combined | % der Paare |
|----------|-------------|
| < 90¢ | 11.0% (fetter Gewinn) |
| 90-95¢ | 7.1% |
| 95-100¢ | 18.5% |
| 100-102¢ | 18.9% |
| 102-105¢ | 20.7% |
| > 105¢ | 17.1% (Verlust) |

**53.2% der Einzelpaare liegen ÜBER $1.00.** Der Profit kommt aus dem **gewichteten Durchschnitt** — die 11% unter 90¢ (bis zu 50¢ Combined!) kompensieren die vielen knappen Verluste.

### 5.5 Worst Case

| Worst Day | P&L |
|-----------|-----|
| Schlechtester Tag | ca. -$2.200 |
| Bester Tag | ca. +$2.700 |

---

## 6. Window-Selektion

### 6.1 Coverage

| Parameter | Wert |
|-----------|------|
| Windows pro Tag (avg) | 140 |
| Mögliche Windows pro Tag | 288 |
| Coverage | 48.7% |

### 6.2 Skip-Pattern

| Gap-Typ | Häufigkeit |
|---------|------------|
| 300s (consecutive) | 52.9% |
| 600s (skip 1) | 1.9% |
| 900s (skip 2) | 43.0% |

**Muster:** Er traded in **Serien** (T→T: 50.3%) und pausiert in Serien (S→S: 41.6%). Übergänge T→S und S→T sind selten (0.4%). Das deutet auf Bot-Sessions hin — er läuft für X Stunden, pausiert, läuft wieder.

### 6.3 Aktivität nach Tageszeit (UTC)

Relativ gleichmäßig über 24h:

| Zeitraum (UTC) | Relative Aktivität |
|----------------|-------------------|
| 00-06 UTC | Hoch (~600 Windows/Stunde) |
| 06-12 UTC | Mittel-Hoch (~590) |
| 13-15 UTC | Niedrig (~440) |
| 16-23 UTC | Mittel (~530) |

Kein klarer Tageszeit-Filter.

### 6.4 Vermutetes Skip-Kriterium

Wir können nicht direkt sehen warum er skippt, aber die Evidenz deutet auf:

1. **Bot läuft in Sessions** (Serien von Trades, dann Pause)
2. **Möglicherweise Orderbuch-Check:** Wenn Combined-Ask über einem Threshold liegt, wird das Window übersprungen
3. **Kein Tageszeit-Filter** (24h aktiv)

---

## 7. Strategie-Evolution

| Monat | Avg Chunk | Windows | Avg Delay | Avg Price |
|-------|-----------|---------|-----------|-----------|
| Dez 2025 | 116.6 | 1.877 | 314s | 0.500 |
| Jan 2026 | 102.1 | 2.682 | 338s | 0.486 |
| Feb 2026 | 64.5 | 4.165 | 239s | 0.494 |
| Mär 2026 | 107.4 | 5.068 | 121s | 0.493 |

**Key Trends:**
- **Windows pro Monat steigen** (1.877 → 5.068) — er skaliert hoch
- **Entry-Delay sinkt drastisch** (314s → 121s) — er wird schneller
- **Chunk-Size schwankt** — bankroll-abhängig, nicht linear

---

## 8. Edge Cases & Anomalien

### 8.1 Ethereum-Versuch

Hat am 23. Januar kurz ETH Up/Down probiert (~60 Trades), dann wieder nur BTC. ETH-Märkte haben wahrscheinlich zu wenig Liquidität.

### 8.2 Transaktionsstruktur

| Parameter | Wert |
|-----------|------|
| Events pro Transaction | 1.00 (kein Batching) |
| Jede Order = eigener TX | Ja |

Kein Smart-Contract-Batching. Jede Order wird einzeln submitted.

### 8.3 Preis-Progression innerhalb eines Windows

| Seite | Erste Orders | Letzte Orders | Veränderung |
|-------|-------------|---------------|-------------|
| Up | 49.8¢ | 48.4¢ | -1.4¢ |
| Down | 49.3¢ | 48.4¢ | -0.9¢ |

**Beide Seiten werden billiger über die Trading-Phase** — nicht weil das Buch dünner wird, sondern weil der Running-Combined-Cost sinkt, sobald mehr Shares matched sind (mathematischer Effekt der Kalkulation).

### 8.4 Sells vor Resolution (Optionale Optimierung)

In 23.3% der Fälle verkauft er Shares **vor Resolution**. Dies passiert wahrscheinlich wenn:
- Eine Seite bei 95¢+ steht (quasi sicherer Gewinner) → verkaufen statt auf Merge/Resolution warten
- Das gibt sofortiges Kapital zurück
- Risiko: Falls der Markt dreht, wäre der Sell ein Fehler

---

## 9. Bot-Architektur (Implementierungsplan)

### 9.1 Technologie-Stack

| Komponente | Empfehlung |
|------------|------------|
| Runtime | Bun (schnellster JS runtime) |
| API | Polymarket CLOB REST + WebSocket |
| HTTP Client | undici (persistent connections) |
| Order-Typ | GTC Limit Orders (aggressiv, am Ask) |
| Hosting | Railway US-East (nah an Polymarket) |
| Monitoring | WebSocket für Fills, Polling für Orderbook |

### 9.2 Core Loop v2 (Pseudocode — Production-Ready)

```
LOOP every 5 minutes (aligned to window schedule):
  
  1. DISCOVER next market
     - GET upcoming conditionId + token IDs (Up token, Down token)
     - If no market found: WAIT and retry
  
  2. WAIT until window opens (T+0) + ENTRY_DELAY
  
  3. PRE-FLIGHT CHECK (loose — rarely skips)
     - Fetch orderbook: asks for Up, asks for Down
     - IF fewer than MIN_BOOK_LEVELS on either side → SKIP
     - IF best_up_ask + best_dn_ask > MAX_COMBINED_ENTRY (105¢) → SKIP
     - ELSE → PROCEED (trade every window, speed first)
  
  4. CALCULATE chunk_size
     available_capital = balance * EQUITY_PER_WINDOW
     chunk_size = available_capital / NUM_PAIRS / estimated_avg_price
     // Round to nearest whole share
  
  5. EXECUTE buy cycle (FILLED-BASED TRACKING)
     
     // === STATE (track ACTUAL fills, not intended) ===
     filled_up_shares = 0
     filled_dn_shares = 0
     total_up_cost = 0
     total_dn_cost = 0
     available_budget = available_capital
     pair_count = 0
     
     WHILE pair_count < MAX_PAIRS AND available_budget > MIN_ORDER_SIZE:
       
       // --- PRE-TRADE CHECK (loose safety net) ---
       refresh orderbook (both sides)
       next_up_ask = best available ask for Up (at chunk_size depth)
       next_dn_ask = best available ask for Down (at chunk_size depth)
       expected_combined = next_up_ask + next_dn_ask
       
       IF expected_combined > MAX_COMBINED_PAIR (103¢):
         LOG "Combined too expensive: {expected_combined}¢ — stopping"
         BREAK
       
       IF depth_available(Up) < chunk_size OR depth_available(Down) < chunk_size:
         LOG "Insufficient depth — stopping"
         BREAK
       
       // --- BUY UP ---
       up_order = submit_buy(
         token: Up_token,
         size: chunk_size,
         price: next_up_ask + SLIPPAGE_BUFFER,  // e.g., +1¢ tolerance
         type: FOK or IOC
       )
       
       WAIT for fill confirmation (WebSocket or poll, timeout 5s)
       
       IF up_order.status == FILLED:
         up_filled = up_order.filled_size        // ACTUAL filled, not requested
         up_cost = up_order.filled_cost           // ACTUAL cost
         filled_up_shares += up_filled
         total_up_cost += up_cost
         available_budget -= up_cost
       ELSE IF up_order.status == PARTIAL:
         up_filled = up_order.filled_size
         up_cost = up_order.filled_cost
         filled_up_shares += up_filled
         total_up_cost += up_cost
         available_budget -= up_cost
         // Adjust Down order to match partial fill
         chunk_size_adjusted = up_filled
       ELSE:  // REJECTED or TIMEOUT
         LOG "Up order failed — skipping pair"
         CONTINUE or BREAK
       
       // --- BUY DOWN (matched to Up fill) ---
       target_dn_size = up_filled  // MATCH to what Up actually filled
       
       dn_order = submit_buy(
         token: Down_token,
         size: target_dn_size,
         price: next_dn_ask + SLIPPAGE_BUFFER,
         type: FOK or IOC
       )
       
       WAIT for fill confirmation
       
       IF dn_order.status == FILLED or PARTIAL:
         dn_filled = dn_order.filled_size
         dn_cost = dn_order.filled_cost
         filled_dn_shares += dn_filled
         total_dn_cost += dn_cost
         available_budget -= dn_cost
         
         // Handle partial: if Down filled less than Up
         IF dn_filled < up_filled:
           // IMBALANCE: we have more Up than Down
           // Option A: immediately buy more Down to match
           // Option B: accept small imbalance, fix at merge time
           imbalance = up_filled - dn_filled
           IF imbalance > MAX_IMBALANCE_SHARES:
             补buy_dn = submit_buy(Down, imbalance, market_price, IOC)
             // track fills...
       ELSE:
         // Down order completely failed — we have naked Up exposure
         LOG "WARNING: Down failed, naked Up position"
         // Option A: Sell the Up shares immediately
         // Option B: Hold and hope Down fills on retry
         // Option C: Accept and handle at cleanup
         RETRY down_order once
         IF still failed: mark for cleanup
       
       pair_count += 1
       
       // --- DYNAMIC MERGE CHECK (after every pair) ---
       matched = min(filled_up_shares, filled_dn_shares)
       
       IF matched >= MERGE_MIN_SIZE:
         // Calculate current cost per matched share
         total_cost = total_up_cost + total_dn_cost
         cost_per_matched = total_cost / matched
         
         LOG "Matched: {matched} shares, cost: {cost_per_matched}"
         
         // MERGE
         merge_tx = submit_merge(conditionId, matched)
         
         IF merge_tx.success:
           recovered = matched * 1.00  // $1 per share returned
           profit_this_batch = recovered - (cost_per_matched * matched)
           available_budget += recovered
           
           // Reset accumulators (only the merged portion)
           filled_up_shares -= matched
           filled_dn_shares -= matched
           // Proportionally reduce costs
           up_share_of_cost = total_up_cost / (total_up_cost + total_dn_cost)
           total_up_cost -= matched * cost_per_matched * up_share_of_cost
           total_dn_cost -= matched * cost_per_matched * (1 - up_share_of_cost)
           
           LOG "Merged {matched} shares, profit: ${profit_this_batch}"
         ELSE:
           LOG "Merge failed — will retry"
           // Don't reset accumulators, try again after next pair
       
       // --- PACE CONTROL ---
       WAIT ORDER_INTERVAL_MS (2-4 seconds)
     
     // END WHILE
  
  6. FINAL MERGE
     matched = min(filled_up_shares, filled_dn_shares)
     IF matched > 0:
       submit_merge(conditionId, matched)
       filled_up_shares -= matched
       filled_dn_shares -= matched
  
  7. CLEANUP (schedule for after resolution at T+300)
     // Remaining imbalance = unmatched shares on one side
     remaining_up = filled_up_shares
     remaining_dn = filled_dn_shares
     
     IF remaining_up > 0:
       // After resolution: if Up won → REDEEM (get $1/share)
       // If Up lost → SELL at market (near 0, minimize loss)
       // Or: just REDEEM — Polymarket handles payout automatically
       REDEEM remaining_up shares
     
     IF remaining_dn > 0:
       REDEEM remaining_dn shares
  
  8. LOG & UPDATE
     log_window_result(conditionId, total_cost, total_merged, profit, imbalance)
     update_bankroll(balance)
```

### 9.3 Konfigurierbare Parameter

```javascript
const CONFIG = {
  // === CORE STRATEGY (the real edge) ===
  EQUITY_PER_WINDOW: 0.20,         // 20% of total equity per window
  MAX_PAIRS: 5,                    // THE KEY PARAMETER: only 5 pairs (10 orders)
                                   // Data proves: 2-8 orders = best P&L
                                   // This IS the filter — no price threshold needed
  MERGE_MIN_SIZE: 10,              // Don't merge if < 10 shares matched
  
  // === ENTRY TIMING (speed > everything) ===
  ENTRY_DELAY_MS: 3000,            // 3s after window open (stargate5: 5-9s)
  ORDER_INTERVAL_MS: 2000,         // 2s between orders (fast but not spammy)
  
  // === LOOSE SAFETY NETS (rarely trigger, prevent catastrophe) ===
  MAX_COMBINED_ENTRY: 1.05,        // Skip window only if OBVIOUSLY broken (>105¢)
  MAX_COMBINED_PAIR: 1.03,         // Stop mid-window only if pair would cost >103¢
  MIN_BOOK_LEVELS: 3,              // Skip if < 3 levels on either side
  
  // === FILL HANDLING ===
  SLIPPAGE_BUFFER: 0.02,           // Accept up to 2¢ worse than quoted
  ORDER_TIMEOUT_MS: 5000,          // Cancel if not filled within 5s
  MAX_IMBALANCE_SHARES: 5,         // Max acceptable imbalance before rebalance
  MAX_RETRIES_PER_ORDER: 1,        // Retry failed orders once
  
  // === RISK LIMITS ===
  MAX_TRADES_PER_WINDOW: 12,       // Hard stop (5 pairs + retries)
  MAX_EXPOSURE_USDC: null,         // Dynamic, based on EQUITY_PER_WINDOW
  
  // === MARKET SELECTION ===
  MARKET_TYPE: 'btc-updown-5m',    // Only BTC 5-minute
  TRADE_EVERY_WINDOW: true,        // No selective skipping (like stargate5)
  
  // === EXIT ===
  AUTO_MERGE: true,                // Merge immediately when balanced
  AUTO_REDEEM_AFTER_RESOLUTION: true,
};
```

### 9.4 Pre-Trade Combined Check (Safety Net — NOT the main filter)

The main filter is `MAX_PAIRS = 5`. These checks are loose safety nets that rarely trigger.

```javascript
function shouldBuyNextPair(upBook, dnBook, chunkSize, pairNum) {
  // HARD STOP: max pairs reached
  if (pairNum >= CONFIG.MAX_PAIRS) return { buy: false, reason: 'max pairs reached' };
  
  // SAFETY: check depth exists
  const upSimulation = simulateFill(upBook.asks, chunkSize);
  if (!upSimulation.canFill) return { buy: false, reason: 'insufficient Up depth' };
  
  const dnSimulation = simulateFill(dnBook.asks, chunkSize);
  if (!dnSimulation.canFill) return { buy: false, reason: 'insufficient Down depth' };
  
  // LOOSE SAFETY: only block obviously broken books (>103¢)
  const expectedCombined = upSimulation.avgPrice + dnSimulation.avgPrice;
  if (expectedCombined > CONFIG.MAX_COMBINED_PAIR) {
    return { buy: false, reason: `combined ${expectedCombined} > ${CONFIG.MAX_COMBINED_PAIR} — too expensive` };
  }
  
  // Otherwise: BUY. Speed matters more than filtering.
  return {
    buy: true,
    expectedCombined,
    upPrice: upSimulation.avgPrice,
    dnPrice: dnSimulation.avgPrice,
  };
}

function simulateFill(asks, targetSize) {
  // Walk through orderbook levels to calculate volume-weighted avg price
  let remaining = targetSize;
  let totalCost = 0;
  let totalFilled = 0;
  
  for (const [price, size] of asks) {
    const fillAtLevel = Math.min(remaining, size);
    totalCost += fillAtLevel * price;
    totalFilled += fillAtLevel;
    remaining -= fillAtLevel;
    if (remaining <= 0) break;
  }
  
  return {
    canFill: remaining <= 0,
    avgPrice: totalFilled > 0 ? totalCost / totalFilled : 0,
    totalCost,
    totalFilled,
    levelsUsed: asks.length - (remaining > 0 ? 1 : 0),
  };
}
```

### 9.5 Partial Fill & Imbalance Handling (Detail)

```javascript
// After each Up buy, adjust Down target to match ACTUAL fill
async function executePair(upToken, dnToken, chunkSize) {
  // Buy Up
  const upResult = await submitBuy(upToken, chunkSize);
  
  if (upResult.filledSize === 0) {
    return { success: false, reason: 'up_not_filled' };
  }
  
  // Buy Down — TARGET = what Up actually filled
  const dnTarget = upResult.filledSize;  // NOT chunkSize
  const dnResult = await submitBuy(dnToken, dnTarget);
  
  if (dnResult.filledSize === 0) {
    // NAKED UP — need to handle
    return { 
      success: false, 
      reason: 'down_not_filled',
      nakedUp: upResult.filledSize,
      // Bot should: retry Down, or sell Up, or hold for resolution
    };
  }
  
  // Track imbalance
  const imbalance = Math.abs(upResult.filledSize - dnResult.filledSize);
  
  if (imbalance > CONFIG.MAX_IMBALANCE_SHARES) {
    // Buy more of the short side to rebalance
    const shortSide = upResult.filledSize > dnResult.filledSize ? dnToken : upToken;
    const rebalanceSize = imbalance;
    await submitBuy(shortSide, rebalanceSize);
  }
  
  return {
    success: true,
    upFilled: upResult.filledSize,
    dnFilled: dnResult.filledSize,
    upCost: upResult.cost,
    dnCost: dnResult.cost,
    combined: (upResult.cost + dnResult.cost) / Math.min(upResult.filledSize, dnResult.filledSize),
    imbalance,
  };
}
```

### 9.6 Dynamic Merge Trigger (Detail)

```javascript
// Merge is NOT on a fixed schedule — it fires when conditions are met
function shouldMerge(filledUp, filledDn, totalCost) {
  const matched = Math.min(filledUp, filledDn);
  
  // Condition 1: enough matched shares to justify gas cost
  if (matched < CONFIG.MERGE_MIN_SIZE) return false;
  
  // Condition 2: we actually have balanced inventory
  // (don't merge if one side is way ahead — wait for rebalance)
  const imbalancePct = Math.abs(filledUp - filledDn) / Math.max(filledUp + filledDn, 1);
  if (imbalancePct > 0.10) return false;  // >10% imbalance, wait
  
  // Condition 3: merge is profitable or near-breakeven
  // Even if slightly negative, merge to free capital
  // (stargate5 merges even at loss — the recycled capital matters more)
  
  return true;
}
```

### 9.7 Polymarket API Endpoints benötigt

| Aktion | Endpoint | Methode |
|--------|----------|---------|
| Orderbuch lesen | `GET /book` | REST |
| Preis abrufen | `GET /price` | REST |
| Order platzieren | `POST /order` | REST (signed) |
| Order canceln | `DELETE /order/{id}` | REST (signed) |
| Merge ausführen | On-chain TX (CTF contract) | Web3 |
| Redeem | On-chain TX (CTF contract) | Web3 |
| Neue Märkte finden | `GET /markets` | REST |
| Fill-Bestätigung | WebSocket User Channel | WSS |
| Markt-Updates | WebSocket Market Channel | WSS |

### 9.8 Merge-Implementierung

Merge ist ein **On-Chain-Call** auf dem Conditional Token Framework (CTF) Contract:

```solidity
// CTF Contract: mergePositions
// Burns equal amounts of ALL outcome tokens → returns collateral (USDC)
function mergePositions(
  IERC20 collateralToken,   // USDC
  bytes32 parentCollectionId, // 0x0 for root
  bytes32 conditionId,       // Market condition ID
  uint[] calldata partition, // [1, 2] for binary market
  uint amount                // Number of shares to merge
)
```

**Wichtig:** Merge benötigt gleiche Anzahl Shares auf ALLEN Outcomes. Vor dem Merge muss `min(up_shares, down_shares)` berechnet werden.

### 9.9 Order-Signing (Polymarket CLOB)

Polymarket CLOB nutzt EIP-712 Signed Orders. Jede Order muss mit dem privaten Schlüssel signiert werden:

```javascript
const order = {
  salt: randomSalt(),
  maker: walletAddress,
  signer: walletAddress,
  taker: "0x0000000000000000000000000000000000000000",
  tokenId: tokenId,        // Up or Down token ID
  makerAmount: makerAmount, // USDC amount (in base units)
  takerAmount: takerAmount, // Shares to receive
  expiration: 0,           // 0 = no expiry
  nonce: 0,
  feeRateBps: feeRate,
  side: "BUY",
  signatureType: 2,        // POLY_GNOSIS_SAFE or EOA
};
```

### 9.10 Race Conditions & Latenz (CRITICAL)

```
Problem:
  Du liest Orderbuch: Up Ask = 45¢, Down Ask = 50¢ → Combined 95¢ ✓
  Du submittest Up Buy...
  20ms später: anderer Bot kauft die gleiche Up-Order
  Dein Fill: Up = 52¢ (nächstes Level)
  Tatsächlicher Combined: 52¢ + 50¢ = 102¢ → Verlust

Mitigationen:
  1. SLIPPAGE_BUFFER in Preis einbauen (+1-2¢ über Quote)
     → akzeptiert schlechteren Fill, aber wird überhaupt gefillt
  
  2. FOK (Fill-or-Kill) Orders verwenden
     → entweder komplett zum Preis oder gar nicht
     → keine Partial Fills auf unerwünschtem Level
  
  3. NACH Fill den Combined-Cost neu berechnen
     → nicht auf Pre-Trade-Simulation vertrauen
     → basiere Merge-Entscheidung auf TATSÄCHLICHEN Fill-Preisen
  
  4. Orderbook REFRESH vor jeder Order (nicht nur am Anfang)
     → buys[i] basiert auf frischem Book, nicht auf altem Snapshot
  
  5. Latenz minimieren:
     → Railway US-East (selbe Region wie Polymarket)
     → Persistent HTTP connections (undici)
     → WebSocket für Fills statt Polling
     → Bun runtime statt Node.js
```

### 9.11 Error Handling & Recovery

```
SCENARIO 1: Order submission fails (network/API error)
  → Retry once with exponential backoff (500ms)
  → If still fails: skip this pair, continue with next
  → If >2 consecutive failures: abort window, merge what we have

SCENARIO 2: Order timeout (submitted but no fill confirmation)
  → After 5s: check order status via REST
  → If OPEN: cancel order (DELETE /order/{id})
  → If FILLED: continue normally
  → If PARTIAL: accept partial, adjust next order

SCENARIO 3: Merge transaction fails (on-chain)
  → Check: do we actually have the tokens? (balance check)
  → If yes: retry merge with same params
  → If gas issue: increase gas, retry
  → If persistent: hold positions, redeem after resolution

SCENARIO 4: Stuck in unbalanced position (Up filled, Down not)
  → If < 60s before resolution: hold, redeem after resolution
  → If > 60s remaining: attempt to buy Down at market
  → Worst case: sell Up at market (accept small loss)

SCENARIO 5: Market disappears / gets cancelled
  → Check market status before each window
  → If market cancelled: positions auto-settle

SCENARIO 6: Bot crash mid-window
  → On startup: check for open positions
  → For each open position: check if merged/resolved
  → If unmerged + unresolved: merge or hold for resolution
  → NEVER leave naked positions untracked
```

### 9.12 Risiken & Mitigationen

| Risiko | Wahrscheinlichkeit | Impact | Mitigation |
|--------|-------------------|--------|------------|
| Orderbuch zu dünn | Hoch | Kein Trade | Pre-flight depth check → Skip Window |
| Combined > $1.00 | ~30% der Paare | Verlust | Pre-trade check: skip pair if expected > 97¢ |
| Partial Fill (eine Seite) | Mittel | Imbalance | Down-Size an Up-Fill anpassen |
| Naked Position (eine Seite nicht gefillt) | Selten (0.2%) | Direktionsrisiko | Sofort Gegenseite nachkaufen oder verkaufen |
| Race Condition (Preis ändert sich) | Häufig | Schlechterer Fill | Slippage Buffer +1-2¢, FOK Orders |
| Merge fehlschlägt (on-chain) | Selten | Locked Capital | Retry, dann Redeem nach Resolution |
| API Downtime | Gelegentlich | Verpasste Windows | Auto-Reconnect, Graceful Degradation |
| Bot Crash mid-window | Selten | Offene Positionen | Startup-Recovery: Check + Merge/Redeem |
| Competition (andere Bots) | Steigend | Sinkender Edge | Schnellere Latenz, weniger Orders (nur die profitablen) |
| Polymarket Regeländerung | Unbekannt | Strategie kaputt | Daily Monitoring, P&L Alerts |
| Gas-Spike bei Merge | Gelegentlich | Merge zu teuer | Gas-Limit setzen, bei Spike warten |

---

## 9A. Wie wir unter 100¢ bleiben (Kernfrage)

### Die Erkenntnis aus den Daten

Stargate5 bleibt **im Durchschnitt** unter 100¢ (median 98.52¢), aber 31.4% seiner Einzelwindows sind drüber. Er hat keinen Filter und akzeptiert Verluste.

**Aber:** Er macht auch 16-18 Orders pro Window und die Daten zeigen eindeutig:

| Orders pro Window | Avg P&L | Avg % |
|-------------------|---------|-------|
| 2-4 | **+$15.10** | +9.5% |
| 5-8 | **+$9.62** | +3.1% |
| 9-14 | +$7.19 | +1.2% |
| 15-20 | +$0.18 | +0.3% |
| 21-30 | **-$10.27** | -0.5% |

Die ersten Fills sweepen die **billigsten Levels** im Orderbuch — dort wo Combined oft 85-95¢ ist. Jedes weitere Paar geht tiefer ins Buch und wird teurer. Ab ~10 Orders vernichtet man seinen eigenen Edge.

### Unsere Strategie: MAX_PAIRS = 5 IST der Filter

Wir brauchen **keinen Preis-Filter**. Der "Filter" ist einfach: **aufhören nach 5 Paaren** (10 Orders).

Warum das besser ist als ein Combined-Threshold:

1. **Kein Zeitverlust** — kein Orderbuch-Scanning vor dem Trade
2. **Keine False Negatives** — kein Risiko dass gute Windows rausgefiltert werden
3. **Funktioniert bei jedem Bias** — egal ob 50/50 oder 80/20
4. **Mathematisch bewiesen** — die ersten 5 Paare sind statistisch IMMER die profitabelsten

### Minimale Sicherheitsnetze (sehr locker)

Trotzdem ein paar Safety-Checks die quasi nie triggern, aber vor extremen Edge-Cases schützen:

```
Window-Gate:  IF Orderbuch hat < 3 Levels auf einer Seite → SKIP
              IF best_up_ask + best_dn_ask > 105¢ → SKIP
              (= nur offensichtlich kaputte Bücher vermeiden)

Pair-Gate:    IF next_up_ask + next_dn_ask > 103¢ → STOP buying
              (= verhindert extremen Overpay, aber greift selten)

Hard Stop:    MAX_PAIRS = 5 (= max 10 Orders, IMMER)
              (= DAS ist der echte Schutz)
```

### Erwartete Performance vs Stargate5

| Metrik | Stargate5 | HolyPoly (projected) |
|--------|-----------|---------------------|
| Windows/Tag | 140 | 140+ (jedes Window) |
| Orders/Window | 16-18 | 8-10 (5 Paare) |
| Avg Profit/Window | $1.78 | ~$9-12 |
| Win-Rate | 56.8% | ~65-70% (weniger teure Paare) |
| Daily Profit | ~$250 | ~$1.200-1.600 |
| Kapital benötigt | ~$10k+ | ~$2-3k (weniger pro Window) |

**Disclaimer:** Diese Projektion basiert auf historischen Daten. Reale Performance kann abweichen, insbesondere durch Competition und sich ändernde Liquidität.

---

## 10. Optimierungs-Empfehlungen

### 10.1 Weniger Orders = Mehr Profit (UNSER KERN-EDGE)

Stargate5 macht im Schnitt 16-18 Orders pro Window. Die Daten zeigen klar:

- **2-8 Orders:** +$9-15 avg pro Window
- **15-20 Orders:** ±$0 avg
- **21+ Orders:** NEGATIV

**Unser Ansatz:** `MAX_PAIRS = 5` (10 Orders). Das ist kein willkürliches Limit — es ist die datenbasierte Optimierung. Die ersten Fills sweepen die billigsten Orderbuch-Levels. Danach werden die Fills teurer weil wir unseren eigenen Edge auffressen. Aufhören nach 5 Paaren = nur die profitablen Fills mitnehmen.

**Das IST unser Filter.** Kein Preis-Threshold nötig. Keine Orderbuch-Analyse vor dem Trade. Einfach: 5 Paare, mergen, fertig, nächstes Window.

### 10.2 Biased Märkte bevorzugen

| Markt-Typ | Avg Combined | Edge |
|-----------|-------------|------|
| Stark biased (eine Seite <30¢) | 96.0¢ | 4.0¢ |
| Mäßig biased (30-40¢ / 60-70¢) | 97.8¢ | 2.2¢ |
| Balanced (45-55¢) | 99.3¢ | 0.7¢ |

**Info:** Biased Märkte sind natürlich profitabler, aber wir filtern NICHT danach — wir traden jedes Window. Der Bias-Vorteil kommt automatisch: in biased Windows sind unsere 5 Paare billiger, in balanced Windows knapper. Der Durchschnitt ist profitabel.

### 10.3 Latenz optimieren

Stargate5 startet bei Median 9s. Jede Sekunde früher = bessere Preise (die billigsten Levels werden zuerst weggenommen). Ziel: unter 5 Sekunden.

### 10.4 Smart Merge-Timing

Stargate5 merged im Median 8s nach dem letzten Buy. Das ist gut, aber Interleaved Merging (merge während noch gekauft wird) erlaubt Kapital-Recycling:

```
Ohne Recycling: $1000 Kapital → ~$1000 in Shares
Mit Recycling:  $1000 Kapital → $1000 + $980 + $960 = ~$2940 in Shares
```

### 10.5 Kein Stop-Cost-Threshold nötig

Stargate5 hat keinen Stop Loss — und wir brauchen auch keinen. Unser `MAX_PAIRS = 5` ist effektiver als jeder Preis-Threshold:

- **Preis-Threshold:** Kostet Zeit (Orderbuch-Check), kann gute Windows rausfiltern, der 5-Min-Markt ändert sich ständig
- **MAX_PAIRS = 5:** Kein Zeitverlust, keine False Negatives, nimmt automatisch nur die billigsten Levels

Die einzigen Safety-Nets sind extrem locker (105¢ Window-Gate, 103¢ Pair-Gate) — sie triggern fast nie, aber verhindern Katastrophen.

---

## 11. Daten-Referenz

### 11.1 Quelldaten

- **Wallet:** `0xb4d2499b6cabd0bb93672bb17c5ae47101759ee1`
- **API Endpoint:** `https://data-api.polymarket.com/activity`
- **Total Entries:** 295.911
- **Zeitraum:** 11. Dez 2025 – 23. März 2026

### 11.2 Wichtige Felder pro Activity Entry

| Feld | Beschreibung |
|------|-------------|
| `timestamp` | Unix timestamp (Sekunden) |
| `type` | TRADE, MERGE, REDEEM, SPLIT, MAKER_REBATE |
| `side` | BUY, SELL |
| `outcome` | Up, Down |
| `price` | Preis pro Share (0.00-1.00) |
| `size` | Anzahl Shares |
| `usdcSize` | Dollar-Betrag |
| `conditionId` | Eindeutige Market ID (pro 5-Min-Window) |
| `slug` | Market-Slug mit Window-Timestamp |
| `outcomeIndex` | 0 = erste Outcome, 1 = zweite |
| `asset` | Token ID (unterschiedlich für Up und Down) |

### 11.3 Window-Timing aus Slug

Der Slug enthält den Window-Start als Unix-Timestamp:

```
btc-updown-5m-1774247700
                ^^^^^^^^^ = Window start (Unix timestamp)
```

Window-Dauer: 300 Sekunden (5 Minuten).
Resolution: Bei oder kurz nach Window-Ende.

---

## 12. Checkliste für Implementierung

- [ ] CLOB API Authentifizierung (EIP-712 Signing)
- [ ] Market Discovery: Neue 5-Min-Windows automatisch erkennen
- [ ] Orderbook-Scanner: Beide Seiten, Combined-Cost berechnen
- [ ] Order-Placement: Taker-Orders, IOC/GTC
- [ ] Fill-Tracking: WebSocket für Echtzeit-Fill-Bestätigung
- [ ] Balance-Tracker: Running Up/Down Share-Count
- [ ] Merge-Logic: CTF Contract Call, min(up, down) Shares
- [ ] Kapital-Recycling: Merge-Revenue sofort für neue Orders verfügbar
- [ ] Cleanup: Redeem/Sell übrige Shares nach Resolution
- [ ] Bankroll-Management: Chunk-Size dynamisch berechnen
- [ ] Logging: Jeder Trade, jeder Merge, P&L pro Window
- [ ] Error Handling: API Timeouts, fehlgeschlagene Merges, partielle Fills
- [ ] Monitoring: Equity Curve, Daily P&L, Alert bei Anomalien
- [ ] Deployment: Railway US-East, Auto-Restart, Health Checks
