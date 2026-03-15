/**
 * EMPIRICAL fair value lookup table for 5-minute BTC Up/Down markets.
 *
 * Built from 104,754 real Binance BTCUSDT 5-minute windows.
 * Generated: 2026-03-15
 *
 * For each (normalized_delta, time_remaining) cell, this table contains
 * the ACTUAL historical probability that BTC closes above its opening price.
 *
 * Direct measurements at [240, 180, 120, 60] seconds (from 1-min candle boundaries).
 * Values at [200, 150, 100] are interpolated between measurements.
 * Values at [30, 10] are extrapolated toward settlement determinism.
 *
// Sample counts per (delta, time) cell:
//  delta= -3.0:     92,    335,    770,   1186 (at 240s, 180s, 120s, 60s)
//  delta= -2.0:    263,    945,   1726,   2573 (at 240s, 180s, 120s, 60s)
//  delta= -1.5:    911,   2615,   3846,   5022 (at 240s, 180s, 120s, 60s)
//  delta= -1.0:   3203,   6106,   7640,   8250 (at 240s, 180s, 120s, 60s)
//  delta= -0.7:   5541,   7808,   8220,   8003 (at 240s, 180s, 120s, 60s)
//  delta= -0.5:   8659,   9041,   8519,   8189 (at 240s, 180s, 120s, 60s)
//  delta= -0.3:  13585,  11654,  10189,   9192 (at 240s, 180s, 120s, 60s)
//  delta= -0.1:  12521,   9623,   8193,   7384 (at 240s, 180s, 120s, 60s)
//  delta=  0.0:  15011,   9110,   6825,   5530 (at 240s, 180s, 120s, 60s)
//  delta=  0.1:  12561,   9468,   8084,   7169 (at 240s, 180s, 120s, 60s)
//  delta=  0.3:  13686,  11613,  10261,   9176 (at 240s, 180s, 120s, 60s)
//  delta=  0.5:   8827,   8996,   8608,   8025 (at 240s, 180s, 120s, 60s)
//  delta=  0.7:   5486,   7655,   7975,   8079 (at 240s, 180s, 120s, 60s)
//  delta=  1.0:   3090,   5944,   7544,   8301 (at 240s, 180s, 120s, 60s)
//  delta=  1.5:    907,   2497,   3896,   4975 (at 240s, 180s, 120s, 60s)
//  delta=  2.0:    284,    948,   1713,   2499 (at 240s, 180s, 120s, 60s)
//  delta=  3.0:    127,    396,    745,   1201 (at 240s, 180s, 120s, 60s)
 */

// Delta buckets: normalized delta (delta / volatility)
// Negative = BTC below opening, Positive = BTC above opening
const DELTA_BUCKETS = [-3, -2, -1.5, -1, -0.7, -0.5, -0.3, -0.1, 0, 0.1, 0.3, 0.5, 0.7, 1, 1.5, 2, 3];

// Time remaining buckets (seconds)
const TIME_BUCKETS = [240, 200, 150, 100, 60, 30, 10];

const LOOKUP: number[][] = [
  // delta:        240s   200s   150s   100s    60s    30s    10s
  /*  -3.0 */ [    4,    4,    3,    1,    1,    1,    1 ],
  /*  -2.0 */ [   10,    6,    3,    1,    1,    1,    1 ],
  /*  -1.5 */ [   10,    7,    4,    2,    1,    1,    1 ],
  /*  -1.0 */ [   15,   12,    8,    4,    1,    2,    2 ],
  /*  -0.7 */ [   22,   18,   13,    8,    4,    3,    3 ],
  /*  -0.5 */ [   27,   25,   21,   15,    9,    6,    5 ],
  /*  -0.3 */ [   35,   33,   30,   24,   18,   12,    9 ],
  /*  -0.1 */ [   42,   41,   39,   37,   33,   22,   15 ],
  /*   0.0 */ [   50,   50,   50,   50,   49,   50,   50 ],
  /*   0.1 */ [   57,   59,   60,   64,   68,   79,   86 ],
  /*   0.3 */ [   65,   67,   70,   76,   82,   88,   91 ],
  /*   0.5 */ [   71,   75,   80,   85,   91,   93,   95 ],
  /*   0.7 */ [   78,   82,   86,   91,   96,   97,   97 ],
  /*   1.0 */ [   85,   88,   92,   96,   98,   98,   98 ],
  /*   1.5 */ [   90,   93,   96,   98,   99,   99,   99 ],
  /*   2.0 */ [   91,   95,   98,   99,   99,   99,   99 ],
  /*   3.0 */ [   95,   98,   99,   99,   99,   99,   99 ],
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
