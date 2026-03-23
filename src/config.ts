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

  // Webhook (kept for optional hybrid mode)
  webhookPort: number;
  webhookSecret?: string;

  // Trading parameters (percentage-based for compounding)
  /** % of wallet balance per individual order (e.g. 4 = 4%) */
  buyAmountPct: number;
  maxBuysPerWindow: number;
  maxBuysPerSide: number;
  maxEntryPriceCents: number;
  minEntryPriceCents: number;
  /** Max ask sum (Up ask + Down ask) to enter — must be below this for hedge to be profitable */
  maxEntryAskSumCents: number;
  redeemDelaySeconds: number;

  // Edge detection parameters
  /** Minimum edge (cents) to enter a trade */
  edgeThresholdCents: number;
  /** Edge tier thresholds for position scaling */
  edgeTier2Cents: number;
  edgeTier3Cents: number;
  edgeTier4Cents: number;
  /** Minimum BTC delta (USD) to consider trading */
  minDeltaThresholdUsd: number;
  /** Max adverse momentum (USD) before skipping trade */
  maxAdverseMomentumUsd: number;
  /** Seconds to look back for momentum check */
  momentumLookbackSeconds: number;
  /** Seconds to look back for volatility calculation */
  volatilityLookbackSeconds: number;
  /** Seconds to wait after window start before scanning */
  entryDelaySeconds: number;
  /** How often (ms) to scan for edge opportunities */
  scanIntervalMs: number;

  // Hedge parameters
  hedgeMonitorEnabled: boolean;
  hedgeTriggerCents: number;
  hedgeEdgeThresholdCents: number;
  hedgeMaxPriceCents: number;

  // Arb completion parameters
  /** Minimum profit (cents) per share pair to complete arb */
  minProfitCents: number;
  /** Max round-trips (buy winner + buy loser) per window */
  maxRoundTripsPerWindow: number;
  /** Max unhedged exposure as % of balance */
  maxUnhedgedPct: number;
  /** Max total cost per window as % of balance */
  maxWindowExposurePct: number;
  /** Timeout (ms) to complete arb before emergency balance */
  arbCompletionTimeoutMs: number;

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

  // Strategy mode
  /** "merge-arb" = V5 maker, "signal-taker" = V6 Binance signal, "edge" = edge-detection, "webhook" = TradingView signals */
  strategyMode: "merge-arb" | "signal-taker" | "edge" | "webhook";

  // V6 Signal-Taker parameters
  /** BTC % move threshold to trigger buy (e.g. 0.0005 = 0.05%) */
  btcMoveThreshold: number;
  /** Only buy when ask < this price (e.g. 0.45 = 45¢) */
  cheapThreshold: number;
  /** How often (ms) to check Binance price and evaluate signal */
  signalCheckIntervalMs: number;
  /** Max chunks more on one side before pausing that side */
  maxImbalanceChunks: number;

  // Merge-Arb Strategy parameters (merge-arb mode, V3 spec)
  /** Fraction of balance to allocate per window (e.g. 0.80 = 80%) */
  equityPerWindow: number;
  /** Maximum number of orders (buys) per window */
  maxOrdersPerWindow: number;
  /** Minimum matched shares before triggering merge */
  mergeMinSize: number;
  /** Milliseconds to wait after window opens before first order */
  mergeEntryDelayMs: number;
  /** Milliseconds between orders within accumulate phase */
  orderIntervalMs: number;
  /** Extra cents above best ask for order price (e.g. 0.02 = +2¢) */
  slippageBuffer: number;
  /** Milliseconds to wait for GTC fill confirmation */
  orderTimeoutMs: number;
  /** Skip window if best combined ask > this (e.g. 1.10 = 110¢) — only for broken books */
  skipIfBestCombinedGt: number;
  /** Minimum orderbook levels on each side to proceed */
  minBookLevels: number;
  /** Number of retries per failed order */
  maxRetriesPerOrder: number;
  /** Hard cap on shares per order (orderbooks are thin on 5-min markets) */
  maxChunkSize: number;
  /** Stop buying this many seconds before window end */
  stopBuyingBeforeEndS: number;
  /** Merge this many seconds before window end */
  mergeBeforeEndS: number;
  /** V4: Dip threshold — buy a side when its ask < midpoint × this (e.g. 0.90 = 10% below mid) */
  dipThresholdPct: number;
  /** V4: How often (ms) to check both books for dip opportunities (fast polling, not order interval) */
  monitorIntervalMs: number;
  /** V5 Maker: cents below best ask to post our bid (must be ≥1 to be maker, not taker) */
  makerOffsetCents: number;
  /** V5 Maker: how often (ms) to update quotes / check fills */
  quoteUpdateMs: number;
  /** V5: Maker phase ends this many seconds before window end (then assess+rebalance) */
  makerPhaseEndS: number;
  /** V5: Max shares to buy as taker for rebalancing (limits fee exposure) */
  maxTakerRebalanceShares: number;

  // Signal strategy parameters (webhook mode)
  /** GTC limit ladder prices in cents (comma-separated) */
  signalLadderPrices: number[];
  /** GTC limit ladder weights (comma-separated, must sum to ~1) */
  signalLadderWeights: number[];
  /** Seconds into target window before FOK fallback */
  signalFokFallbackSec: number;
  /** Max price (cents) for FOK fallback */
  signalFokMaxPriceCents: number;
  /** Maker fee rate (0 on Polymarket) */
  makerFeeRate: number;
  /** Taker fee rate (0.02 on Polymarket crypto) */
  takerFeeRate: number;

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
    // Try parsing just the leading numeric portion (handles values like "52 (default 52)")
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

  // Webhook
  const webhookPort = parseNumber("PORT", 3000); // Railway sets PORT automatically
  const webhookSecret = getEnv("WEBHOOK_SECRET");

  // Trading parameters
  const buyAmountPct = parseNumber("BUY_AMOUNT_PCT", 4);
  const maxBuysPerWindow = parseNumber("MAX_BUYS_PER_WINDOW", 5);
  const maxBuysPerSide = parseNumber("MAX_BUYS_PER_SIDE", 3);
  const maxEntryPriceCents = parseNumber("MAX_ENTRY_PRICE_CENTS", 92);
  const minEntryPriceCents = parseNumber("MIN_ENTRY_PRICE_CENTS", 40);
  const maxEntryAskSumCents = parseNumber("MAX_ENTRY_ASK_SUM_CENTS", 100);
  const redeemDelaySeconds = parseNumber("REDEEM_DELAY_SECONDS", 200);

  // Edge detection parameters
  const edgeThresholdCents = parseNumber("EDGE_THRESHOLD_CENTS", 5);
  const edgeTier2Cents = parseNumber("EDGE_TIER2_CENTS", 8);
  const edgeTier3Cents = parseNumber("EDGE_TIER3_CENTS", 12);
  const edgeTier4Cents = parseNumber("EDGE_TIER4_CENTS", 15);
  const minDeltaThresholdUsd = parseNumber("MIN_DELTA_THRESHOLD_USD", 10);
  const maxAdverseMomentumUsd = parseNumber("MAX_ADVERSE_MOMENTUM_USD", 50);
  const momentumLookbackSeconds = parseNumber("MOMENTUM_LOOKBACK_SECONDS", 30);
  const volatilityLookbackSeconds = parseNumber("VOLATILITY_LOOKBACK_SECONDS", 120);
  const entryDelaySeconds = parseNumber("ENTRY_DELAY_SECONDS", 30);
  const scanIntervalMs = parseNumber("SCAN_INTERVAL_MS", 2000);

  // Hedge parameters
  const hedgeMonitorEnabled = parseBoolean("HEDGE_MONITOR_ENABLED", true);
  const hedgeTriggerCents = parseNumber("HEDGE_TRIGGER_CENTS", 5);
  const hedgeEdgeThresholdCents = parseNumber("HEDGE_EDGE_THRESHOLD_CENTS", 12);
  const hedgeMaxPriceCents = parseNumber("HEDGE_MAX_PRICE_CENTS", 45);

  // Arb completion parameters
  const minProfitCents = parseNumber("MIN_PROFIT_CENTS", 4);
  const maxRoundTripsPerWindow = parseNumber("MAX_ROUND_TRIPS_PER_WINDOW", 3);
  const maxUnhedgedPct = parseNumber("MAX_UNHEDGED_PCT", 11);
  const maxWindowExposurePct = parseNumber("MAX_WINDOW_EXPOSURE_PCT", 15);
  const arbCompletionTimeoutMs = parseNumber("ARB_COMPLETION_TIMEOUT_MS", 60000);

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

  // Strategy mode
  const strategyModeRaw = getEnv("STRATEGY_MODE") ?? "merge-arb";
  const strategyMode = strategyModeRaw === "webhook" ? "webhook"
    : strategyModeRaw === "edge" ? "edge"
    : strategyModeRaw === "signal-taker" ? "signal-taker"
    : "merge-arb" as const;

  // V6 Signal-Taker parameters
  const btcMoveThreshold = parseNumber("BTC_MOVE_THRESHOLD", 0.0005);
  const cheapThreshold = parseNumber("CHEAP_THRESHOLD", 0.45);
  const signalCheckIntervalMs = parseNumber("SIGNAL_CHECK_INTERVAL_MS", 500);
  const maxImbalanceChunks = parseNumber("MAX_IMBALANCE_CHUNKS", 3);

  // Merge-Arb Strategy parameters (V3)
  const equityPerWindow = parseNumber("EQUITY_PER_WINDOW", 0.80);
  const maxOrdersPerWindow = parseNumber("MAX_ORDERS_PER_WINDOW", 30);
  const mergeMinSize = parseNumber("MERGE_MIN_SIZE", 10);
  const mergeEntryDelayMs = parseNumber("MERGE_ENTRY_DELAY_MS", 5000);
  const orderIntervalMs = parseNumber("ORDER_INTERVAL_MS", 2000);
  const slippageBuffer = parseNumber("SLIPPAGE_BUFFER", 0.02);
  const orderTimeoutMs = parseNumber("ORDER_TIMEOUT_MS", 3000);
  const skipIfBestCombinedGt = parseNumber("SKIP_IF_BEST_COMBINED_GT", 1.10);
  const minBookLevels = parseNumber("MIN_BOOK_LEVELS", 3);
  const maxRetriesPerOrder = parseNumber("MAX_RETRIES_PER_ORDER", 1);
  const maxChunkSize = parseNumber("MAX_CHUNK_SIZE", 200);
  const stopBuyingBeforeEndS = parseNumber("STOP_BUYING_BEFORE_END_S", 40);
  const mergeBeforeEndS = parseNumber("MERGE_BEFORE_END_S", 20);
  const dipThresholdPct = parseNumber("DIP_THRESHOLD_PCT", 0.92);
  const monitorIntervalMs = parseNumber("MONITOR_INTERVAL_MS", 500);
  const makerOffsetCents = parseNumber("MAKER_OFFSET_CENTS", 2);
  const quoteUpdateMs = parseNumber("QUOTE_UPDATE_MS", 1000);
  const makerPhaseEndS = parseNumber("MAKER_PHASE_END_S", 60);
  const maxTakerRebalanceShares = parseNumber("MAX_TAKER_REBALANCE_SHARES", 500);

  // Signal strategy parameters (webhook mode)
  const signalLadderPricesRaw = getEnv("SIGNAL_LADDER_PRICES") ?? "49,50,51";
  const signalLadderPrices = signalLadderPricesRaw.split(",").map((s) => Number(s.trim()));
  const signalLadderWeightsRaw = getEnv("SIGNAL_LADDER_WEIGHTS") ?? "0.25,0.40,0.35";
  const signalLadderWeights = signalLadderWeightsRaw.split(",").map((s) => Number(s.trim()));
  const signalFokFallbackSec = parseNumber("SIGNAL_FOK_FALLBACK_SEC", 240);
  const signalFokMaxPriceCents = parseNumber("SIGNAL_FOK_MAX_PRICE_CENTS", 52);
  const makerFeeRate = parseNumber("MAKER_FEE_RATE", 0);
  const takerFeeRate = parseNumber("TAKER_FEE_RATE", 0.02);

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
    maxBuysPerSide,
    maxEntryPriceCents,
    minEntryPriceCents,
    maxEntryAskSumCents,
    redeemDelaySeconds,
    edgeThresholdCents,
    edgeTier2Cents,
    edgeTier3Cents,
    edgeTier4Cents,
    minDeltaThresholdUsd,
    maxAdverseMomentumUsd,
    momentumLookbackSeconds,
    volatilityLookbackSeconds,
    entryDelaySeconds,
    scanIntervalMs,
    hedgeMonitorEnabled,
    hedgeTriggerCents,
    hedgeEdgeThresholdCents,
    hedgeMaxPriceCents,
    minProfitCents,
    maxRoundTripsPerWindow,
    maxUnhedgedPct,
    maxWindowExposurePct,
    arbCompletionTimeoutMs,
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
    strategyMode,
    btcMoveThreshold,
    cheapThreshold,
    signalCheckIntervalMs,
    maxImbalanceChunks,
    equityPerWindow,
    maxOrdersPerWindow,
    mergeMinSize,
    mergeEntryDelayMs,
    orderIntervalMs,
    slippageBuffer,
    orderTimeoutMs,
    skipIfBestCombinedGt,
    minBookLevels,
    maxRetriesPerOrder,
    maxChunkSize,
    stopBuyingBeforeEndS,
    mergeBeforeEndS,
    dipThresholdPct,
    monitorIntervalMs,
    makerOffsetCents,
    quoteUpdateMs,
    makerPhaseEndS,
    maxTakerRebalanceShares,
    signalLadderPrices,
    signalLadderWeights,
    signalFokFallbackSec,
    signalFokMaxPriceCents,
    makerFeeRate,
    takerFeeRate,
    dryRun,
    debug,
    stateFile,
  };
};
