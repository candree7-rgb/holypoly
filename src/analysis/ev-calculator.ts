/**
 * Expected Value Calculator for the HolyPoly hybrid strategy.
 *
 * Calculates per-trade EV, win rate, breakeven rate, and risk metrics
 * based on the empirical lookup table and actual strategy parameters.
 *
 * Run: npx ts-node --esm src/analysis/ev-calculator.ts
 */

// ============================================================
// LOOKUP TABLE (from lookup-table.ts)
// ============================================================

const DELTA_BUCKETS = [-3, -2, -1.5, -1, -0.7, -0.5, -0.3, -0.1, 0, 0.1, 0.3, 0.5, 0.7, 1, 1.5, 2, 3];
const TIME_BUCKETS = [240, 200, 150, 100, 60, 30, 10];

const LOOKUP: number[][] = [
  /*  -3.0 */ [  4,  4,  3,  1,  1,  1,  1],
  /*  -2.0 */ [ 10,  6,  3,  1,  1,  1,  1],
  /*  -1.5 */ [ 10,  7,  4,  2,  1,  1,  1],
  /*  -1.0 */ [ 15, 12,  8,  4,  1,  1,  1],
  /*  -0.7 */ [ 22, 18, 13,  8,  4,  3,  2],
  /*  -0.5 */ [ 27, 25, 21, 15,  9,  6,  4],
  /*  -0.3 */ [ 35, 33, 30, 24, 18, 12,  8],
  /*  -0.1 */ [ 42, 41, 39, 37, 33, 22, 14],
  /*   0.0 */ [ 50, 50, 50, 50, 49, 50, 50],
  /*   0.1 */ [ 57, 59, 60, 64, 68, 79, 86],
  /*   0.3 */ [ 65, 67, 70, 76, 82, 88, 92],
  /*   0.5 */ [ 71, 75, 80, 85, 91, 94, 96],
  /*   0.7 */ [ 78, 82, 86, 91, 96, 97, 98],
  /*   1.0 */ [ 85, 88, 92, 96, 98, 99, 99],
  /*   1.5 */ [ 90, 93, 96, 98, 99, 99, 99],
  /*   2.0 */ [ 91, 95, 98, 99, 99, 99, 99],
  /*   3.0 */ [ 95, 98, 99, 99, 99, 99, 99],
];

function lookupFairUp(normalizedDelta: number, timeSec: number): number {
  const findBracket = (arr: number[], val: number): [number, number, number] => {
    if (val <= arr[0]) return [0, 0, 0];
    if (val >= arr[arr.length - 1]) return [arr.length - 1, arr.length - 1, 0];
    for (let i = 0; i < arr.length - 1; i++) {
      if (val >= arr[i] && val <= arr[i + 1]) {
        const range = arr[i + 1] - arr[i];
        return [i, i + 1, range > 0 ? (val - arr[i]) / range : 0];
      }
    }
    return [arr.length - 1, arr.length - 1, 0];
  };

  const [dLo, dHi, dFrac] = findBracket(DELTA_BUCKETS, normalizedDelta);
  const [tLo, tHi, tFrac] = findBracket(TIME_BUCKETS, timeSec);

  const v00 = LOOKUP[dLo][tLo], v01 = LOOKUP[dLo][tHi];
  const v10 = LOOKUP[dHi][tLo], v11 = LOOKUP[dHi][tHi];
  const top = v00 + (v01 - v00) * tFrac;
  const bot = v10 + (v11 - v10) * tFrac;
  return Math.max(2, Math.min(98, Math.round(top + (bot - top) * dFrac)));
}

// ============================================================
// STRATEGY PARAMETERS
// ============================================================

const BALANCE = 500;                // USD
const BUY_PCT = 4;                  // % of balance per order
const BUY_AMOUNT = BALANCE * BUY_PCT / 100; // $20
const MIN_PROFIT_CENTS = 2;         // minimum arb profit per pair
const EDGE_THRESHOLD = 5;           // minimum edge in cents
const VOLATILITY = 50;              // typical BTC 5-min volatility in USD

// DCA tranche config (matches arb-completion.ts)
const TRANCHES = [
  { pct: 0.50, bonusCents: 0 },
  { pct: 0.30, bonusCents: 3 },
  { pct: 0.20, bonusCents: 6 },
];

// ============================================================
// SIMULATION
// ============================================================

interface TradeResult {
  edgeCents: number;
  entryPriceCents: number;
  fairValueCents: number;
  shares: number;
  invested: number;

  // Arb outcomes (probability-weighted)
  pFullArb: number;        // probability all tranches fill
  pPartialArb: number;     // probability some tranches + emergency
  pEmergency: number;      // probability emergency fill all
  pNakedWin: number;       // probability naked hold → win
  pNakedLose: number;      // probability naked hold → lose

  fullArbProfit: number;
  partialArbProfit: number;
  emergencyProfit: number;
  nakedWinProfit: number;
  nakedLoseProfit: number;

  ev: number;              // expected value per trade
  evPct: number;           // EV as % of invested
  winRate: number;         // % of trades that are profitable
  maxLoss: number;         // worst case loss
  maxProfit: number;       // best case profit
}

function simulateTrade(btcDelta: number, timeRemainingSec: number): TradeResult | null {
  const normalizedDelta = btcDelta / VOLATILITY;
  const fairUp = lookupFairUp(normalizedDelta, timeRemainingSec);
  const fairDown = 100 - fairUp;

  // Which side has the edge?
  // Market lags Binance, so assume market is ~10-15¢ behind fair value
  const marketLag = Math.min(20, Math.max(5, Math.abs(btcDelta) / VOLATILITY * 15));
  const bestSide = btcDelta >= 0 ? "Up" : "Down";
  const fairValue = bestSide === "Up" ? fairUp : fairDown;

  // Market price = fair value - edge (market hasn't caught up)
  const entryPriceCents = Math.max(40, Math.min(92, fairValue - marketLag));
  const edgeCents = fairValue - entryPriceCents;

  if (edgeCents < EDGE_THRESHOLD) return null;

  const shares = BUY_AMOUNT / (entryPriceCents / 100);
  const invested = BUY_AMOUNT;

  // Loser target: 100 - entry - minProfit
  const baseTarget = 100 - entryPriceCents - MIN_PROFIT_CENTS;

  // DCA tranche targets
  const t1Target = baseTarget;
  const t2Target = baseTarget - 3;
  const t3Target = baseTarget - 6;

  // Loser fair value (what it should reprice to)
  const loserFairValue = 100 - fairValue;

  // Probability loser drops to each level:
  // If loser fair value < target, it will almost certainly get there
  const pLoserHitsT1 = loserFairValue <= t1Target ? 0.90 : 0.40;
  const pLoserHitsT2 = loserFairValue <= t2Target ? 0.70 : 0.25;
  const pLoserHitsT3 = loserFairValue <= t3Target ? 0.50 : 0.15;

  // Outcome probabilities
  const pFullArb = pLoserHitsT3;                                    // all 3 tranches fill
  const pPartialT1T2 = pLoserHitsT2 - pFullArb;                    // T1+T2 fill, T3 emergency
  const pPartialT1 = pLoserHitsT1 - pLoserHitsT2;                  // T1 fills, T2+T3 emergency
  const pEmergencyAll = (1 - pLoserHitsT1) * 0.85;                 // nothing fills naturally, emergency
  const pNaked = (1 - pLoserHitsT1) * 0.15;                        // can't fill even emergency
  const pWinAtSettlement = fairValue / 100;                         // P(our side wins)
  const pNakedWin = pNaked * pWinAtSettlement;
  const pNakedLose = pNaked * (1 - pWinAtSettlement);

  // Profit calculations
  // Full arb: all 3 tranches at their bonus prices
  const avgLoserFullArb = TRANCHES[0].pct * Math.min(t1Target, loserFairValue + 5) +
                          TRANCHES[1].pct * Math.min(t2Target, loserFairValue + 3) +
                          TRANCHES[2].pct * Math.min(t3Target, loserFairValue + 1);
  const fullArbProfitPerPair = (100 - entryPriceCents - avgLoserFullArb) / 100;
  const fullArbProfit = shares * fullArbProfitPerPair;

  // Partial arb (T1+T2 fill, T3 at emergency)
  const emergencyPrice = Math.min(100 - entryPriceCents + 1, loserFairValue + 8);
  const avgLoserPartialT1T2 = TRANCHES[0].pct * Math.min(t1Target, loserFairValue + 5) +
                               TRANCHES[1].pct * Math.min(t2Target, loserFairValue + 3) +
                               TRANCHES[2].pct * emergencyPrice;
  const partialArbProfitPerPair = (100 - entryPriceCents - avgLoserPartialT1T2) / 100;
  const partialArbProfit = shares * Math.max(-0.01, partialArbProfitPerPair);

  // Emergency all: buy all at emergency price
  const emergencyProfitPerPair = (100 - entryPriceCents - emergencyPrice) / 100;
  const emergencyProfit = shares * Math.max(-0.01, emergencyProfitPerPair);

  // Naked outcomes
  const nakedWinProfit = shares * (100 - entryPriceCents) / 100;  // payout $1 - cost
  const nakedLoseProfit = -invested;                                // total loss

  // Combined EV
  const ev = pFullArb * fullArbProfit +
             (pPartialT1T2 + pPartialT1) * partialArbProfit +
             pEmergencyAll * emergencyProfit +
             pNakedWin * nakedWinProfit +
             pNakedLose * nakedLoseProfit;

  // Win rate: all arb scenarios are wins, naked win is win, naked lose is loss
  const winRate = (pFullArb + pPartialT1T2 + pPartialT1 + pEmergencyAll + pNakedWin) * 100;

  return {
    edgeCents,
    entryPriceCents,
    fairValueCents: fairValue,
    shares,
    invested,
    pFullArb,
    pPartialArb: pPartialT1T2 + pPartialT1,
    pEmergency: pEmergencyAll,
    pNakedWin,
    pNakedLose,
    fullArbProfit,
    partialArbProfit,
    emergencyProfit,
    nakedWinProfit,
    nakedLoseProfit,
    ev,
    evPct: (ev / invested) * 100,
    winRate,
    maxLoss: nakedLoseProfit,
    maxProfit: nakedWinProfit,
  };
}

// ============================================================
// RUN SIMULATION ACROSS TYPICAL SCENARIOS
// ============================================================

console.log("═══════════════════════════════════════════════════════════════");
console.log("  HolyPoly EV Analysis — Per Trade ($20 invested, $500 bal)");
console.log("═══════════════════════════════════════════════════════════════\n");

// Simulate across different BTC deltas and time remaining
const scenarios: Array<{ label: string; delta: number; time: number }> = [
  // Small edges (most common)
  { label: "Small edge, early",    delta: 15,  time: 200 },
  { label: "Small edge, mid",      delta: 20,  time: 120 },
  { label: "Small edge, late",     delta: 25,  time: 60 },

  // Medium edges
  { label: "Medium edge, early",   delta: 35,  time: 200 },
  { label: "Medium edge, mid",     delta: 40,  time: 120 },
  { label: "Medium edge, late",    delta: 50,  time: 60 },

  // Large edges
  { label: "Large edge, early",    delta: 60,  time: 200 },
  { label: "Large edge, mid",      delta: 75,  time: 120 },
  { label: "Large edge, late",     delta: 100, time: 60 },

  // Extreme edges (rare but profitable)
  { label: "Extreme edge, mid",    delta: 150, time: 120 },
  { label: "Extreme edge, late",   delta: 150, time: 30 },
];

const results: TradeResult[] = [];

for (const s of scenarios) {
  const result = simulateTrade(s.delta, s.time);
  if (!result) {
    console.log(`${s.label.padEnd(24)} — NO TRADE (edge < ${EDGE_THRESHOLD}¢)`);
    continue;
  }
  results.push(result);

  console.log(`${s.label.padEnd(24)} | BTC Δ$${s.delta.toString().padStart(3)} @ ${s.time}s remaining`);
  console.log(`  Entry: ${result.entryPriceCents}¢  Fair: ${result.fairValueCents}¢  Edge: ${result.edgeCents.toFixed(0)}¢  Shares: ${result.shares.toFixed(1)}`);
  console.log(`  Outcomes:`);
  console.log(`    Full Arb:     ${(result.pFullArb*100).toFixed(0)}%  → +$${result.fullArbProfit.toFixed(2)}`);
  console.log(`    Partial Arb:  ${(result.pPartialArb*100).toFixed(0)}%  → +$${result.partialArbProfit.toFixed(2)}`);
  console.log(`    Emergency:    ${(result.pEmergency*100).toFixed(0)}%  → ${result.emergencyProfit >= 0 ? "+" : ""}$${result.emergencyProfit.toFixed(2)}`);
  console.log(`    Naked Win:    ${(result.pNakedWin*100).toFixed(1)}%  → +$${result.nakedWinProfit.toFixed(2)}`);
  console.log(`    Naked Lose:   ${(result.pNakedLose*100).toFixed(1)}%  → -$${Math.abs(result.nakedLoseProfit).toFixed(2)}`);
  console.log(`  ► EV: ${result.ev >= 0 ? "+" : ""}$${result.ev.toFixed(2)} (${result.evPct >= 0 ? "+" : ""}${result.evPct.toFixed(1)}%) | Win Rate: ${result.winRate.toFixed(1)}% | Max Loss: -$${Math.abs(result.maxLoss).toFixed(2)}`);
  console.log();
}

// ============================================================
// AGGREGATE STATISTICS
// ============================================================

if (results.length > 0) {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  AGGREGATE STATISTICS (across all tradeable scenarios)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Weight by approximate frequency (small edges most common)
  const weights = [
    0.15, 0.15, 0.10,  // small: 40%
    0.10, 0.10, 0.10,  // medium: 30%
    0.08, 0.07, 0.05,  // large: 20%
    0.05, 0.05,         // extreme: 10%
  ];

  // Normalize weights to actual results count
  const activeWeights = weights.slice(0, results.length);
  const totalWeight = activeWeights.reduce((a, b) => a + b, 0);
  const normalizedWeights = activeWeights.map(w => w / totalWeight);

  const weightedEv = results.reduce((sum, r, i) => sum + r.ev * normalizedWeights[i], 0);
  const weightedEvPct = results.reduce((sum, r, i) => sum + r.evPct * normalizedWeights[i], 0);
  const weightedWinRate = results.reduce((sum, r, i) => sum + r.winRate * normalizedWeights[i], 0);
  const worstLoss = Math.min(...results.map(r => r.maxLoss));
  const bestProfit = Math.max(...results.map(r => r.maxProfit));
  const avgEdge = results.reduce((sum, r, i) => sum + r.edgeCents * normalizedWeights[i], 0);

  console.log(`  Average Edge:           ${avgEdge.toFixed(1)}¢`);
  console.log(`  Weighted EV per Trade:  ${weightedEv >= 0 ? "+" : ""}$${weightedEv.toFixed(2)} (${weightedEvPct >= 0 ? "+" : ""}${weightedEvPct.toFixed(1)}%)`);
  console.log(`  Weighted Win Rate:      ${weightedWinRate.toFixed(1)}%`);
  console.log(`  Breakeven Rate:         ~${(100 / (1 + weightedEv / BUY_AMOUNT * 100)).toFixed(1)}% (% of trades needed to break even)`);
  console.log(`  Max Single Loss:        -$${Math.abs(worstLoss).toFixed(2)}`);
  console.log(`  Max Single Profit:      +$${bestProfit.toFixed(2)}`);
  console.log();

  // Daily projection
  const tradesPerDay = 100; // ~5 tradeable windows per hour × 20 hours × chance of edge
  const dailyEv = weightedEv * tradesPerDay;
  const dailyMaxDrawdown = Math.abs(worstLoss) * 3; // 3 max losses in a row

  console.log("  ─── DAILY PROJECTIONS (est. ~100 trades/day) ───");
  console.log(`  Expected Daily Profit:  +$${dailyEv.toFixed(2)}`);
  console.log(`  Daily Return on $500:   +${(dailyEv / BALANCE * 100).toFixed(1)}%`);
  console.log(`  Worst Case Daily Loss:  -$${(BALANCE * 0.10).toFixed(2)} (10% circuit breaker)`);
  console.log(`  Max Drawdown (3 naked): -$${dailyMaxDrawdown.toFixed(2)}`);
  console.log();

  // Monthly projection (with compounding)
  const dailyReturnRate = dailyEv / BALANCE;
  let monthlyBalance = BALANCE;
  for (let d = 0; d < 30; d++) {
    monthlyBalance *= (1 + dailyReturnRate);
  }

  console.log("  ─── MONTHLY PROJECTION (30 days, compounding) ───");
  console.log(`  Starting Balance:       $${BALANCE.toFixed(2)}`);
  console.log(`  Projected End Balance:  $${monthlyBalance.toFixed(2)}`);
  console.log(`  Monthly Return:         +${((monthlyBalance / BALANCE - 1) * 100).toFixed(1)}%`);
  console.log(`  Monthly Profit:         +$${(monthlyBalance - BALANCE).toFixed(2)}`);
  console.log();

  // Risk-adjusted metrics
  const sharpeApprox = weightedEv / BUY_AMOUNT / (Math.abs(worstLoss) / BUY_AMOUNT);
  console.log("  ─── RISK-ADJUSTED METRICS ───");
  console.log(`  Profit Factor:          ${(weightedEv * weightedWinRate / 100 / (Math.abs(worstLoss) * (100 - weightedWinRate) / 100)).toFixed(2)}x`);
  console.log(`  EV/MaxLoss Ratio:       ${(weightedEv / Math.abs(worstLoss) * 100).toFixed(1)}%`);
  console.log(`  Kelly Criterion:        ${(weightedWinRate/100 - (100-weightedWinRate)/100 / (bestProfit/Math.abs(worstLoss))).toFixed(2)} (optimal fraction)`);
}

console.log("\n═══════════════════════════════════════════════════════════════");
console.log("  REMAINING OPTIMIZATION OPPORTUNITIES");
console.log("═══════════════════════════════════════════════════════════════\n");
console.log("  1. MAKER REBATES: Place limit orders at best ask (maker) instead");
console.log("     of FOK (taker). Saves ~1-2¢/trade in fees. Fallback to FOK");
console.log("     if not filled in 1s. Est. impact: +5-10% on arb profits.\n");
console.log("  2. ADAPTIVE TRANCHES: Instead of fixed 50/30/20, use loser");
console.log("     repricing speed to size tranches. Fast drop → bigger T2/T3.\n");
console.log("  3. TIME-OF-DAY: BTC vol varies by session. Asian session lower");
console.log("     vol → raise thresholds. US session higher → lower thresholds.\n");
console.log("  4. SPREAD-AWARE SIZING: Check depth at each ask level to ensure");
console.log("     our order can fill without excessive slippage.\n");
console.log("  5. CROSS-WINDOW MEMORY: Track if last N windows all went Up.");
console.log("     Market might underestimate continuation probability.\n");
console.log("  NOTE: These are diminishing returns (est. +10-20% total improvement).");
console.log("  The core strategy (FOK + DCA + edge SL + depth) captures 80%+ of value.\n");
