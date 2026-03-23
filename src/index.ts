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
import { WindowMemory } from "./signal/window-memory.js";
import { ArbManager } from "./execution/arb-manager.js";
import { ArbCompletionMonitor } from "./execution/arb-completion.js";
import { WindowManager } from "./execution/window-manager.js";
import { SignalExecutor } from "./execution/signal-executor.js";
import { MergeArbExecutor } from "./execution/merge-arb-executor.js";
import { RiskManager } from "./risk/limits.js";
import { TelegramNotifier } from "./telegram.js";
import { createWebhookServer } from "./webhook.js";
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

  logger.info(`=== HolyPoly Bot Starting [${config.strategyMode.toUpperCase()}] ===`);
  logger.info("Mode", { strategy: config.strategyMode, dryRun: config.dryRun });

  if (config.strategyMode === "merge-arb") {
    logger.info("Merge-Arb V3 parameters", {
      equityPerWindow: `${(config.equityPerWindow * 100).toFixed(0)}%`,
      maxOrders: config.maxOrdersPerWindow,
      mergeMinSize: config.mergeMinSize,
      entryDelay: `${config.mergeEntryDelayMs}ms`,
      orderInterval: `${config.orderIntervalMs}ms`,
      slippage: `+${(config.slippageBuffer * 100).toFixed(0)}¢`,
      skipGate: `${(config.skipIfBestCombinedGt * 100).toFixed(0)}¢`,
      stopBuyingBefore: `${config.stopBuyingBeforeEndS}s`,
      mergeBefore: `${config.mergeBeforeEndS}s`,
      feeModel: "curve",
    });
  } else {
    logger.info("Edge parameters", {
      edgeThreshold: `${config.edgeThresholdCents}¢`,
      entryDelay: `${config.entryDelaySeconds}s`,
      scanInterval: `${config.scanIntervalMs}ms`,
    });
  }
  logger.info("Risk", {
    dailyLossLimit: `${config.dailyLossLimitPct}%`,
    weeklyLossLimit: `${config.weeklyLossLimitPct}%`,
    minBalance: `$${config.minBalanceFloorUsd}`,
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
  const windowMemory = new WindowMemory(logger);
  const fairValueEngine = new FairValueEngine(volatilityCalc);
  fairValueEngine.setWindowMemory(windowMemory);
  const edgeDetector = new EdgeDetector(fairValueEngine, clob, config, logger, volatilityCalc);

  // Risk manager
  const riskManager = new RiskManager(
    config,
    db,
    logger,
    () => clob.getBalance(),
  );

  // === WebSocket connections ===
  const binance = new BinanceWsClient(logger);
  binance.onTick((tick) => {
    volatilityCalc.addPrice(tick.price, tick.timestamp);
  });
  binance.start();

  const rtds = new RtdsWsClient(logger);
  rtds.start();

  const clobWs = new ClobWsClient(logger);
  clobWs.start();

  // Arb manager (tracks position state per window)
  const arbManager = new ArbManager(
    {
      maxRoundTripsPerWindow: config.maxRoundTripsPerWindow,
      maxUnhedgedPct: config.maxUnhedgedPct,
      maxWindowExposurePct: config.maxWindowExposurePct,
      minProfitCents: config.minProfitCents,
      emergencyBalanceAfterMs: config.arbCompletionTimeoutMs,
    },
    logger,
  );

  // Arb completion monitor (proactively seeks loser side)
  const arbCompletion = new ArbCompletionMonitor(
    clobWs,
    clob,
    config,
    arbManager,
    logger,
    telegram,
    volatilityCalc,
    fairValueEngine,
  );

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

  // Track all order IDs per window for settlement
  let windowOrderIds: string[] = [];
  let currentWindowInfo: WindowInfo | null = null;

  /**
   * Settle the window: calculate P&L from all positions.
   */
  const settleWindow = async (window: WindowInfo) => {
    const state = arbManager.getState();
    if (!state.upShares && !state.downShares) return;

    const settlementPrice = rtds.price ?? binance.price;
    if (settlementPrice === null) {
      logger.warn("No settlement price, skipping P&L");
      return;
    }

    const winner: TradeSide = settlementPrice > window.openingPrice ? "Up" : "Down";
    let totalPnl: number;

    // Polymarket taker fee (from config, default 2%)
    const TAKER_FEE_PCT = config.takerFeeRate;

    const isLive = !config.dryRun && windowOrderIds.length > 0;
    if (isLive) {
      const fills = await clob.getOrderFills(windowOrderIds, window.conditionId);
      totalPnl = 0;
      let totalFees = 0;
      for (const fill of fills) {
        if (fill.sizeMatched <= 0) continue;
        const fillSide: TradeSide =
          fill.tokenId === window.upTokenId ? "Up" : "Down";
        const won = fillSide === winner;
        const fee = fill.costFilled * TAKER_FEE_PCT;
        totalFees += fee;
        totalPnl += won
          ? (fill.sizeMatched - fill.costFilled - fee)
          : -(fill.costFilled + fee);
      }
      if (totalPnl === 0 && fills.every((f) => f.sizeMatched <= 0)) {
        logger.info("No fills this window, skipping settlement");
        return;
      }
      logger.debug("Fee impact", { totalFees: `$${totalFees.toFixed(4)}` });
    } else {
      // Dry run: calculate from arb state (with fee deduction)
      totalPnl = 0;
      const totalCost = state.upCostUsd + state.downCostUsd;
      const totalFees = totalCost * TAKER_FEE_PCT;
      const balanced = Math.min(state.upShares, state.downShares);
      if (balanced > 0) {
        // Balanced pairs: guaranteed $1.00 payout minus cost and fees
        const upProp = state.upShares > 0 ? balanced / state.upShares : 0;
        const downProp = state.downShares > 0 ? balanced / state.downShares : 0;
        const balancedCost = state.upCostUsd * upProp + state.downCostUsd * downProp;
        const balancedFees = balancedCost * TAKER_FEE_PCT;
        totalPnl += balanced - balancedCost - balancedFees;
      }
      // Unhedged portion
      const unhedged = Math.abs(state.upShares - state.downShares);
      if (unhedged > 0) {
        const unhedgedSide = state.upShares > state.downShares ? "Up" : "Down";
        const unhedgedWon = unhedgedSide === winner;
        const unhedgedCost = unhedgedSide === "Up"
          ? state.upCostUsd * (unhedged / state.upShares)
          : state.downCostUsd * (unhedged / state.downShares);
        const unhedgedFees = unhedgedCost * TAKER_FEE_PCT;
        totalPnl += unhedgedWon
          ? (unhedged - unhedgedCost - unhedgedFees)
          : -(unhedgedCost + unhedgedFees);
      }
      logger.debug("Fee impact (dry run)", { totalFees: `$${totalFees.toFixed(4)}` });
    }

    const prefix = config.dryRun ? "DRY_RUN SETTLEMENT" : "SETTLEMENT";
    logger.info(prefix, {
      winner,
      totalPnl: `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`,
      upShares: state.upShares.toFixed(1),
      downShares: state.downShares.toFixed(1),
      roundTrips: state.roundTrips,
      lockedProfit: `$${state.lockedProfit.toFixed(2)}`,
      btcOpen: window.openingPrice.toFixed(2),
      btcSettle: settlementPrice.toFixed(2),
    });

    // Atomic settlement: all DB writes in one transaction
    const won = totalPnl >= 0;
    const today = new Date();
    const dailyDate = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
    const weekStart = new Date(today);
    weekStart.setUTCDate(today.getUTCDate() - today.getUTCDay());
    const weeklyWeek = `${weekStart.getUTCFullYear()}-W${String(weekStart.getUTCMonth() + 1).padStart(2, "0")}${String(weekStart.getUTCDate()).padStart(2, "0")}`;

    try {
      await db.settleWindowAtomic({
        conditionId: window.conditionId,
        pnl: totalPnl,
        winner,
        dailyDate,
        weeklyWeek,
        won,
      });
    } catch {
      // Fallback to non-atomic if transaction fails
      logger.warn("Atomic settlement failed, using fallback");
      await riskManager.recordResult(totalPnl);
      await db.updateWindowSettlement(window.conditionId, totalPnl, winner);
    }

    // Invalidate balance cache after settlement
    riskManager.invalidateBalanceCache();

    // Record outcome for cross-window continuation bias
    windowMemory.recordOutcome(winner, settlementPrice - window.openingPrice);

    const dailyStats = await riskManager.getDailyStats();
    telegram.alertSettlement(
      winner,
      totalPnl,
      totalPnl >= 0 ? 1 : 0,
      1,
      dailyStats.totalPnl,
      dailyStats.wins,
      dailyStats.losses,
    );
  };

  // === FLASH CRASH CIRCUIT BREAKER ===
  let circuitBreakerUntil = 0;

  const checkCircuitBreaker = (): boolean => {
    const now = Date.now();
    if (now < circuitBreakerUntil) return true; // still paused

    // Only pause on truly extreme flash crashes (>$500 5-min move)
    // High volatility ($100-300) is GOOD — it creates the mispricings we profit from.
    const vol = volatilityCalc.getVolatility();
    if (vol > 500) {
      const pauseMs = 60000; // 1 minute pause (shorter — we want back in fast)
      circuitBreakerUntil = now + pauseMs;
      logger.warn("CIRCUIT BREAKER — extreme flash crash, brief pause", {
        volatility: `$${vol.toFixed(1)}`,
        threshold: "$500",
        pauseSeconds: 60,
      });
      telegram.alertCircuitBreaker(`Flash crash: $${vol.toFixed(0)} vol. Pausing 1 min.`);
      return true;
    }
    return false;
  };

  // === MAIN HYBRID LOOP ===
  const hybridLoop = async () => {
    let lastStatusLog = 0;
    let currentWindowId: string | null = null;

    while (true) {
      try {
        const now = Date.now();

        // Status log every 5 minutes
        if (now - lastStatusLog >= 300000) {
          await riskManager.logStatus();
          const state = arbManager.getState();
          logger.info("Status", {
            binance: binance.connected,
            btcPrice: binance.price?.toFixed(2) ?? "N/A",
            chainlink: rtds.connected,
            clobWs: clobWs.connected,
            volatility: `$${volatilityCalc.getVolatility().toFixed(1)}`,
            regime: volatilityCalc.getRegime(),
            arbState: state.roundTrips > 0 || state.upShares > 0
              ? `${state.roundTrips}RT, Up=${state.upShares.toFixed(0)} Down=${state.downShares.toFixed(0)}`
              : "idle",
          });
          lastStatusLog = now;
        }

        // Find current window
        const window = await windowManager.tick();
        if (!window) {
          await sleep(config.scanIntervalMs);
          continue;
        }

        // Window transition
        if (window.conditionId !== currentWindowId) {
          // Settle previous window
          if (currentWindowInfo && currentWindowId) {
            logger.info("Window ended, settling");
            arbCompletion.reset();
            await settleWindow(currentWindowInfo);
          }

          currentWindowId = window.conditionId;
          currentWindowInfo = window;
          windowOrderIds = [];
          arbManager.reset(window.conditionId);
          arbCompletion.reset();

          // Subscribe CLOB WS to new window
          clobWs.clear();
          clobWs.subscribe([window.upTokenId, window.downTokenId]);

          logger.info("New window", {
            conditionId: window.conditionId.slice(0, 16) + "...",
            start: new Date(window.startTime).toISOString().slice(11, 19),
            end: new Date(window.endTime).toISOString().slice(11, 19),
          });
        }

        // Set opening price
        if (window.openingPrice === 0) {
          const price = rtds.price ?? binance.price;
          if (price) {
            window.openingPrice = price;
            windowManager.setOpeningPrice(price);
          }
        }

        // Wait for entry delay
        const windowElapsedSec = (now - window.startTime) / 1000;
        if (windowElapsedSec < config.entryDelaySeconds) {
          await sleep(config.scanIntervalMs);
          continue;
        }

        const timeRemaining = (window.endTime - now) / 1000;

        // Don't start new entries with < 30s remaining
        if (timeRemaining < 30) {
          // But check if we need forced settlement
          if (now >= window.endTime && currentWindowInfo) {
            arbCompletion.reset();
            await settleWindow(currentWindowInfo);
            currentWindowId = null;
            currentWindowInfo = null;
          }
          await sleep(config.scanIntervalMs);
          continue;
        }

        // Need Binance price
        const btcPrice = binance.price;
        if (!btcPrice) {
          await sleep(config.scanIntervalMs);
          continue;
        }

        // Circuit breaker: pause on extreme volatility
        if (checkCircuitBreaker()) {
          await sleep(config.scanIntervalMs);
          continue;
        }

        // If arb completion monitor is active, feed it updated BTC price
        if (arbCompletion.isActive) {
          arbCompletion.updateBtcPrice(btcPrice, timeRemaining);
          await sleep(500); // faster polling during arb completion
          continue;
        }

        // Check if ArbManager allows new entry
        const balance = await riskManager.getBalance();

        // Check unhedged exposure limit
        if (arbManager.isOverExposed(balance)) {
          const state = arbManager.getState();
          logger.warn("Over-exposed — blocking new trades", {
            unhedgedShares: state.unhedgedShares.toFixed(1),
            unhedgedSide: state.unhedgedSide,
            maxUnhedgedPct: `${config.maxUnhedgedPct}%`,
          });
          await sleep(config.scanIntervalMs);
          continue;
        }

        const arbCheck = arbManager.canEnterNewTrade(balance);
        if (!arbCheck.allowed) {
          logger.debug("Arb manager blocked", { reason: arbCheck.reason });
          await sleep(config.scanIntervalMs);
          continue;
        }

        // Risk check
        const riskCheck = await riskManager.check();
        if (!riskCheck.allowed) {
          logger.debug("Risk blocked", { reason: riskCheck.reason });
          await sleep(config.scanIntervalMs);
          continue;
        }

        // *** CORE: Evaluate edge ***
        const decision = await edgeDetector.evaluate(
          window,
          btcPrice,
          timeRemaining,
          riskCheck.buyAmountUsd,
        );

        if (!decision.shouldTrade) {
          logger.debug("No edge", { reason: decision.reason });
          await sleep(config.scanIntervalMs);
          continue;
        }

        // === STEP 1: BUY WINNER SIDE ===
        const primaryOrders = decision.orders.filter((o) => o.side === decision.primarySide);
        if (primaryOrders.length === 0) {
          await sleep(config.scanIntervalMs);
          continue;
        }

        logger.info("EDGE DETECTED — Entering winner side (FOK)", {
          side: decision.primarySide,
          edge: `${decision.bestEdge.toFixed(1)}¢`,
          fairUp: decision.fairUp,
          confidence: `${(decision.confidence * 100).toFixed(0)}%`,
          depthConfirm: `${decision.depthConfirmation.toFixed(1)}x`,
          regime: decision.regime,
          orders: primaryOrders.length,
        });

        // Place winner orders using FOK (Fill or Kill) — prevents stale fills
        // FOK ensures we either fill NOW (while edge exists) or not at all
        let orderIds: string[] = [];
        let totalCost = 0;
        let totalShares = 0;

        if (!config.dryRun) {
          // Use FOK market order for immediate fill with price protection
          const worstPrice = Math.max(...primaryOrders.map((o) => o.price)) / 100;
          const totalAmount = primaryOrders.reduce((s, o) => s + o.amount, 0);

          const fokResult = await clob.placeMarketOrderFOK({
            tokenId: primaryOrders[0].tokenId,
            side: Side.BUY,
            amount: totalAmount,
            worstPrice: worstPrice + 0.02, // 2¢ slippage tolerance
          });

          if (!fokResult.filled) {
            // FOK failed — edge may have evaporated, which is GOOD (we avoided a bad fill)
            logger.info("FOK not filled — edge may have been arbed away, skipping");
            await sleep(config.scanIntervalMs);
            continue;
          }

          orderIds = fokResult.orderIds;
          windowOrderIds.push(...orderIds);

          // Get ACTUAL fill prices from API (not order prices — FOK may fill at different price)
          const fills = await clob.getOrderFills(orderIds, window.conditionId);
          if (fills.length > 0) {
            for (const f of fills) {
              totalShares += f.sizeMatched;
              totalCost += f.costFilled;
            }
            logger.info("FOK actual fills", {
              fills: fills.map((f) => `${(f.price * 100).toFixed(1)}¢ × ${f.sizeMatched.toFixed(2)}`),
              totalShares: totalShares.toFixed(2),
              totalCost: `$${totalCost.toFixed(2)}`,
            });
          } else {
            // Fallback to order prices if fill query fails
            logger.warn("Could not get actual fill prices, using order prices as estimate");
            for (const o of primaryOrders) {
              const shares = o.amount / (o.price / 100);
              totalShares += shares;
              totalCost += o.amount;
            }
          }
        } else {
          for (const o of primaryOrders) {
            const shares = o.amount / (o.price / 100);
            totalShares += shares;
            totalCost += o.amount;
          }
          logger.info("DRY_RUN — winner entry simulated (FOK)", {
            side: decision.primarySide,
            orders: primaryOrders.map((o) => `${o.price.toFixed(1)}¢ × $${o.amount.toFixed(2)}`),
          });
        }

        // Record fill in arb manager
        arbManager.recordFill(decision.primarySide, totalShares, totalCost);
        arbManager.setEntryTime();

        // Weighted average entry price in cents (from actual cost & shares, not order prices)
        const avgEntry = totalShares > 0 ? (totalCost / totalShares) * 100 : 0;

        // Record to database
        await db.recordWindow({
          windowStart: window.startTime,
          conditionId: window.conditionId,
          traded: true,
          primarySide: decision.primarySide,
          orders: primaryOrders,
          fillCount: primaryOrders.length,
          pnl: null,
          winner: null,
          balanceBefore: balance,
          balanceAfter: null,
        });

        // === STEP 2: START ARB COMPLETION — seek loser side ===
        const winnerTokenId = decision.primarySide === "Up"
          ? window.upTokenId
          : window.downTokenId;
        const loserTokenId = decision.primarySide === "Up"
          ? window.downTokenId
          : window.upTokenId;

        arbCompletion.startSeeking({
          winnerSide: decision.primarySide,
          winnerAvgPriceCents: avgEntry,
          winnerShares: totalShares,
          winnerTokenId,
          loserTokenId,
          window,
          currentBtcPrice: btcPrice,
          timeRemainingSeconds: timeRemaining,
          onComplete: (side, shares, costUsd, loserOrderIds) => {
            arbManager.recordFill(side, shares, costUsd);
            windowOrderIds.push(...loserOrderIds);

            const state = arbManager.getState();
            const avgLoserCents = shares > 0 ? (costUsd / shares) * 100 : 0;
            const totalPairCostCents = shares > 0 ? avgEntry + avgLoserCents : 0;
            logger.info("Arb completion filled", {
              side,
              shares: shares.toFixed(2),
              cost: `$${costUsd.toFixed(2)}`,
              totalPairCost: shares > 0 ? `${totalPairCostCents.toFixed(1)}¢` : "N/A (no fills)",
              lockedProfit: `$${state.lockedProfit.toFixed(2)}`,
              roundTrips: state.roundTrips,
            });

            telegram.alertEdgeEntry(
              `${decision.primarySide}+${side} ARB`,
              decision.bestEdge,
              decision.fairUp,
              decision.regime,
              decision.confidence,
              totalCost + costUsd,
              primaryOrders.length + 1,
            );
          },
        });

        // Brief wait before next scan (let arb completion work)
        await sleep(1000);
      } catch (err) {
        logger.error("Hybrid loop error", { error: (err as Error).message });
        telegram.alertError((err as Error).message);
      }

      await sleep(config.scanIntervalMs);
    }
  };

  // === WEBHOOK SIGNAL STRATEGY LOOP ===
  const webhookSignalLoop = async () => {
    // Signal executor
    const signalExecutor = new SignalExecutor(
      clob,
      discovery,
      {
        ladderPricesCents: config.signalLadderPrices,
        ladderWeights: config.signalLadderWeights,
        fallbackAfterSec: config.signalFokFallbackSec,
        fallbackMaxPriceCents: config.signalFokMaxPriceCents,
        buyAmountPct: config.buyAmountPct,
        fillPollIntervalMs: 5000,
        makerFeeRate: config.makerFeeRate,
        takerFeeRate: config.takerFeeRate,
      },
      logger,
      telegram,
      config.dryRun,
    );

    // Start webhook server and wire signal handler
    const webhook = createWebhookServer(config.webhookPort, logger, config.webhookSecret);
    webhook.onSignal((signal) => {
      const direction: TradeSide = signal.direction === "up" ? "Up" : "Down";
      signalExecutor.queueSignal(direction, signal.asset);
    });
    webhook.start();

    logger.info("=== Webhook Signal Strategy Active ===", {
      port: config.webhookPort,
      ladder: config.signalLadderPrices.join("/") + "¢",
      fokFallback: `${config.signalFokFallbackSec}s @ max ${config.signalFokMaxPriceCents}¢`,
      makerFee: `${config.makerFeeRate * 100}%`,
      takerFee: `${config.takerFeeRate * 100}%`,
    });

    // Track active positions for settlement
    let activeResult: {
      direction: TradeSide;
      shares: number;
      costUsd: number;
      orderIds: string[];
      conditionId: string;
      window: WindowInfo;
      makerFills: number;
      takerFills: number;
    } | null = null;

    while (true) {
      try {
        const balance = await riskManager.getBalance();

        // Risk check
        const riskCheck = await riskManager.check();
        if (!riskCheck.allowed && signalExecutor.hasPendingSignal) {
          logger.warn("Risk blocked — skipping signal", { reason: riskCheck.reason });
          signalExecutor.reset();
          await sleep(config.scanIntervalMs);
          continue;
        }

        // Tick the signal executor
        const result = await signalExecutor.tick(balance);

        if (result) {
          // Execution complete — store for settlement
          if (result.success) {
            // Find the window info for settlement
            const windowStartSec = Math.floor(result.windowStart / 1000);
            const window = await discovery.findMarketByTimestamp(windowStartSec, result.asset as "btc" | "eth");

            if (window) {
              activeResult = {
                direction: result.direction,
                shares: result.totalShares,
                costUsd: result.totalCostUsd,
                orderIds: result.orderIds,
                conditionId: result.conditionId,
                window,
                makerFills: result.makerFills,
                takerFills: result.takerFills,
              };

              // Record to database
              await db.recordWindow({
                windowStart: result.windowStart,
                conditionId: result.conditionId,
                traded: true,
                primarySide: result.direction,
                orders: [{
                  side: result.direction,
                  tokenId: result.direction === "Up" ? window.upTokenId : window.downTokenId,
                  price: result.avgPriceCents,
                  amount: result.totalCostUsd,
                }],
                fillCount: result.makerFills + result.takerFills,
                pnl: null,
                winner: null,
                balanceBefore: balance,
                balanceAfter: null,
              });
            }
          }
        }

        // Check if active position's window has ended → settle
        if (activeResult) {
          const now = Date.now();
          if (now >= activeResult.window.endTime + 5000) {
            // Settlement
            const settlementPrice = rtds.price ?? binance.price;
            if (settlementPrice && activeResult.window.openingPrice > 0) {
              const winner: TradeSide = settlementPrice >= activeResult.window.openingPrice ? "Up" : "Down";
              const won = activeResult.direction === winner;

              // Calculate fees: maker fills = 0%, taker fills = takerFeeRate
              const makerPortion = activeResult.makerFills / Math.max(1, activeResult.makerFills + activeResult.takerFills);
              const makerCost = activeResult.costUsd * makerPortion;
              const takerCost = activeResult.costUsd - makerCost;
              const totalFees = makerCost * config.makerFeeRate + takerCost * config.takerFeeRate;

              const pnl = won
                ? (activeResult.shares - activeResult.costUsd - totalFees)
                : -(activeResult.costUsd + totalFees);

              const prefix = config.dryRun ? "DRY_RUN SETTLEMENT" : "SETTLEMENT";
              logger.info(prefix, {
                winner,
                direction: activeResult.direction,
                won,
                pnl: `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
                shares: activeResult.shares.toFixed(1),
                cost: `$${activeResult.costUsd.toFixed(2)}`,
                fees: `$${totalFees.toFixed(4)}`,
                makerPct: `${(makerPortion * 100).toFixed(0)}%`,
              });

              // Record in DB
              const today = new Date();
              const dailyDate = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
              const weekStart = new Date(today);
              weekStart.setUTCDate(today.getUTCDate() - today.getUTCDay());
              const weeklyWeek = `${weekStart.getUTCFullYear()}-W${String(weekStart.getUTCMonth() + 1).padStart(2, "0")}${String(weekStart.getUTCDate()).padStart(2, "0")}`;

              try {
                await db.settleWindowAtomic({
                  conditionId: activeResult.conditionId,
                  pnl,
                  winner,
                  dailyDate,
                  weeklyWeek,
                  won,
                });
              } catch {
                await riskManager.recordResult(pnl);
                await db.updateWindowSettlement(activeResult.conditionId, pnl, winner);
              }

              riskManager.invalidateBalanceCache();

              const dailyStats = await riskManager.getDailyStats();
              telegram.alertSettlement(
                winner,
                pnl,
                won ? 1 : 0,
                1,
                dailyStats.totalPnl,
                dailyStats.wins,
                dailyStats.losses,
              );

              activeResult = null;
            }
          }
        }
      } catch (err) {
        logger.error("Webhook signal loop error", { error: (err as Error).message });
        telegram.alertError((err as Error).message);
      }

      await sleep(config.scanIntervalMs);
    }
  };

  // === MERGE-ARB STRATEGY LOOP ===
  const mergeArbLoop = async () => {
    const mergeArbExecutor = new MergeArbExecutor(
      clob,
      clobWs,
      redeemService,
      config,
      logger,
      telegram,
    );

    // --- CRASH RECOVERY (Spec 9.11 Scenario 6) ---
    await mergeArbExecutor.crashRecovery(dataApi, config.profileAddress);

    logger.info("=== Merge-Arb V3 Strategy Active ===", {
      equityPerWindow: `${(config.equityPerWindow * 100).toFixed(0)}%`,
      maxOrders: config.maxOrdersPerWindow,
      mergeMinSize: config.mergeMinSize,
      entryDelay: `${config.mergeEntryDelayMs}ms`,
      orderInterval: `${config.orderIntervalMs}ms`,
      slippage: `+${(config.slippageBuffer * 100).toFixed(0)}¢`,
      skipGate: `${(config.skipIfBestCombinedGt * 100).toFixed(0)}¢`,
      stopBuyingBefore: `${config.stopBuyingBeforeEndS}s`,
      feeModel: "curve",
      dryRun: config.dryRun,
    });

    while (true) {
      try {
        // --- DISCOVER NEXT WINDOW ---
        const balance = await riskManager.getBalance();
        const riskCheck = await riskManager.check();
        if (!riskCheck.allowed) {
          logger.warn("Risk blocked", { reason: riskCheck.reason });
          await sleep(5000);
          continue;
        }

        const window = await discovery.findActive5MinBtcMarket();
        if (!window) {
          await sleep(5000);
          continue;
        }

        // --- WAIT FOR WINDOW OPEN + ENTRY DELAY ---
        const now = Date.now();
        const windowStart = window.startTime;
        const entryTime = windowStart + config.mergeEntryDelayMs;

        if (now < entryTime) {
          // Subscribe to WS before window opens (get orderbook ready)
          clobWs.subscribe([window.upTokenId, window.downTokenId]);
          const waitMs = entryTime - now;
          if (waitMs > 60_000) {
            // Too early, keep polling
            await sleep(5000);
            continue;
          }
          logger.info("Waiting for entry time", {
            window: new Date(windowStart).toISOString().slice(11, 19),
            waitMs,
          });
          await sleep(waitMs);
        }

        // Don't enter if window is almost over (<30s remaining)
        const timeRemaining = window.endTime - Date.now();
        if (timeRemaining < 30_000) {
          logger.debug("Window too close to end, waiting for next");
          clobWs.clear();
          await sleep(5000);
          continue;
        }

        // --- SUBSCRIBE ORDERBOOK WS ---
        clobWs.subscribe([window.upTokenId, window.downTokenId]);
        // Brief wait for orderbook snapshot to arrive
        await sleep(1000);

        // --- EXECUTE ---
        const result = await mergeArbExecutor.executeWindow(window, balance);

        // --- RECORD TO DB ---
        const hadFills = !result.skipped && result.orderFills.length > 0;
        if (hadFills) {
          await db.recordWindow({
            windowStart: result.windowStart,
            conditionId: result.conditionId,
            traded: true,
            primarySide: null,
            orders: result.orderFills.map(f => ({
              side: f.side,
              tokenId: f.side === "Up" ? window.upTokenId : window.downTokenId,
              price: f.avgPrice * 100,
              amount: f.totalCost,
            })),
            fillCount: result.orderFills.length,
            pnl: result.totalMergeProfit,
            winner: null,
            balanceBefore: balance,
            balanceAfter: config.dryRun ? balance + result.totalMergeProfit : null,
          });

          // Update risk manager
          if (result.totalMergeProfit !== 0) {
            await riskManager.recordResult(result.totalMergeProfit);
            riskManager.invalidateBalanceCache();
          }
        }

        // --- POST-RESOLUTION CLEANUP (Spec 4.2: sell/redeem remaining imbalance) ---
        if (result.remainingUp > 0 || result.remainingDn > 0) {
          // Wait for resolution
          const waitForResolution = Math.max(0, window.endTime - Date.now()) + 5000;
          if (waitForResolution > 0 && waitForResolution < 600_000) {
            logger.info("Waiting for resolution to handle remaining imbalance", {
              remainingUp: result.remainingUp.toFixed(1),
              remainingDn: result.remainingDn.toFixed(1),
              waitMs: waitForResolution,
            });
            await sleep(waitForResolution);
          }

          // Determine winner from settlement price (Spec 4.2)
          const settlementPrice = rtds.price ?? binance.price;
          const winner: TradeSide | null = settlementPrice && window.openingPrice > 0
            ? (settlementPrice >= window.openingPrice ? "Up" : "Down")
            : null;

          if (winner) {
            logger.info("Post-resolution cleanup", { winner, remainingUp: result.remainingUp, remainingDn: result.remainingDn });
            // Winning side → auto-redeem at $1.00 (handled by redeemLoop)
            // Losing side → sell at market to recover whatever possible
            if (result.remainingUp > 0 && winner !== "Up") {
              clobWs.subscribe([window.upTokenId]);
              await sleep(1000);
              await mergeArbExecutor.sellRemainingShares(window.upTokenId, result.remainingUp, "Up");
            }
            if (result.remainingDn > 0 && winner !== "Down") {
              clobWs.subscribe([window.downTokenId]);
              await sleep(1000);
              await mergeArbExecutor.sellRemainingShares(window.downTokenId, result.remainingDn, "Down");
            }
            // Winning side remaining shares → redeemLoop handles at $1.00
          } else {
            logger.warn("No settlement price available, relying on redeemLoop for cleanup");
          }
        }

        // --- CLEANUP ---
        clobWs.clear();

        // Wait for next window (remaining time + buffer)
        const sleepUntilNext = Math.max(0, window.endTime - Date.now()) + 2000;
        if (sleepUntilNext > 0 && sleepUntilNext < 600_000) {
          await sleep(sleepUntilNext);
        }
      } catch (err) {
        logger.error("Merge-arb loop error", { error: (err as Error).message });
        telegram.alertError((err as Error).message);
        await sleep(5000);
      }
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
          if (now - last > REDEEM_COOLDOWN_SEC) eligible.push(pos);
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
    arbCompletion.reset();
    binance.stop();
    rtds.stop();
    clobWs.stop();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const strategyLoop = config.strategyMode === "merge-arb"
    ? mergeArbLoop
    : config.strategyMode === "webhook"
      ? webhookSignalLoop
      : hybridLoop;

  logger.info("Strategy mode", { mode: config.strategyMode });
  await Promise.all([strategyLoop(), redeemLoop()]);
};

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(`[config] ${err.message}`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
