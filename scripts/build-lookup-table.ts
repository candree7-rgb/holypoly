/**
 * Build empirical lookup table from real Binance 1-minute BTC/USDT candles.
 *
 * Downloads monthly CSV archives from data.binance.vision, then for each
 * group of 5 consecutive 1m candles (= one 5-minute window):
 *   - opening = first candle open
 *   - settlement = last candle close
 *   - winner = close > open ? "Up" : "Down"
 *   - At each intermediate minute mark, compute normalized delta
 *   - Bin into (delta_bucket × time_bucket) and count wins
 *
 * Outputs a new lookup-table.ts with empirical P(Up wins).
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = "/tmp/btc_klines";

// ── Data Types ───────────────────────────────────────────────────────

interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

// ── Download & Parse ─────────────────────────────────────────────────

function getMonthsToDownload(count: number): string[] {
  const months: string[] = [];
  const now = new Date();
  // Start from 2 months ago (current month incomplete, last month may be incomplete)
  for (let i = 2; i < 2 + count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = (d.getMonth() + 1).toString().padStart(2, "0");
    months.push(`${y}-${m}`);
  }
  return months.reverse(); // oldest first
}

function downloadMonth(yearMonth: string): string {
  const filename = `BTCUSDT-1m-${yearMonth}`;
  const csvPath = `${TMP_DIR}/${filename}.csv`;

  if (fs.existsSync(csvPath)) {
    console.log(`  ${yearMonth}: cached`);
    return csvPath;
  }

  const url = `https://data.binance.vision/data/spot/monthly/klines/BTCUSDT/1m/${filename}.zip`;
  const zipPath = `${TMP_DIR}/${filename}.zip`;

  console.log(`  ${yearMonth}: downloading...`);
  execSync(`curl -sL "${url}" -o "${zipPath}"`, { timeout: 30000 });
  execSync(`unzip -qo "${zipPath}" -d "${TMP_DIR}"`, { timeout: 10000 });
  fs.unlinkSync(zipPath);

  return csvPath;
}

function parseCSV(csvPath: string): Kline[] {
  const content = fs.readFileSync(csvPath, "utf-8");
  const lines = content.trim().split("\n");
  const candles: Kline[] = [];

  for (const line of lines) {
    const cols = line.split(",");
    if (cols.length < 6) continue;
    const openTime = parseInt(cols[0]);
    if (isNaN(openTime)) continue; // skip header if present

    // Binance CSV timestamps may be in microseconds — normalize to milliseconds
    const normalizedTime = openTime > 1e15 ? Math.floor(openTime / 1000) : openTime;
    candles.push({
      openTime: normalizedTime,
      open: parseFloat(cols[1]),
      high: parseFloat(cols[2]),
      low: parseFloat(cols[3]),
      close: parseFloat(cols[4]),
    });
  }

  return candles;
}

// ── Window Analysis ──────────────────────────────────────────────────

interface Window {
  opening: number;
  settlement: number;
  winner: "Up" | "Down";
  // Prices at each minute mark within the window
  // Index 0 = T+0 (opening), 1 = T+60s, ..., 5 = T+300s (close)
  prices: number[];
  // Rolling volatility (std dev of 1m returns scaled to 5m)
  volatility: number;
}

function buildWindows(candles: Kline[]): Window[] {
  const windows: Window[] = [];
  const VOL_LOOKBACK = 60; // 1 hour of 1m candles

  for (let i = VOL_LOOKBACK; i + 4 < candles.length; i += 5) {
    const windowCandles = candles.slice(i, i + 5);

    // Check continuity: candles must be consecutive (gap < 2 minutes)
    let continuous = true;
    for (let j = 1; j < windowCandles.length; j++) {
      const gap = windowCandles[j].openTime - windowCandles[j - 1].openTime;
      if (gap > 120000 || gap < 30000) {
        continuous = false;
        break;
      }
    }
    if (!continuous) continue;

    const opening = windowCandles[0].open;
    const settlement = windowCandles[4].close;

    // Skip windows where open == close (exact tie, no winner)
    if (settlement === opening) continue;

    const winner = settlement > opening ? "Up" : "Down";

    const prices = [
      windowCandles[0].open, // T+0   (time remaining = 300)
      windowCandles[1].open, // T+60  (time remaining = 240)
      windowCandles[2].open, // T+120 (time remaining = 180)
      windowCandles[3].open, // T+180 (time remaining = 120)
      windowCandles[4].open, // T+240 (time remaining = 60)
      settlement,            // T+300 (time remaining = 0)
    ];

    // Calculate volatility from preceding candles
    const volCandles = candles.slice(i - VOL_LOOKBACK, i);
    const returns: number[] = [];
    for (let j = 1; j < volCandles.length; j++) {
      returns.push(volCandles[j].close - volCandles[j - 1].close);
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
    const stdDev1m = Math.sqrt(variance);
    // Scale 1-minute vol to 5-minute: vol_5m = vol_1m * sqrt(5)
    const volatility = Math.max(stdDev1m * Math.sqrt(5), 5);

    windows.push({ opening, settlement, winner, prices, volatility });
  }

  return windows;
}

// ── Empirical Table Construction ─────────────────────────────────────

const DELTA_BUCKETS = [
  -3.0, -2.0, -1.5, -1.0, -0.7, -0.5, -0.3, -0.1, 0.0, 0.1, 0.3, 0.5, 0.7,
  1.0, 1.5, 2.0, 3.0,
];

// Direct measurement points from 1m candle boundaries
const MEASUREMENT_TIMES = [240, 180, 120, 60];
// Final output columns (interpolated where needed)
const OUTPUT_TIMES = [240, 200, 150, 100, 60, 30, 10];

function findBucketIndex(value: number): number {
  let bestIdx = 0;
  let bestDist = Math.abs(value - DELTA_BUCKETS[0]);
  for (let i = 1; i < DELTA_BUCKETS.length; i++) {
    const dist = Math.abs(value - DELTA_BUCKETS[i]);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

interface BucketStats {
  wins: number;
  total: number;
}

function buildEmpiricalTable(
  windows: Window[]
): Map<string, BucketStats> {
  const stats = new Map<string, BucketStats>();

  for (const d of DELTA_BUCKETS) {
    for (const t of MEASUREMENT_TIMES) {
      stats.set(`${d}:${t}`, { wins: 0, total: 0 });
    }
  }

  for (const w of windows) {
    const upWin = w.winner === "Up" ? 1 : 0;

    for (let mi = 0; mi < MEASUREMENT_TIMES.length; mi++) {
      const priceIdx = mi + 1;
      const price = w.prices[priceIdx];
      const delta = price - w.opening;
      const normalizedDelta = w.volatility > 0.01 ? delta / w.volatility : 0;

      const clampedDelta = Math.max(-3, Math.min(3, normalizedDelta));
      const bucketIdx = findBucketIndex(clampedDelta);
      const bucketDelta = DELTA_BUCKETS[bucketIdx];

      const key = `${bucketDelta}:${MEASUREMENT_TIMES[mi]}`;
      const s = stats.get(key)!;
      s.wins += upWin;
      s.total += 1;
    }
  }

  return stats;
}

function interpolateTime(
  empirical: Map<string, BucketStats>,
  deltaKey: number,
  targetTime: number
): number {
  if (targetTime >= 240) {
    const s = empirical.get(`${deltaKey}:240`)!;
    return s.total > 0 ? (s.wins / s.total) * 100 : 50;
  }
  if (targetTime <= 60) {
    const s = empirical.get(`${deltaKey}:60`)!;
    const baseProb = s.total > 0 ? (s.wins / s.total) * 100 : 50;
    if (targetTime === 60) return baseProb;

    // Extrapolate toward determinism for 30s and 10s
    // For positive delta: P(Up) increases toward 99 as time → 0
    // For negative delta: P(Up) decreases toward 1 as time → 0
    // For zero delta: stays at ~50
    const targetProb = deltaKey > 0 ? 99 : deltaKey < 0 ? 1 : 50;
    const frac = 1 - targetTime / 60;
    const extrapolated = baseProb + (targetProb - baseProb) * frac * 0.7;
    // Ensure monotonicity: never move away from determinism
    if (deltaKey > 0) return Math.max(baseProb, extrapolated);
    if (deltaKey < 0) return Math.min(baseProb, extrapolated);
    return extrapolated;
  }

  // Interpolate between measurement points
  for (let i = 0; i < MEASUREMENT_TIMES.length - 1; i++) {
    const tHi = MEASUREMENT_TIMES[i];
    const tLo = MEASUREMENT_TIMES[i + 1];
    if (targetTime <= tHi && targetTime >= tLo) {
      const sHi = empirical.get(`${deltaKey}:${tHi}`)!;
      const sLo = empirical.get(`${deltaKey}:${tLo}`)!;
      const pHi = sHi.total > 0 ? (sHi.wins / sHi.total) * 100 : 50;
      const pLo = sLo.total > 0 ? (sLo.wins / sLo.total) * 100 : 50;
      const frac = (tHi - targetTime) / (tHi - tLo);
      return pHi + (pLo - pHi) * frac;
    }
  }

  return 50;
}

function buildFinalTable(
  empirical: Map<string, BucketStats>
): number[][] {
  const table: number[][] = [];

  for (const d of DELTA_BUCKETS) {
    const row: number[] = [];
    for (const t of OUTPUT_TIMES) {
      const prob = interpolateTime(empirical, d, t);
      row.push(Math.max(1, Math.min(99, Math.round(prob))));
    }
    table.push(row);
  }

  return table;
}

// ── Output Generation ────────────────────────────────────────────────

function generateTypeScript(
  table: number[][],
  sampleCounts: Map<string, number>,
  totalWindows: number
): string {
  const rows = table
    .map((row, i) => {
      const delta = DELTA_BUCKETS[i].toFixed(1).padStart(5);
      const vals = row.map((v) => v.toString().padStart(5)).join(",");
      return `  /* ${delta} */ [${vals} ],`;
    })
    .join("\n");

  let sampleInfo = "// Sample counts per (delta, time) cell:\n";
  for (const d of DELTA_BUCKETS) {
    const counts = MEASUREMENT_TIMES.map((t) => {
      const key = `${d}:${t}`;
      return (sampleCounts.get(key) ?? 0).toString().padStart(6);
    });
    sampleInfo += `//  delta=${d.toFixed(1).padStart(5)}: ${counts.join(", ")} (at ${MEASUREMENT_TIMES.join("s, ")}s)\n`;
  }

  return `/**
 * EMPIRICAL fair value lookup table for 5-minute BTC Up/Down markets.
 *
 * Built from ${totalWindows.toLocaleString()} real Binance BTCUSDT 5-minute windows.
 * Generated: ${new Date().toISOString().split("T")[0]}
 *
 * For each (normalized_delta, time_remaining) cell, this table contains
 * the ACTUAL historical probability that BTC closes above its opening price.
 *
 * Direct measurements at [240, 180, 120, 60] seconds (from 1-min candle boundaries).
 * Values at [200, 150, 100] are interpolated between measurements.
 * Values at [30, 10] are extrapolated toward settlement determinism.
 *
${sampleInfo} */

// Delta buckets: normalized delta (delta / volatility)
// Negative = BTC below opening, Positive = BTC above opening
const DELTA_BUCKETS = [${DELTA_BUCKETS.join(", ")}];

// Time remaining buckets (seconds)
const TIME_BUCKETS = [${OUTPUT_TIMES.join(", ")}];

const LOOKUP: number[][] = [
  // delta:       ${OUTPUT_TIMES.map((t) => `${t}s`.padStart(5)).join("  ")}
${rows}
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
`;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Empirical Lookup Table Builder ===\n");

  // Create temp dir
  fs.mkdirSync(TMP_DIR, { recursive: true });

  // Download 12 months of 1m candle data
  const MONTHS = 12;
  const monthList = getMonthsToDownload(MONTHS);
  console.log(`Downloading ${MONTHS} months of 1m BTC/USDT data...`);

  let allCandles: Kline[] = [];
  for (const ym of monthList) {
    try {
      const csvPath = downloadMonth(ym);
      const candles = parseCSV(csvPath);
      allCandles.push(...candles);
      console.log(`    → ${candles.length} candles`);
    } catch (err) {
      console.log(`  ${ym}: FAILED (skipping) - ${(err as Error).message}`);
    }
  }

  console.log(`\nTotal candles: ${allCandles.length.toLocaleString()}`);

  // Sort by time (should already be sorted, but just in case)
  allCandles.sort((a, b) => a.openTime - b.openTime);

  // Build windows
  console.log("\nBuilding 5-minute windows...");
  const windows = buildWindows(allCandles);
  console.log(`Built ${windows.length.toLocaleString()} valid windows`);

  // Basic stats
  const upWins = windows.filter((w) => w.winner === "Up").length;
  console.log(
    `  Up wins: ${upWins} (${((upWins / windows.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `  Down wins: ${windows.length - upWins} (${(((windows.length - upWins) / windows.length) * 100).toFixed(1)}%)`
  );
  const avgVol =
    windows.reduce((s, w) => s + w.volatility, 0) / windows.length;
  console.log(`  Avg 5m volatility: $${avgVol.toFixed(2)}`);

  // Build empirical table
  console.log("\nBuilding empirical probability table...");
  const empirical = buildEmpiricalTable(windows);

  // Print raw empirical data
  console.log("\n--- Raw Empirical P(Up) [direct measurements] ---");
  console.log(
    "  Delta".padEnd(10),
    ...MEASUREMENT_TIMES.map((t) => `${t}s`.padStart(16))
  );
  for (const d of DELTA_BUCKETS) {
    const cells = MEASUREMENT_TIMES.map((t) => {
      const s = empirical.get(`${d}:${t}`)!;
      if (s.total === 0) return "n/a".padStart(16);
      const pct = ((s.wins / s.total) * 100).toFixed(1);
      return `${pct}% (n=${s.total})`.padStart(16);
    });
    console.log(`  ${d.toFixed(1).padStart(5)}   `, ...cells);
  }

  // Build final interpolated table
  const finalTable = buildFinalTable(empirical);

  // Sample counts
  const sampleCounts = new Map<string, number>();
  for (const [key, val] of empirical.entries()) {
    sampleCounts.set(key, val.total);
  }

  // Generate TypeScript
  const output = generateTypeScript(finalTable, sampleCounts, windows.length);
  const outputPath = path.join(
    __dirname,
    "..",
    "src",
    "signal",
    "lookup-table.ts"
  );

  // Backup old table
  const backupPath = outputPath.replace(".ts", ".old.ts");
  if (fs.existsSync(outputPath)) {
    fs.copyFileSync(outputPath, backupPath);
    console.log(`\nBacked up old table to ${backupPath}`);
  }

  fs.writeFileSync(outputPath, output);
  console.log(`Wrote new lookup table to ${outputPath}`);

  // Print final table
  console.log("\n--- Final Empirical Table ---");
  console.log(
    "  Delta".padEnd(10),
    ...OUTPUT_TIMES.map((t) => `${t}s`.padStart(6))
  );
  for (let i = 0; i < DELTA_BUCKETS.length; i++) {
    const row = finalTable[i].map((v) => v.toString().padStart(6));
    console.log(`  ${DELTA_BUCKETS[i].toFixed(1).padStart(5)}   `, ...row);
  }

  // Compare with old table
  console.log("\n--- Comparison: Old vs New (at 240s, 60s) ---");
  const OLD_TABLE = [
    [12, 2], [20, 5], [27, 9], [34, 14], [38, 19], [42, 24], [45, 31],
    [48, 41], [50, 50], [52, 59], [55, 69], [58, 76], [62, 81],
    [66, 86], [73, 91], [80, 95], [88, 98],
  ];
  console.log("  Delta     Old@240  New@240  Diff    Old@60   New@60   Diff");
  for (let i = 0; i < DELTA_BUCKETS.length; i++) {
    const o240 = OLD_TABLE[i][0];
    const n240 = finalTable[i][0];
    const o60 = OLD_TABLE[i][1];
    const n60 = finalTable[i][4];
    const d240 = n240 - o240;
    const d60 = n60 - o60;
    const sign240 = d240 >= 0 ? "+" : "";
    const sign60 = d60 >= 0 ? "+" : "";
    console.log(
      `  ${DELTA_BUCKETS[i].toFixed(1).padStart(5)}   ${o240.toString().padStart(6)}   ${n240.toString().padStart(6)}  ${(sign240 + d240).padStart(4)}    ${o60.toString().padStart(6)}   ${n60.toString().padStart(6)}  ${(sign60 + d60).padStart(4)}`
    );
  }

  console.log("\n=== Done! ===");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
