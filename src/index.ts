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
import { WindowManager } from "./execution/window-manager.js";
import { RiskManager } from "./risk/limits.js";
import { TelegramNotifier } from "./telegram.js";
import { createWebhookServer } from "./webhook.js";
import { sleep, nowSec } from "./utils.js";
import type { GridOrder, TradeSide, ActivePosition, WindowInfo } from "./types.js";

const REDEEM_COOLDOWN_SEC = 600;
const REDEEM_POLL_INTERVAL_MS = 30000;
const WINDOW_CHECK_INTERVAL_MS = 5000;

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

  logger.info("=== HolyPoly Bot Starting (Webhook Strategy) ===");
  logger.info("Mode", { dryRun: config.dryRun });
  logger.info("Parameters", {
    buyAmountPct: `${config.buyAmountPct}%`,
    maxPriceCents: `${config.currentMarketMaxPriceCents}¢`,
    signalWindow: "windowStart-60s to windowStart+149s",
    webhookPort: config.webhookPort,
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

  // Risk manager (%-based, uses CLOB getBalance for real USDC balance)
  const riskManager = new RiskManager(
    config,
    db,
    logger,
    () => clob.getBalance(),
  );

  // === WebSocket connections ===

  // 1. Binance direct (fastest BTC price, ~100ms) — used for monitoring + opening price
  const binance = new BinanceWsClient(logger);
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

  // === Position tracking ===
  const activePositions = new Map<string, ActivePosition>();
  let processingSignal = false;

  // === Helper: enter a market ===
  const enterMarket = async (
    window: WindowInfo,
    side: TradeSide,
    buyAmountUsd: number,
    limitPriceCents?: number,
    marketType: "CURRENT" | "NEXT" = "CURRENT",
  ): Promise<ActivePosition | null> => {
    const tokenId =
      side === "Up" ? window.upTokenId : window.downTokenId;

    // Determine entry price
    let entryPriceCents: number;
    if (limitPriceCents) {
      entryPriceCents = limitPriceCents;
    } else {
      // Market order — use best ask
      const book = clobWs.getBook(tokenId);
      let bestAsk = book?.bestAsk;

      if (!bestAsk) {
        const ob = await clob.getOrderbook(tokenId);
        bestAsk = ob.bestAsk ?? undefined;
      }

      if (!bestAsk) {
        logger.warn("No ask price available, cannot enter");
        return null;
      }
      entryPriceCents = bestAsk * 100;
    }

    // Sanity checks
    if (entryPriceCents < config.minEntryPriceCents || entryPriceCents > config.maxEntryPriceCents) {
      logger.warn("Entry price outside bounds", {
        price: `${entryPriceCents.toFixed(1)}¢`,
        min: config.minEntryPriceCents,
        max: config.maxEntryPriceCents,
      });
      return null;
    }

    const priceDecimal = entryPriceCents / 100;
    const shares = buyAmountUsd / priceDecimal;
    const balance = await riskManager.getBalance();

    const orderType = limitPriceCents ? "LIMIT" : "MARKET";
    logger.info(`ENTERING market (${orderType})`, {
      side,
      price: `${entryPriceCents.toFixed(1)}¢`,
      amount: `$${buyAmountUsd.toFixed(2)} (${config.buyAmountPct}%)`,
      shares: shares.toFixed(2),
      window: `${new Date(window.startTime).toISOString().slice(11, 19)} - ${new Date(window.endTime).toISOString().slice(11, 19)}`,
      balance: `$${balance.toFixed(2)}`,
    });

    let orderIds: string[] = [];
    if (config.dryRun) {
      logger.info("DRY_RUN — would place order", {
        side,
        type: orderType,
        price: `${entryPriceCents.toFixed(1)}¢`,
        amount: `$${buyAmountUsd.toFixed(2)}`,
      });
    } else {
      const result = await clob.placeBatchOrders([
        {
          tokenId,
          side: Side.BUY,
          price: priceDecimal,
          size: shares,
        },
      ]);

      if (result.placed === 0) {
        logger.warn("Order failed to place");
        return null;
      }
      orderIds = result.orderIds;
      logger.info("Order placed", {
        placed: result.placed,
        orderIds: result.orderIds.map((id) => id.slice(0, 12) + "..."),
      });
    }

    const position: ActivePosition = {
      conditionId: window.conditionId,
      side,
      tokenId,
      entryPriceCents,
      shares,
      costUsd: buyAmountUsd,
      orderIds,
      openingPrice: window.openingPrice,
      windowStart: window.startTime,
      windowEnd: window.endTime,
      balanceBefore: balance,
    };

    activePositions.set(window.conditionId, position);

    // Telegram alert
    telegram.alertTrade(
      side,
      entryPriceCents,
      marketType,
      limitPriceCents ? "LIMIT" : "MARKET",
      buyAmountUsd,
      balance,
      binance.price ?? 0,
      (window.endTime - Date.now()) / 1000,
    );

    // Record to database
    const order: GridOrder = {
      side,
      tokenId,
      price: entryPriceCents,
      amount: buyAmountUsd,
    };
    await db.recordWindow({
      windowStart: window.startTime,
      conditionId: window.conditionId,
      traded: true,
      primarySide: side,
      orders: [order],
      fillCount: 1,
      pnl: null,
      winner: null,
      balanceBefore: balance,
      balanceAfter: null,
    });

    return position;
  };

  // === Settle a position at window end ===
  const settlePosition = async (pos: ActivePosition): Promise<void> => {

    const settlementPrice = rtds.price ?? binance.price;
    if (settlementPrice === null) {
      logger.warn("No settlement price available, skipping P&L calc");
      return;
    }

    const winner: TradeSide =
      settlementPrice > pos.openingPrice ? "Up" : "Down";
    const won = pos.side === winner;

    let totalPnl: number;
    const isLive = !config.dryRun && pos.orderIds.length > 0;

    if (isLive) {
      const fills = await clob.getOrderFills(pos.orderIds, pos.conditionId);
      totalPnl = 0;
      for (const fill of fills) {
        if (fill.sizeMatched <= 0) continue;
        const fillWon = pos.side === winner;
        totalPnl += fillWon
          ? fill.sizeMatched * (1 - fill.price)
          : -fill.costFilled;
      }

      if (totalPnl === 0 && fills.every((f) => f.sizeMatched <= 0)) {
        logger.info("No fills — order was not executed, skipping settlement");
        return;
      }
    } else {
      totalPnl = won
        ? pos.costUsd * (100 / pos.entryPriceCents - 1)
        : -pos.costUsd;
    }

    const prefix = config.dryRun ? "DRY_RUN SETTLEMENT" : "SETTLEMENT";
    logger.info(prefix, {
      winner,
      side: pos.side,
      result: won ? "WIN" : "LOSS",
      pnl: `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`,
      entry: `${pos.entryPriceCents.toFixed(1)}¢`,
      btcOpen: pos.openingPrice.toFixed(2),
      btcSettlement: settlementPrice.toFixed(2),
      delta: `$${(settlementPrice - pos.openingPrice).toFixed(2)}`,
    });

    await riskManager.recordResult(totalPnl);
    await db.updateWindowSettlement(pos.conditionId, totalPnl, winner);

    const dailyStats = await riskManager.getDailyStats();
    telegram.alertSettlement(
      winner,
      totalPnl,
      won ? 1 : 0,
      1,
      dailyStats.totalPnl,
      dailyStats.wins,
      dailyStats.losses,
    );
  };

  // === WEBHOOK SIGNAL HANDLER ===
  const handleSignal = async (direction: "up" | "down") => {
    if (processingSignal) {
      logger.warn("Signal ignored (already processing previous signal)");
      return;
    }
    processingSignal = true;

    try {
      const side: TradeSide = direction === "up" ? "Up" : "Down";
      const nowMs = Date.now();
      const nowSecs = Math.floor(nowMs / 1000);
      const windowSize = 300;

      // 1. Determine which window this signal targets
      //    Signal valid window: windowStart - 60s  to  windowStart + 149s
      //    Before windowStart → NEXT (limit order)
      //    After windowStart  → CURRENT (market order)
      const currentWindowStart = Math.floor(nowSecs / windowSize) * windowSize;
      const currentWindowElapsed = nowSecs - currentWindowStart;

      let targetWindowStart: number;
      let marketType: "CURRENT" | "NEXT";

      if (currentWindowElapsed < 150) {
        // We're within the first 149s of the current window → CURRENT
        targetWindowStart = currentWindowStart;
        marketType = "CURRENT";
      } else if (currentWindowElapsed >= 240) {
        // We're within 60s before next window (300-60=240) → NEXT
        targetWindowStart = currentWindowStart + windowSize;
        marketType = "NEXT";
      } else {
        // Between 150s and 239s — outside valid signal window
        logger.info("Signal outside valid time window, ignoring", {
          elapsed: `${currentWindowElapsed}s into window`,
          validRanges: "0-149s (CURRENT) or 240-299s (NEXT)",
        });
        return;
      }

      logger.info("Signal received", {
        direction,
        side,
        marketType,
        targetWindow: new Date(targetWindowStart * 1000).toISOString().slice(11, 19),
        windowElapsed: `${currentWindowElapsed}s`,
      });

      // 2. Check if we already have a position in this window
      for (const [condId, pos] of activePositions) {
        // Check if this position belongs to our target window
        if (Math.floor(pos.windowStart / 1000) === targetWindowStart) {
          logger.info("Already have position in this window, skipping", {
            side: pos.side,
            window: new Date(targetWindowStart * 1000).toISOString().slice(11, 19),
          });
          return;
        }
      }

      // 3. Risk check
      const riskCheck = await riskManager.check();
      if (!riskCheck.allowed) {
        logger.warn("Risk check blocked", { reason: riskCheck.reason });
        telegram.alertCircuitBreaker(riskCheck.reason ?? "Unknown");
        return;
      }

      // 4. Find the target market
      let targetWindow: WindowInfo | null;
      if (marketType === "CURRENT") {
        targetWindow = await windowManager.tick();
        if (!targetWindow) {
          // Try direct lookup
          targetWindow = await discovery.findMarketByTimestamp(targetWindowStart);
        }
      } else {
        targetWindow = await discovery.findMarketByTimestamp(targetWindowStart);
      }

      if (!targetWindow) {
        logger.warn("Target market not found", {
          marketType,
          targetWindow: new Date(targetWindowStart * 1000).toISOString().slice(11, 19),
        });
        return;
      }

      // Subscribe CLOB WS to target window's tokens
      clobWs.clear();
      clobWs.subscribe([targetWindow.upTokenId, targetWindow.downTokenId]);

      // Set opening price if not yet set
      if (targetWindow.openingPrice === 0) {
        const openingPrice = rtds.price ?? binance.price;
        if (openingPrice) {
          targetWindow.openingPrice = openingPrice;
          if (marketType === "CURRENT") windowManager.setOpeningPrice(openingPrice);
        }
      }

      // Brief wait for CLOB WS to populate orderbook
      await sleep(500);

      // 5. Get best ask price
      const tokenId = side === "Up" ? targetWindow.upTokenId : targetWindow.downTokenId;
      const book = clobWs.getBook(tokenId);
      let bestAskCents: number | null = null;

      if (book?.bestAsk) {
        bestAskCents = book.bestAsk * 100;
      } else {
        const ob = await clob.getOrderbook(tokenId);
        bestAskCents = ob.bestAsk ? ob.bestAsk * 100 : null;
      }

      logger.info("Signal evaluation", {
        direction,
        side,
        marketType,
        window: `${new Date(targetWindow.startTime).toISOString().slice(11, 19)} - ${new Date(targetWindow.endTime).toISOString().slice(11, 19)}`,
        bestAsk: bestAskCents ? `${bestAskCents.toFixed(1)}¢` : "N/A",
        maxPrice: `${config.currentMarketMaxPriceCents}¢`,
        btcPrice: binance.price?.toFixed(2) ?? "N/A",
      });

      // 6. Price check — both CURRENT and NEXT use same max price
      if (!bestAskCents || bestAskCents > config.currentMarketMaxPriceCents) {
        logger.info("Price too high, skipping", {
          bestAsk: bestAskCents ? `${bestAskCents.toFixed(1)}¢` : "N/A",
          max: `${config.currentMarketMaxPriceCents}¢`,
        });
        return;
      }

      // 7. Enter market
      if (marketType === "CURRENT") {
        // Market order at best ask
        logger.info("Entering CURRENT market (market order)");
        await enterMarket(targetWindow, side, riskCheck.buyAmountUsd, undefined, "CURRENT");
      } else {
        // NEXT market — limit order at best ask price
        logger.info("Entering NEXT market (limit order at best ask)");
        await enterMarket(targetWindow, side, riskCheck.buyAmountUsd, bestAskCents, "NEXT");
      }
    } catch (err) {
      logger.error("Signal handler error", { error: (err as Error).message });
      telegram.alertError((err as Error).message);
    } finally {
      processingSignal = false;
    }
  };

  // === WEBHOOK SERVER ===
  const webhook = createWebhookServer(
    config.webhookPort,
    logger,
    config.webhookSecret,
  );
  webhook.onSignal(handleSignal);
  webhook.start();

  // === WINDOW LIFECYCLE LOOP (handles settlement + status) ===
  const windowLoop = async () => {
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
          logger.info("Active positions", {
            count: activePositions.size,
            positions: Array.from(activePositions.values()).map((p) => ({
              side: p.side,
              entry: `${p.entryPriceCents.toFixed(1)}¢`,
              window: new Date(p.windowStart).toISOString().slice(11, 19),
            })),
          });
          lastStatusLog = now;
        }

        // Check for positions that need settlement (window ended)
        for (const [condId, pos] of activePositions) {
          if (now >= pos.windowEnd) {
            logger.info("Window ended, settling position", {
              conditionId: condId.slice(0, 16) + "...",
              side: pos.side,
            });
            await settlePosition(pos);
            activePositions.delete(condId);
          }
        }

        // Keep window manager ticking (for discovery cache)
        await windowManager.tick();
      } catch (err) {
        logger.error("Window loop error", {
          error: (err as Error).message,
        });
      }

      await sleep(WINDOW_CHECK_INTERVAL_MS);
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
        logger.error("Redeem loop error", {
          error: (err as Error).message,
        });
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
  await Promise.all([windowLoop(), redeemLoop()]);
};

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(`[config] ${err.message}`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
