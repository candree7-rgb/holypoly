import "dotenv/config";
import { webcrypto } from "crypto";
import { Side } from "@polymarket/clob-client";
import { loadConfig, ConfigError, type Config } from "./config.js";
import { createLogger } from "./logger.js";
import { Database } from "./db.js";
import { BinanceWsClient } from "./data/binance-ws.js";
import { GammaClient } from "./data/gamma.js";
import { ClobService } from "./data/clob.js";
import { DataApiClient } from "./data/data-api.js";
import { RedeemService } from "./data/redeem.js";
import { VolatilityCalculator } from "./signal/volatility.js";
import { FairValueEngine } from "./signal/fair-value.js";
import { EdgeDetector } from "./signal/edge-detector.js";
import { WindowManager } from "./execution/window-manager.js";
import { RiskManager } from "./risk/limits.js";
import { sleep, nowSec } from "./utils.js";
import type { GridOrder } from "./types.js";

const MAIN_LOOP_INTERVAL_MS = 1000;
const REDEEM_COOLDOWN_SEC = 600;
const REDEEM_POLL_INTERVAL_MS = 30000;

const main = async () => {
  if (!globalThis.crypto) {
    (globalThis as typeof globalThis & { crypto?: Crypto }).crypto =
      webcrypto as Crypto;
  }

  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[config] ${err.message}`);
      console.error("Fix configuration and restart.");
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger(config.debug);

  // Initialize PostgreSQL
  const db = new Database(config.databaseUrl, logger);
  await db.init();

  logger.info("=== HolyPoly Bot Starting ===");
  logger.info("Mode", { dryRun: config.dryRun });
  logger.info("Parameters", {
    buyAmountPct: `${config.buyAmountPct}%`,
    edgeThreshold: `${config.edgeThresholdCents}¢`,
    maxBuysPerWindow: config.maxBuysPerWindow,
    entryDelay: `${config.entryDelaySeconds}s`,
    dailyLossLimit: `${config.dailyLossLimitPct}%`,
    weeklyLossLimit: `${config.weeklyLossLimitPct}%`,
  });

  // Initialize services
  const clob = await ClobService.init(
    {
      host: config.clobHost,
      chainId: config.chainId,
      privateKey: config.privateKey,
      signatureType: config.signatureType,
      funderAddress: config.funderAddress,
      apiCreds: config.apiCreds,
    },
    logger,
  );

  const gamma = new GammaClient(config.gammaHost, logger);
  const dataApi = new DataApiClient(config.dataApiHost, logger);
  const windowManager = new WindowManager(gamma, logger);

  // Signal engine
  const volatilityCalc = new VolatilityCalculator(config.volatilityLookbackSeconds);
  const fairValueEngine = new FairValueEngine(volatilityCalc);
  const edgeDetector = new EdgeDetector(fairValueEngine, clob, config, logger);

  // Risk manager (%-based, backed by PostgreSQL)
  const riskManager = new RiskManager(
    config,
    db,
    logger,
    () => dataApi.getBalance(config.profileAddress)
  );

  // Binance WebSocket (realtime BTC price)
  const binance = new BinanceWsClient(logger);
  binance.onTick((tick) => {
    volatilityCalc.addPrice(tick.price, tick.timestamp);
  });
  binance.start();

  // Auto-redeem service
  const redeemService = config.autoRedeem
    ? RedeemService.init(
        {
          relayerUrl: config.relayerUrl,
          chainId: config.chainId,
          privateKey: config.privateKey,
          rpcUrl: config.rpcUrl!,
          txType: config.relayerTxType,
          builderCreds: config.builderCreds,
          builderSigningUrl: config.builderSigningUrl,
          builderSigningToken: config.builderSigningToken,
        },
        logger,
      )
    : null;

  // Per-window state
  let tradedThisWindow = false;
  let currentWindowId: string | null = null;
  let windowOrders: GridOrder[] = [];

  // === MAIN TRADING LOOP ===
  const tradingLoop = async () => {
    let lastStatusLog = 0;

    while (true) {
      try {
        const now = Date.now();

        // Log status every 5 minutes
        if (now - lastStatusLog >= 300000) {
          await riskManager.logStatus();
          logger.info("Binance WS", { connected: binance.connected, price: binance.price });
          lastStatusLog = now;
        }

        // Skip if Binance not connected
        if (!binance.connected || binance.price === null) {
          await sleep(MAIN_LOOP_INTERVAL_MS);
          continue;
        }

        // Get current window
        const window = await windowManager.tick();
        if (!window) {
          await sleep(MAIN_LOOP_INTERVAL_MS);
          continue;
        }

        // New window — reset
        if (window.conditionId !== currentWindowId) {
          currentWindowId = window.conditionId;
          tradedThisWindow = false;
          windowOrders = [];

          if (window.openingPrice === 0) {
            windowManager.setOpeningPrice(binance.price);
          }
        }

        if (tradedThisWindow) {
          await sleep(MAIN_LOOP_INTERVAL_MS);
          continue;
        }

        // Wait for entry phase
        if (!windowManager.isEntryPhase(config.entryDelaySeconds)) {
          await sleep(MAIN_LOOP_INTERVAL_MS);
          continue;
        }

        // Risk check (returns dynamic buy amount from balance %)
        const riskCheck = await riskManager.check();
        if (!riskCheck.allowed) {
          logger.warn("Risk check blocked", { reason: riskCheck.reason });
          tradedThisWindow = true;
          await sleep(MAIN_LOOP_INTERVAL_MS);
          continue;
        }

        const buyAmountUsd = riskCheck.buyAmountUsd;

        // Evaluate edge
        const timeRemaining = windowManager.timeRemaining();
        const decision = await edgeDetector.evaluate(
          window,
          binance.price,
          timeRemaining,
          buyAmountUsd
        );

        if (!decision.shouldTrade) {
          logger.debug("Skip window", { reason: decision.reason });
          tradedThisWindow = true;
          await sleep(MAIN_LOOP_INTERVAL_MS);
          continue;
        }

        // === PLACE ORDERS ===
        const balance = await riskManager.getBalance();
        logger.info("Trading window!", {
          side: decision.primarySide,
          edge: decision.bestEdge.toFixed(1) + "¢",
          fairUp: decision.fairUp + "¢",
          orders: decision.orders.length,
          buyAmount: `$${buyAmountUsd.toFixed(2)} (${config.buyAmountPct}% of $${balance.toFixed(2)})`,
          btcPrice: binance.price.toFixed(2),
          delta: (binance.price - window.openingPrice).toFixed(2),
        });

        if (config.dryRun) {
          logger.info("DRY_RUN — would place orders:", {
            orders: decision.orders.map((o) => ({
              side: o.side,
              price: o.price.toFixed(1) + "¢",
              amount: "$" + o.amount.toFixed(2),
            })),
          });
        } else {
          const clobOrders = decision.orders.map((o) => ({
            tokenId: o.tokenId,
            side: Side.BUY,
            price: o.price / 100,
            size: o.amount / (o.price / 100),
          }));

          const result = await clob.placeBatchOrders(clobOrders);
          logger.info("Batch result", { placed: result.placed, failed: result.failed });
        }

        tradedThisWindow = true;
        windowOrders = decision.orders;

        // Record to database
        await db.recordWindow({
          windowStart: window.startTime,
          conditionId: window.conditionId,
          traded: true,
          primarySide: decision.primarySide,
          orders: decision.orders,
          fillCount: decision.orders.length,
          pnl: null, // set after settlement
          winner: null,
          balanceBefore: balance,
          balanceAfter: null,
        });

      } catch (err) {
        logger.error("Trading loop error", { error: (err as Error).message });
      }

      await sleep(MAIN_LOOP_INTERVAL_MS);
    }
  };

  // === REDEEM LOOP ===
  const redeemLoop = async () => {
    if (!redeemService) return;

    while (true) {
      try {
        const positions = await dataApi.getPositions(config.profileAddress, true);
        const now = nowSec();
        const eligible: typeof positions = [];

        for (const pos of positions) {
          const last = await db.getRedeemAttempt(pos.conditionId);
          if (now - last > REDEEM_COOLDOWN_SEC) {
            eligible.push(pos);
          }
        }

        if (eligible.length) {
          logger.info("Redeeming positions", { count: eligible.length });
          await redeemService.redeemPositions(eligible);
          for (const pos of eligible) {
            await db.markRedeemAttempt(pos.conditionId);
          }
        }
      } catch (err) {
        logger.error("Redeem loop error", { error: (err as Error).message });
      }

      await sleep(REDEEM_POLL_INTERVAL_MS);
    }
  };

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    binance.stop();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Run both loops
  await Promise.all([tradingLoop(), redeemLoop()]);
};

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(`[config] ${err.message}`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
