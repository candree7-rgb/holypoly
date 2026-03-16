import { Side } from "@polymarket/clob-client";
import type { BookSnapshot, ClobWsClient } from "../data/clob-ws.js";
import type { ClobService } from "../data/clob.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { TelegramNotifier } from "../telegram.js";
import type { GridOrder, TradeSide, WindowInfo } from "../types.js";

/**
 * Reactive hedge monitor: watches prices after entry and automatically
 * hedges (buys opposite side) when the primary position drops by
 * a configurable trigger amount.
 *
 * Key mechanics:
 * - Listens to CLOB WS price updates in real-time
 * - If primary best bid drops ≥ triggerCents below entry price → hedge
 * - Hedge buys same number of shares on opposite side → locks in small loss
 * - Guaranteed loss = (entryPrice + hedgePrice - 100) × shares
 *
 * Example: Buy YES at 70¢ (2.857 shares for $2).
 *   Price drops to 67¢ → hedge trigger!
 *   Buy NO at 33¢ → 2.857 shares costs $0.94
 *   Total invested: $2.94, guaranteed payout: $2.857
 *   Locked loss: $0.086 (~4.3% of position)
 */
export class HedgeMonitor {
  private active = false;
  private hedged = false;
  private hedging = false; // lock to prevent concurrent hedge attempts
  private entryPriceCents = 0;
  private primarySide: TradeSide = "Up";
  private primaryTokenId = "";
  private hedgeTokenId = "";
  private primaryCostUsd = 0;
  private primaryShares = 0;
  private onHedgeCallback: ((orders: GridOrder[], orderIds: string[]) => void) | null = null;

  constructor(
    private clobWs: ClobWsClient,
    private clob: ClobService,
    private config: Config,
    private logger: Logger,
    private telegram: TelegramNotifier,
  ) {
    this.clobWs.onUpdate(this.onPriceUpdate.bind(this));
  }

  /**
   * Start monitoring a newly entered position.
   * Call this right after placing primary orders.
   */
  startMonitoring(params: {
    primarySide: TradeSide;
    entryPriceCents: number;
    primaryTokenId: string;
    hedgeTokenId: string;
    primaryCostUsd: number;
    primaryShares: number;
    onHedge: (orders: GridOrder[], orderIds: string[]) => void;
  }): void {
    this.active = true;
    this.hedged = false;
    this.hedging = false;
    this.primarySide = params.primarySide;
    this.entryPriceCents = params.entryPriceCents;
    this.primaryTokenId = params.primaryTokenId;
    this.hedgeTokenId = params.hedgeTokenId;
    this.primaryCostUsd = params.primaryCostUsd;
    this.primaryShares = params.primaryShares;
    this.onHedgeCallback = params.onHedge;

    const triggerPrice = params.entryPriceCents - this.config.hedgeTriggerCents;
    this.logger.info("Hedge monitor active", {
      side: params.primarySide,
      entry: `${params.entryPriceCents.toFixed(1)}¢`,
      trigger: `≤${triggerPrice.toFixed(1)}¢ (−${this.config.hedgeTriggerCents}¢)`,
      shares: params.primaryShares.toFixed(2),
      cost: `$${params.primaryCostUsd.toFixed(2)}`,
    });
  }

  /** Reset on window transition. */
  reset(): void {
    this.active = false;
    this.hedged = false;
    this.hedging = false;
    this.onHedgeCallback = null;
  }

  get isHedged(): boolean {
    return this.hedged;
  }

  get isActive(): boolean {
    return this.active;
  }

  /**
   * Called on every CLOB WS price update (real-time, sub-second).
   * Checks if hedge trigger is hit and fires hedge if so.
   */
  private onPriceUpdate(assetId: string, book: BookSnapshot): void {
    if (!this.active || this.hedged || this.hedging) return;
    if (assetId !== this.primaryTokenId) return;

    // Use best bid as the current exit value of our position
    const bestBid = book.bestBid;
    if (bestBid === null) return;

    const currentPriceCents = bestBid * 100;
    const drop = this.entryPriceCents - currentPriceCents;

    if (drop >= this.config.hedgeTriggerCents) {
      this.hedging = true;
      this.executeHedge(currentPriceCents).catch((err) => {
        this.logger.error("Hedge execution failed", { error: (err as Error).message });
        this.hedging = false;
      });
    }
  }

  /**
   * Place hedge order on opposite side with matching shares.
   * Locks in a small guaranteed loss instead of risking full position.
   */
  private async executeHedge(triggerPriceCents: number): Promise<void> {
    const hedgeSide: TradeSide = this.primarySide === "Up" ? "Down" : "Up";

    // Get opposite side best ask from WS book (or estimate from trigger price)
    const hedgeBook = this.clobWs.getBook(this.hedgeTokenId);
    const hedgePriceDecimal = hedgeBook?.bestAsk ?? (100 - triggerPriceCents) / 100;
    const hedgePriceCents = hedgePriceDecimal * 100;

    // Calculate locked-in loss: cost of both sides minus guaranteed $1/share payout
    const hedgeCostUsd = this.primaryShares * hedgePriceDecimal;
    const totalCost = this.primaryCostUsd + hedgeCostUsd;
    const guaranteedPayout = this.primaryShares; // shares × $1
    const lockedLoss = totalCost - guaranteedPayout;

    this.logger.info("HEDGE TRIGGERED!", {
      hedgeSide,
      entryPrice: `${this.entryPriceCents.toFixed(1)}¢`,
      triggerPrice: `${triggerPriceCents.toFixed(1)}¢`,
      drop: `${(this.entryPriceCents - triggerPriceCents).toFixed(1)}¢`,
      hedgePrice: `${hedgePriceCents.toFixed(1)}¢`,
      hedgeCost: `$${hedgeCostUsd.toFixed(2)}`,
      lockedLoss: `-$${lockedLoss.toFixed(2)}`,
      shares: this.primaryShares.toFixed(2),
    });

    const hedgeOrder: GridOrder = {
      side: hedgeSide,
      tokenId: this.hedgeTokenId,
      price: hedgePriceCents,
      amount: hedgeCostUsd,
    };

    let orderIds: string[] = [];

    if (!this.config.dryRun) {
      const result = await this.clob.placeBatchOrders([{
        tokenId: this.hedgeTokenId,
        side: Side.BUY,
        price: hedgePriceDecimal,
        size: this.primaryShares, // match shares for perfect hedge
      }]);
      orderIds = result.orderIds;

      if (result.placed === 0) {
        this.logger.warn("Hedge order failed to place!", { failed: result.failed });
        // Still mark as hedged to avoid retrying — we tried our best
      } else {
        this.logger.info("Hedge order placed", { placed: result.placed, orderIds });
      }
    } else {
      this.logger.info("DRY_RUN — hedge simulated", {
        side: hedgeSide,
        price: `${hedgePriceCents.toFixed(1)}¢`,
        amount: `$${hedgeCostUsd.toFixed(2)}`,
        shares: this.primaryShares.toFixed(2),
      });
    }

    this.hedged = true;
    this.hedging = false;

    // Telegram alert
    this.telegram.alertHedge(
      hedgeSide,
      this.entryPriceCents,
      triggerPriceCents,
      hedgePriceCents,
      lockedLoss,
    );

    // Notify main loop to update pendingTrade with hedge order + IDs
    if (this.onHedgeCallback) {
      this.onHedgeCallback([hedgeOrder], orderIds);
    }
  }
}
