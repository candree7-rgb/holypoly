import { Side } from "@polymarket/clob-client";
import type { BookSnapshot, ClobWsClient } from "../data/clob-ws.js";
import type { ClobService } from "../data/clob.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { TelegramNotifier } from "../telegram.js";
import type { TradeSide, WindowInfo } from "../types.js";
import type { ArbManager } from "./arb-manager.js";
import type { VolatilityCalculator } from "../signal/volatility.js";

/**
 * ArbCompletionMonitor: Proactively seeks the loser side to lock in profit.
 *
 * After a winner entry, this monitor:
 * 1. Calculates the target loser price for guaranteed profit
 * 2. Watches CLOB WS for the loser side to reach that price
 * 3. Places aggressive limit orders to complete the arb
 * 4. Falls back to emergency balancing if timeout exceeded
 *
 * This replaces the old defensive HedgeMonitor with a PROACTIVE approach:
 * - Old: wait for primary to drop, then hedge defensively
 * - New: actively seek opposite side at profit-locking price
 */

export type ArbCompletionCallback = (side: TradeSide, shares: number, costUsd: number, orderIds: string[]) => void;

interface MonitorState {
  active: boolean;
  winnerSide: TradeSide;
  winnerAvgPriceCents: number;
  winnerShares: number;
  loserTokenId: string;
  loserTargetPriceCents: number;
  emergencyPriceCents: number;
  startedAt: number;
  orderPlaced: boolean;
  orderId: string | null;
  phase: "watching" | "ordered" | "emergency" | "done";
}

export class ArbCompletionMonitor {
  private state: MonitorState | null = null;
  private onCompleteCallback: ArbCompletionCallback | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private clobWs: ClobWsClient,
    private clob: ClobService,
    private config: Config,
    private arbManager: ArbManager,
    private logger: Logger,
    private telegram: TelegramNotifier,
    private volatilityCalc?: VolatilityCalculator,
  ) {
    // Listen to CLOB WS updates for loser side repricing
    this.clobWs.onUpdate(this.onPriceUpdate.bind(this));
  }

  /**
   * Start monitoring for arb completion opportunity.
   * Called immediately after winner side fills.
   */
  startSeeking(params: {
    winnerSide: TradeSide;
    winnerAvgPriceCents: number;
    winnerShares: number;
    loserTokenId: string;
    window: WindowInfo;
    onComplete: ArbCompletionCallback;
  }): void {
    const targetPrice = this.arbManager.getLoserTargetPriceCents(params.winnerAvgPriceCents);
    // Emergency price: accept break-even or small loss to avoid naked exposure
    const emergencyPrice = 100 - params.winnerAvgPriceCents + 1; // at most 1¢ loss

    this.state = {
      active: true,
      winnerSide: params.winnerSide,
      winnerAvgPriceCents: params.winnerAvgPriceCents,
      winnerShares: params.winnerShares,
      loserTokenId: params.loserTokenId,
      loserTargetPriceCents: targetPrice,
      emergencyPriceCents: emergencyPrice,
      startedAt: Date.now(),
      orderPlaced: false,
      orderId: null,
      phase: "watching",
    };

    this.onCompleteCallback = params.onComplete;

    const loserSide: TradeSide = params.winnerSide === "Up" ? "Down" : "Up";
    this.logger.info("Arb completion monitor started", {
      seeking: loserSide,
      targetPrice: `≤${targetPrice.toFixed(1)}¢`,
      emergencyPrice: `≤${emergencyPrice.toFixed(1)}¢`,
      shares: params.winnerShares.toFixed(2),
      timeout: `${this.config.arbCompletionTimeoutMs}ms`,
    });

    // Start periodic check for timeout/emergency
    this.checkTimer = setInterval(() => this.periodicCheck(), 500);
  }

  reset(): void {
    this.state = null;
    this.onCompleteCallback = null;
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  get isActive(): boolean {
    return this.state?.active ?? false;
  }

  get phase(): string {
    return this.state?.phase ?? "idle";
  }

  /**
   * React to CLOB WS orderbook updates — check if loser price hit target.
   */
  private onPriceUpdate(assetId: string, book: BookSnapshot): void {
    if (!this.state || !this.state.active) return;
    if (assetId !== this.state.loserTokenId) return;
    if (this.state.phase !== "watching") return;

    const bestAsk = book.bestAsk;
    if (bestAsk === null) return;

    const askCents = bestAsk * 100;

    // Check if loser price has dropped to our target
    if (askCents <= this.state.loserTargetPriceCents) {
      this.logger.info("Loser price hit target — placing arb completion order", {
        loserAsk: `${askCents.toFixed(1)}¢`,
        target: `${this.state.loserTargetPriceCents.toFixed(1)}¢`,
        totalCost: `${(this.state.winnerAvgPriceCents + askCents).toFixed(1)}¢`,
      });
      this.placeLoserOrder(askCents).catch((err) => {
        this.logger.error("Arb completion order failed", { error: (err as Error).message });
      });
    }
  }

  /**
   * Periodic check for timeouts and emergency conditions.
   */
  private periodicCheck(): void {
    if (!this.state || !this.state.active) return;

    const elapsed = Date.now() - this.state.startedAt;

    // Check if BTC reversed (winner side now losing)
    if (this.volatilityCalc && this.state.phase === "watching") {
      const momentum = this.volatilityCalc.getRecentMomentum(5);
      if (momentum !== null) {
        const adverse =
          (this.state.winnerSide === "Up" && momentum < -20) ||
          (this.state.winnerSide === "Down" && momentum > 20);

        if (adverse && elapsed > 3000) {
          this.logger.warn("BTC reversing — emergency balance", {
            momentum: `$${momentum.toFixed(0)}`,
            elapsed: `${(elapsed / 1000).toFixed(1)}s`,
          });
          this.emergencyBalance().catch((err) => {
            this.logger.error("Emergency balance failed", { error: (err as Error).message });
          });
          return;
        }
      }
    }

    // Timeout — force emergency balance
    if (elapsed > this.config.arbCompletionTimeoutMs && this.state.phase === "watching") {
      this.logger.warn("Arb completion timeout — emergency balance", {
        elapsed: `${(elapsed / 1000).toFixed(1)}s`,
        timeout: `${this.config.arbCompletionTimeoutMs}ms`,
      });
      this.emergencyBalance().catch((err) => {
        this.logger.error("Emergency balance failed", { error: (err as Error).message });
      });
    }
  }

  /**
   * Place the loser side order at the target or better price.
   */
  private async placeLoserOrder(priceCents: number): Promise<void> {
    if (!this.state || this.state.phase !== "watching") return;
    this.state.phase = "ordered";

    const loserSide: TradeSide = this.state.winnerSide === "Up" ? "Down" : "Up";
    const priceDecimal = priceCents / 100;
    const shares = this.state.winnerShares;
    const costUsd = shares * priceDecimal;

    if (this.config.dryRun) {
      this.logger.info("DRY_RUN — arb completion simulated", {
        side: loserSide,
        price: `${priceCents.toFixed(1)}¢`,
        shares: shares.toFixed(2),
        cost: `$${costUsd.toFixed(2)}`,
        totalPairCost: `${(this.state.winnerAvgPriceCents + priceCents).toFixed(1)}¢`,
        profit: `${(100 - this.state.winnerAvgPriceCents - priceCents).toFixed(1)}¢/pair`,
      });

      this.complete(loserSide, shares, costUsd, []);
      return;
    }

    const result = await this.clob.placeBatchOrders([{
      tokenId: this.state.loserTokenId,
      side: Side.BUY,
      price: priceDecimal,
      size: shares,
    }]);

    if (result.placed > 0) {
      this.logger.info("Arb completion order placed", {
        side: loserSide,
        price: `${priceCents.toFixed(1)}¢`,
        shares: shares.toFixed(2),
        orderIds: result.orderIds.map((id) => id.slice(0, 12) + "..."),
      });
      this.complete(loserSide, shares, costUsd, result.orderIds);
    } else {
      this.logger.warn("Arb completion order failed — going to emergency balance");
      this.state.phase = "watching"; // try again or emergency
      await this.emergencyBalance();
    }
  }

  /**
   * Emergency balance: buy loser at any price ≤ emergency threshold
   * to avoid naked exposure at settlement.
   */
  private async emergencyBalance(): Promise<void> {
    if (!this.state || this.state.phase === "done") return;
    this.state.phase = "emergency";

    const loserSide: TradeSide = this.state.winnerSide === "Up" ? "Down" : "Up";

    // Get current best ask for loser
    const book = this.clobWs.getBook(this.state.loserTokenId);
    let askCents: number | null = book?.bestAsk ? book.bestAsk * 100 : null;

    if (!askCents) {
      const ob = await this.clob.getOrderbook(this.state.loserTokenId);
      askCents = ob.bestAsk ? ob.bestAsk * 100 : null;
    }

    if (!askCents) {
      this.logger.error("No loser price available for emergency balance — holding naked");
      this.state.phase = "done";
      this.state.active = false;
      this.telegram.alertError(`Emergency balance failed: no ${loserSide} price. Holding naked ${this.state.winnerSide}.`);
      return;
    }

    const totalCost = this.state.winnerAvgPriceCents + askCents;
    const pnlPerPair = 100 - totalCost;

    this.logger.info("EMERGENCY BALANCE", {
      side: loserSide,
      price: `${askCents.toFixed(1)}¢`,
      totalCost: `${totalCost.toFixed(1)}¢`,
      pnlPerPair: `${pnlPerPair >= 0 ? "+" : ""}${pnlPerPair.toFixed(1)}¢`,
    });

    // Accept up to 3¢ loss per pair to avoid naked exposure
    if (askCents <= this.state.emergencyPriceCents) {
      await this.placeLoserOrderForced(askCents);
    } else {
      // Price too high — just hold naked and let settlement decide
      this.logger.warn("Emergency price too high, holding naked", {
        loserAsk: `${askCents.toFixed(1)}¢`,
        maxAcceptable: `${this.state.emergencyPriceCents.toFixed(1)}¢`,
      });
      this.telegram.alertError(
        `Arb incomplete: ${loserSide} at ${askCents.toFixed(1)}¢ too expensive. Holding naked ${this.state.winnerSide}.`,
      );
      this.state.phase = "done";
      this.state.active = false;
    }
  }

  private async placeLoserOrderForced(priceCents: number): Promise<void> {
    if (!this.state) return;

    const loserSide: TradeSide = this.state.winnerSide === "Up" ? "Down" : "Up";
    const priceDecimal = priceCents / 100;
    const shares = this.state.winnerShares;
    const costUsd = shares * priceDecimal;

    if (this.config.dryRun) {
      this.logger.info("DRY_RUN — emergency balance simulated", {
        side: loserSide,
        price: `${priceCents.toFixed(1)}¢`,
      });
      this.complete(loserSide, shares, costUsd, []);
      return;
    }

    const result = await this.clob.placeBatchOrders([{
      tokenId: this.state.loserTokenId,
      side: Side.BUY,
      price: priceDecimal,
      size: shares,
    }]);

    if (result.placed > 0) {
      this.complete(loserSide, shares, costUsd, result.orderIds);
    } else {
      this.logger.error("Emergency order also failed!");
      this.telegram.alertError("Emergency balance order rejected. Manual intervention needed.");
      this.state.phase = "done";
      this.state.active = false;
    }
  }

  private complete(side: TradeSide, shares: number, costUsd: number, orderIds: string[]): void {
    if (!this.state) return;

    this.state.phase = "done";
    this.state.active = false;

    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }

    if (this.onCompleteCallback) {
      this.onCompleteCallback(side, shares, costUsd, orderIds);
    }
  }
}
