import { Wallet, utils } from "ethers";

export interface CopyTradeConfig {
  // Polymarket endpoints
  clobHost: string;
  dataApiHost: string;
  gammaHost: string;
  chainId: number;

  // Your wallet
  privateKey: string;
  signatureType: number;
  funderAddress?: string;
  profileAddress: string;
  apiCreds?: { key: string; secret: string; passphrase: string };

  // Target trader to copy
  targetAddress: string;

  // Detection
  /** Polygon WebSocket RPC URL for real-time on-chain detection */
  rpcWsUrl: string;
  /** Data API polling interval (ms) — fallback + metadata enrichment */
  pollIntervalMs: number;

  // Position sizing
  /** Sizing mode: "fixed" | "percentage" | "portfolio" | "shares" */
  sizingMode: "fixed" | "percentage" | "portfolio" | "shares";
  /** Fixed USD amount per copy trade (sizingMode=fixed) */
  fixedAmountUsd: number;
  /** Fixed shares per copy trade (sizingMode=shares) */
  fixedShares: number;
  /** % of target's trade size to copy (sizingMode=percentage, 100 = same size) */
  copyAmountPct: number;
  /** Multiplier on top of portfolio weighting (1=same%, 2=double%, 0.5=half%) */
  copyMultiplier: number;
  /** Fallback leader portfolio if on-chain check fails */
  leaderPortfolioUsd: number;
  /** Max USD per single copy trade */
  maxTradeUsd: number;
  /** Min USD per single copy trade */
  minTradeUsd: number;

  // RPC for on-chain balance checks
  rpcUrl: string;

  // Slippage / Price control
  /** Max slippage in cents per bump (e.g. 1 = bump by 1¢ each time) */
  maxSlippageCents: number;
  /** Max price willing to pay (cents). Skip if price > this */
  maxPriceCents: number;
  /** Bump price after this many ms if GTC order not filled (0 = no bump) */
  bumpAfterMs: number;
  /** Max number of price bumps before giving up or falling back to FOK (default 3) */
  maxBumps: number;
  /** Use FOK (market order) as fallback after all bumps exhausted (default true) */
  fokFallback: boolean;
  /** Speed mode: "normal" = GTC test → FOK fallback, "fast" = direct FOK (lowest latency) */
  speedMode: "normal" | "fast";

  // Filters
  /** Only copy trades on these market types (empty = all) */
  marketFilter: string[];
  /** Only copy BUY trades (ignore SELL) */
  copyBuysOnly: boolean;
  /** Copy redemptions too */
  copyRedemptions: boolean;

  // Risk
  /** Max total exposure as % of balance */
  maxExposurePct: number;
  /** Absolute minimum balance floor */
  minBalanceFloorUsd: number;
  /** Max trades to copy per 5-min window */
  maxCopiesPerWindow: number;
  /** Cooldown between copy trades (ms) to avoid duplicates */
  cooldownMs: number;

  // Auto-redeem
  autoRedeem: boolean;
  relayerUrl: string;
  relayerTxType: "SAFE" | "PROXY";
  builderCreds?: { key: string; secret: string; passphrase: string };

  // Telegram
  telegramBotToken?: string;
  telegramChatId?: string;

  // Database (optional)
  databaseUrl?: string;

  // Operation
  dryRun: boolean;
  debug: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const getEnv = (name: string): string | undefined => {
  const val = process.env[name];
  return val === undefined || val === "" ? undefined : val;
};

const requireEnv = (name: string): string => {
  const val = getEnv(name);
  if (!val) throw new ConfigError(`Missing required env var: ${name}`);
  return val;
};

const parseNumber = (name: string, fallback?: number): number => {
  const raw = getEnv(name);
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`Missing required numeric env var: ${name}`);
  }
  const num = Number(raw.trim());
  if (!Number.isFinite(num)) throw new ConfigError(`Invalid number for ${name}: ${raw}`);
  return num;
};

const parseBoolean = (name: string, fallback = false): boolean => {
  const raw = getEnv(name);
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
};

const assertAddress = (name: string, value?: string): string | undefined => {
  if (!value) return undefined;
  try {
    return utils.getAddress(value);
  } catch {
    throw new ConfigError(`Invalid address for ${name}: ${value}`);
  }
};

export const loadCopyTradeConfig = (): CopyTradeConfig => {
  const clobHost = getEnv("CLOB_HOST") ?? "https://clob.polymarket.com";
  const dataApiHost = getEnv("DATA_API_HOST") ?? "https://data-api.polymarket.com";
  const gammaHost = getEnv("GAMMA_HOST") ?? "https://gamma-api.polymarket.com";
  const chainId = parseNumber("CHAIN_ID", 137);

  const privateKey = requireEnv("PRIVATE_KEY");
  const signatureType = parseNumber("SIGNATURE_TYPE", 1);
  const profileRaw = assertAddress("PROFILE_ADDRESS", getEnv("PROFILE_ADDRESS"));
  const funderRaw = assertAddress("FUNDER_ADDRESS", getEnv("FUNDER_ADDRESS"));
  const derivedAddress = new Wallet(privateKey).address.toLowerCase();
  const profileAddress = (profileRaw ?? funderRaw ?? derivedAddress)?.toLowerCase();
  const funderAddress = (funderRaw ?? profileRaw)?.toLowerCase();

  if ((signatureType === 1 || signatureType === 2) && !funderAddress) {
    throw new ConfigError("FUNDER_ADDRESS or PROFILE_ADDRESS is required for SIGNATURE_TYPE 1 or 2");
  }

  const apiKey = getEnv("CLOB_API_KEY");
  const apiSecret = getEnv("CLOB_API_SECRET");
  const apiPassphrase = getEnv("CLOB_API_PASSPHRASE");
  const apiCreds = apiKey && apiSecret && apiPassphrase
    ? { key: apiKey, secret: apiSecret, passphrase: apiPassphrase }
    : undefined;

  // Target trader
  const targetAddress = requireEnv("COPY_TARGET_ADDRESS").toLowerCase();

  // Detection
  const rpcWsUrl = getEnv("RPC_WS_URL") ?? "wss://polygon-bor-rpc.publicnode.com";
  const pollIntervalMs = parseNumber("COPY_POLL_INTERVAL_MS", 200);

  // Position sizing
  const sizingModeRaw = (getEnv("COPY_SIZING_MODE") ?? "portfolio").toLowerCase();
  const sizingMode = (["fixed", "percentage", "portfolio", "shares"].includes(sizingModeRaw)
    ? sizingModeRaw : "portfolio") as "fixed" | "percentage" | "portfolio" | "shares";
  const fixedAmountUsd = parseNumber("COPY_FIXED_AMOUNT_USD", 0);
  const fixedShares = parseNumber("COPY_FIXED_SHARES", 0);
  const copyAmountPct = parseNumber("COPY_AMOUNT_PCT", 100);
  const copyMultiplier = parseNumber("COPY_MULTIPLIER", 1.0);
  const leaderPortfolioUsd = parseNumber("COPY_LEADER_PORTFOLIO_USD", 0); // fallback only
  const maxTradeUsd = parseNumber("COPY_MAX_TRADE_USD", 500);
  const minTradeUsd = parseNumber("COPY_MIN_TRADE_USD", 1);

  // RPC for on-chain balance checks (leader portfolio)
  const rpcUrl = getEnv("RPC_URL") ?? "https://polygon-rpc.com";

  // Slippage — FOK worst price = leader price + this (default 2¢)
  const maxSlippageCents = parseNumber("COPY_MAX_SLIPPAGE_CENTS", 2);
  const maxPriceCents = parseNumber("COPY_MAX_PRICE_CENTS", 95);
  const bumpAfterMs = parseNumber("COPY_BUMP_AFTER_MS", 5 * 60_000); // 5 min — bump only if still unfilled after a long wait
  const maxBumps = parseNumber("COPY_MAX_BUMPS", 2); // up to 2 bumps (+1¢ each)
  const fokFallback = parseBoolean("COPY_FOK_FALLBACK", true); // FOK as last resort after bumps
  const speedModeRaw = (getEnv("COPY_SPEED_MODE") ?? "normal").toLowerCase();
  const speedMode = (speedModeRaw === "fast" ? "fast" : "normal") as "normal" | "fast";

  // Filters
  const marketFilterRaw = getEnv("COPY_MARKET_FILTER") ?? "";
  const marketFilter = marketFilterRaw ? marketFilterRaw.split(",").map((s) => s.trim().toLowerCase()) : [];
  const copyBuysOnly = parseBoolean("COPY_BUYS_ONLY", true);
  const copyRedemptions = parseBoolean("COPY_REDEMPTIONS", false);

  // Risk
  const maxExposurePct = parseNumber("COPY_MAX_EXPOSURE_PCT", 50);
  const minBalanceFloorUsd = parseNumber("MIN_BALANCE_FLOOR_USD", 50);
  const maxCopiesPerWindow = parseNumber("COPY_MAX_PER_WINDOW", 10);
  const cooldownMs = parseNumber("COPY_COOLDOWN_MS", 200);

  // Auto-redeem
  const autoRedeem = parseBoolean("AUTO_REDEEM", true);
  const relayerUrl = getEnv("RELAYER_URL") ?? "https://relayer-v2.polymarket.com";
  const relayerTxType = (getEnv("RELAYER_TX_TYPE") ?? "PROXY").toUpperCase() as "SAFE" | "PROXY";
  const builderKey = getEnv("BUILDER_API_KEY");
  const builderSecret = getEnv("BUILDER_API_SECRET");
  const builderPassphrase = getEnv("BUILDER_API_PASSPHRASE");
  const builderCreds = builderKey && builderSecret && builderPassphrase
    ? { key: builderKey, secret: builderSecret, passphrase: builderPassphrase }
    : undefined;

  // Telegram
  const telegramBotToken = getEnv("TELEGRAM_BOT_TOKEN");
  const telegramChatId = getEnv("TELEGRAM_CHAT_ID");

  // Database (optional)
  const databaseUrl = getEnv("DATABASE_URL");

  // Operation
  const dryRun = parseBoolean("DRY_RUN", true);
  const debug = parseBoolean("DEBUG", false);

  if (!profileAddress) {
    throw new ConfigError("PROFILE_ADDRESS or FUNDER_ADDRESS is required.");
  }

  return {
    clobHost,
    dataApiHost,
    gammaHost,
    chainId,
    privateKey,
    signatureType,
    funderAddress: funderAddress?.toLowerCase(),
    profileAddress,
    apiCreds,
    targetAddress,
    rpcWsUrl,
    pollIntervalMs,
    sizingMode,
    fixedAmountUsd,
    fixedShares,
    copyAmountPct,
    copyMultiplier,
    leaderPortfolioUsd,
    maxTradeUsd,
    minTradeUsd,
    rpcUrl,
    maxSlippageCents,
    maxPriceCents,
    bumpAfterMs,
    maxBumps,
    fokFallback,
    speedMode,
    marketFilter,
    copyBuysOnly,
    copyRedemptions,
    maxExposurePct,
    minBalanceFloorUsd,
    maxCopiesPerWindow,
    cooldownMs,
    autoRedeem,
    relayerUrl,
    relayerTxType,
    builderCreds,
    telegramBotToken,
    telegramChatId,
    databaseUrl,
    dryRun,
    debug,
  };
};
