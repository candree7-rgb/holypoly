# Stargate Reverse-Engineered Strategy Thesis

## Purpose

This document defines the current best reconstruction of the Stargate-style Polymarket strategy, based on historical observations and ongoing dry-run experimentation.

This is NOT a generic Polymarket trading strategy.
This is specifically an attempt to model a highly active, highly hedged, merge-heavy execution system that appears to operate mostly on short-duration BTC Up/Down markets.

---

## What We Now Believe With High Confidence

### 1. Two-sided trading is core, not incidental
Historical data strongly suggests that Stargate trades both sides of the same condition in ~99.8% of traded conditions.

This means:
- two-sided hedging is NOT cosmetic
- it is NOT a rare emergency behavior
- it is NOT something that only happens occasionally after a directional bet
- it is a core structural feature of the strategy

### 2. Merge is central
A very high percentage of two-sided traded conditions also show merge activity.

This means:
- merge is not a minor technical afterthought
- merge is a core capital-recycling mechanism
- the strategy likely relies on repeatedly building mergeable paired inventory and converting it back into collateral

### 3. The strategy is not pure simultaneous orderbook arbitrage
The two sides are often bought relatively close together in time, but not always at the exact same instant.

Observed timing suggests:
- fast sequential two-sided construction
- not static “buy both sides now below 100c” logic
- not long naked directional holding
- but rapid inventory building across both sides in short bursts

### 4. 5m and 15m both matter
Historical activity suggests that both:
- BTC 5-minute markets
- BTC 15-minute markets

are relevant to the real strategy family.

Therefore:
- 15m should not be treated as irrelevant
- but 5m and 15m may still need separate parameterization and sub-logic

### 5. The strategy uses many micro-fills per condition
Historical buy counts per condition are often high.

This strongly suggests:
- the real engine is higher-resolution than our current simplified implementations
- inventory is likely managed through many small fills
- the strategy is probably not just “one entry + one hedge + merge”
- it is more likely a dense micro-fill balancing system

### 6. Combined cost is not always under 100c
Historical combined average buy costs are often near 100c, but not always below it.

Therefore:
- the real strategy is NOT simply “always build both sides under 100c”
- slightly above 100c may still be acceptable if it prevents much worse inventory outcomes
- the strategy likely prioritizes controlled balancing and capital recycling, not perfection on every condition

---

## Core Strategy Thesis

The current best thesis is:

Stargate is likely a high-frequency, two-sided inventory-management strategy that:
- determines which side to buy first based on trend / regime / local opportunity
- rapidly alternates between sides
- uses many small fills
- improves both cost bases over time through gaps, bounces, and repricing
- tries to stay close to balanced inventory
- avoids prolonged naked exposure
- and repeatedly merges matched inventory back into collateral

This is best described as:

**fast sequential two-sided inventory construction + merge-based capital recycling**

Not:
- pure directional trend trading
- pure static under-100 arbitrage
- pure simultaneous hedge entry
- simple one-entry / one-exit scalping

---

## Core Behavioral Principles

### A. Two-sided always
The strategy should almost never devolve into long one-sided holding.
A side may be entered first, but the opposite side should be pursued quickly.

### B. Alternation is fundamental
The intended flow is closer to:
- Up → Down → Up → Down
or
- Down → Up → Down → Up

rather than:
- Up → Up → Up → Up
or
- Down → Down → Down → Down

The system may temporarily lean to one side, but the dominant pattern should be rapid re-balancing and alternating side acquisition.

### C. Trend / oscillation determines ordering
The strategy is not necessarily symmetric in all market regimes.

Likely:
- in a strong trend, buy the likely winning / strengthening side first because it may become more expensive
- in oscillation or unresolved conditions, buy whichever side is temporarily mispriced / favorable first, then rebalance through repricing

So:
- ordering is regime-dependent
- not fixed

### D. Cost-basis improvement through volatility
The strategy likely uses:
- strong short-term movement
- bouncebacks
- repricing gaps
- local overreaction
- short-term trend extensions

to progressively improve the blended cost basis across both sides.

This behaves somewhat like controlled DCA across both sides, but with alternating inventory logic rather than passive averaging.

### E. Merge is part of the profit engine
The strategy likely profits not only from “perfect under-100 pairs”, but from:
- high-frequency capital recycling
- many acceptable paired constructions
- avoiding catastrophic pair quality
- repeated merge / reset cycles

### F. Avoiding disaster is as important as seeking edge
A 101c protected pair may be acceptable if it avoids becoming a 120c+ inventory disaster later.
The system likely cares about:
- keeping both sides in play
- avoiding bad runaway one-sided inventory
- preserving capital efficiency

---

## What The Strategy Is NOT

It is NOT:
- “wait until Up ask + Down ask < 100 and buy both”
- “always buy the cheaper side first”
- “let one side run and hedge much later”
- “directional bet first, hedge if convenient”
- “long naked exposure with occasional balancing”
- “single-entry/single-hedge simplification”

---

## Working Hypothesis for Execution

### 1. Window selection
The system likely filters for specific market states, such as:
- tradable liquidity
- sufficiently reactive books
- conditions where both sides remain executable
- potentially trend-following or oscillatory states where rapid alternating fills are possible

### 2. First side selection
The first side is chosen according to:
- trend direction
- current local repricing opportunity
- cost of waiting
- risk that the favored side becomes more expensive quickly

### 3. Rapid balancing
Once one side is taken, the system quickly seeks the opposite side.
It does not want long naked exposure.

### 4. Alternating fill sequence
After both sides are in inventory, the system may continue adding in alternating fashion when favorable repricing appears.

### 5. Inventory compression
The system gradually compresses the effective combined cost of paired inventory, or at minimum avoids letting inventory become dangerously imbalanced or too expensive.

### 6. Merge and recycle
Matched inventory is merged back into collateral and redeployed repeatedly.

---

## Important Open Questions

We do NOT yet know:

1. How much of the edge comes from:
   - trend selection
   - oscillation / gap capture
   - liquidity reading
   - timing
   - micro-fill density
   - sizing logic

2. Whether Stargate explicitly uses:
   - inventory stop logic
   - dynamic re-hedge caps
   - trailing rebalance thresholds
   - per-regime side-ordering rules

3. Whether 5m and 15m are:
   - the same strategy with parameter changes
   - or separate but related sub-strategies

4. How much live latency / queue priority contributes to profitability

5. How scalable the strategy really is before edge degradation

---

## Current Implementation Gap vs Historical Stargate

Our current implementation is probably still too low-resolution.

Most likely missing:
- more micro-fills per condition
- better alternation logic
- better regime-dependent first-side selection
- tighter inventory-state transitions
- finer merge/recycle timing
- explicit modeling of “acceptable but not perfect” pair construction
- support for both 5m and 15m sub-modes

---

## Implementation Direction

The implementation should increasingly move toward:

- explicit two-sided inventory engine
- alternating fill logic
- minimal prolonged imbalance
- regime-based first-leg ordering
- micro-fill density
- merge-centric capital recycling
- avoidance of catastrophic inventory skew

The system should optimize for:
- expected profit
- repeatability
- capital recycling
- robustness

not for:
- aesthetic perfect under-100 pairs on every single condition

---

## Core Summary

The best current Stargate thesis is:

A fast, high-frequency, two-sided, merge-heavy inventory-management strategy that rapidly alternates between sides, uses trend/volatility/gaps to improve both cost bases, keeps exposure close to balanced, and recycles capital through frequent merge activity.

That is the strategy we are trying to model.
