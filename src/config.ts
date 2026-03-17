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

  // Webhook
  webhookPort: number;
  webhookSecret?: string;

  // Trading parameters (percentage-based for compounding)
  /** % of wallet balance per individual order (e.g. 4 = 4%) */
  buyAmountPct: number;
  maxBuysPerWindow: number;
  /** Max price (cents) to enter current market — above this, target next market */
  currentMarketMaxPriceCents: number;
  /** Limit order price (cents) for early next-market entry */
  nextMarketLimitPriceCents: number;
  /** Timeout (ms) for limit order before switching to market order */
  limitOrderTimeoutMs: number;
  maxEntryPriceCents: number;
  minEntryPriceCents: number;
  redeemDelaySeconds: number;

  // Risk management (percentage-based)
  /** Max daily loss as % of starting daily balance (e.g. 10 = 10%) */
  dailyLossLimitPct: number;
  /** Max weekly loss as % of starting weekly balance */
  weeklyLossLimitPct: number;
  losingStreakPause: number;
  /** Absolute minimum USDC balance — stop trading below this */
  minBalanceFloorUsd: number;

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
  const num = Number(raw);
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

  // Webhook
  const webhookPort = parseNumber("PORT", 3000); // Railway sets PORT automatically
  const webhookSecret = getEnv("WEBHOOK_SECRET");

  // Trading parameters
  const buyAmountPct = parseNumber("BUY_AMOUNT_PCT", 4);
  const maxBuysPerWindow = parseNumber("MAX_BUYS_PER_WINDOW", 7);
  const currentMarketMaxPriceCents = parseNumber("CURRENT_MARKET_MAX_PRICE_CENTS", 58);
  const nextMarketLimitPriceCents = parseNumber("NEXT_MARKET_LIMIT_PRICE_CENTS", 52);
  const limitOrderTimeoutMs = parseNumber("LIMIT_ORDER_TIMEOUT_MS", 15000);
  const maxEntryPriceCents = parseNumber("MAX_ENTRY_PRICE_CENTS", 92);
  const minEntryPriceCents = parseNumber("MIN_ENTRY_PRICE_CENTS", 40);
  const redeemDelaySeconds = parseNumber("REDEEM_DELAY_SECONDS", 200);

  // Risk management (percentage-based)
  const dailyLossLimitPct = parseNumber("DAILY_LOSS_LIMIT_PCT", 10);
  const weeklyLossLimitPct = parseNumber("WEEKLY_LOSS_LIMIT_PCT", 20);
  const losingStreakPause = parseNumber("LOSING_STREAK_PAUSE", 5);
  const minBalanceFloorUsd = parseNumber("MIN_BALANCE_FLOOR_USD", 50);

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

  // Telegram (optional)
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
    currentMarketMaxPriceCents,
    nextMarketLimitPriceCents,
    limitOrderTimeoutMs,
    maxEntryPriceCents,
    minEntryPriceCents,
    redeemDelaySeconds,
    dailyLossLimitPct,
    weeklyLossLimitPct,
    losingStreakPause,
    minBalanceFloorUsd,
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
