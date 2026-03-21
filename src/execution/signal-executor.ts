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
  /** Seconds into the target window before placing FOK fallback */
  fokFallbackAfterSec: number;
  /** Max price (cents) for FOK fallback */
  fokMaxPriceCents: number;
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
  fokFallbackAfterSec: 240, // 4 min into the window
  fokMaxPriceCents: 52,     // 52¢ + 2% taker fee = 53.04¢ effective — max acceptable
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
    fokSent: boolean;
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

      // Not yet time for the target window? Wait.
      if (nowSec < signal.targetWindowStartSec - 5) {
        return null; // main loop will sleep
      }

      // Try to find the target market
      const window = await this.discovery.findMarketByTimestamp(
        signal.targetWindowStartSec,
        signal.asset,
      );

      if (!window) {
        // Market not available yet — keep polling
        if (nowSec < signal.targetWindowStartSec + 30) {
          this.logger.debug("Waiting for target market", {
            targetStart: signal.targetWindowStartSec,
            secsSinceTarget: nowSec - signal.targetWindowStartSec,
          });
          return null;
        }
        // Gave up after 30s
        this.logger.warn("Target market not found after 30s, aborting signal");
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
        fokSent: false,
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

      // FOK fallback: if not enough filled and past the threshold
      if (
        !exec.fokSent &&
        windowElapsedSec >= this.config.fokFallbackAfterSec &&
        exec.totalShares < 1 // minimum viable position
      ) {
        await this.placeFokFallback(currentBalance);
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

    for (let i = 0; i < this.config.ladderPricesCents.length; i++) {
      const priceCents = this.config.ladderPricesCents[i];
      const weight = this.config.ladderWeights[i] ?? (1 / this.config.ladderPricesCents.length);
      const amountUsd = totalBuyUsd * weight;
      const priceDecimal = priceCents / 100;
      const size = amountUsd / priceDecimal; // shares = USD / price

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
   * FOK fallback for unfilled portion.
   * Uses taker (2% fee) but ensures we have a position.
   */
  private async placeFokFallback(balance: number): Promise<void> {
    if (!this.activeExecution) return;
    const exec = this.activeExecution;

    // Cancel remaining GTC orders first
    for (const orderId of exec.orderIds) {
      await this.clob.cancelOrder(orderId);
    }

    const totalBuyUsd = balance * this.config.buyAmountPct / 100;
    const alreadySpent = exec.totalCostUsd;
    const remainingUsd = Math.max(0, totalBuyUsd - alreadySpent);

    if (remainingUsd < 1) {
      this.logger.info("Ladder fills sufficient, skipping FOK fallback");
      exec.fokSent = true;
      return;
    }

    const tokenId = exec.signal.direction === "Up"
      ? exec.window.upTokenId
      : exec.window.downTokenId;

    const worstPrice = this.config.fokMaxPriceCents / 100;

    this.logger.info("FOK fallback (taker 2% fee)", {
      remainingUsd: `$${remainingUsd.toFixed(2)}`,
      maxPrice: `${this.config.fokMaxPriceCents}¢`,
    });

    const fokResult = await this.clob.placeMarketOrderFOK({
      tokenId,
      side: Side.BUY,
      amount: remainingUsd,
      worstPrice,
    });

    exec.fokSent = true;

    if (fokResult.filled) {
      exec.orderIds.push(...fokResult.orderIds);
      exec.takerFills++;
      // Fills will be picked up on next updateFills()
      this.logger.info("FOK fallback filled");
    } else {
      this.logger.warn("FOK fallback not filled — holding partial or no position");
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

    // Cancel any remaining GTC orders
    if (!exec.fokSent) {
      for (const orderId of exec.orderIds) {
        await this.clob.cancelOrder(orderId);
      }
    }

    // Final fill update
    await this.updateFills();

    const avgPriceCents = exec.totalShares > 0
      ? (exec.totalCostUsd / exec.totalShares) * 100
      : 0;

    // Estimate fees: maker fills = 0%, taker fills = 2%
    // For simplicity, all GTC fills are maker (0%), FOK fills are taker (2%)
    const makerCost = exec.fokSent
      ? Math.max(0, exec.totalCostUsd - (exec.totalCostUsd * (exec.takerFills / Math.max(1, exec.makerFills + exec.takerFills))))
      : exec.totalCostUsd;
    const takerCost = exec.totalCostUsd - makerCost;
    const estimatedFees = makerCost * this.config.makerFeeRate + takerCost * this.config.takerFeeRate;

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
