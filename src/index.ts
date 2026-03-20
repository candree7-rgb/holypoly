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
import { RiskManager } from "./risk/limits.js";
import { TelegramNotifier } from "./telegram.js";
import { sleep, nowSec, polymarketFee } from "./utils.js";
import type { TradeSide, WindowInfo } from "./types.js";

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

  // Telegram
  const telegram = new TelegramNotifier(
    config.telegramBotToken,
    config.telegramChatId,
    logger,
  );

  logger.info("=== HolyPoly Convergence Arb Bot Starting ===");
  logger.info("Mode", { dryRun: config.dryRun });
  logger.info("Strategy", {
    approach: "Naked-first + Binance reversal detection",
    entryWindow: `${config.minEntryTimeRemaining}-${config.maxEntryTimeRemaining}s remaining`,
    minDelta: `${config.minNormalizedDelta}σ`,
    edgeThreshold: `${config.edgeThresholdCents}¢`,
    spikeFilter: `ratio > ${config.spikeRatioThreshold}`,
    minFairValue: `${config.minFairValueCents}¢`,
    nakedSafe: `fairValue >= ${config.nakedSafetyThreshold}¢`,
    exitPriority: "hedge > hold(+EV) > sell-back(−EV only)",
    reversalTrigger: `delta drop >= ${config.reversalDeltaDropPct}%`,
    opportunisticLoser: `≤${config.opportunisticLoserMaxCents}¢`,
  });
  logger.info("Risk", {
    buyAmountPct: `${config.buyAmountPct}%`,
    maxUnhedgedPct: `${config.maxUnhedgedPct}%`,
    dailyLossLimit: `${config.dailyLossLimitPct}%`,
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

  // Arb manager
  const arbManager = new ArbManager(
    {
      maxRoundTripsPerWindow: config.maxBuysPerWindow,
      maxUnhedgedPct: config.maxUnhedgedPct,
      maxWindowExposurePct: config.maxWindowExposurePct,
      minProfitCents: 1, // convergence: any profit is good
      emergencyBalanceAfterMs: 60000,
    },
    logger,
  );

  // Arb completion monitor — now with Binance + RTDS for reversal detection
  const arbCompletion = new ArbCompletionMonitor(
    clobWs,
    clob,
    config,
    arbManager,
    logger,
    telegram,
    volatilityCalc,
    fairValueEngine,
    binance,
    rtds,
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

  // Startup alert
  const startupBalance = await clob.getBalance();
  telegram.alertStartup(config.dryRun, startupBalance, config.buyAmountPct);

  // Track all order IDs per window for settlement
  let windowOrderIds: string[] = [];
  /** Order IDs that were filled as maker (0% fee on Polymarket crypto) */
  let makerOrderIds: Set<string> = new Set();
  let currentWindowInfo: WindowInfo | null = null;

  /**
   * Settle the window: calculate P&L from all positions.
   * Uses correct Polymarket crypto fee formula (NOT flat 2%).
   */
  const settleWindow = async (window: WindowInfo) => {
    const state = arbManager.getState();
    if (!state.upShares && !state.downShares) return;

    // === PRIMARY: Query Polymarket's own resolution data ===
    // This is THE authoritative source — not our calculation from external oracles.
    // Polymarket settles markets using their own Chainlink oracle, so we should
    // always defer to their resolution rather than guessing from Binance.
    let winner: TradeSide | null = null;
    let settlementSource = "unknown";

    // Try Polymarket API first (with retry — market may take a few seconds to resolve)
    for (let attempt = 0; attempt < 3; attempt++) {
      const resolution = await discovery.getMarketResolution(window.conditionId);
      if (resolution) {
        winner = resolution.winner;
        settlementSource = "polymarket-api";
        break;
      }
      if (attempt < 2) await sleep(2000); // Wait 2s between retries
    }

    // Fallback: calculate from oracle prices (ONLY if Polymarket API failed)
    if (!winner) {
      const settlementPrice = (!rtds.isStale ? rtds.price : null) ?? binance.price;
      if (settlementPrice === null) {
        logger.warn("No settlement price and Polymarket API unavailable, skipping P&L");
        return;
      }
      winner = settlementPrice > window.openingPrice ? "Up" : "Down";
      settlementSource = !rtds.isStale ? "chainlink-rtds" : "binance-fallback";
      logger.warn("Using oracle fallback for settlement — Polymarket API did not return resolution", {
        settlementSource,
        settlementPrice: settlementPrice.toFixed(2),
        openingPrice: window.openingPrice.toFixed(2),
      });
    }

    let totalPnl: number;

    const isLive = !config.dryRun && windowOrderIds.length > 0;
    if (isLive) {
      const fills = await clob.getOrderFills(windowOrderIds, window.conditionId);
      totalPnl = 0;
      let totalFees = 0;
      let makerFills = 0;
      for (const fill of fills) {
        if (fill.sizeMatched <= 0) continue;
        const fillSide: TradeSide =
          fill.tokenId === window.upTokenId ? "Up" : "Down";
        const won = fillSide === winner;
        // Maker orders have 0% fee on Polymarket crypto markets
        const isMaker = makerOrderIds.has(fill.orderID);
        const fee = isMaker ? 0 : polymarketFee(fill.sizeMatched, fill.price);
        if (isMaker) makerFills++;
        totalFees += fee;
        totalPnl += won
          ? (fill.sizeMatched - fill.costFilled - fee)
          : -(fill.costFilled + fee);
      }
      if (totalPnl === 0 && fills.every((f) => f.sizeMatched <= 0)) {
        logger.info("No fills this window, skipping settlement");
        return;
      }
      logger.debug("Fee impact", {
        totalFees: `$${totalFees.toFixed(4)}`,
        makerFills,
        takerFills: fills.length - makerFills,
        feeSaved: makerFills > 0 ? "yes (0% maker)" : "no",
      });
    } else {
      // Dry run: calculate from arb state with correct fee formula
      totalPnl = 0;
      const balanced = Math.min(state.upShares, state.downShares);
      if (balanced > 0) {
        const upProp = state.upShares > 0 ? balanced / state.upShares : 0;
        const downProp = state.downShares > 0 ? balanced / state.downShares : 0;
        const balancedCost = state.upCostUsd * upProp + state.downCostUsd * downProp;
        const avgUpPrice = state.upShares > 0 ? state.upCostUsd / state.upShares : 0;
        const avgDownPrice = state.downShares > 0 ? state.downCostUsd / state.downShares : 0;
        const upFee = polymarketFee(balanced, avgUpPrice);
        const downFee = polymarketFee(balanced, avgDownPrice);
        totalPnl += balanced - balancedCost - upFee - downFee;
      }
      // Unhedged portion
      const unhedged = Math.abs(state.upShares - state.downShares);
      if (unhedged > 0) {
        const unhedgedSide = state.upShares > state.downShares ? "Up" : "Down";
        const unhedgedWon = unhedgedSide === winner;
        const unhedgedCost = unhedgedSide === "Up"
          ? state.upCostUsd * (unhedged / state.upShares)
          : state.downCostUsd * (unhedged / state.downShares);
        const avgPrice = unhedgedSide === "Up"
          ? state.upCostUsd / state.upShares
          : state.downCostUsd / state.downShares;
        const fee = polymarketFee(unhedged, avgPrice);
        totalPnl += unhedgedWon
          ? (unhedged - unhedgedCost - fee)
          : -(unhedgedCost + fee);
      }
    }

    const prefix = config.dryRun ? "DRY_RUN SETTLEMENT" : "SETTLEMENT";
    logger.info(prefix, {
      winner,
      settlementSource,
      totalPnl: `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`,
      upShares: state.upShares.toFixed(1),
      downShares: state.downShares.toFixed(1),
      roundTrips: state.roundTrips,
      lockedProfit: `$${state.lockedProfit.toFixed(2)}`,
      btcOpen: window.openingPrice.toFixed(2),
    });

    // DB settlement
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
      logger.warn("Atomic settlement failed, using fallback");
      await riskManager.recordResult(totalPnl);
      await db.updateWindowSettlement(window.conditionId, totalPnl, winner);
    }

    riskManager.invalidateBalanceCache();
    // Use Binance price for memory delta (approximate) — winner is already authoritative from Polymarket
    const memoryDelta = (binance.price ?? 0) - window.openingPrice;
    windowMemory.recordOutcome(winner, memoryDelta);

    // === PnL SANITY CHECK: compare reported PnL against actual balance change ===
    if (!config.dryRun) {
      try {
        const postBalance = await clob.getBalance();
        const expectedBalance = startupBalance; // rough — should track pre-window balance
        logger.info("Balance check after settlement", {
          reportedPnl: `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`,
          currentBalance: `$${postBalance.toFixed(2)}`,
          settlementSource,
        });
      } catch {
        // Non-critical — don't fail settlement over balance check
      }
    }

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
    if (now < circuitBreakerUntil) return true;

    const vol = volatilityCalc.getVolatility();
    if (vol > 500) {
      const pauseMs = 60000;
      circuitBreakerUntil = now + pauseMs;
      logger.warn("CIRCUIT BREAKER — extreme flash crash", {
        volatility: `$${vol.toFixed(1)}`,
        pauseSeconds: 60,
      });
      telegram.alertCircuitBreaker(`Flash crash: $${vol.toFixed(0)} vol. Pausing 1 min.`);
      return true;
    }
    return false;
  };

  // === MAIN CONVERGENCE ARB LOOP ===
  const mainLoop = async () => {
    let lastStatusLog = 0;
    let currentWindowId: string | null = null;
    let entriesThisWindow = 0;

    while (true) {
      try {
        const now = Date.now();

        // Status log every 5 minutes
        if (now - lastStatusLog >= 300000) {
          await riskManager.logStatus();
          logger.info("Status", {
            binance: binance.connected,
            btcPrice: binance.price?.toFixed(2) ?? "N/A",
            chainlink: rtds.connected,
            chainlinkStale: rtds.isStale,
            clobWs: clobWs.connected,
            volatility: `$${volatilityCalc.getVolatility().toFixed(1)}`,
            regime: volatilityCalc.getRegime(),
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
          makerOrderIds = new Set();
          entriesThisWindow = 0;
          arbManager.reset(window.conditionId);
          arbCompletion.reset();

          // Subscribe CLOB WS to new window tokens
          clobWs.clear();
          clobWs.subscribe([window.upTokenId, window.downTokenId]);

          logger.info("New window", {
            conditionId: window.conditionId.slice(0, 16) + "...",
            start: new Date(window.startTime).toISOString().slice(11, 19),
            end: new Date(window.endTime).toISOString().slice(11, 19),
          });
        }

        // Set opening price: ONLY from Polymarket's "Price to Beat" (authoritative).
        // If Polymarket API doesn't provide it, we skip trading this window entirely.
        // Using Binance/Chainlink as opening price caused wrong edge detection and losses.
        if (window.openingPrice === 0) {
          const priceToBeat = await discovery.getPriceToBeat(window.conditionId);
          if (priceToBeat) {
            window.openingPrice = priceToBeat;
            windowManager.setOpeningPrice(priceToBeat);
            logger.info("Opening price from Polymarket API", { priceToBeat: priceToBeat.toFixed(2) });
          } else {
            // No authoritative opening price — log warning but do NOT trade
            // (edge calculation would be based on wrong reference price)
            logger.warn("No Price to Beat from Polymarket API — skipping trading this window", {
              conditionId: window.conditionId.slice(0, 16) + "...",
              binancePrice: binance.price?.toFixed(2) ?? "N/A",
            });
            // Don't set opening price → edge detector will reject with "No opening price yet"
          }
        }

        // Calculate time remaining
        const timeRemaining = (window.endTime - now) / 1000;

        // Handle window end
        if (now >= window.endTime && currentWindowInfo) {
          arbCompletion.reset();
          await settleWindow(currentWindowInfo);
          currentWindowId = null;
          currentWindowInfo = null;
          await sleep(config.scanIntervalMs);
          continue;
        }

        // Need opening price and Binance price for everything
        if (window.openingPrice === 0) {
          await sleep(config.scanIntervalMs);
          continue;
        }

        const btcPrice = binance.price;
        if (!btcPrice) {
          await sleep(config.scanIntervalMs);
          continue;
        }

        // Circuit breaker
        if (checkCircuitBreaker()) {
          await sleep(config.scanIntervalMs);
          continue;
        }

        // If arb completion is monitoring a position, feed it updates
        if (arbCompletion.isActive) {
          arbCompletion.updateBtcPrice(btcPrice, timeRemaining);
          await sleep(config.scanIntervalMs);
          continue;
        }

        // Max entries per window
        if (entriesThisWindow >= config.maxBuysPerWindow) {
          await sleep(config.scanIntervalMs);
          continue;
        }

        // Check if ArbManager allows new entry
        const balance = await riskManager.getBalance();

        if (arbManager.isOverExposed(balance)) {
          await sleep(config.scanIntervalMs);
          continue;
        }

        const arbCheck = arbManager.canEnterNewTrade(balance);
        if (!arbCheck.allowed) {
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

        // *** CORE: Evaluate edge for convergence entry ***
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

        // === BUY WINNER SIDE (Limit → FOK fallback) ===
        logger.info("EDGE DETECTED — buying winner", {
          side: decision.primarySide,
          edge: `${decision.bestEdge.toFixed(1)}¢`,
          fairUp: decision.fairUp,
          delta: `${decision.normalizedDelta.toFixed(2)}σ`,
          confidence: `${(decision.confidence * 100).toFixed(0)}%`,
          regime: decision.regime,
          timeLeft: `${timeRemaining.toFixed(0)}s`,
          amount: `$${decision.buyAmountUsd.toFixed(2)}`,
          strategy: "limit-maker → FOK-fallback",
        });

        let orderIds: string[] = [];
        let totalCost = 0;
        let totalShares = 0;
        let entryWasMaker = false;
        const entryPrice = decision.winnerAskCents / 100;
        const estimatedShares = decision.buyAmountUsd / entryPrice;

        if (!config.dryRun) {
          // Try limit order first (maker = 0% fee), fallback to FOK (taker) after 1.5s
          const result = await clob.placeLimitThenFOK({
            tokenId: decision.winnerTokenId,
            side: Side.BUY,
            price: entryPrice,
            size: estimatedShares,
            timeoutMs: 1500,
          });

          if (!result.filled) {
            logger.info("Order not filled — edge evaporated, skipping");
            await sleep(config.scanIntervalMs);
            continue;
          }

          entryWasMaker = result.maker;
          orderIds = result.orderIds;
          windowOrderIds.push(...orderIds);
          // Track maker orders for 0% fee at settlement
          if (entryWasMaker) {
            for (const id of orderIds) makerOrderIds.add(id);
          }

          // Get actual fill prices
          const fills = await clob.getOrderFills(orderIds, window.conditionId);
          if (fills.length > 0) {
            for (const f of fills) {
              totalShares += f.sizeMatched;
              totalCost += f.costFilled;
            }
          } else {
            // Fallback to estimated prices
            totalShares = decision.buyAmountUsd / (decision.winnerAskCents / 100);
            totalCost = decision.buyAmountUsd;
          }
        } else {
          totalShares = decision.buyAmountUsd / (decision.winnerAskCents / 100);
          totalCost = decision.buyAmountUsd;
          logger.info("DRY_RUN — winner entry simulated", {
            side: decision.primarySide,
            price: `${decision.winnerAskCents}¢`,
            shares: totalShares.toFixed(2),
            cost: `$${totalCost.toFixed(2)}`,
          });
        }

        // Record fill
        arbManager.recordFill(decision.primarySide, totalShares, totalCost);
        arbManager.setEntryTime();
        entriesThisWindow++;

        const avgEntry = totalShares > 0 ? (totalCost / totalShares) * 100 : 0;

        // Record to database
        await db.recordWindow({
          windowStart: window.startTime,
          conditionId: window.conditionId,
          traded: true,
          primarySide: decision.primarySide,
          orders: [{
            side: decision.primarySide,
            tokenId: decision.winnerTokenId,
            price: avgEntry,
            amount: totalCost,
          }],
          fillCount: 1,
          pnl: null,
          winner: null,
          balanceBefore: balance,
          balanceAfter: null,
        });

        // === START CONVERGENCE MONITORING ===
        arbCompletion.startSeeking({
          winnerSide: decision.primarySide,
          winnerAvgPriceCents: avgEntry,
          winnerShares: totalShares,
          winnerTokenId: decision.winnerTokenId,
          loserTokenId: decision.loserTokenId,
          window,
          currentBtcPrice: btcPrice,
          timeRemainingSeconds: timeRemaining,
          onComplete: (side, shares, costUsd, loserOrderIds, soldBack, loserMaker) => {
            if (soldBack) {
              // Winner was sold back — clear it from arbManager
              arbManager.recordSellBack(decision.primarySide, totalShares);
              windowOrderIds.push(...loserOrderIds);
              logger.info("Arb completion — SELL-BACK executed", {
                soldSide: decision.primarySide,
                shares: totalShares.toFixed(2),
              });
            } else {
              arbManager.recordFill(side, shares, costUsd);
              windowOrderIds.push(...loserOrderIds);
              // Track maker fills for 0% fee at settlement
              if (loserMaker) {
                for (const id of loserOrderIds) makerOrderIds.add(id);
              }

              const state = arbManager.getState();
              if (shares > 0) {
                const avgLoserCents = (costUsd / shares) * 100;
                logger.info("Arb completion — loser filled (hedged)", {
                  side,
                  shares: shares.toFixed(2),
                  cost: `$${costUsd.toFixed(2)}`,
                  pairCost: `${(avgEntry + avgLoserCents).toFixed(1)}¢`,
                  lockedProfit: `$${state.lockedProfit.toFixed(2)}`,
                });
              } else {
                logger.info("Arb completion — naked hold to settlement", {
                  upShares: state.upShares.toFixed(1),
                  downShares: state.downShares.toFixed(1),
                });
              }
            }

            telegram.alertEdgeEntry(
              `${decision.primarySide} CONVERGENCE`,
              decision.bestEdge,
              decision.fairUp,
              decision.regime,
              decision.confidence,
              totalCost + costUsd,
              shares > 0 ? 2 : 1,
            );
          },
        });

        await sleep(1000);
      } catch (err) {
        logger.error("Main loop error", { error: (err as Error).message });
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

  await Promise.all([mainLoop(), redeemLoop()]);
};

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(`[config] ${err.message}`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
