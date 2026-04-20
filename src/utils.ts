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

/**
 * Polymarket crypto fee calculation.
 * Formula: shares × price × feeRate × (price × (1 - price))^exponent
 * Crypto markets: feeRate=0.25, exponent=2
 * Returns fee in USD.
 */
export const polymarketFee = (shares: number, price: number): number => {
  const CRYPTO_FEE_RATE = 0.25;
  const CRYPTO_FEE_EXPONENT = 2;
  const pq = price * (1 - price);
  return shares * price * CRYPTO_FEE_RATE * Math.pow(pq, CRYPTO_FEE_EXPONENT);
};

/**
 * Effective fee rate at a given price level.
 * At 90¢: ~0.20%, at 50¢: ~1.56%, at 10¢: ~0.20%, at 5¢: ~0.06%
 */
export const polymarketFeeRate = (price: number): number => {
  const CRYPTO_FEE_RATE = 0.25;
  const CRYPTO_FEE_EXPONENT = 2;
  const pq = price * (1 - price);
  return CRYPTO_FEE_RATE * Math.pow(pq, CRYPTO_FEE_EXPONENT);
};

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
