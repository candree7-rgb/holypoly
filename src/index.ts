import "dotenv/config";
import { webcrypto } from "crypto";
import { Side } from "@polymarket/clob-client";
import { loadConfig, ConfigError, type Config } from "./config.js";
import { createLogger } from "./logger.js";
import { Database } from "./db.js";
import { BinanceWsClient } from "./data/binance-ws.js";
import { RtdsWsClient } from "./data/rtds-ws.js";
import { ClobWsClient } from "./data/clob-ws.js";
import { MarketDiscovery } from "./data/gamma.js";
import { ClobService } from "./data/clob.js";
import { DataApiClient } from "./data/data-api.js";
import { RedeemService } from "./data/redeem.js";
import { VolatilityCalculator } from "./signal/volatility.js";
import { FairValueEngine } from "./signal/fair-value.js";
import { EdgeDetector } from "./signal/edge-detector.js";
import { WindowManager } from "./execution/window-manager.js";
import { RiskManager } from "./risk/limits.js";
import { TelegramNotifier } from "./telegram.js";
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

  // PostgreSQL
  const db = new Database(config.databaseUrl, logger);
  await db.init();

  // Telegram notifications
  const telegram = new TelegramNotifier(
    config.telegramBotToken,
    config.telegramChatId,
    logger,
  );

  logger.info("=== HolyPoly Bot Starting ===");
  logger.info("Mode", { dryRun: config.dryRun });
  logger.info("Parameters", {
    buyAmountPct: `${config.buyAmountPct}%`,
    edgeThreshold: `${config.edgeThresholdCents}¢`,
    edgeTiers: `${config.edgeTier2Cents}/${config.edgeTier3Cents}/${config.edgeTier4Cents}¢`,
    maxBuysPerWindow: config.maxBuysPerWindow,
    maxBuysPerSide: config.maxBuysPerSide,
    hedgeMode: `dynamic (no hedge above ${config.hedgeEdgeThresholdCents}¢)`,
    hedgeMaxPrice: `${config.hedgeMaxPriceCents}¢`,
    entryPrice: `${config.minEntryPriceCents}-${config.maxEntryPriceCents}¢`,
    entryDelay: `${config.entryDelaySeconds}s`,
    dailyLossLimit: `${config.dailyLossLimitPct}%`,
    weeklyLossLimit: `${config.weeklyLossLimitPct}%`,
  });

  // CLOB service (order placement, balance, Magic EOA signing)
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

  // Market discovery (finds 5-min BTC markets via slug pattern)
  const discovery = new MarketDiscovery(config.clobHost, logger);
  const dataApi = new DataApiClient(config.dataApiHost, logger);
  const windowManager = new WindowManager(discovery, logger);

  // Signal engine
  const volatilityCalc = new VolatilityCalculator(config.volatilityLookbackSeconds);
  const fairValueEngine = new FairValueEngine(volatilityCalc);
  const edgeDetector = new EdgeDetector(fairValueEngine, clob, config, logger);

  // Risk manager (%-based, uses CLOB getBalance for real USDC balance)
  const riskManager = new RiskManager(
    config,
    db,
    logger,
    () => clob.getBalance()
  );

  // === WebSocket connections ===

  // 1. Binance direct (fastest BTC price, ~100ms)
  const binance = new BinanceWsClient(logger);
  binance.onTick((tick) => {
    volatilityCalc.addPrice(tick.price, tick.timestamp);
  });
  binance.start();

  // 2. Chainlink via RTDS (settlement reference price)
  const rtds = new RtdsWsClient(logger);
  rtds.start();

  // 3. CLOB WebSocket (realtime orderbook)
  const clobWs = new ClobWsClient(logger);
  clobWs.start();

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

  // Send startup alert
  const startupBalance = await clob.getBalance();
  telegram.alertStartup(config.dryRun, startupBalance, config.buyAmountPct);

  // Per-window state
  let tradedThisWindow = false;
  let currentWindowId: string | null = null;

  // Pending trade for settlement tracking (dry run + live)
  let pendingTrade: {
    conditionId: string;
    openingPrice: number;
    orders: GridOrder[];
    primarySide: "Up" | "Down";
    balanceBefore: number;
  } | null = null;

  /**
   * Settle a pending trade by checking BTC price vs opening price.
   * Works for both dry run (simulated) and live trades.
   */
  const settlePendingTrade = async () => {
    if (!pendingTrade) return;

    // Use Chainlink price (settlement oracle), fallback to Binance
    const settlementPrice = rtds.price ?? binance.price;
    if (settlementPrice === null) {
      logger.warn("No settlement price available, skipping P&L calc");
      pendingTrade = null;
      return;
    }

    const winner: "Up" | "Down" = settlementPrice > pendingTrade.openingPrice ? "Up" : "Down";
    let totalPnl = 0;
    const orderResults: Array<{ side: string; price: string; amount: string; pnl: string; won: boolean }> = [];

    for (const order of pendingTrade.orders) {
      const won = order.side === winner;
      // Binary outcome: win pays $1/share, lose pays $0/share
      // shares = amount / (price/100), cost = amount
      // win pnl = shares * 1 - cost = amount * (100/price - 1)
      // lose pnl = -cost = -amount
      const pnl = won
        ? order.amount * (100 / order.price - 1)
        : -order.amount;
      totalPnl += pnl;
      orderResults.push({
        side: order.side,
        price: `${order.price.toFixed(1)}¢`,
        amount: `$${order.amount.toFixed(2)}`,
        pnl: `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
        won,
      });
    }

    const prefix = config.dryRun ? "DRY_RUN SETTLEMENT" : "SETTLEMENT";
    logger.info(`${prefix}`, {
      conditionId: pendingTrade.conditionId.slice(0, 16) + "...",
      winner,
      btcOpening: pendingTrade.openingPrice.toFixed(2),
      btcSettlement: settlementPrice.toFixed(2),
      delta: `$${(settlementPrice - pendingTrade.openingPrice).toFixed(2)}`,
      orders: orderResults,
      totalPnl: `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`,
      result: totalPnl >= 0 ? "WIN" : "LOSS",
    });

    // Update risk manager P&L tracking (works for both dry run and live)
    await riskManager.recordResult(totalPnl);

    // Update DB record with settlement data
    await db.updateWindowSettlement(
      pendingTrade.conditionId,
      totalPnl,
      winner,
    );

    // Telegram settlement alert
    const ordersWon = orderResults.filter((o) => o.won).length;
    const dailyStats = await riskManager.getDailyStats();
    telegram.alertSettlement(
      winner,
      totalPnl,
      ordersWon,
      orderResults.length,
      dailyStats.totalPnl,
      dailyStats.wins,
      dailyStats.losses,
    );

    pendingTrade = null;
  };

  // === MAIN TRADING LOOP ===
  const tradingLoop = async () => {
    let lastStatusLog = 0;

    while (true) {
      try {
        const now = Date.now();

        // Status log every 5 minutes
        if (now - lastStatusLog >= 300000) {
          await riskManager.logStatus();
          logger.info("Connections", {
            binance: binance.connected,
            binancePrice: binance.price?.toFixed(2) ?? "N/A",
            chainlink: rtds.connected,
            chainlinkPrice: rtds.price?.toFixed(2) ?? "N/A",
            chainlinkStale: rtds.isStale,
            clobWs: clobWs.connected,
          });
          lastStatusLog = now;
        }

        // Must have Binance price
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

        // New window — settle previous trade + reset state
        if (window.conditionId !== currentWindowId) {
          // Settle the previous window's trade before starting new one
          await settlePendingTrade();

          currentWindowId = window.conditionId;
          tradedThisWindow = false;

          // Subscribe CLOB WS to this window's tokens
          clobWs.clear();
          clobWs.subscribe([window.upTokenId, window.downTokenId]);

          // Set opening price from Chainlink (preferred) or Binance (fallback)
          if (window.openingPrice === 0) {
            const openingPrice = rtds.price ?? binance.price;
            windowManager.setOpeningPrice(openingPrice);
            logger.info("Window started", {
              source: rtds.price ? "Chainlink" : "Binance",
              openingPrice: openingPrice.toFixed(2),
            });
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

        // Skip if Chainlink is stale (oracle might be stuck)
        if (rtds.isStale) {
          logger.warn("Chainlink stale — skipping window");
          tradedThisWindow = true;
          await sleep(MAIN_LOOP_INTERVAL_MS);
          continue;
        }

        // Risk check (returns dynamic buy amount from balance %)
        const riskCheck = await riskManager.check();
        if (!riskCheck.allowed) {
          logger.warn("Risk check blocked", { reason: riskCheck.reason });
          telegram.alertCircuitBreaker(riskCheck.reason ?? "Unknown");
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
        logger.info("TRADING!", {
          side: decision.primarySide,
          edge: `${decision.bestEdge.toFixed(1)}¢`,
          fairUp: `${decision.fairUp}¢`,
          orders: decision.orders.length,
          buyAmount: `$${buyAmountUsd.toFixed(2)} (${config.buyAmountPct}% of $${balance.toFixed(2)})`,
          btcBinance: binance.price.toFixed(2),
          btcChainlink: rtds.price?.toFixed(2) ?? "N/A",
          delta: `$${(binance.price - window.openingPrice).toFixed(2)}`,
          timeLeft: `${timeRemaining.toFixed(0)}s`,
        });

        // Telegram trade alert
        telegram.alertTrade(
          decision.primarySide,
          decision.bestEdge,
          decision.orders.length,
          buyAmountUsd,
          balance,
          binance.price,
          timeRemaining,
        );

        if (config.dryRun) {
          logger.info("DRY_RUN — would place:", {
            orders: decision.orders.map((o) => ({
              side: o.side,
              price: `${o.price.toFixed(1)}¢`,
              amount: `$${o.amount.toFixed(2)}`,
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

          // Only track trade if orders were actually placed
          if (result.placed === 0) {
            logger.warn("No orders placed (all below minimum or failed), skipping trade tracking");
            continue;
          }
        }

        tradedThisWindow = true;

        // Store pending trade for settlement P&L calculation
        pendingTrade = {
          conditionId: window.conditionId,
          openingPrice: window.openingPrice,
          orders: decision.orders,
          primarySide: decision.primarySide,
          balanceBefore: balance,
        };

        // Record to database
        await db.recordWindow({
          windowStart: window.startTime,
          conditionId: window.conditionId,
          traded: true,
          primarySide: decision.primarySide,
          orders: decision.orders,
          fillCount: decision.orders.length,
          pnl: null,
          winner: null,
          balanceBefore: balance,
          balanceAfter: null,
        });

      } catch (err) {
        logger.error("Trading loop error", { error: (err as Error).message });
        telegram.alertError((err as Error).message);
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
    rtds.stop();
    clobWs.stop();
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
