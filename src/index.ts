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
import { HedgeMonitor } from "./signal/hedge-monitor.js";
import { WindowManager } from "./execution/window-manager.js";
import { RiskManager } from "./risk/limits.js";
import { TelegramNotifier } from "./telegram.js";
import { sleep, nowSec } from "./utils.js";
import type { GridOrder, TradeSide, WindowInfo } from "./types.js";

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

  logger.info("=== HolyPoly Bot Starting (Edge Detection v2) ===");
  logger.info("Mode", { dryRun: config.dryRun });
  logger.info("Parameters", {
    buyAmountPct: `${config.buyAmountPct}%`,
    edgeThreshold: `${config.edgeThresholdCents}¢`,
    edgeTiers: `${config.edgeTier2Cents}/${config.edgeTier3Cents}/${config.edgeTier4Cents}¢`,
    maxBuysPerWindow: config.maxBuysPerWindow,
    maxBuysPerSide: config.maxBuysPerSide,
    hedgeMonitor: config.hedgeMonitorEnabled ? `ON (trigger: −${config.hedgeTriggerCents}¢)` : "OFF",
    entryPrice: `${config.minEntryPriceCents}-${config.maxEntryPriceCents}¢`,
    entryDelay: `${config.entryDelaySeconds}s`,
    scanInterval: `${config.scanIntervalMs}ms`,
    dailyLossLimit: `${config.dailyLossLimitPct}%`,
    weeklyLossLimit: `${config.weeklyLossLimitPct}%`,
  });

  // CLOB service
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

  // Market discovery
  const discovery = new MarketDiscovery(config.clobHost, logger);
  const dataApi = new DataApiClient(config.dataApiHost, logger);
  const windowManager = new WindowManager(discovery, logger);

  // Signal engine
  const volatilityCalc = new VolatilityCalculator(config.volatilityLookbackSeconds);
  const fairValueEngine = new FairValueEngine(volatilityCalc);
  const edgeDetector = new EdgeDetector(fairValueEngine, clob, config, logger, volatilityCalc);

  // Risk manager
  const riskManager = new RiskManager(
    config,
    db,
    logger,
    () => clob.getBalance(),
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

  // Reactive hedge monitor
  const hedgeMonitor = config.hedgeMonitorEnabled
    ? new HedgeMonitor(clobWs, clob, config, logger, telegram, volatilityCalc)
    : null;

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

  // Pending trade for settlement tracking
  let pendingTrade: {
    conditionId: string;
    openingPrice: number;
    orders: GridOrder[];
    primarySide: TradeSide;
    balanceBefore: number;
    orderIds: string[];
    windowEnd: number;
  } | null = null;

  /**
   * Settle a pending trade by checking BTC price vs opening price.
   */
  const settlePendingTrade = async () => {
    if (!pendingTrade) return;

    const settlementPrice = rtds.price ?? binance.price;
    if (settlementPrice === null) {
      logger.warn("No settlement price available, skipping P&L calc");
      pendingTrade = null;
      return;
    }

    const winner: TradeSide = settlementPrice > pendingTrade.openingPrice ? "Up" : "Down";
    let totalPnl = 0;
    const orderResults: Array<{ side: string; price: string; amount: string; pnl: string; won: boolean }> = [];

    const isLive = !config.dryRun && pendingTrade.orderIds.length > 0;
    if (isLive) {
      const fills = await clob.getOrderFills(pendingTrade.orderIds, pendingTrade.conditionId);

      const tokenSideMap = new Map<string, TradeSide>();
      for (const order of pendingTrade.orders) {
        tokenSideMap.set(order.tokenId, order.side as TradeSide);
      }

      for (const fill of fills) {
        if (fill.sizeMatched <= 0) continue;

        const side = tokenSideMap.get(fill.tokenId) ?? pendingTrade.primarySide;
        const fillWon = side === winner;
        const pnl = fillWon
          ? fill.sizeMatched * (1 - fill.price)
          : -fill.costFilled;

        totalPnl += pnl;
        orderResults.push({
          side,
          price: `${(fill.price * 100).toFixed(1)}¢`,
          amount: `$${fill.costFilled.toFixed(2)}`,
          pnl: `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
          won: fillWon,
        });
      }

      if (totalPnl === 0 && fills.every((f) => f.sizeMatched <= 0)) {
        logger.info("No fills — orders were not executed, skipping settlement");
        pendingTrade = null;
        return;
      }
    } else {
      // Simulated P&L for dry run
      for (const order of pendingTrade.orders) {
        const orderSide = order.side as TradeSide;
        const fillWon = orderSide === winner;
        const pnl = fillWon
          ? order.amount * (100 / order.price - 1)
          : -order.amount;
        totalPnl += pnl;

        orderResults.push({
          side: orderSide,
          price: `${order.price.toFixed(1)}¢`,
          amount: `$${order.amount.toFixed(2)}`,
          pnl: `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
          won: fillWon,
        });
      }
    }

    const prefix = config.dryRun ? "DRY_RUN SETTLEMENT" : "SETTLEMENT";
    const primaryWon = pendingTrade.primarySide === winner;
    logger.info(prefix, {
      winner,
      primarySide: pendingTrade.primarySide,
      result: primaryWon ? "WIN" : "LOSS",
      totalPnl: `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`,
      btcOpen: pendingTrade.openingPrice.toFixed(2),
      btcSettlement: settlementPrice.toFixed(2),
      delta: `$${(settlementPrice - pendingTrade.openingPrice).toFixed(2)}`,
      orders: orderResults,
    });

    // Record result
    await riskManager.recordResult(totalPnl);
    await db.updateWindowSettlement(pendingTrade.conditionId, totalPnl, winner);

    const dailyStats = await riskManager.getDailyStats();
    const ordersWon = orderResults.filter((o) => o.won).length;
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

  // === MAIN EDGE SCANNING LOOP ===
  const edgeLoop = async () => {
    let lastStatusLog = 0;

    while (true) {
      try {
        const now = Date.now();
        const nowSecs = Math.floor(now / 1000);

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
            volatility: `$${volatilityCalc.getVolatility().toFixed(1)}`,
            regime: volatilityCalc.getRegime(),
          });
          lastStatusLog = now;
        }

        // Check if pending trade needs settlement (window ended)
        if (pendingTrade && now >= pendingTrade.windowEnd) {
          logger.info("Window ended, settling trade");
          hedgeMonitor?.reset();
          await settlePendingTrade();
        }

        // Find current window
        const window = await windowManager.tick();
        if (!window) {
          await sleep(config.scanIntervalMs);
          continue;
        }

        // Detect window transition
        if (window.conditionId !== currentWindowId) {
          if (currentWindowId) {
            tradedThisWindow = false;
            hedgeMonitor?.reset();
          }
          currentWindowId = window.conditionId;
          tradedThisWindow = false;

          // Subscribe CLOB WS to new window's tokens
          clobWs.clear();
          clobWs.subscribe([window.upTokenId, window.downTokenId]);

          logger.info("New window", {
            conditionId: window.conditionId.slice(0, 16) + "...",
            start: new Date(window.startTime).toISOString().slice(11, 19),
            end: new Date(window.endTime).toISOString().slice(11, 19),
            openingPrice: window.openingPrice.toFixed(2),
          });
        }

        // Skip if already traded this window
        if (tradedThisWindow) {
          await sleep(config.scanIntervalMs);
          continue;
        }

        // Wait for entry delay (let prices settle after window start)
        const windowElapsedSec = (now - window.startTime) / 1000;
        if (windowElapsedSec < config.entryDelaySeconds) {
          await sleep(config.scanIntervalMs);
          continue;
        }

        // Need Binance price for edge calculation
        const btcPrice = binance.price;
        if (!btcPrice) {
          await sleep(config.scanIntervalMs);
          continue;
        }

        // Set opening price if not yet set
        if (window.openingPrice === 0) {
          const openingPrice = rtds.price ?? btcPrice;
          window.openingPrice = openingPrice;
          windowManager.setOpeningPrice(openingPrice);
        }

        // Risk check
        const riskCheck = await riskManager.check();
        if (!riskCheck.allowed) {
          logger.debug("Risk blocked", { reason: riskCheck.reason });
          await sleep(config.scanIntervalMs);
          continue;
        }

        // *** CORE: Evaluate edge ***
        const timeRemaining = (window.endTime - now) / 1000;
        const decision = await edgeDetector.evaluate(
          window,
          btcPrice,
          timeRemaining,
          riskCheck.buyAmountUsd,
        );

        if (!decision.shouldTrade) {
          logger.debug("No trade", { reason: decision.reason });
          await sleep(config.scanIntervalMs);
          continue;
        }

        // === EXECUTE TRADE ===
        logger.info("EDGE DETECTED — Entering trade", {
          side: decision.primarySide,
          edge: `${decision.bestEdge.toFixed(1)}¢`,
          fairUp: decision.fairUp,
          confidence: `${(decision.confidence * 100).toFixed(0)}%`,
          regime: decision.regime,
          orders: decision.orders.length,
          reason: decision.reason,
        });

        tradedThisWindow = true;
        const balance = await riskManager.getBalance();

        // Place orders
        let orderIds: string[] = [];
        if (!config.dryRun) {
          const batchOrders = decision.orders.map((o) => ({
            tokenId: o.tokenId,
            side: Side.BUY,
            price: o.price / 100,
            size: o.amount / (o.price / 100),
          }));

          const result = await clob.placeBatchOrders(batchOrders);
          orderIds = result.orderIds;

          if (result.placed === 0) {
            logger.warn("All orders failed to place");
            tradedThisWindow = false;
            await sleep(config.scanIntervalMs);
            continue;
          }

          logger.info("Orders placed", {
            placed: result.placed,
            failed: result.failed,
            orderIds: result.orderIds.map((id) => id.slice(0, 12) + "..."),
          });
        } else {
          logger.info("DRY_RUN — simulated orders", {
            orders: decision.orders.map((o) => ({
              side: o.side,
              price: `${o.price.toFixed(1)}¢`,
              amount: `$${o.amount.toFixed(2)}`,
            })),
          });
        }

        // Track pending trade for settlement
        pendingTrade = {
          conditionId: window.conditionId,
          openingPrice: window.openingPrice,
          orders: decision.orders,
          primarySide: decision.primarySide,
          balanceBefore: balance,
          orderIds,
          windowEnd: window.endTime,
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

        // Start hedge monitor if enabled
        if (hedgeMonitor && decision.orders.length > 0) {
          const primaryOrders = decision.orders.filter((o) => o.side === decision.primarySide);
          if (primaryOrders.length > 0) {
            const avgEntry = primaryOrders.reduce((s, o) => s + o.price, 0) / primaryOrders.length;
            const totalCost = primaryOrders.reduce((s, o) => s + o.amount, 0);
            const avgPriceDecimal = avgEntry / 100;
            const totalShares = totalCost / avgPriceDecimal;

            hedgeMonitor.startMonitoring({
              primarySide: decision.primarySide,
              entryPriceCents: avgEntry,
              primaryTokenId: decision.primarySide === "Up" ? window.upTokenId : window.downTokenId,
              hedgeTokenId: decision.primarySide === "Up" ? window.downTokenId : window.upTokenId,
              primaryCostUsd: totalCost,
              primaryShares: totalShares,
              windowEndMs: window.endTime,
              onHedge: (hedgeOrders, hedgeIds) => {
                if (pendingTrade) {
                  pendingTrade.orders.push(...hedgeOrders);
                  pendingTrade.orderIds.push(...hedgeIds);
                }
              },
            });
          }
        }

        // Telegram alert
        telegram.alertEdgeEntry(
          decision.primarySide,
          decision.bestEdge,
          decision.fairUp,
          decision.regime,
          decision.confidence,
          riskCheck.buyAmountUsd,
          decision.orders.length,
        );
      } catch (err) {
        logger.error("Edge loop error", { error: (err as Error).message });
        telegram.alertError((err as Error).message);
      }

      await sleep(config.scanIntervalMs);
    }
  };

  // === REDEEM LOOP ===
  const redeemLoop = async () => {
    if (!redeemService) return;

    while (true) {
      try {
        const positions = await dataApi.getPositions(
          config.profileAddress,
          true,
        );
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
  await Promise.all([edgeLoop(), redeemLoop()]);
};

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(`[config] ${err.message}`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
