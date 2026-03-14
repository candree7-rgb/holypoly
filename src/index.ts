import "dotenv/config";
import { webcrypto } from "crypto";
import { Side } from "@polymarket/clob-client";
import { loadConfig, ConfigError, type Config } from "./config.js";
import { createLogger } from "./logger.js";
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
import {
  loadState,
  saveState,
  recordWindowResult,
  markRedeemAttempt,
} from "./state.js";
import { sleep, nowSec } from "./utils.js";
import type { GridOrder, TradeSide, WindowResult } from "./types.js";

const MAIN_LOOP_INTERVAL_MS = 1000; // Check every second
const REDEEM_COOLDOWN_SEC = 600;
const REDEEM_POLL_INTERVAL_MS = 30000;

const main = async () => {
  if (!globalThis.crypto) {
    (globalThis as typeof globalThis & { crypto?: Crypto }).crypto =
      webcrypto as Crypto;
  }

  // Load config
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
  const state = await loadState(config.stateFile);

  logger.info("=== HolyPoly Bot Starting ===");
  logger.info("Mode", { dryRun: config.dryRun });
  logger.info("Parameters", {
    buyAmount: config.buyAmountUsd,
    edgeThreshold: config.edgeThresholdCents,
    maxBuysPerWindow: config.maxBuysPerWindow,
    entryDelay: config.entryDelaySeconds,
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

  // Risk manager
  const riskManager = new RiskManager(config, state, logger);

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

  // Track state per window
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
          riskManager.logStatus();
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

        // New window detected — reset per-window state
        if (window.conditionId !== currentWindowId) {
          currentWindowId = window.conditionId;
          tradedThisWindow = false;
          windowOrders = [];

          // Set opening price from current Binance price at window start
          if (window.openingPrice === 0) {
            windowManager.setOpeningPrice(binance.price);
          }
        }

        // Already traded this window — wait for it to end
        if (tradedThisWindow) {
          await sleep(MAIN_LOOP_INTERVAL_MS);
          continue;
        }

        // Not in entry phase yet — wait
        if (!windowManager.isEntryPhase(config.entryDelaySeconds)) {
          await sleep(MAIN_LOOP_INTERVAL_MS);
          continue;
        }

        // Risk check
        const riskCheck = riskManager.check();
        if (!riskCheck.allowed) {
          logger.warn("Risk check blocked", { reason: riskCheck.reason });
          tradedThisWindow = true; // Skip this window
          await sleep(MAIN_LOOP_INTERVAL_MS);
          continue;
        }

        // Evaluate edge and decide
        const timeRemaining = windowManager.timeRemaining();
        const decision = await edgeDetector.evaluate(
          window,
          binance.price,
          timeRemaining
        );

        if (!decision.shouldTrade) {
          logger.debug("Skip window", { reason: decision.reason });
          tradedThisWindow = true; // Don't re-evaluate
          await sleep(MAIN_LOOP_INTERVAL_MS);
          continue;
        }

        // === PLACE ORDERS ===
        logger.info("Trading window!", {
          side: decision.primarySide,
          edge: decision.bestEdge.toFixed(1) + "¢",
          fairUp: decision.fairUp + "¢",
          orders: decision.orders.length,
          btcPrice: binance.price.toFixed(2),
          openingPrice: window.openingPrice.toFixed(2),
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
          // Convert GridOrders to CLOB orders
          const clobOrders = decision.orders.map((o) => ({
            tokenId: o.tokenId,
            side: Side.BUY, // We only buy, never sell
            price: o.price / 100, // cents back to decimal
            size: o.amount / (o.price / 100), // shares = USD / price
          }));

          const result = await clob.placeBatchOrders(clobOrders);
          logger.info("Batch result", {
            placed: result.placed,
            failed: result.failed,
          });
        }

        tradedThisWindow = true;
        windowOrders = decision.orders;

        // Save state
        state.currentWindow = {
          startTime: window.startTime,
          ordersPlaced: decision.orders.length,
        };
        await saveState(config.stateFile, state);

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
        const positions = await dataApi.getPositions(
          config.profileAddress,
          true, // redeemable only
        );
        const now = nowSec();
        const eligible = positions.filter((pos) => {
          const last = state.redeemAttempts[pos.conditionId] ?? 0;
          return now - last > REDEEM_COOLDOWN_SEC;
        });

        if (eligible.length) {
          logger.info("Redeeming positions", { count: eligible.length });
          await redeemService.redeemPositions(eligible);
          const attemptedConditions = new Set(eligible.map((p) => p.conditionId));
          for (const conditionId of attemptedConditions) {
            markRedeemAttempt(state, conditionId);
          }
          await saveState(config.stateFile, state);
        }
      } catch (err) {
        logger.error("Redeem loop error", { error: (err as Error).message });
      }

      await sleep(REDEEM_POLL_INTERVAL_MS);
    }
  };

  // Run both loops concurrently
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
