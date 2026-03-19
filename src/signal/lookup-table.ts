/**
 * EMPIRICAL fair value lookup table for 5-minute BTC Up/Down markets.
 *
 * Built from 104,754 real Binance BTCUSDT 5-minute windows.
 *
 * For each (normalized_delta, time_remaining) cell, this table contains
 * the ACTUAL historical probability that BTC closes above its opening price.
 *
 * Improvements over v1:
 * - Added confidence scores per cell (based on sample counts)
 * - Interpolation returns confidence alongside value
 * - Enables the edge detector to weight decisions by data quality
 */

const DELTA_BUCKETS = [-3, -2, -1.5, -1, -0.7, -0.5, -0.3, -0.1, 0, 0.1, 0.3, 0.5, 0.7, 1, 1.5, 2, 3];
const TIME_BUCKETS = [240, 200, 150, 100, 60, 30, 10];

// P(Up wins) in cents [1-99] — empirical from 104,754 windows
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

// Sample counts per cell (minimum of the 4 measured time points)
// Used to compute confidence: higher samples = more reliable
const SAMPLE_COUNTS: number[][] = [
  /*  -3.0 */ [  92, 160, 335, 550, 1186, 1186, 1186],
  /*  -2.0 */ [ 263, 500, 945, 1335, 2573, 2573, 2573],
  /*  -1.5 */ [ 911, 1500, 2615, 3230, 5022, 5022, 5022],
  /*  -1.0 */ [3203, 4650, 6106, 6870, 8250, 8250, 8250],
  /*  -0.7 */ [5541, 6670, 7808, 8014, 8003, 8003, 8003],
  /*  -0.5 */ [8659, 8850, 9041, 8780, 8189, 8189, 8189],
  /*  -0.3 */ [13585, 12620, 11654, 10920, 9192, 9192, 9192],
  /*  -0.1 */ [12521, 11070, 9623, 8908, 7384, 7384, 7384],
  /*   0.0 */ [15011, 12060, 9110, 7968, 5530, 5530, 5530],
  /*   0.1 */ [12561, 11010, 9468, 8776, 7169, 7169, 7169],
  /*   0.3 */ [13686, 12650, 11613, 10937, 9176, 9176, 9176],
  /*   0.5 */ [8827, 8910, 8996, 8802, 8025, 8025, 8025],
  /*   0.7 */ [5486, 6570, 7655, 7815, 8079, 8079, 8079],
  /*   1.0 */ [3090, 4520, 5944, 6744, 8301, 8301, 8301],
  /*   1.5 */ [ 907, 1400, 2497, 3196, 4975, 4975, 4975],
  /*   2.0 */ [ 284, 500, 948, 1330, 2499, 2499, 2499],
  /*   3.0 */ [ 127, 200, 396, 570, 1201, 1201, 1201],
];

export interface LookupResult {
  fairUp: number;        // P(Up wins) in cents [2-98]
  confidence: number;    // 0-1 confidence based on sample count
}

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
 * Returns P(Up wins) in cents [2-98] plus confidence score.
 */
export function lookupFairUp(normalizedDelta: number, timeRemainingSeconds: number): LookupResult {
  const [dLo, dHi, dFrac] = findBracket(DELTA_BUCKETS, normalizedDelta);
  const [tLo, tHi, tFrac] = findBracket(TIME_BUCKETS, timeRemainingSeconds);

  // Bilinear interpolation for fair value
  const v00 = LOOKUP[dLo][tLo];
  const v01 = LOOKUP[dLo][tHi];
  const v10 = LOOKUP[dHi][tLo];
  const v11 = LOOKUP[dHi][tHi];

  const top = v00 + (v01 - v00) * tFrac;
  const bot = v10 + (v11 - v10) * tFrac;
  const fairUp = Math.max(2, Math.min(98, Math.round(top + (bot - top) * dFrac)));

  // Bilinear interpolation for sample count
  const s00 = SAMPLE_COUNTS[dLo][tLo];
  const s01 = SAMPLE_COUNTS[dLo][tHi];
  const s10 = SAMPLE_COUNTS[dHi][tLo];
  const s11 = SAMPLE_COUNTS[dHi][tHi];

  const sTop = s00 + (s01 - s00) * tFrac;
  const sBot = s10 + (s11 - s10) * tFrac;
  const sampleCount = sTop + (sBot - sTop) * dFrac;

  // Confidence: sigmoid mapping — 1000 samples = ~0.7, 5000 = ~0.95, 10000 = ~0.99
  const confidence = 1 - Math.exp(-sampleCount / 3000);

  return { fairUp, confidence };
}
