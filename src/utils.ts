export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const nowSec = () => Math.floor(Date.now() / 1000);

export const nowMs = () => Date.now();

export const toBaseUnits = (amount: number, decimals = 6): bigint => {
  if (!Number.isFinite(amount)) return 0n;
  const factor = 10 ** decimals;
  return BigInt(Math.max(0, Math.round(amount * factor)));
};

export const fromBaseUnits = (amount: bigint, decimals = 6): number => {
  const factor = 10 ** decimals;
  return Number(amount) / factor;
};

export const formatUsd = (amount: number) => amount.toFixed(2);

export const isPositive = (n: number) => Number.isFinite(n) && n > 0;

/** Standard normal CDF approximation (Abramowitz & Stegun) */
export const normalCdf = (x: number): number => {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);

  return 0.5 * (1.0 + sign * y);
};
