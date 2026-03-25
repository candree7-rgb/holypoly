# Executor Specification — Stargate-Style Polymarket Inventory Engine

## Purpose

This document defines how the executor should implement the current Stargate-style strategy thesis.

The goal is NOT to build a simple arbitrage bot or a simple trend bot.

The goal is to build a **fast, two-sided, merge-centric inventory engine** that:
- acquires both sides of the same condition rapidly
- alternates fills across sides
- uses trend / regime to determine ordering and aggressiveness
- improves both cost bases through micro-fills
- minimizes prolonged naked exposure
- merges matched inventory back into collateral
- operates on BTC short-duration markets (initially 5m, later 15m support)

---

## Core Principles

### 1. Two-sided by default
The executor should assume that both sides of a traded condition will be acquired.

A first-side fill is not the end of the trade.
It is the start of a balancing / inventory-building process.

### 2. Fast alternation
The expected flow is generally:

- side A
- side B
- side A
- side B

not:

- side A
- side A
- side A
- side A

Same-side repeated accumulation should be rare and justified by a strong regime/opportunity reason.

### 3. No prolonged naked exposure
A temporary imbalance is acceptable.
A prolonged one-sided inventory state is not.

The executor should aggressively monitor:
- which side is ahead
- how long one-sided inventory remains unbalanced
- whether the opposite side remains executable
- when balancing becomes mandatory

### 4. Merge is part of the main loop
Matched inventory is not just “nice to have”.
Merge is a central capital-recycling mechanism.

The executor should treat:
- pair construction
- mergeability
- merge timing
as core strategy components.

### 5. Trend and oscillation both matter
The executor must not assume that all good windows are pure oscillation.
Strong trend may dictate which side to acquire first.
Oscillation may improve opportunities for alternating fills and better average pricing.

### 6. Sub-100 is ideal, not mandatory
The executor should prefer excellent pair quality, but should not use a simplistic “only under 100c matters” view.

Reasonable pair construction quality bands are needed.

---

## Supported Market Types

## Phase 1
- BTC 5m

## Phase 2
- BTC 15m

Note:
5m and 15m should be treated as **related but parameter-distinct sub-modes**.
Shared logic is acceptable, but parameter sets and pacing may differ.

---

## High-Level Engine Model

The executor should behave like a **two-sided inventory state machine**.

---

## Inventory Definitions

For each condition:

- `upShares`
- `downShares`

Derived:
- `pairedShares = min(upShares, downShares)`
- `unpairedUp = upShares - pairedShares`
- `unpairedDown = downShares - pairedShares`

Cost basis tracking:
- `avgUpCost`
- `avgDownCost`
- `pairedCombinedAvg = avgUpCost + avgDownCost` (for matched inventory context)
- `marginalPairCost` = estimated cost of the next balancing unit

Runtime tracking:
- `lastFillSide`
- `lastFillTime`
- `timeSinceUnpaired`
- `fillCount`
- `buyCountBySide`
- `mergeCount`
- `regime`
- `mode`

---

## Executor State Machine

Recommended states:

### 1. `FLAT`
No inventory on either side.

Allowed actions:
- observe
- classify regime
- optionally place first fill

### 2. `FIRST_LEG_ACQUIRED`
One side has inventory, opposite side has none.

Allowed actions:
- prioritize acquiring the opposite side
- do NOT casually continue same-side accumulation
- enter balancing mode quickly

### 3. `BALANCING`
Both sides exist, but imbalance remains meaningful.

Allowed actions:
- prioritize short side
- selectively improve cost basis on either side only if justified
- keep moving toward pair quality + balance

### 4. `NEAR_BALANCED`
Both sides exist and inventory is close enough for efficient merge planning.

Allowed actions:
- fine-tune pair quality
- merge matched inventory
- optionally continue controlled alternating fills if window still attractive

### 5. `MERGE_READY`
Matched inventory has reached merge threshold / merge decision condition.

Allowed actions:
- merge paired inventory
- recycle capital
- leave residual inventory only if explicitly justified

### 6. `DEFENSIVE_REBALANCE`
Triggered when:
- one-sided exposure lasts too long
- opposite side becomes expensive
- inventory skew exceeds threshold
- window is approaching end
- pair quality is degrading

Allowed actions:
- prioritize neutralization / controlled balancing
- no speculative same-side expansion

### 7. `STOP_BUILD`
Triggered when:
- further accumulation is likely to worsen expectancy materially
- marginal pair quality becomes too poor
- market state is no longer suitable
- time remaining is too short

Allowed actions:
- merge what is acceptable
- rebalance leftovers if possible
- avoid further expansion

---

## Regime Model

Each window should be classified at minimum into:

- `TREND`
- `OSCILLATION`
- `SKIP`

### TREND
Characteristics:
- directional movement persists
- likely stronger pressure to acquire the strengthening side first
- balancing may happen on pullbacks or opposing repricing

### OSCILLATION
Characteristics:
- more back-and-forth repricing
- both sides offer repeated entry opportunities
- ideal for alternating cost-basis improvement

### SKIP
Characteristics:
- poor liquidity
- weak executable depth
- ugly book structure
- no clear tradable microstructure
- dangerous time-to-end conditions

---

## First-Side Selection Rules

The executor must NOT hardcode:
- always cheaper side first

Instead:

### In TREND
Prefer acquiring the side that is likely to become more expensive if not taken now.

Logic:
- the “winning” / strengthening side may need to be secured first
- the opposite side may be accumulated later on repricing / bounce / DCA-like balancing

### In OSCILLATION
Prefer whichever side is currently more favorable under:
- local repricing opportunity
- cost basis improvement
- expected alternation path

### In SKIP
Do nothing.

---

## Alternation Rules

### Hard philosophy
Alternation is the default operating pattern.

### Guidance
After one side is filled, the next priority is generally the opposite side.

### Same-side follow-up is allowed only when:
- regime strongly justifies it
- the opposite side is temporarily unexecutable
- pair-quality math still supports the move
- imbalance remains within allowed bounds
- time-to-rebalance remains acceptable

### Same-side expansion should be blocked if:
- it would materially increase one-sided exposure
- it worsens rescue risk
- it creates a likely future toxic pair
- it violates balancing urgency

---

## Pair Quality Bands

The executor should classify pair quality into bands.

Suggested conceptual bands:

### `IDEAL`
Very strong merge economics.
Clearly attractive combined construction.

### `GOOD`
Comfortably acceptable.
Likely profitable or strongly capital-efficient.

### `ACCEPTABLE`
Not perfect, but defensible.
May still be worthwhile for controlled merge and inventory safety.

### `DEFENSIVE`
Borderline construction.
May be tolerated only to avoid worse inventory outcomes.

### `TOXIC`
Too expensive / too poor.
Should not be built further.

Important:
The system must not behave as if every condition must end below 100c.
But it also must not drift into repeated toxic constructions.

---

## Fill Style

The executor should evolve toward **micro-fill behavior**, not only coarse chunking.

### Desired properties
- many small controlled fills
- rapid response to repricing
- alternating inventory improvement
- no giant rescue fills by default

### Avoid
- low-resolution “one big buy, one big hedge”
- heavy all-at-once catch-up fills
- uncontrolled same-side stacking

---

## Merge Logic

### Merge is required behavior, not optional decoration
Once matched inventory reaches acceptable state:
- merge should be considered part of the expected loop

### Merge should consider
- matched size
- pair quality
- time remaining
- remaining imbalance
- whether further improvement is realistic
- whether capital is better recycled now

### Merge philosophy
Prefer repeated capital recycling over overholding if the quality is acceptable and the window is maturing.

---

## Timing Logic

### General
The executor must care about:
- time since first fill
- time remaining to window end
- time spent unpaired
- time since last opposite-side acquisition

### Time-related defensive rules
As window end approaches:
- tolerance for new unpaired inventory should decrease
- tolerance for large same-side expansions should decrease
- merge / defensive rebalance urgency should increase

---

## Unpaired Exposure Logic

### Objective
Keep unpaired exposure:
- small
- short-lived
- intentional only when justified

### Track
- unpaired side
- size
- duration
- whether opposite side is executable now
- whether balancing path remains acceptable

### Trigger defensive mode when:
- unpaired duration exceeds threshold
- size exceeds allowed skew
- opposite side deteriorates
- time remaining gets short

---

## 5m vs 15m Handling

The same architecture can be shared, but 5m and 15m should not necessarily use identical parameters.

Areas likely needing asset/timeframe-specific tuning:
- observation length
- fill pacing
- imbalance tolerance
- merge timing
- first-side aggressiveness
- balancing urgency
- acceptable pair-quality bands

---

## What The Executor Must Not Do

Do NOT:
- reduce the strategy to static under-100 simultaneous arbitrage
- treat merge as a minor cleanup step
- allow repeated same-side buying without strong justification
- let imbalance sit for long periods
- assume all profitability comes from perfect pair construction
- ignore 15m just because 5m is easier to think about
- rely on overly optimistic fill assumptions

---

## Logging Requirements

For each variant / window, log:

- regime
- first-side decision and reason
- whether same-side expansion was allowed or blocked
- why the opposite side was or was not prioritized
- inventory state transitions
- paired/unpaired shares
- pair-quality band
- merge decisions and reasons
- defensive rebalance triggers
- final action and final reason

The goal is to make behavioral differences visible, not just final scoreboard metrics.

---

## Implementation Goal

The executor should increasingly resemble:

A **high-frequency, two-sided, alternating inventory engine**
that:
- reacts to trend and oscillation
- builds both sides quickly
- uses many controlled micro-fills
- keeps inventory close to balanced
- merges aggressively enough to recycle capital
- and avoids catastrophic inventory drift

This is the model we want.
