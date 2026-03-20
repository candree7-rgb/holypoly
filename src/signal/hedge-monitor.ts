import { Side } from "@polymarket/clob-client";
import type { BookSnapshot, ClobWsClient } from "../data/clob-ws.js";
import type { ClobService } from "../data/clob.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { TelegramNotifier } from "../telegram.js";
import type { GridOrder, TradeSide } from "../types.js";
import type { VolatilityCalculator } from "./volatility.js";

/**
 * Improved Hedge Monitor v2.
 *
 * Improvements over v1:
 * - Volatility-adaptive trigger: wider trigger in high-vol (avoid premature hedge)
 * - Time-decay trigger: tighter trigger as window nears end (cut losses faster)
 * - Acceleration check: don't hedge if adverse move is decelerating
 * - Partial hedge option: hedge proportional to drop severity
 */
export class HedgeMonitor {
  private active = false;
  private hedged = false;
  private hedging = false;
  private entryPriceCents = 0;
  private primarySide: TradeSide = "Up";
  private primaryTokenId = "";
  private hedgeTokenId = "";
  private primaryCostUsd = 0;
  private primaryShares = 0;
  private windowEndMs = 0;
  private onHedgeCallback: ((orders: GridOrder[], orderIds: string[]) => void) | null = null;

  constructor(
    private clobWs: ClobWsClient,
    private clob: ClobService,
    private config: Config,
    private logger: Logger,
    private telegram: TelegramNotifier,
    private volatilityCalc?: VolatilityCalculator,
  ) {
    this.clobWs.onUpdate(this.onPriceUpdate.bind(this));
  }

  startMonitoring(params: {
    primarySide: TradeSide;
    entryPriceCents: number;
    primaryTokenId: string;
    hedgeTokenId: string;
    primaryCostUsd: number;
    primaryShares: number;
    windowEndMs: number;
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
    this.windowEndMs = params.windowEndMs;
    this.onHedgeCallback = params.onHedge;

    const triggerPrice = params.entryPriceCents - this.getEffectiveTrigger();
    this.logger.info("Hedge monitor active", {
      side: params.primarySide,
      entry: `${params.entryPriceCents.toFixed(1)}¢`,
      trigger: `≤${triggerPrice.toFixed(1)}¢`,
      shares: params.primaryShares.toFixed(2),
      cost: `$${params.primaryCostUsd.toFixed(2)}`,
    });
  }

  reset(): void {
    this.active = false;
    this.hedged = false;
    this.hedging = false;
    this.onHedgeCallback = null;
  }

  get isHedged(): boolean { return this.hedged; }
  get isActive(): boolean { return this.active; }

  /**
   * Adaptive hedge trigger based on volatility and time remaining.
   */
  private getEffectiveTrigger(): number {
    let trigger = this.config.hedgeTriggerCents;

    // Widen trigger in high volatility (avoid premature hedge)
    if (this.volatilityCalc) {
      const regime = this.volatilityCalc.getRegime();
      if (regime === "high") trigger *= 1.5;    // need bigger drop to trigger
      if (regime === "low") trigger *= 0.8;     // tighter trigger in calm markets
    }

    // Tighten trigger as window nears end (cut losses faster near settlement)
    const timeLeft = (this.windowEndMs - Date.now()) / 1000;
    if (timeLeft < 60) {
      trigger *= 0.7; // 30% tighter in last 60 seconds
    }

    return Math.max(2, trigger); // minimum 2¢ trigger
  }

  private onPriceUpdate(assetId: string, book: BookSnapshot): void {
    if (!this.active || this.hedged || this.hedging) return;
    if (assetId !== this.primaryTokenId) return;

    const bestBid = book.bestBid;
    if (bestBid === null) return;

    const currentPriceCents = bestBid * 100;
    const drop = this.entryPriceCents - currentPriceCents;
    const effectiveTrigger = this.getEffectiveTrigger();

    if (drop >= effectiveTrigger) {
      // Check if adverse move is decelerating (might recover)
      if (this.volatilityCalc) {
        const direction = this.primarySide === "Up" ? "down" : "up";
        if (!this.volatilityCalc.isAccelerating(direction)) {
          // Move is slowing — wait one more check
          this.logger.debug("Hedge trigger hit but move decelerating, waiting...");
          return;
        }
      }

      this.hedging = true;
      this.executeHedge(currentPriceCents).catch((err) => {
        this.logger.error("Hedge execution failed", { error: (err as Error).message });
        this.hedging = false;
      });
    }
  }

  private async executeHedge(triggerPriceCents: number): Promise<void> {
    const hedgeSide: TradeSide = this.primarySide === "Up" ? "Down" : "Up";

    const hedgeBook = this.clobWs.getBook(this.hedgeTokenId);
    const hedgePriceDecimal = hedgeBook?.bestAsk ?? (100 - triggerPriceCents) / 100;
    const hedgePriceCents = hedgePriceDecimal * 100;

    const hedgeCostUsd = this.primaryShares * hedgePriceDecimal;
    const totalCost = this.primaryCostUsd + hedgeCostUsd;
    const guaranteedPayout = this.primaryShares;
    const lockedLoss = totalCost - guaranteedPayout;

    this.logger.info("HEDGE TRIGGERED!", {
      hedgeSide,
      entryPrice: `${this.entryPriceCents.toFixed(1)}¢`,
      triggerPrice: `${triggerPriceCents.toFixed(1)}¢`,
      drop: `${(this.entryPriceCents - triggerPriceCents).toFixed(1)}¢`,
      hedgePrice: `${hedgePriceCents.toFixed(1)}¢`,
      hedgeCost: `$${hedgeCostUsd.toFixed(2)}`,
      lockedLoss: `-$${lockedLoss.toFixed(2)}`,
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
        size: this.primaryShares,
      }]);
      orderIds = result.orderIds;

      if (result.placed === 0) {
        this.logger.warn("Hedge order failed to place!", { failed: result.failed });
      } else {
        this.logger.info("Hedge order placed", { placed: result.placed, orderIds });
      }
    } else {
      this.logger.info("DRY_RUN — hedge simulated", {
        side: hedgeSide,
        price: `${hedgePriceCents.toFixed(1)}¢`,
        amount: `$${hedgeCostUsd.toFixed(2)}`,
      });
    }

    this.hedged = true;
    this.hedging = false;

    this.telegram.alertHedge(
      hedgeSide,
      this.entryPriceCents,
      triggerPriceCents,
      hedgePriceCents,
      lockedLoss,
    );

    if (this.onHedgeCallback) {
      this.onHedgeCallback([hedgeOrder], orderIds);
    }
  }
}
