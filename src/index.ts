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
    currentMarketMax: `${config.currentMarketMaxPriceCents}¢`,
    nextMarketLimit: `${config.nextMarketLimitPriceCents}¢`,
    limitTimeout: `${config.limitOrderTimeoutMs}ms`,
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

  // === Helper: sell a position (counter-signal) ===
  const sellPosition = async (pos: ActivePosition): Promise<number> => {
    logger.info("SELLING position (counter-signal)", {
      side: pos.side,
      conditionId: pos.conditionId.slice(0, 16) + "...",
      entry: `${pos.entryPriceCents.toFixed(1)}¢`,
      shares: pos.shares.toFixed(2),
    });

    if (config.dryRun) {
      const book = clobWs.getBook(pos.tokenId);
      const sellPriceDecimal = book?.bestBid ?? pos.entryPriceCents / 100;
      const sellPriceCents = sellPriceDecimal * 100;
      const pnl = ((sellPriceCents - pos.entryPriceCents) / 100) * pos.shares;

      logger.info("DRY_RUN — would sell", {
        sellPrice: `${sellPriceCents.toFixed(1)}¢`,
        pnl: `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
      });

      telegram.alertSell(pos.side, pos.entryPriceCents, sellPriceCents, pnl);
      await riskManager.recordResult(pnl);
      return pnl;
    }

    // Cancel any open (unfilled) orders first
    for (const orderId of pos.orderIds) {
      await clob.cancelOrder(orderId);
    }

    // Check how many shares actually filled
    let actualShares = 0;
    for (const orderId of pos.orderIds) {
      const filled = await clob.getFilledShares(orderId);
      actualShares += filled;
    }

    if (actualShares <= 0) {
      logger.info("No filled shares to sell (order was not filled)");
      return 0;
    }

    // Get best bid for sell price
    const book = clobWs.getBook(pos.tokenId);
    let bestBid = book?.bestBid;

    if (!bestBid || bestBid <= 0) {
      // REST fallback
      const ob = await clob.getOrderbook(pos.tokenId);
      bestBid = ob.bestBid;
    }

    if (!bestBid || bestBid <= 0) {
      logger.warn("No bid available, cannot sell — holding to settlement");
      return 0;
    }

    // Place sell order
    const result = await clob.placeBatchOrders([
      {
        tokenId: pos.tokenId,
        side: Side.SELL,
        price: bestBid,
        size: actualShares,
      },
    ]);

    const sellPriceCents = bestBid * 100;
    const pnl = ((sellPriceCents - pos.entryPriceCents) / 100) * actualShares;

    logger.info("Position sold", {
      placed: result.placed,
      sellPrice: `${sellPriceCents.toFixed(1)}¢`,
      shares: actualShares.toFixed(2),
      pnl: `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
    });

    telegram.alertSell(pos.side, pos.entryPriceCents, sellPriceCents, pnl);
    await riskManager.recordResult(pnl);

    return pnl;
  };

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
    if (pos.sold) return;

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

      // 1. Check existing positions
      for (const [condId, pos] of activePositions) {
        if (pos.sold) {
          activePositions.delete(condId);
          continue;
        }

        if (pos.side === side) {
          logger.info("Already holding position in same direction", { side });
          return;
        }

        // Counter-signal → SELL
        logger.info("Counter-signal detected! Selling existing position", {
          held: pos.side,
          newSignal: side,
        });
        const pnl = await sellPosition(pos);
        pos.sold = true;
        pos.soldPnl = pnl;
        activePositions.delete(condId);
      }

      // 2. Risk check
      const riskCheck = await riskManager.check();
      if (!riskCheck.allowed) {
        logger.warn("Risk check blocked", { reason: riskCheck.reason });
        telegram.alertCircuitBreaker(riskCheck.reason ?? "Unknown");
        return;
      }

      // 3. Find current window
      const window = await windowManager.tick();
      if (!window) {
        logger.warn("No active window found");
        return;
      }

      // Subscribe CLOB WS to this window's tokens
      clobWs.clear();
      clobWs.subscribe([window.upTokenId, window.downTokenId]);

      // Set opening price if not yet set
      if (window.openingPrice === 0) {
        const openingPrice = rtds.price ?? binance.price;
        if (openingPrice) windowManager.setOpeningPrice(openingPrice);
      }

      // 4. Check time remaining
      const timeRemaining = windowManager.timeRemaining();

      // 5. Get current market price
      const tokenId = side === "Up" ? window.upTokenId : window.downTokenId;

      // Brief wait for CLOB WS to populate orderbook after subscribe
      await sleep(500);

      let book = clobWs.getBook(tokenId);
      let bestAskCents: number | null = null;

      if (book?.bestAsk) {
        bestAskCents = book.bestAsk * 100;
      } else {
        // REST fallback
        const ob = await clob.getOrderbook(tokenId);
        bestAskCents = ob.bestAsk ? ob.bestAsk * 100 : null;
      }

      logger.info("Signal evaluation", {
        direction,
        side,
        window: `${new Date(window.startTime).toISOString().slice(11, 19)} - ${new Date(window.endTime).toISOString().slice(11, 19)}`,
        timeRemaining: `${timeRemaining.toFixed(0)}s`,
        bestAsk: bestAskCents ? `${bestAskCents.toFixed(1)}¢` : "N/A",
        threshold: `${config.currentMarketMaxPriceCents}¢`,
        btcPrice: binance.price?.toFixed(2) ?? "N/A",
      });

      // 6. Decision: current market or next market?
      if (
        timeRemaining > 30 &&
        bestAskCents &&
        bestAskCents <= config.currentMarketMaxPriceCents
      ) {
        // === ENTER CURRENT MARKET ===
        logger.info("Entering CURRENT market (price within threshold)");
        await enterMarket(window, side, riskCheck.buyAmountUsd, undefined, "CURRENT");
      } else {
        // === ENTER NEXT MARKET (early entry) ===
        const skipReason = timeRemaining <= 30
          ? `${timeRemaining.toFixed(0)}s left`
          : `${bestAskCents?.toFixed(1)}¢ > ${config.currentMarketMaxPriceCents}¢`;
        telegram.alertSkip(side, bestAskCents, config.nextMarketLimitPriceCents, skipReason);

        const now = Math.floor(Date.now() / 1000);
        const windowSize = 300;
        const nextWindowStart =
          (Math.floor(now / windowSize) + 1) * windowSize;

        logger.info("Targeting NEXT market", {
          reason:
            timeRemaining <= 30
              ? "window ending soon"
              : `price ${bestAskCents?.toFixed(1)}¢ > ${config.currentMarketMaxPriceCents}¢`,
          nextWindow: new Date(nextWindowStart * 1000)
            .toISOString()
            .slice(11, 19),
          limitPrice: `${config.nextMarketLimitPriceCents}¢`,
        });

        // Try to find the next market
        const nextWindow =
          await discovery.findMarketByTimestamp(nextWindowStart);
        if (!nextWindow) {
          logger.warn(
            "Next market not yet available — may not be created yet",
          );
          return;
        }

        // Subscribe to next market tokens
        clobWs.clear();
        clobWs.subscribe([nextWindow.upTokenId, nextWindow.downTokenId]);

        // Set opening price
        if (nextWindow.openingPrice === 0) {
          const price = rtds.price ?? binance.price;
          if (price) nextWindow.openingPrice = price;
        }

        // Place limit order at nextMarketLimitPriceCents
        const pos = await enterMarket(
          nextWindow,
          side,
          riskCheck.buyAmountUsd,
          config.nextMarketLimitPriceCents,
          "NEXT",
        );

        // After timeout, check if filled → convert to market order if not
        if (pos && !config.dryRun) {
          setTimeout(async () => {
            try {
              const currentPos = activePositions.get(nextWindow.conditionId);
              if (!currentPos || currentPos.sold) return;

              // Check fill status
              let totalFilled = 0;
              for (const orderId of currentPos.orderIds) {
                const filled = await clob.getFilledShares(orderId);
                totalFilled += filled;
              }

              if (totalFilled <= 0) {
                logger.info(
                  "Limit order not filled after timeout, converting to market order",
                );

                // Cancel limit order
                for (const orderId of currentPos.orderIds) {
                  await clob.cancelOrder(orderId);
                }
                activePositions.delete(nextWindow.conditionId);

                // Re-enter at market price
                const riskCheck2 = await riskManager.check();
                if (riskCheck2.allowed) {
                  await enterMarket(
                    nextWindow,
                    side,
                    riskCheck2.buyAmountUsd,
                  );
                }
              } else {
                logger.info("Limit order filled", {
                  shares: totalFilled.toFixed(2),
                });
              }
            } catch (err) {
              logger.error("Limit order timeout handler error", {
                error: (err as Error).message,
              });
            }
          }, config.limitOrderTimeoutMs);
        }
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
          if (pos.sold) {
            activePositions.delete(condId);
            continue;
          }

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
