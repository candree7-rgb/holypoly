# Implementation Plan: Merge-Arb Strategy + Realistic DRY_RUN

## Übersicht

Neue Strategie basierend auf HOLYPOLY_STRATEGY_SPEC.md (Stargate5-Clone):
- **Richtungsneutral**: Buy Up + Buy Down alternierend
- **Merge sofort** wenn balanced → $1/Share → Kapital recyceln
- **MAX_PAIRS = 5** als Hauptfilter
- **FOK/Taker** Orders (nicht GTC Ladder)
- **DRY_RUN=true** simuliert realistisch gegen echtes Live-Orderbook

## Was bleibt (bestehende Infrastruktur)

- `src/data/clob.ts` — CLOB API Client (Orders, Balance, Fills)
- `src/data/clob-ws.ts` — Orderbook WebSocket (PING/PONG schon drin)
- `src/data/gamma.ts` — Market Discovery
- `src/data/binance-ws.ts` — BTC Price Feed
- `src/data/rtds-ws.ts` — Settlement/Chainlink Feed
- `src/data/redeem.ts` — Auto-Redeem via Relayer
- `src/data/data-api.ts` — Position Queries
- `src/db.ts` — PostgreSQL Persistence
- `src/config.ts` — Config System (wird erweitert)
- `src/logger.ts` — Structured Logging
- `src/telegram.ts` — Alerts
- `src/utils.ts` — Helpers
- `src/types.ts` — Type Definitions (wird erweitert)
- `src/risk/limits.ts` — Risk Manager
- `src/execution/window-manager.ts` — Window Lifecycle

## Was ersetzt/neu wird

### Step 1: Config erweitern (`src/config.ts`)

Neue Parameter für Merge-Arb Strategie:
```typescript
// Merge-Arb Strategy Config
equityPerWindow: number;        // 0.20 (20% of balance)
maxPairs: number;               // 5
mergeMinSize: number;           // 10 shares
entryDelayMs: number;           // 3000 (3s nach Window-Open)
orderIntervalMs: number;        // 2000 (2s zwischen Orders)
slippageBuffer: number;         // 0.02 (+2¢)
orderTimeoutMs: number;         // 5000
maxCombinedEntry: number;       // 1.05 (105¢)
maxCombinedPair: number;        // 1.03 (103¢)
minBookLevels: number;          // 3
maxImbalanceShares: number;     // 5
maxRetriesPerOrder: number;     // 1
maxTradesPerWindow: number;     // 12
autoMerge: boolean;             // true
```

### Step 2: Merge-Arb Executor (`src/execution/merge-arb-executor.ts`) — NEW

Core execution engine. Replaces SignalExecutor for the new strategy.

```
Flow per Window:
1. Pre-flight check (book depth, combined cost)
2. Calculate chunk_size from balance
3. Loop (max 5 pairs):
   a. Refresh orderbook
   b. Pre-trade combined check (<103¢)
   c. FOK Buy Up (chunk_size, bestAsk + slippage)
   d. FOK Buy Down (actual_up_filled shares, bestAsk + slippage)
   e. Track fills (actual, not intended)
   f. Dynamic merge check → merge if balanced
   g. Wait ORDER_INTERVAL_MS
4. Final merge
5. Schedule cleanup (redeem after resolution)
6. Log P&L
```

Key methods:
- `executeWindow(window, balance)` — Main loop for one 5-min window
- `preFlightCheck(upBook, dnBook)` — 105¢ gate + depth check
- `shouldBuyNextPair(upBook, dnBook, pairNum)` — 103¢ pair gate
- `executePair(upToken, dnToken, chunkSize)` — FOK Buy Up + Down
- `tryMerge(conditionId, matched)` — CTF merge call
- `handleImbalance(...)` — Rebalance if one side short
- `cleanup(...)` — Post-resolution redeem

### Step 3: DRY_RUN Fill Engine (`src/execution/dry-run-engine.ts`) — NEW

Realistic simulation against LIVE orderbook via WebSocket.

```
When DRY_RUN=true:
- WebSocket connects normally (no auth needed for market channel)
- Orders are NOT sent to CLOB API
- Instead: simulate FOK fill against current orderbook snapshot

simulateFokFill(tokenId, size, maxPrice):
  1. Get current book from ClobWsClient.getBook(tokenId)
  2. Walk asks up to maxPrice, accumulate fills
  3. If total fillable >= size → FILLED (return avg price, cost)
  4. If partial but FOK → REJECTED (return nothing)
  5. Track: virtual balance, virtual positions, virtual merges

simulateMerge(matched):
  1. Deduct matched shares from both sides
  2. Credit matched * $1.00 to virtual balance
  3. Calculate profit = $1.00 - avg_combined_cost per share

Virtual State:
  - virtualBalance: starts at config balance
  - virtualUpShares / virtualDnShares: running totals
  - virtualUpCost / virtualDnCost: running costs
  - virtualMergeProfit: accumulated merge P&L
  - fillLog: array of {timestamp, side, size, price, type}
```

### Step 4: Integrate into Main Loop (`src/index.ts`)

New strategy mode: `STRATEGY_MODE=merge-arb` (default)

```
Main Loop:
1. Discover next 5-min window
2. Subscribe CLOB WS to Up+Down tokens
3. Wait until window open + ENTRY_DELAY_MS
4. If DRY_RUN: use DryRunEngine for fills/merges
   If LIVE: use real CLOB API
5. Call mergeArbExecutor.executeWindow(window, balance)
6. After resolution: auto-redeem remaining imbalance
7. Log settlement, update DB
```

### Step 5: Update CLAUDE.md

Replace webhook strategy description with merge-arb strategy.

### Step 6: Types erweitern (`src/types.ts`)

```typescript
interface PairResult {
  pairNum: number;
  upFilled: number;
  upCost: number;
  upPrice: number;
  dnFilled: number;
  dnCost: number;
  dnPrice: number;
  combinedCents: number;
  imbalance: number;
}

interface WindowExecutionResult {
  pairs: PairResult[];
  totalMerged: number;
  totalMergeProfit: number;
  remainingUp: number;
  remainingDn: number;
  totalCost: number;
  avgCombinedCents: number;
  dryRun: boolean;
}
```

### Step 7: DB Schema Update

Extend `window_trades` for merge-arb fields:
- `pairs_count` — how many pairs traded
- `total_merged` — shares merged
- `merge_profit` — profit from merges
- `remaining_imbalance` — leftover shares
- `avg_combined_cents` — average combined entry cost

## Execution Order

1. **Config** — Add merge-arb parameters
2. **Types** — New interfaces
3. **DryRunEngine** — Orderbook-based simulation
4. **MergeArbExecutor** — Core strategy logic
5. **Main Loop** — Wire up new strategy mode
6. **CLAUDE.md** — Update documentation
7. **Test** — Run with DRY_RUN=true against live WS
