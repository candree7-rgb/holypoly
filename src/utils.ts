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

/**
 * Polymarket crypto taker fee (non-flat curve).
 * Formula: fee = shares × price × feeRate × (price × (1 - price))^exponent
 * For crypto markets: feeRate=0.25, exponent=2
 * Max effective rate ~1.56% at price=0.50, drops toward extremes.
 * See: https://docs.polymarket.com/trading/fees
 */
export const polymarketCryptoFee = (
  shares: number,
  price: number,
  feeRate = 0.25,
  exponent = 2,
): number => {
  if (shares <= 0 || price <= 0 || price >= 1) return 0;
  const pq = price * (1 - price);
  const fee = shares * price * feeRate * pq ** exponent;
  // Round to 4 decimal places per Polymarket spec
  return Math.round(fee * 10000) / 10000;
};

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
