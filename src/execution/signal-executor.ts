import { Side, OrderType } from "@polymarket/clob-client";
import type { Logger } from "../logger.js";
import type { TelegramNotifier } from "../telegram.js";
import type { ClobService } from "../data/clob.js";
import type { MarketDiscovery } from "../data/gamma.js";
import type { WindowInfo, TradeSide } from "../types.js";
import { sleep } from "../utils.js";

/**
 * SignalExecutor: Webhook-driven GTC limit ladder with FOK fallback.
 *
 * Flow:
 * 1. Webhook delivers UP/DOWN signal at current 5-min boundary (e.g. 13:10:02)
 * 2. We compute the NEXT window start (13:15:00) and target that market
 * 3. Poll until that market is available on CLOB
 * 4. Place GTC limit ladder at 48-50¢ (maker = 0% fee)
 * 5. Monitor fills for ~4 minutes
 * 6. At T+4:00 into the window, FOK fallback at 51-52¢ for unfilled remainder
 * 7. Hold naked until settlement
 */

export interface SignalExecutorConfig {
  /** Price ladder for GTC limit orders (cents, ascending) */
  ladderPricesCents: number[];
  /** How to distribute size across ladder levels (fractions, must sum to 1) */
  ladderWeights: number[];
  /** Seconds into the target window before placing GTC fallback at max price */
  fallbackAfterSec: number;
  /** Max price (cents) for GTC fallback order */
  fallbackMaxPriceCents: number;
  /** Total buy amount as % of balance */
  buyAmountPct: number;
  /** How often (ms) to poll for fills */
  fillPollIntervalMs: number;
  /** Maker fee rate (typically 0 on Polymarket) */
  makerFeeRate: number;
  /** Taker fee rate (typically 0.02 on Polymarket crypto) */
  takerFeeRate: number;
}

export const DEFAULT_SIGNAL_CONFIG: SignalExecutorConfig = {
  ladderPricesCents: [49, 50, 51],
  ladderWeights: [0.25, 0.40, 0.35], // 25% at 49¢, 40% at 50¢, 35% at 51¢
  fallbackAfterSec: 240, // 4 min into the window
  fallbackMaxPriceCents: 52, // 52¢ + 0% maker = 52¢ effective
  buyAmountPct: 4,
  fillPollIntervalMs: 5000,
  makerFeeRate: 0,
  takerFeeRate: 0.02,
};

export interface PendingSignal {
  direction: TradeSide;
  asset: "btc" | "eth";
  /** When the signal was received */
  receivedAt: number;
  /** The target window start timestamp (unix seconds) */
  targetWindowStartSec: number;
}

export interface SignalResult {
  success: boolean;
  direction: TradeSide;
  asset: string;
  totalShares: number;
  totalCostUsd: number;
  avgPriceCents: number;
  makerFills: number;
  takerFills: number;
  estimatedFees: number;
  orderIds: string[];
  conditionId: string;
  windowStart: number;
  windowEnd: number;
}

export class SignalExecutor {
  private pendingSignal: PendingSignal | null = null;
  private activeExecution: {
    signal: PendingSignal;
    window: WindowInfo;
    orderIds: string[];
    totalShares: number;
    totalCostUsd: number;
    makerFills: number;
    takerFills: number;
    fallbackSent: boolean;
  } | null = null;

  constructor(
    private clob: ClobService,
    private discovery: MarketDiscovery,
    private config: SignalExecutorConfig,
    private logger: Logger,
    private telegram: TelegramNotifier,
  ) {}

  /**
   * Called when webhook receives a signal.
   * Computes the next 5-min window and queues the signal.
   */
  queueSignal(direction: TradeSide, asset: "btc" | "eth" = "btc"): PendingSignal {
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);
    const windowSize = 300;

    // Current window start (rounded down)
    const currentWindowStart = Math.floor(nowSec / windowSize) * windowSize;
    // Target is the NEXT window
    const targetWindowStartSec = currentWindowStart + windowSize;

    const signal: PendingSignal = {
      direction,
      asset,
      receivedAt: now,
      targetWindowStartSec,
    };

    this.pendingSignal = signal;

    const targetTime = new Date(targetWindowStartSec * 1000).toISOString().slice(11, 19);
    this.logger.info("Signal queued for next window", {
      direction,
      asset,
      targetWindow: targetTime,
      secsUntilTarget: targetWindowStartSec - nowSec,
    });

    this.telegram.send(
      `Signal: ${direction.toUpperCase()} ${asset.toUpperCase()} → target window ${targetTime}`,
    );

    return signal;
  }

  /** Check if there's a pending signal waiting for its target window */
  get hasPendingSignal(): boolean {
    return this.pendingSignal !== null;
  }

  /** Check if there's an active execution (orders placed, monitoring fills) */
  get hasActiveExecution(): boolean {
    return this.activeExecution !== null;
  }

  /** Get the active execution's window info (for settlement) */
  get activeWindow(): WindowInfo | null {
    return this.activeExecution?.window ?? null;
  }

  /** Get the active execution's direction */
  get activeDirection(): TradeSide | null {
    return this.activeExecution?.signal.direction ?? null;
  }

  /** Get all order IDs from the active execution */
  get activeOrderIds(): string[] {
    return this.activeExecution?.orderIds ?? [];
  }

  /**
   * Main tick — called from the main loop.
   * Handles the full lifecycle: wait → place ladder → monitor → fallback.
   *
   * Returns a SignalResult when the execution is complete (filled or window ending).
   */
  async tick(currentBalance: number): Promise<SignalResult | null> {
    const now = Date.now();
    const nowSec = Math.floor(now / 1000);

    // === Phase 1: Pending signal → wait for target window to become available ===
    if (this.pendingSignal && !this.activeExecution) {
      const signal = this.pendingSignal;

      // Expire signal if too old (> 6 minutes — missed the window)
      if (nowSec > signal.targetWindowStartSec + 360) {
        this.logger.warn("Signal expired — target window missed", {
          direction: signal.direction,
          targetWindowStart: signal.targetWindowStartSec,
        });
        this.pendingSignal = null;
        return null;
      }

      // Try to find the target market immediately — CLOB is open well before
      // the 5-min window starts. Placing GTC early = better queue position.
      const window = await this.discovery.findMarketByTimestamp(
        signal.targetWindowStartSec,
        signal.asset,
      );

      if (!window) {
        // Market not on CLOB yet — keep polling (markets appear ~30min before start)
        if (nowSec < signal.targetWindowStartSec + 30) {
          this.logger.debug("Waiting for target market on CLOB", {
            targetStart: signal.targetWindowStartSec,
            secsUntilTarget: signal.targetWindowStartSec - nowSec,
          });
          return null;
        }
        // Gave up after window start + 30s
        this.logger.warn("Target market not found after 30s past start, aborting signal");
        this.pendingSignal = null;
        return null;
      }

      // Market found! Place the GTC limit ladder
      this.logger.info("Target market found — placing GTC limit ladder", {
        direction: signal.direction,
        asset: signal.asset,
        conditionId: window.conditionId.slice(0, 16) + "...",
        ladder: this.config.ladderPricesCents.join("/") + "¢",
      });

      const orderIds = await this.placeLadder(signal, window, currentBalance);

      this.activeExecution = {
        signal,
        window,
        orderIds,
        totalShares: 0,
        totalCostUsd: 0,
        makerFills: 0,
        takerFills: 0,
        fallbackSent: false,
      };

      this.pendingSignal = null;
      return null; // will monitor fills on next tick
    }

    // === Phase 2: Active execution → monitor fills and apply fallback ===
    if (this.activeExecution) {
      const exec = this.activeExecution;
      const windowElapsedSec = (now - exec.window.startTime) / 1000;
      const windowRemainingSec = (exec.window.endTime - now) / 1000;

      // Window ended? Finalize.
      if (windowRemainingSec <= 0) {
        return this.finalize();
      }

      // Check fills
      await this.updateFills();

      // GTC fallback: if nothing filled and we're past threshold into the window
      // Only triggers after the window has actually started (windowElapsedSec > 0)
      if (
        !exec.fallbackSent &&
        windowElapsedSec > 0 &&
        windowElapsedSec >= this.config.fallbackAfterSec &&
        exec.totalShares < 1 // minimum viable position
      ) {
        await this.placeGtcFallback(currentBalance);
      }

      // If window is about to end (< 10s), finalize early for clean settlement
      if (windowRemainingSec <= 10) {
        return this.finalize();
      }

      return null; // keep monitoring
    }

    return null;
  }

  /**
   * Place GTC limit order ladder.
   * Orders rest on the book → maker → 0% fee.
   */
  private async placeLadder(
    signal: PendingSignal,
    window: WindowInfo,
    balance: number,
  ): Promise<string[]> {
    const tokenId = signal.direction === "Up"
      ? window.upTokenId
      : window.downTokenId;

    const totalBuyUsd = balance * this.config.buyAmountPct / 100;
    const orders: Array<{ tokenId: string; side: Side; price: number; size: number }> = [];

    // First pass: find which levels meet the 5-share minimum
    const validLevels: Array<{ priceCents: number; weight: number }> = [];
    for (let i = 0; i < this.config.ladderPricesCents.length; i++) {
      const priceCents = this.config.ladderPricesCents[i];
      const weight = this.config.ladderWeights[i] ?? (1 / this.config.ladderPricesCents.length);
      const size = (totalBuyUsd * weight) / (priceCents / 100);
      if (size >= 5) {
        validLevels.push({ priceCents, weight });
      } else {
        this.logger.debug("Skipping ladder level below 5-share minimum", {
          price: `${priceCents}¢`, size: size.toFixed(1),
        });
      }
    }

    // Redistribute weights across valid levels
    const totalWeight = validLevels.reduce((s, l) => s + l.weight, 0);

    for (const level of validLevels) {
      const adjustedWeight = totalWeight > 0 ? level.weight / totalWeight : 0;
      const amountUsd = totalBuyUsd * adjustedWeight;
      const priceDecimal = level.priceCents / 100;
      const size = amountUsd / priceDecimal;

      orders.push({
        tokenId,
        side: Side.BUY,
        price: priceDecimal,
        size,
      });
    }

    this.logger.info("Placing GTC limit ladder (maker 0% fee)", {
      direction: signal.direction,
      totalBuyUsd: `$${totalBuyUsd.toFixed(2)}`,
      levels: orders.map((o) =>
        `${(o.price * 100).toFixed(0)}¢ × ${o.size.toFixed(1)} shares ($${(o.size * o.price).toFixed(2)})`
      ),
    });

    const result = await this.clob.placeBatchOrders(orders, OrderType.GTC);

    this.logger.info("Ladder placed", {
      placed: result.placed,
      failed: result.failed,
      orderIds: result.orderIds.length,
    });

    return result.orderIds;
  }

  /**
   * GTC fallback for unfilled portion.
   * Cancels lower ladder orders and places a single GTC at the fallback price.
   * Still maker = 0% fee (much better than FOK at 2% taker).
   */
  private async placeGtcFallback(balance: number): Promise<void> {
    if (!this.activeExecution) return;
    const exec = this.activeExecution;

    // Cancel remaining unfilled GTC orders (lower prices that didn't fill)
    for (const orderId of exec.orderIds) {
      await this.clob.cancelOrder(orderId);
    }

    // Re-check fills after cancellation
    await this.updateFills();

    const totalBuyUsd = balance * this.config.buyAmountPct / 100;
    const alreadySpent = exec.totalCostUsd;
    const remainingUsd = Math.max(0, totalBuyUsd - alreadySpent);

    if (remainingUsd < 1) {
      this.logger.info("Ladder fills sufficient, skipping fallback");
      exec.fallbackSent = true;
      return;
    }

    const tokenId = exec.signal.direction === "Up"
      ? exec.window.upTokenId
      : exec.window.downTokenId;

    const fallbackPrice = this.config.fallbackMaxPriceCents / 100; // e.g. 0.52

    this.logger.info("GTC fallback at max price (maker 0% fee)", {
      remainingUsd: `$${remainingUsd.toFixed(2)}`,
      price: `${this.config.fallbackMaxPriceCents}¢`,
    });

    const size = remainingUsd / fallbackPrice;

    const result = await this.clob.placeBatchOrders(
      [{ tokenId, side: Side.BUY, price: fallbackPrice, size }],
      OrderType.GTC,
    );

    exec.fallbackSent = true;

    if (result.placed > 0) {
      exec.orderIds.push(...result.orderIds);
      exec.makerFills++; // still maker!
      this.logger.info("GTC fallback placed", { size: size.toFixed(1) });
    } else {
      this.logger.warn("GTC fallback failed to place");
    }
  }

  /**
   * Query actual fills from the API and update execution state.
   */
  private async updateFills(): Promise<void> {
    if (!this.activeExecution || this.activeExecution.orderIds.length === 0) return;
    const exec = this.activeExecution;

    const fills = await this.clob.getOrderFills(
      exec.orderIds,
      exec.window.conditionId,
    );

    let totalShares = 0;
    let totalCost = 0;
    let makerFills = 0;

    for (const fill of fills) {
      if (fill.sizeMatched > 0) {
        totalShares += fill.sizeMatched;
        totalCost += fill.costFilled;
        makerFills++;
      }
    }

    // Log if fills changed
    if (Math.abs(totalShares - exec.totalShares) > 0.01) {
      this.logger.info("Fill update", {
        shares: totalShares.toFixed(2),
        cost: `$${totalCost.toFixed(2)}`,
        avgPrice: totalShares > 0 ? `${((totalCost / totalShares) * 100).toFixed(1)}¢` : "N/A",
        fills: fills.length,
      });
    }

    exec.totalShares = totalShares;
    exec.totalCostUsd = totalCost;
    exec.makerFills = makerFills;
  }

  /**
   * Finalize execution — cancel remaining orders, return result.
   */
  private async finalize(): Promise<SignalResult> {
    const exec = this.activeExecution!;

    // Cancel any remaining unfilled GTC orders
    for (const orderId of exec.orderIds) {
      await this.clob.cancelOrder(orderId);
    }

    // Final fill update
    await this.updateFills();

    const avgPriceCents = exec.totalShares > 0
      ? (exec.totalCostUsd / exec.totalShares) * 100
      : 0;

    // All orders are GTC (maker = 0% fee) — no taker fees in this strategy
    const estimatedFees = exec.totalCostUsd * this.config.makerFeeRate;

    const result: SignalResult = {
      success: exec.totalShares > 0,
      direction: exec.signal.direction,
      asset: exec.signal.asset,
      totalShares: exec.totalShares,
      totalCostUsd: exec.totalCostUsd,
      avgPriceCents,
      makerFills: exec.makerFills,
      takerFills: exec.takerFills,
      estimatedFees,
      orderIds: exec.orderIds,
      conditionId: exec.window.conditionId,
      windowStart: exec.window.startTime,
      windowEnd: exec.window.endTime,
    };

    this.logger.info("Signal execution finalized", {
      direction: result.direction,
      asset: result.asset,
      shares: result.totalShares.toFixed(2),
      cost: `$${result.totalCostUsd.toFixed(2)}`,
      avgPrice: `${result.avgPriceCents.toFixed(1)}¢`,
      fees: `$${result.estimatedFees.toFixed(4)}`,
      success: result.success,
    });

    if (result.success) {
      this.telegram.send(
        `Filled: ${result.direction} ${result.asset.toUpperCase()} ` +
        `${result.totalShares.toFixed(1)} shares @ ${result.avgPriceCents.toFixed(1)}¢ ` +
        `($${result.totalCostUsd.toFixed(2)}, fees ~$${result.estimatedFees.toFixed(3)})`,
      );
    }

    this.activeExecution = null;
    return result;
  }

  /** Reset everything (e.g. on shutdown) */
  reset(): void {
    this.pendingSignal = null;
    this.activeExecution = null;
  }
}
