/**
 * Empirical fair value lookup table for 5-minute BTC Up/Down markets.
 *
 * Based on observed BTC microstructure:
 * - BTC has fat tails (extreme moves more likely than normal distribution predicts)
 * - Short-term momentum: moves tend to continue more than mean-revert in 5-min windows
 * - The normal CDF underestimates continuation probability at moderate deltas
 *
 * Table maps (delta_bucket, time_bucket) → P(Up wins) in cents [0-100].
 * Delta is normalized: delta_usd / volatility to make it vol-adjusted.
 *
 * Constructed from empirical BTC 5-min candle analysis and adjusted for
 * purpledeer's observed edge patterns (entries at 50-65¢, ~60% win rate).
 */

// Delta buckets: normalized delta (delta / volatility)
// Negative = BTC below opening, Positive = BTC above opening
const DELTA_BUCKETS = [-3.0, -2.0, -1.5, -1.0, -0.7, -0.5, -0.3, -0.1, 0.0, 0.1, 0.3, 0.5, 0.7, 1.0, 1.5, 2.0, 3.0];

// Time remaining buckets (seconds)
const TIME_BUCKETS = [240, 200, 150, 100, 60, 30, 10];

/**
 * Empirical P(Up wins) lookup table.
 * Each row is a delta bucket, each column is a time bucket.
 *
 * Key differences from normal CDF:
 * 1. Mean-reversion bias at early timepoints (240s, 200s) — BTC dips/spikes
 *    frequently revert within 5 minutes, so P(continuation) is LOWER than
 *    normal CDF suggests when lots of time remains.
 * 2. Directional confidence only with less time (≤60s) — less time to revert.
 * 3. Conservative at moderate deltas — only give strong edge signal when
 *    the move is large or time is short.
 *
 * Calibrated to avoid the observed failure mode: Bot sees -$20 dip at 60s,
 * bets Down at 67%, but BTC reverts and Up wins. With mean-reversion table,
 * the same dip at 240s remaining gives only ~55% Down, requiring a bigger
 * move or less time before triggering a trade.
 */
const LOOKUP: number[][] = [
  // delta:        240s   200s   150s   100s    60s    30s    10s
  /* -3.0 */ [ 12,     8,     5,     3,     2,     1,     1 ],
  /* -2.0 */ [ 20,    16,    12,     8,     5,     3,     1 ],
  /* -1.5 */ [ 27,    23,    18,    13,     9,     5,     2 ],
  /* -1.0 */ [ 34,    30,    25,    20,    14,     8,     3 ],
  /* -0.7 */ [ 38,    35,    30,    25,    19,    12,     5 ],
  /* -0.5 */ [ 42,    39,    35,    30,    24,    16,     7 ],
  /* -0.3 */ [ 45,    43,    40,    36,    31,    23,    12 ],
  /* -0.1 */ [ 48,    47,    46,    44,    41,    36,    25 ],
  /*  0.0 */ [ 50,    50,    50,    50,    50,    50,    50 ],
  /*  0.1 */ [ 52,    53,    54,    56,    59,    64,    75 ],
  /*  0.3 */ [ 55,    57,    60,    64,    69,    77,    88 ],
  /*  0.5 */ [ 58,    61,    65,    70,    76,    84,    93 ],
  /*  0.7 */ [ 62,    65,    70,    75,    81,    88,    95 ],
  /*  1.0 */ [ 66,    70,    75,    80,    86,    92,    97 ],
  /*  1.5 */ [ 73,    77,    82,    87,    91,    95,    98 ],
  /*  2.0 */ [ 80,    84,    88,    92,    95,    97,    99 ],
  /*  3.0 */ [ 88,    92,    95,    97,    98,    99,    99 ],
];

/**
 * Find the nearest index in a sorted array.
 */
function findBracket(arr: number[], value: number): [number, number, number] {
  if (value <= arr[0]) return [0, 0, 0];
  if (value >= arr[arr.length - 1]) return [arr.length - 1, arr.length - 1, 0];

  for (let i = 0; i < arr.length - 1; i++) {
    if (value >= arr[i] && value <= arr[i + 1]) {
      const range = arr[i + 1] - arr[i];
      const frac = range > 0 ? (value - arr[i]) / range : 0;
      return [i, i + 1, frac];
    }
  }
  return [arr.length - 1, arr.length - 1, 0];
}

/**
 * Bilinear interpolation in the lookup table.
 * Returns P(Up wins) in cents [2-98].
 */
export function lookupFairUp(normalizedDelta: number, timeRemainingSeconds: number): number {
  const [dLo, dHi, dFrac] = findBracket(DELTA_BUCKETS, normalizedDelta);
  const [tLo, tHi, tFrac] = findBracket(TIME_BUCKETS, timeRemainingSeconds);

  // Bilinear interpolation
  const v00 = LOOKUP[dLo][tLo];
  const v01 = LOOKUP[dLo][tHi];
  const v10 = LOOKUP[dHi][tLo];
  const v11 = LOOKUP[dHi][tHi];

  const top = v00 + (v01 - v00) * tFrac;
  const bot = v10 + (v11 - v10) * tFrac;
  const result = top + (bot - top) * dFrac;

  return Math.max(2, Math.min(98, Math.round(result)));
}
