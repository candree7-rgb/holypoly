import type { Logger } from "../logger.js";

/** USDC.e on Polygon (Polymarket uses this for pUSD) */
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

export interface Position {
  asset: string; // CLOB token ID
  conditionId: string;
  size: number; // shares held
  avgPrice: number;
  curPrice: number;
  currentValue: number; // USD value at current price
  outcome: string;
  outcomeIndex: number;
  title: string;
}

export interface PortfolioValue {
  /** Free USDC (pUSD) on-chain */
  usdc: number;
  /** Sum of currentValue across all open positions */
  positionValue: number;
  /** Total equity: usdc + positionValue */
  total: number;
}

/**
 * Fetch a user's total portfolio value (USDC + open positions).
 * This is what "how much capital does this user have" really means.
 *
 * Polymarket Data API endpoints (no auth):
 *   GET /value?user=<proxyWallet> → total position value
 *   USDC.balanceOf via RPC → free USDC on proxy wallet
 */
export async function getPortfolioValue(
  proxyWallet: string,
  rpcUrl: string,
  dataApiHost: string,
  logger: Logger,
): Promise<PortfolioValue> {
  const addr = proxyWallet.toLowerCase();

  const [usdc, positionValue] = await Promise.all([
    fetchUsdcBalance(addr, rpcUrl).catch((err) => {
      logger.warn("USDC balance fetch failed", { error: (err as Error).message });
      return 0;
    }),
    fetchPositionValue(addr, dataApiHost).catch((err) => {
      logger.warn("Position value fetch failed", { error: (err as Error).message });
      return 0;
    }),
  ]);

  return { usdc, positionValue, total: usdc + positionValue };
}

/**
 * Fetch a user's current open positions for a specific token ID.
 * Returns shares held and current value.
 */
export async function getPositionForToken(
  proxyWallet: string,
  tokenId: string,
  dataApiHost: string,
): Promise<Position | null> {
  const url = new URL(`${dataApiHost.replace(/\/$/, "")}/positions`);
  url.searchParams.set("user", proxyWallet.toLowerCase());
  url.searchParams.set("sizeThreshold", "0"); // Don't hide small positions
  url.searchParams.set("limit", "500");

  const resp = await fetch(url.toString(), {
    headers: { Accept: "application/json", "User-Agent": "holypoly-copytrade" },
    signal: AbortSignal.timeout(3000),
  });
  // Throw on HTTP errors so caller can distinguish "no position" from "API failure"
  if (!resp.ok) throw new Error(`Positions API returned ${resp.status}`);

  const data = await resp.json() as Array<{
    asset?: string;
    conditionId?: string;
    size?: number;
    avgPrice?: number;
    curPrice?: number;
    currentValue?: number;
    outcome?: string;
    outcomeIndex?: number;
    title?: string;
  }>;
  if (!Array.isArray(data)) throw new Error("Positions API returned non-array response");

  const match = data.find((p) => p.asset === tokenId);
  // Valid "no position" response — return null (distinguishable from thrown error)
  if (!match || !match.size || match.size <= 0) return null;

  return {
    asset: match.asset || "",
    conditionId: match.conditionId || "",
    size: match.size,
    avgPrice: match.avgPrice || 0,
    curPrice: match.curPrice || 0,
    currentValue: match.currentValue || 0,
    outcome: match.outcome || "",
    outcomeIndex: match.outcomeIndex || 0,
    title: match.title || "",
  };
}

async function fetchPositionValue(proxyWallet: string, dataApiHost: string): Promise<number> {
  const url = `${dataApiHost.replace(/\/$/, "")}/value?user=${proxyWallet}`;
  const resp = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "holypoly-copytrade" },
    signal: AbortSignal.timeout(3000),
  });
  if (!resp.ok) return 0;

  const data = await resp.json() as Array<{ value?: number }>;
  if (!Array.isArray(data) || data.length === 0) return 0;
  const first = data[0];
  if (!first || typeof first !== "object") return 0;
  return typeof first.value === "number" ? first.value : 0;
}

async function fetchUsdcBalance(proxyWallet: string, rpcUrl: string): Promise<number> {
  // ERC-20 balanceOf(address) selector = 0x70a08231
  const paddedAddr = proxyWallet.replace("0x", "").padStart(64, "0");
  const callData = "0x70a08231" + paddedAddr;

  const resp = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: USDC_ADDRESS, data: callData }, "latest"],
    }),
    signal: AbortSignal.timeout(3000),
  });
  if (!resp.ok) return 0;

  const data = await resp.json() as { result?: string };
  if (!data.result) return 0;
  const raw = BigInt(data.result);
  return Number(raw) / 1e6; // USDC has 6 decimals
}
