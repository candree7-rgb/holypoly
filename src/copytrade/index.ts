#!/usr/bin/env node

/**
 * HolyPoly CopyTrader — Ultra-fast Polymarket copy trading bot.
 *
 * Detection: Polygon WebSocket (real-time, ~2s) + Data API polling (fallback)
 * Execution: GTC limit orders at target's exact price (0% maker fee)
 * Runtime: Optimized for Bun (also works with Node.js/tsx)
 *
 * Usage:
 *   bun run src/copytrade/index.ts    # Fast (recommended)
 *   npx tsx src/copytrade/index.ts     # Node.js fallback
 */

import "dotenv/config";
import { webcrypto } from "crypto";
import { createLogger } from "../logger.js";
import { ClobService } from "../data/clob.js";
import { TelegramNotifier } from "../telegram.js";
import { loadCopyTradeConfig } from "./config.js";
import { TargetTracker } from "./tracker.js";
import { CopyExecutor, type CopyResult, type FillEvent, type UnfilledEvent } from "./executor.js";
import { CopyTradeDB } from "./db.js";
import { sleep } from "../utils.js";
import type { Logger } from "../logger.js";

const BANNER = `
╔═══════════════════════════════════════════════╗
║  HolyPoly CopyTrader                         ║
║                                               ║
║  Detection: Polygon WebSocket (real-time)     ║
║  Orders:    GTC Limit (0% maker fee)          ║
║  Slippage:  Same price as target              ║
╚═══════════════════════════════════════════════╝
`;

async function main() {
  // Polyfill crypto.subtle for Node 18 (needed by CLOB client for API key derivation)
  if (!globalThis.crypto) {
    (globalThis as typeof globalThis & { crypto?: Crypto }).crypto =
      webcrypto as Crypto;
  }

  console.log(BANNER);

  const config = loadCopyTradeConfig();
  const logger = createLogger(config.debug);

  const runtime = typeof (globalThis as Record<string, unknown>).Bun !== "undefined" ? "Bun" : "Node.js";
  logger.info(`Runtime: ${runtime} ${process.version}`);

  logger.info("Config loaded", {
    target: config.targetAddress.slice(0, 8) + "..." + config.targetAddress.slice(-6),
    detection: config.rpcWsUrl ? "WebSocket + API polling" : "API polling only",
    pollInterval: `${config.pollIntervalMs}ms`,
    orderType: "GTC limit (maker, 0% fee)",
    slippage: config.bumpAfterMs > 0 ? `bump +${config.maxSlippageCents}¢ after ${config.bumpAfterMs}ms` : "same price (no bump)",
    sizing: config.sizingMode === "fixed" ? `$${config.fixedAmountUsd} fixed`
      : config.sizingMode === "shares" ? `${config.fixedShares} shares fixed`
      : config.sizingMode === "portfolio" ? `portfolio-weighted x${config.copyMultiplier} (dynamic balance)`
      : `${config.copyAmountPct}% of target`,
    dryRun: config.dryRun,
  });

  // Init Telegram
  const telegram = new TelegramNotifier(
    config.telegramBotToken,
    config.telegramChatId,
    logger,
    "🤖",
  );

  // Init CLOB (pre-derive API keys)
  logger.info("Initializing CLOB client...");
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

  const balance = await clob.getBalance();
  logger.info(`Balance: $${balance.toFixed(2)} USDC`);

  if (balance < config.minBalanceFloorUsd) {
    if (config.dryRun) {
      logger.warn(`Balance ($${balance.toFixed(2)}) below floor — continuing anyway (DRY RUN)`);
    } else {
      logger.error(`Balance ($${balance.toFixed(2)}) below floor ($${config.minBalanceFloorUsd}). Exiting.`);
      process.exit(1);
    }
  }

  // Init executor (GTC limit orders)
  const executor = new CopyExecutor(clob, config, logger);

  // Init DB (optional — only if DATABASE_URL is set)
  let db: CopyTradeDB | null = null;
  if (config.databaseUrl) {
    try {
      db = new CopyTradeDB(config.databaseUrl, logger);
      await db.init();
    } catch (err) {
      logger.warn("DB init failed — continuing without persistence", { error: (err as Error).message });
      db = null;
    }
  }

  // Init tracker (WebSocket + API polling)
  const tracker = new TargetTracker(
    config.dataApiHost,
    config.targetAddress,
    config.rpcWsUrl,
    config.pollIntervalMs,
    logger,
    config.gammaHost,
  );

  // Wire: tracker → executor → telegram → DB
  tracker.onNewTrade((trade) => {
    executor.executeCopy(trade)
      .then(async (result) => {
        // Telegram (fire-and-forget)
        notifyResult(result, telegram, logger).catch((err) => {
          logger.warn("Telegram notify failed", { error: (err as Error).message });
        });
        // DB persistence
        if (db) {
          try {
            if (result.success) {
              await db.recordPlacement({
                orderId: result.orderId,
                tradeId: trade.id,
                side: trade.side,
                marketTitle: trade.title,
                outcome: trade.outcome,
                conditionId: trade.conditionId,
                tokenId: trade.tokenId,
                priceCents: trade.priceCents,
                requestedShares: result.executedShares ?? 0,
                requestedUsd: result.executedUsd ?? 0,
                leaderPriceCents: result.leaderPriceCents,
                leaderUsd: result.leaderUsd,
                leaderShares: result.leaderShares,
                source: trade.source,
                latencyMs: result.latencyMs,
                dryRun: result.reason === "dry_run",
              });
            } else if (result.reason === "order_failed_after_retries") {
              await db.recordFailed(trade.id, trade.side, trade.title, result.reason);
            } else if (result.reason && !["cooldown", "sell_filtered", "market_filtered"].includes(result.reason)) {
              await db.recordSkip({
                tradeId: trade.id, side: trade.side, marketTitle: trade.title,
                outcome: trade.outcome, reason: result.reason, source: trade.source,
              });
            }
          } catch (err) {
            logger.warn("DB record failed", { error: (err as Error).message });
          }
        }
      })
      .catch((err) => {
        logger.error("executeCopy crashed", { error: (err as Error).message, trade: trade.id });
      });
  });

  // Wire: fill tracking → telegram + DB
  executor.onFilled((event) => {
    notifyFilled(event, telegram, logger).catch((err) => {
      logger.warn("Telegram fill notify failed", { error: (err as Error).message });
    });
    if (db) {
      db.recordFill(event.orderId, event.filledShares, event.usd).catch((err) => {
        logger.warn("DB fill record failed", { error: (err as Error).message });
      });
    }
  });

  executor.onUnfilled((event) => {
    notifyUnfilled(event, telegram, logger).catch((err) => {
      logger.warn("Telegram unfilled notify failed", { error: (err as Error).message });
    });
    if (db) {
      db.recordUnfilled(event.orderId, event.filledShares, event.cancelled).catch((err) => {
        logger.warn("DB unfilled record failed", { error: (err as Error).message });
      });
    }
  });

  // Startup alert
  await telegram.send(
    [
      `*CopyTrader Started*`,
      `Target: \`${config.targetAddress.slice(0, 8)}...${config.targetAddress.slice(-6)}\``,
      `Balance: $${balance.toFixed(2)}`,
      `Detection: ${config.rpcWsUrl ? "WebSocket + API" : "API polling"}`,
      `Orders: GTC limit (0% fee)`,
      `Slippage: ${config.bumpAfterMs > 0 ? `bump +${config.maxSlippageCents}¢ after ${config.bumpAfterMs / 1000}s` : "same price"}`,
      `Mode: ${config.dryRun ? "DRY RUN" : "LIVE"}`,
    ].join("\n"),
  );

  // Start
  tracker.start();

  // Status every 60s
  const statusInterval = setInterval(() => {
    const ts = tracker.getStats();
    const es = executor.getStats();
    logger.info("Status", {
      chainEvents: ts.chainEvents,
      apiDetections: ts.apiDetections,
      polls: ts.totalPolls,
      copied: es.totalCopied,
      skipped: es.totalSkipped,
      failed: es.totalFailed,
      balance: `$${es.balance.toFixed(2)}`,
    });
  }, 60_000);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    tracker.stop();
    clearInterval(statusInterval);

    const es = executor.getStats();
    await telegram.send(
      [
        `*CopyTrader Stopped*`,
        `Copied: ${es.totalCopied}`,
        `Skipped: ${es.totalSkipped}`,
        `Failed: ${es.totalFailed}`,
        `Balance: $${es.balance.toFixed(2)}`,
      ].join("\n"),
    );

    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info("CopyTrader running. Watching target wallet...");
  while (true) {
    await sleep(60_000);
  }
}

async function notifyResult(
  result: CopyResult,
  telegram: TelegramNotifier,
  _logger: Logger,
): Promise<void> {
  if (result.success) {
    const ourPrice = result.executedPrice ? (result.executedPrice * 100).toFixed(1) : "?";
    const leaderPrice = result.leaderPriceCents ? result.leaderPriceCents.toFixed(1) : "?";
    const leaderUsd = result.leaderUsd ? `$${result.leaderUsd.toFixed(2)}` : "?";
    const leaderShares = result.leaderShares ? result.leaderShares.toFixed(1) : "?";
    const ourUsd = result.executedUsd ? `$${result.executedUsd.toFixed(2)}` : "?";
    const ourShares = result.executedShares ? result.executedShares.toFixed(1) : "?";
    const priceDiff = result.executedPrice && result.leaderPriceCents
      ? ((result.executedPrice * 100) - result.leaderPriceCents).toFixed(1)
      : null;
    const priceDiffStr = priceDiff ? ` (${Number(priceDiff) >= 0 ? "+" : ""}${priceDiff}¢)` : "";
    const dryTag = result.reason === "dry_run" ? " [DRY]" : "";

    await telegram.send(
      [
        `*Copy Trade ${result.trade.side}${dryTag}*`,
        `Market: ${result.trade.title.slice(0, 60) || "?"}`,
        `Outcome: ${result.trade.outcome || "?"}`,
        ``,
        `Leader: ${leaderUsd} · ${leaderShares} sh @ ${leaderPrice}¢`,
        `Ours:   ${ourUsd} · ${ourShares} sh @ ${ourPrice}¢${priceDiffStr}`,
        ``,
        `GTC limit · ${result.latencyMs}ms · ${result.trade.source}`,
        result.reason !== "dry_run" ? `_Waiting for fill..._` : "",
      ].filter(Boolean).join("\n"),
      "copy_placed",
    );
  } else if (result.reason === "order_failed_after_retries") {
    await telegram.send(
      [
        `*Copy Trade Failed*`,
        `Market: ${result.trade.title.slice(0, 60) || "?"}`,
        `Action: ${result.trade.side}`,
        `Error: No matching orders available or insufficient liquidity.`,
      ].join("\n"),
    );
  } else if (result.reason?.startsWith("price_too_high")) {
    const price = result.trade.priceCents;
    await telegram.send(
      [
        `*Copy Trade Skipped*`,
        `Market: ${result.trade.title.slice(0, 60) || "?"}`,
        `Reason: Price ${price}¢ out of configured range`,
        `Your position is protected.`,
      ].join("\n"),
      "copy_skipped",
    );
  } else if (result.reason === "exposure_limit") {
    await telegram.send(
      [
        `*Copy Trade Skipped*`,
        `Market: ${result.trade.title.slice(0, 60) || "?"}`,
        `Reason: Exposure limit reached`,
        `Your position is protected.`,
      ].join("\n"),
      "copy_skipped",
    );
  } else if (result.reason?.startsWith("balance_floor")) {
    await telegram.send(
      [
        `*Copy Trade Skipped*`,
        `Market: ${result.trade.title.slice(0, 60) || "?"}`,
        `Reason: Balance too low`,
      ].join("\n"),
      "copy_skipped",
    );
  } else if (result.reason === "no_liquidity") {
    await telegram.send(
      [
        `*Copy Trade Failed*`,
        `Market: ${result.trade.title.slice(0, 60) || "?"}`,
        `Action: ${result.trade.side}`,
        `Error: No liquidity on ${result.trade.side === "BUY" ? "ask" : "bid"} side of the orderbook.`,
      ].join("\n"),
    );
  } else if (result.reason === "orderbook_failed") {
    await telegram.send(
      [
        `*Copy Trade Failed*`,
        `Market: ${result.trade.title.slice(0, 60) || "?"}`,
        `Error: Orderbook lookup failed — trade skipped for safety.`,
      ].join("\n"),
    );
  }
  // Silently skip cooldown, sell_filtered, market_filtered, window_limit
}

async function notifyFilled(
  event: FillEvent,
  telegram: TelegramNotifier,
  _logger: Logger,
): Promise<void> {
  const priceCents = (event.price * 100).toFixed(1);
  const elapsed = ((event.filledAt - event.placedAt) / 1000).toFixed(1);
  await telegram.send(
    [
      `*Copy Trade Filled*`,
      `Market: ${event.trade.title.slice(0, 60) || "?"}`,
      `Outcome: ${event.trade.outcome || "?"}`,
      `${event.filledShares.toFixed(1)} shares @ ${priceCents}¢ ($${event.usd.toFixed(2)})`,
      `Maker fee: 0%`,
      `Filled in ${elapsed}s`,
    ].join("\n"),
  );
}

async function notifyUnfilled(
  event: UnfilledEvent,
  telegram: TelegramNotifier,
  _logger: Logger,
): Promise<void> {
  const priceCents = (event.price * 100).toFixed(1);
  const elapsed = ((Date.now() - event.placedAt) / 1000).toFixed(0);
  const partial = event.filledShares > 0
    ? `Partial fill: ${event.filledShares.toFixed(1)}/${event.requestedShares.toFixed(1)} shares`
    : `0/${event.requestedShares.toFixed(1)} shares filled`;
  await telegram.send(
    [
      `*Copy Trade Unfilled*`,
      `Market: ${event.trade.title.slice(0, 60) || "?"}`,
      `Price: ${priceCents}¢`,
      partial,
      event.cancelled ? `Order cancelled after ${elapsed}s` : `Order expired after ${elapsed}s`,
    ].join("\n"),
  );
}

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
