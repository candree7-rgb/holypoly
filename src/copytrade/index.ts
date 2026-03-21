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
import { createLogger } from "../logger.js";
import { ClobService } from "../data/clob.js";
import { TelegramNotifier } from "../telegram.js";
import { loadCopyTradeConfig } from "./config.js";
import { TargetTracker } from "./tracker.js";
import { CopyExecutor, type CopyResult } from "./executor.js";
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
      : config.sizingMode === "portfolio" ? `portfolio-weighted (leader=$${config.leaderPortfolioUsd})`
      : `${config.copyAmountPct}% of target`,
    dryRun: config.dryRun,
  });

  // Init Telegram
  const telegram = new TelegramNotifier(
    config.telegramBotToken,
    config.telegramChatId,
    logger,
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
    logger.error(`Balance ($${balance.toFixed(2)}) below floor ($${config.minBalanceFloorUsd}). Exiting.`);
    process.exit(1);
  }

  // Init executor (GTC limit orders)
  const executor = new CopyExecutor(clob, config, logger);

  // Init tracker (WebSocket + API polling)
  const tracker = new TargetTracker(
    config.dataApiHost,
    config.targetAddress,
    config.rpcWsUrl,
    config.pollIntervalMs,
    logger,
  );

  // Wire: tracker → executor → telegram
  tracker.onNewTrade(async (trade) => {
    const result = await executor.executeCopy(trade);
    await notifyResult(result, telegram, logger);
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
        `Copy-Trade ${result.trade.side}${dryTag}`,
        `${result.trade.title.slice(0, 60) || "?"}`,
        `Outcome: ${result.trade.outcome || "?"}`,
        ``,
        `Leader: ${leaderUsd} · ${leaderShares} sh @ ${leaderPrice}¢`,
        `Ours:   ${ourUsd} · ${ourShares} sh @ ${ourPrice}¢${priceDiffStr}`,
        ``,
        `GTC limit · ${result.latencyMs}ms · ${result.trade.source}`,
      ].join("\n"),
      "copy_filled",
    );
  } else if (result.reason && !["cooldown", "sell_filtered", "market_filtered"].includes(result.reason)) {
    await telegram.send(
      [
        `Copy Skipped: ${result.reason}`,
        `${result.trade.outcome || "?"} @ ${result.trade.priceCents}¢`,
      ].join("\n"),
      "copy_skipped",
    );
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
