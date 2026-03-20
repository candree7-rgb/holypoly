import { Wallet, utils } from "ethers";

export interface ApiCreds {
  key: string;
  secret: string;
  passphrase: string;
}

export interface Config {
  // Polymarket endpoints
  clobHost: string;
  dataApiHost: string;
  gammaHost: string;
  chainId: number;

  // Wallet
  privateKey: string;
  signatureType: number;
  funderAddress?: string;
  profileAddress: string;
  apiCreds?: ApiCreds;

  // Webhook (kept for optional use)
  webhookPort: number;
  webhookSecret?: string;

  // === CONVERGENCE ARB PARAMETERS ===

  // Position sizing
  /** % of wallet balance per entry (e.g. 5 = 5%) */
  buyAmountPct: number;
  /** Max buys per window */
  maxBuysPerWindow: number;

  // Entry timing — time-remaining based
  /** Only enter when window has <= this many seconds remaining */
  maxEntryTimeRemaining: number;
  /** Don't enter with < this many seconds remaining */
  minEntryTimeRemaining: number;

  // Entry filters
  /** Minimum edge (cents) to enter: fairValue - marketAsk */
  edgeThresholdCents: number;
  /** Minimum normalized delta (sigma) to enter */
  minNormalizedDelta: number;
  /** Minimum absolute BTC delta (USD) to consider trading */
  minDeltaThresholdUsd: number;
  /** Max adverse momentum (USD) before skipping */
  maxAdverseMomentumUsd: number;
  /** Spike ratio threshold: |momentum10s|/|momentum30s| > this = spike, skip */
  spikeRatioThreshold: number;
  /** Seconds to look back for momentum check */
  momentumLookbackSeconds: number;
  /** Seconds to look back for volatility calculation */
  volatilityLookbackSeconds: number;
  /** How often (ms) to scan for edge opportunities */
  scanIntervalMs: number;

  // Naked position safety
  /** Fair value threshold: if winner fairValue >= this, naked hold is safe */
  nakedSafetyThreshold: number;
  /** If delta drops by this % from entry, trigger emergency sell */
  reversalDeltaDropPct: number;
  /** Max spread (cents) for emergency sell-back: sell at bestBid */
  emergencySellMaxSpreadCents: number;

  // Opportunistic loser fill
  /** Buy loser if it drops to <= this price (cents). Ultra-cheap = free hedge */
  opportunisticLoserMaxCents: number;

  // Risk management
  /** Max unhedged exposure as % of balance */
  maxUnhedgedPct: number;
  /** Max total cost per window as % of balance */
  maxWindowExposurePct: number;
  /** Max daily loss as % of starting daily balance */
  dailyLossLimitPct: number;
  /** Max weekly loss as % of starting weekly balance */
  weeklyLossLimitPct: number;
  losingStreakPause: number;
  /** Absolute minimum USDC balance — stop trading below this */
  minBalanceFloorUsd: number;

  // Redeem
  redeemDelaySeconds: number;

  // Database
  databaseUrl: string;

  // Auto-redeem
  autoRedeem: boolean;
  relayerUrl: string;
  relayerTxType: "SAFE" | "PROXY";
  builderCreds?: ApiCreds;
  builderSigningUrl?: string;
  builderSigningToken?: string;
  rpcUrl?: string;

  // Telegram
  telegramBotToken?: string;
  telegramChatId?: string;

  // Operation
  dryRun: boolean;
  debug: boolean;
  stateFile: string;
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
  const trimmed = raw.trim();
  const num = Number(trimmed);
  if (!Number.isFinite(num)) {
    const match = trimmed.match(/^-?\d+(\.\d+)?/);
    if (!match) throw new ConfigError(`Invalid number for ${name}: ${raw}`);
    const parsed = Number(match[0]);
    if (!Number.isFinite(parsed)) throw new ConfigError(`Invalid number for ${name}: ${raw}`);
    return parsed;
  }
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

export const loadConfig = (): Config => {
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

  const webhookPort = parseNumber("PORT", 3000);
  const webhookSecret = getEnv("WEBHOOK_SECRET");

  // === CONVERGENCE ARB PARAMETERS ===
  const buyAmountPct = parseNumber("BUY_AMOUNT_PCT", 5);
  const maxBuysPerWindow = parseNumber("MAX_BUYS_PER_WINDOW", 2);

  // Entry timing
  const maxEntryTimeRemaining = parseNumber("MAX_ENTRY_TIME_REMAINING", 100);
  const minEntryTimeRemaining = parseNumber("MIN_ENTRY_TIME_REMAINING", 30);

  // Entry filters
  const edgeThresholdCents = parseNumber("EDGE_THRESHOLD_CENTS", 2);
  const minNormalizedDelta = parseNumber("MIN_NORMALIZED_DELTA", 0.7);
  const minDeltaThresholdUsd = parseNumber("MIN_DELTA_THRESHOLD_USD", 10);
  const maxAdverseMomentumUsd = parseNumber("MAX_ADVERSE_MOMENTUM_USD", 50);
  const spikeRatioThreshold = parseNumber("SPIKE_RATIO_THRESHOLD", 3.0);
  const momentumLookbackSeconds = parseNumber("MOMENTUM_LOOKBACK_SECONDS", 30);
  const volatilityLookbackSeconds = parseNumber("VOLATILITY_LOOKBACK_SECONDS", 120);
  const scanIntervalMs = parseNumber("SCAN_INTERVAL_MS", 500);

  // Naked position safety
  const nakedSafetyThreshold = parseNumber("NAKED_SAFETY_THRESHOLD", 95);
  const reversalDeltaDropPct = parseNumber("REVERSAL_DELTA_DROP_PCT", 30);
  const emergencySellMaxSpreadCents = parseNumber("EMERGENCY_SELL_MAX_SPREAD_CENTS", 3);

  // Opportunistic loser fill
  const opportunisticLoserMaxCents = parseNumber("OPPORTUNISTIC_LOSER_MAX_CENTS", 3);

  // Risk management
  const maxUnhedgedPct = parseNumber("MAX_UNHEDGED_PCT", 8);
  const maxWindowExposurePct = parseNumber("MAX_WINDOW_EXPOSURE_PCT", 15);
  const dailyLossLimitPct = parseNumber("DAILY_LOSS_LIMIT_PCT", 10);
  const weeklyLossLimitPct = parseNumber("WEEKLY_LOSS_LIMIT_PCT", 20);
  const losingStreakPause = parseNumber("LOSING_STREAK_PAUSE", 5);
  const minBalanceFloorUsd = parseNumber("MIN_BALANCE_FLOOR_USD", 50);

  // Redeem
  const redeemDelaySeconds = parseNumber("REDEEM_DELAY_SECONDS", 200);

  // Database
  const databaseUrl = requireEnv("DATABASE_URL");

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

  const builderSigningUrl = getEnv("BUILDER_SIGNING_URL");
  const builderSigningToken = getEnv("BUILDER_SIGNING_TOKEN");
  const rpcUrl = getEnv("RPC_URL");

  if (!profileAddress) {
    throw new ConfigError("PROFILE_ADDRESS or FUNDER_ADDRESS is required.");
  }

  if (autoRedeem) {
    if (!rpcUrl) throw new ConfigError("RPC_URL is required when AUTO_REDEEM=true");
    if (!builderCreds && !(builderSigningUrl && builderSigningToken)) {
      throw new ConfigError("Builder credentials required when AUTO_REDEEM=true. Provide BUILDER_API_* or BUILDER_SIGNING_*.");
    }
  }

  const telegramBotToken = getEnv("TELEGRAM_BOT_TOKEN");
  const telegramChatId = getEnv("TELEGRAM_CHAT_ID");

  const dryRun = parseBoolean("DRY_RUN", true);
  const debug = parseBoolean("DEBUG", false);
  const stateFile = getEnv("STATE_FILE") ?? "./data/state.json";

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
    webhookPort,
    webhookSecret,
    buyAmountPct,
    maxBuysPerWindow,
    maxEntryTimeRemaining,
    minEntryTimeRemaining,
    edgeThresholdCents,
    minNormalizedDelta,
    minDeltaThresholdUsd,
    maxAdverseMomentumUsd,
    spikeRatioThreshold,
    momentumLookbackSeconds,
    volatilityLookbackSeconds,
    scanIntervalMs,
    nakedSafetyThreshold,
    reversalDeltaDropPct,
    emergencySellMaxSpreadCents,
    opportunisticLoserMaxCents,
    maxUnhedgedPct,
    maxWindowExposurePct,
    dailyLossLimitPct,
    weeklyLossLimitPct,
    losingStreakPause,
    minBalanceFloorUsd,
    redeemDelaySeconds,
    databaseUrl,
    autoRedeem,
    relayerUrl,
    relayerTxType,
    builderCreds,
    builderSigningUrl,
    builderSigningToken,
    rpcUrl,
    telegramBotToken,
    telegramChatId,
    dryRun,
    debug,
    stateFile,
  };
};
