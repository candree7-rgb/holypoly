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
import { ResolutionTracker, type ResolutionEvent } from "./resolution.js";
import { sleep } from "../utils.js";
import type { Logger } from "../logger.js";

const BANNER = `
╔═══════════════════════════════════════════════╗
║  HolyPoly CopyTrader                         ║
║                                               ║
║  Detection: CLOB WS + API Poll + Chain WS     ║
║  Orders:    Fast FOK / GTC Limit              ║
║  Latency:   ~100-300ms (3-layer detection)    ║
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

  const targetsSummary = config.targets.map((t) =>
    `${t.address.slice(0, 8)}...${t.address.slice(-4)}×${t.multiplier}`,
  ).join(", ");
  logger.info("Config loaded", {
    targets: `${config.targets.length} leader(s): ${targetsSummary}`,
    detection: "CLOB WS (trigger) + API Poll (100ms) + Chain WS (backup)",
    pollInterval: `${config.pollIntervalMs}ms`,
    strategy: `GTC (500ms) → FAK +${config.maxSlippageCents}¢ → patient GTC`,
    sizing: config.sizingMode === "fixed" ? `$${config.fixedAmountUsd} fixed`
      : config.sizingMode === "shares" ? `${config.fixedShares} shares fixed`
      : config.sizingMode === "portfolio" ? `portfolio-weighted (per-leader multiplier)`
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

  // Init DB FIRST (needed for resolution tracker)
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

  // Resolution tracker (needs DB, but used by executor's SellEngine for short-circuit)
  let resolution: ResolutionTracker | null = null;
  if (db) {
    resolution = new ResolutionTracker(db, config.gammaHost, logger);
  }

  // Init executor (uses resolution for SELL short-circuit)
  const executor = new CopyExecutor(clob, config, logger, resolution ?? undefined);

  // Init tracker (WebSocket + API polling) — pass ALL target addresses
  const tracker = new TargetTracker(
    config.dataApiHost,
    config.targets.map((t) => t.address),
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
            logger.info("DB: recording trade", { success: result.success, reason: result.reason });
            if (result.success) {
              await db.recordPlacement({
                orderId: result.orderId,
                tradeId: trade.id,
                leaderAddress: trade.leaderAddress,
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
            } else if (result.reason && result.reason.startsWith("order_failed")) {
              await db.recordFailed(trade.id, trade.leaderAddress, trade.side, trade.title, result.reason);
            } else if (result.reason && !["cooldown", "sell_filtered", "market_filtered"].includes(result.reason)) {
              await db.recordSkip({
                tradeId: trade.id, leaderAddress: trade.leaderAddress,
                side: trade.side, marketTitle: trade.title,
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
      `Targets (${config.targets.length}):\n${config.targets.map((t) => `  • \`${t.address.slice(0, 8)}...${t.address.slice(-4)}\` ×${t.multiplier}`).join("\n")}`,
      `Balance: $${balance.toFixed(2)}`,
      `Detection: CLOB WS + API Poll + Chain WS`,
      `Strategy: GTC → FAK +${config.maxSlippageCents}¢ → patient GTC`,
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
      clobWsTriggers: ts.clobWsTriggers,
      polls: ts.totalPolls,
      copied: es.totalCopied,
      skipped: es.totalSkipped,
      failed: es.totalFailed,
      balance: `$${es.balance.toFixed(2)}`,
    });
  }, 60_000);

  // Wire resolution tracker callbacks + start (constructed earlier)
  if (resolution) {
    // Win/Loss Telegram notification per resolved trade
    resolution.onTradeResolved((event: ResolutionEvent) => {
      const emoji = event.won ? "✅" : "❌";
      const result = event.won ? "WON" : "LOST";
      const pnlStr = event.pnl >= 0 ? `+$${event.pnl.toFixed(2)}` : `-$${Math.abs(event.pnl).toFixed(2)}`;
      const leader = `\`${event.leaderAddress.slice(0, 8)}...${event.leaderAddress.slice(-4)}\``;

      telegram.send(
        [
          `${emoji} *${result}* — ${event.market.slice(0, 50)}`,
          `Leader: ${leader}`,
          `Outcome: ${event.outcome}`,
          `Shares: ${event.filledShares.toFixed(1)} · Cost: $${event.costUsd.toFixed(2)} · Payout: $${event.payoutUsd.toFixed(2)}`,
          `*PNL: ${pnlStr}*`,
        ].join("\n"),
        "resolution",
      ).catch((err) => {
        logger.warn("TG resolution notify failed", { error: (err as Error).message });
      });
    });

    resolution.start(60_000); // check every 60s
  }

  // Per-leader PNL summary — log every 15min, Telegram every 6h
  let lastTelegramSummary = Date.now();
  const pnlInterval = setInterval(async () => {
    if (!db) return;
    try {
      const stats = await db.getLeaderStats();
      if (stats.length === 0) return;

      // Console log (every 15min)
      const totalPnl = stats.reduce((s, x) => s + x.realizedPnl, 0);
      const totalOpen = stats.reduce((s, x) => s + x.openPositionsUsd, 0);
      logger.info("Per-leader PNL", {
        totalRealized: `$${totalPnl.toFixed(2)}`,
        totalOpen: `$${totalOpen.toFixed(2)}`,
        leaders: stats.map((s) => ({
          addr: s.leaderAddress.slice(0, 8) + "...",
          copies: s.copies,
          spent: `$${s.totalSpentUsd.toFixed(2)}`,
          pnl: `$${s.realizedPnl.toFixed(2)}`,
          winRate: `${(s.winRate * 100).toFixed(0)}%`,
          open: `$${s.openPositionsUsd.toFixed(2)}`,
        })),
      });

      // Telegram daily summary (every 24h)
      if (Date.now() - lastTelegramSummary >= 24 * 60 * 60_000) {
        const todayStats = await db.getLeaderStats(24);
        const todayPnl = todayStats.reduce((s, x) => s + x.realizedPnl, 0);
        const todayFilled = todayStats.reduce((s, x) => s + x.filled, 0);
        const todayCopies = todayStats.reduce((s, x) => s + x.copies, 0);
        const todayWinRate = todayStats.length > 0
          ? todayStats.reduce((s, x) => s + x.winRate, 0) / todayStats.length : 0;

        const lines = [
          `*📊 Daily PNL Report*`,
          ``,
          `Balance: $${(await executor.getStats().balance).toFixed(2)}`,
          `Today: ${todayFilled}/${todayCopies} trades filled`,
          `Total PNL: ${todayPnl >= 0 ? "+" : ""}$${todayPnl.toFixed(2)}`,
          `Win Rate: ${(todayWinRate * 100).toFixed(0)}%`,
          `Open: $${totalOpen.toFixed(2)}`,
          ``,
          `*Per Leader (24h):*`,
        ];
        for (const s of todayStats) {
          const pnlStr = s.realizedPnl >= 0 ? `+$${s.realizedPnl.toFixed(2)}` : `-$${Math.abs(s.realizedPnl).toFixed(2)}`;
          const emoji = s.realizedPnl >= 0 ? "🟢" : "🔴";
          lines.push(
            `${emoji} \`${s.leaderAddress.slice(0, 8)}...${s.leaderAddress.slice(-4)}\``,
            `   ${s.filled} trades · ${pnlStr} · ${(s.winRate * 100).toFixed(0)}% wins`,
          );
        }
        await telegram.send(lines.join("\n"), "daily_summary");
        lastTelegramSummary = Date.now();
      }
    } catch (err) {
      logger.warn("PNL summary failed", { error: (err as Error).message });
    }
  }, 15 * 60_000);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    tracker.stop();
    clearInterval(statusInterval);
    clearInterval(pnlInterval);
    resolution?.stop();

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

    let statusLine: string;
    if (result.reason === "dry_run") {
      statusLine = `DRY RUN · ${result.latencyMs}ms`;
    } else if (result.reason === "gtc_instant_fill") {
      statusLine = `GTC instant fill (0% fee) · ${result.latencyMs}ms`;
    } else if (result.reason === "fast_fok_filled") {
      statusLine = `FAST FOK filled · ${result.latencyMs}ms`;
    } else if (result.reason === "fak_filled") {
      statusLine = `FAK filled · ${result.latencyMs}ms`;
    } else if (result.reason === "gtc_pending") {
      statusLine = `Patient GTC placed (0% fee) · ${result.latencyMs}ms`;
    } else {
      statusLine = `${result.reason} · ${result.latencyMs}ms`;
    }

    const leaderAddr = result.trade.leaderAddress
      ? `\`${result.trade.leaderAddress.slice(0, 8)}...${result.trade.leaderAddress.slice(-4)}\``
      : "?";
    await telegram.send(
      [
        `*Copy Trade ${result.trade.side}${dryTag}*`,
        `Leader: ${leaderAddr}`,
        `Market: ${result.trade.title.slice(0, 60) || "?"}`,
        `Outcome: ${result.trade.outcome || "?"}`,
        ``,
        `Leader: ${leaderUsd} · ${leaderShares} sh @ ${leaderPrice}¢`,
        `Ours:   ${ourUsd} · ${ourShares} sh @ ${ourPrice}¢${priceDiffStr}`,
        ``,
        statusLine,
      ].join("\n"),
      "copy_placed",
    );
  } else if (result.reason === "order_failed_after_retries" || result.reason === "order_failed" || result.reason === "order_failed_no_liquidity") {
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
  // This only fires for async fills (from checkPendingOrders)
  // Immediate fills (maker/taker) are handled by notifyResult
  const priceCents = (event.price * 100).toFixed(1);
  const elapsed = ((event.filledAt - event.placedAt) / 1000).toFixed(1);
  await telegram.send(
    [
      `*Copy Trade Filled (async)*`,
      `Market: ${event.trade.title.slice(0, 60) || "?"}`,
      `Outcome: ${event.trade.outcome || "?"}`,
      `${event.filledShares.toFixed(1)} shares @ ${priceCents}¢ ($${event.usd.toFixed(2)})`,
      `Maker (0% fee) · filled in ${elapsed}s`,
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
