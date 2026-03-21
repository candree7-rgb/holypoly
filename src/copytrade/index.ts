#!/usr/bin/env node

/**
 * HolyPoly CopyTrader — Ultra-fast Polymarket copy trading bot.
 *
 * Monitors a target trader's activity and copies their trades
 * with minimal latency. Optimized for 5-minute crypto markets.
 *
 * Speed advantages over PolyGun / PolyCop:
 * - Bun runtime (faster startup, native fetch with keep-alive)
 * - 200-500ms polling interval (configurable)
 * - FOK orders for instant fill (no limit→cancel→market fallback)
 * - Pre-initialized CLOB client (API keys derived at startup)
 * - Minimal processing between detection and execution
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
║  Ultra-fast Polymarket copy trading           ║
║                                               ║
║  Optimized for 5-min crypto markets           ║
╚═══════════════════════════════════════════════╝
`;

async function main() {
  console.log(BANNER);

  // Load config
  const config = loadCopyTradeConfig();
  const logger = createLogger(config.debug);

  // Detect runtime
  const runtime = typeof (globalThis as Record<string, unknown>).Bun !== "undefined" ? "Bun" : "Node.js";
  logger.info(`Runtime: ${runtime} ${process.version}`);

  if (runtime !== "Bun") {
    logger.warn("Running on Node.js — for maximum speed, use: bun run src/copytrade/index.ts");
  }

  logger.info("Config loaded", {
    target: config.targetAddress.slice(0, 8) + "..." + config.targetAddress.slice(-6),
    pollInterval: `${config.pollIntervalMs}ms`,
    dryRun: config.dryRun,
    fixedAmount: config.fixedAmountUsd > 0 ? `$${config.fixedAmountUsd}` : `${config.copyAmountPct}%`,
    maxSlippage: `${config.maxSlippageCents}¢`,
    maxPrice: `${config.maxPriceCents}¢`,
    marketFilter: config.marketFilter.length > 0 ? config.marketFilter.join(",") : "all",
  });

  // Initialize Telegram
  const telegram = new TelegramNotifier(
    config.telegramBotToken,
    config.telegramChatId,
    logger,
  );

  // Initialize CLOB client (pre-derive API keys for speed)
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

  // Get initial balance
  const balance = await clob.getBalance();
  logger.info(`Balance: $${balance.toFixed(2)} USDC`);

  if (balance < config.minBalanceFloorUsd) {
    logger.error(`Balance ($${balance.toFixed(2)}) below floor ($${config.minBalanceFloorUsd}). Exiting.`);
    process.exit(1);
  }

  // Initialize executor
  const executor = new CopyExecutor(clob, config, logger);

  // Initialize tracker
  const tracker = new TargetTracker(
    config.dataApiHost,
    config.targetAddress,
    config.pollIntervalMs,
    logger,
  );

  // Wire up: tracker → executor
  tracker.onNewTrade(async (trade) => {
    const result = await executor.executeCopy(trade);
    await notifyResult(result, telegram, logger);
  });

  // Send startup alert
  await telegram.send(
    [
      `*CopyTrader Started*`,
      `Target: \`${config.targetAddress.slice(0, 8)}...${config.targetAddress.slice(-6)}\``,
      `Balance: $${balance.toFixed(2)}`,
      `Poll: ${config.pollIntervalMs}ms`,
      `Mode: ${config.dryRun ? "DRY RUN" : "LIVE"}`,
      `Runtime: ${runtime}`,
    ].join("\n"),
  );

  // Start tracking
  tracker.start();

  // Status reporting loop
  const statusInterval = setInterval(() => {
    const trackerStats = tracker.getStats();
    const execStats = executor.getStats();

    logger.info("Status", {
      polls: trackerStats.totalPolls,
      detected: trackerStats.totalTrades,
      copied: execStats.totalCopied,
      skipped: execStats.totalSkipped,
      failed: execStats.totalFailed,
      balance: `$${execStats.balance.toFixed(2)}`,
      errors: trackerStats.consecutiveErrors,
    });
  }, 60_000); // Every minute

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    tracker.stop();
    clearInterval(statusInterval);

    const execStats = executor.getStats();
    await telegram.send(
      [
        `*CopyTrader Stopped*`,
        `Copied: ${execStats.totalCopied}`,
        `Skipped: ${execStats.totalSkipped}`,
        `Failed: ${execStats.totalFailed}`,
        `Final balance: $${execStats.balance.toFixed(2)}`,
      ].join("\n"),
    );

    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep alive
  logger.info("CopyTrader running. Monitoring target wallet...");
  while (true) {
    await sleep(60_000);
  }
}

/**
 * Send Telegram notification for copy trade results.
 */
async function notifyResult(
  result: CopyResult,
  telegram: TelegramNotifier,
  logger: Logger,
): Promise<void> {
  if (result.success) {
    await telegram.send(
      [
        `*COPY TRADE ${result.trade.side}*`,
        `Market: ${result.trade.title.slice(0, 50)}`,
        `Outcome: ${result.trade.outcome}`,
        `Target price: ${result.trade.priceCents}¢`,
        `Our price: ${result.executedPrice ? Math.round(result.executedPrice * 100) + "¢" : "?"}`,
        `Amount: $${result.executedUsd?.toFixed(2) || "?"}`,
        `Shares: ${result.executedShares?.toFixed(1) || "?"}`,
        `Latency: ${result.latencyMs}ms`,
        result.reason === "dry_run" ? "_(dry run)_" : "",
      ].join("\n"),
      "copy_filled",
    );
  } else if (result.reason && !["cooldown", "sell_filtered", "market_filtered"].includes(result.reason)) {
    // Only notify for interesting skips/failures
    await telegram.send(
      [
        `*Copy Skipped*`,
        `Reason: ${result.reason}`,
        `Market: ${result.trade.title.slice(0, 40)}`,
        `${result.trade.outcome} @ ${result.trade.priceCents}¢`,
      ].join("\n"),
      "copy_skipped",
    );
  }
}

// Bun and Node.js compatible entry
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
