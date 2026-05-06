import { Side } from "@polymarket/clob-client-v2";
import type { Logger } from "../logger.js";
import type { ClobService } from "../data/clob.js";
import type { CopyTradeConfig } from "./config.js";
import type { TargetTrade } from "./tracker.js";
import type { PositionLedger } from "./ledger.js";
import { sleep } from "../utils.js";

export interface SellIntent {
  intentId: string;
  leaderAddress: string;
  tokenId: string;
  conditionId: string;
  marketTitle: string;
  outcome: string;
  startedAt: number;
  /** Total shares we MUST close */
  targetShares: number;
  /** Running tally of shares actually filled */
  filledShares: number;
  /** Average fill price across all child orders */
  avgFillPrice: number;
  /** Sum of (filledShares × fillPrice) — for avg calc */
  totalProceedsUsd: number;
  /** Every child orderId we placed */
  childOrderIds: string[];
  attempts: number;
  status: "active" | "complete" | "abandoned" | "redeemed";
  reason?: string;
  lastEscalationAt: number;
  /** True once Stage 3 (patient GTC) has placed a resting order */
  patientGtcPlaced: boolean;
  patientGtcOrderId?: string;
  /** Trade event that triggered this intent (for callbacks) */
  trade: TargetTrade;
}

export interface SellResolutionLookup {
  isResolved(conditionId: string): Promise<boolean>;
}

export interface SellPendingBuyCanceler {
  cancelPendingBuysFor(leader: string, tokenId: string): Promise<void>;
}

/**
 * Bulletproof SELL execution engine.
 *
 * Runs each leader-SELL signal as a SellIntent through staged escalation:
 *
 *   Stage 1: Aggressive FAK at bestBid - aggressiveSlippageCents
 *   Stage 2: Escalating FAK loop (-1¢ per attempt, max 5 attempts)
 *   Stage 3: Patient GTC at bestBid (rests in book)
 *   Stage 4: Escalation timer (30s/60s/120s) → force-floor exit
 *
 * Guarantees:
 *   - No gaps: every signaled SELL drives toward filledShares ≥ targetShares
 *   - No double-sell: per-(leader,token) mutex serializes
 *   - No selling resolved markets: resolution check at every stage
 *   - No fighting orders: cancels pending BUYs before SELL
 */
export class SellEngine {
  private clob: ClobService;
  private ledger: PositionLedger;
  private config: CopyTradeConfig;
  private logger: Logger;
  private resolutionLookup: SellResolutionLookup;
  private buyCanceler: SellPendingBuyCanceler;

  /** Active SellIntents keyed by intentId */
  private intents: Map<string, SellIntent> = new Map();
  /** Per-(leader,tokenId) mutex */
  private locks: Map<string, Promise<void>> = new Map();
  /** Cache of leader's pre-event position (5s TTL) for back-to-back SELLs */
  private leaderPosCache: Map<string, { size: number; ts: number }> = new Map();

  /** Callbacks */
  private onIntentCompleteCb: ((intent: SellIntent) => void) | null = null;

  constructor(
    clob: ClobService,
    ledger: PositionLedger,
    config: CopyTradeConfig,
    logger: Logger,
    resolutionLookup: SellResolutionLookup,
    buyCanceler: SellPendingBuyCanceler,
  ) {
    this.clob = clob;
    this.ledger = ledger;
    this.config = config;
    this.logger = logger;
    this.resolutionLookup = resolutionLookup;
    this.buyCanceler = buyCanceler;

    // Run escalation timer every 5s
    setInterval(() => this.checkIntents().catch((err) =>
      this.logger.warn("SellEngine tick failed", { error: (err as Error).message }),
    ), 5_000);
  }

  onIntentComplete(cb: (intent: SellIntent) => void): void {
    this.onIntentCompleteCb = cb;
  }

  /**
   * Process a SELL trade event from a leader.
   * Returns the SellIntent that was created (status will be one of: complete, active, redeemed, etc.)
   */
  async exit(trade: TargetTrade, leaderPreSellSize: number): Promise<SellIntent> {
    const lockKey = `${trade.leaderAddress}:${trade.tokenId}`;

    // Acquire per-(leader,token) mutex
    while (this.locks.get(lockKey)) {
      await this.locks.get(lockKey);
    }
    let resolveLock!: () => void;
    this.locks.set(lockKey, new Promise<void>((r) => { resolveLock = r; }));

    try {
      // Stage 0a: resolution short-circuit
      const resolved = await this.resolutionLookup.isResolved(trade.conditionId).catch(() => false);
      if (resolved) {
        return this.makeIntent(trade, 0, "redeemed_at_start");
      }

      // Stage 0b: cancel any pending BUYs we have on this market with this leader
      await this.buyCanceler.cancelPendingBuysFor(trade.leaderAddress, trade.tokenId);

      // Stage 0c: compute exitShares from LEDGER (not /positions)
      const available = this.ledger.availableShares(trade.leaderAddress, trade.tokenId);
      if (available <= 0) {
        return this.makeIntent(trade, 0, "no_position");
      }

      // sellPct = leader's sold / leader's pre-sell size
      const sellPct = leaderPreSellSize > 0 ? trade.shares / leaderPreSellSize : 1;
      const exitShares = Math.min(available, available * sellPct);

      // Reserve shares to prevent concurrent exits from doubling
      if (!this.ledger.reservePendingSell(trade.leaderAddress, trade.tokenId, exitShares)) {
        return this.makeIntent(trade, 0, "ledger_reservation_failed");
      }

      const intent = this.makeIntent(trade, exitShares, undefined);
      this.intents.set(intent.intentId, intent);

      this.logger.info("SellEngine: intent created", {
        intentId: intent.intentId,
        leader: trade.leaderAddress.slice(0, 8) + "...",
        targetShares: exitShares.toFixed(1),
        sellPct: `${(sellPct * 100).toFixed(1)}%`,
        leaderSold: trade.shares.toFixed(1),
        leaderPre: leaderPreSellSize.toFixed(1),
        ourAvail: available.toFixed(1),
      });

      // Stage 1: Aggressive FAK
      await this.runStage1(intent);
      if (this.intentDone(intent)) return this.complete(intent, "stage1_filled");

      // Stage 2: Escalating FAK loop
      await this.runStage2(intent);
      if (this.intentDone(intent)) return this.complete(intent, "stage2_filled");

      // Stage 3: Patient GTC
      await this.runStage3(intent);
      // Stage 4 runs from the periodic checkIntents() timer

      return intent;
    } finally {
      resolveLock();
      this.locks.delete(lockKey);
    }
  }

  /** Called by external code on every fill that affects an intent's tokenId */
  applyExternalFill(tokenId: string, leader: string, filledShares: number, fillPrice: number): void {
    // Find any intents matching this leader + tokenId
    for (const intent of this.intents.values()) {
      if (intent.leaderAddress === leader && intent.tokenId === tokenId && intent.status === "active") {
        intent.filledShares += filledShares;
        intent.totalProceedsUsd += filledShares * fillPrice;
        intent.avgFillPrice = intent.filledShares > 0 ? intent.totalProceedsUsd / intent.filledShares : 0;
        if (this.intentDone(intent)) {
          this.complete(intent, "external_fill_completed");
        }
      }
    }
  }

  private async runStage1(intent: SellIntent): Promise<void> {
    intent.attempts++;
    const ob = await this.clob.getOrderbook(intent.tokenId).catch(() => null);
    if (!ob || ob.bestBid === null) {
      this.logger.warn("Stage 1: no bid book", { intentId: intent.intentId });
      return;
    }
    const slipCents = this.config.sellAggressiveSlippageCents;
    const worstPrice = Math.max(0.01, ob.bestBid - slipCents / 100);
    const remaining = intent.targetShares - intent.filledShares;
    if (remaining < 1) return;

    try {
      const result = await this.clob.placeMarketOrderFAK({
        tokenId: intent.tokenId,
        side: Side.SELL,
        amount: remaining, // SELL amount = shares
        worstPrice,
      });
      if (result.orderIds[0]) intent.childOrderIds.push(result.orderIds[0]);

      // Query actual fill amount
      const filled = await this.queryFakFill(result.orderIds[0]);
      this.recordFill(intent, filled, worstPrice);
      this.logger.info("Stage 1 FAK", {
        intentId: intent.intentId,
        worstPrice: `${Math.round(worstPrice * 100)}¢`,
        filled: filled.toFixed(1),
        remaining: (intent.targetShares - intent.filledShares).toFixed(1),
      });
    } catch (err) {
      this.logger.warn("Stage 1 FAK failed", { intentId: intent.intentId, error: (err as Error).message });
    }
  }

  private async runStage2(intent: SellIntent): Promise<void> {
    for (let n = 1; n <= this.config.sellMaxAttempts && !this.intentDone(intent); n++) {
      // Check resolution mid-flow
      if (await this.resolutionLookup.isResolved(intent.conditionId).catch(() => false)) {
        intent.status = "redeemed";
        intent.reason = "redeemed_midflow";
        return;
      }

      const ob = await this.clob.getOrderbook(intent.tokenId).catch(() => null);
      if (!ob?.bestBid) break;

      // Each attempt drops bid by 1¢ more
      const slipCents = this.config.sellAggressiveSlippageCents + n;
      const worstPrice = Math.max(this.config.minPriceCents / 100, ob.bestBid - slipCents / 100);
      if (worstPrice * 100 < this.config.minPriceCents) break;

      const remaining = intent.targetShares - intent.filledShares;
      if (remaining < 1) break;

      try {
        const result = await this.clob.placeMarketOrderFAK({
          tokenId: intent.tokenId,
          side: Side.SELL,
          amount: remaining,
          worstPrice,
        });
        if (result.orderIds[0]) intent.childOrderIds.push(result.orderIds[0]);
        const filled = await this.queryFakFill(result.orderIds[0]);
        this.recordFill(intent, filled, worstPrice);
        this.logger.info(`Stage 2 FAK attempt ${n}`, {
          intentId: intent.intentId,
          slip: `${slipCents}¢`,
          filled: filled.toFixed(1),
          remaining: (intent.targetShares - intent.filledShares).toFixed(1),
        });
      } catch (err) {
        this.logger.warn(`Stage 2 FAK ${n} failed`, { intentId: intent.intentId, error: (err as Error).message });
      }

      intent.attempts++;
      await sleep(200);
    }
  }

  private async runStage3(intent: SellIntent): Promise<void> {
    const remaining = intent.targetShares - intent.filledShares;
    if (remaining < 1) return;

    const ob = await this.clob.getOrderbook(intent.tokenId).catch(() => null);
    if (!ob?.bestBid) return;

    // Patient GTC at bestBid (instant taker fill, accept fees for closure)
    const patientPrice = ob.bestBid;
    try {
      const { orderId } = await this.clob.placeLimitOrder({
        tokenId: intent.tokenId,
        side: Side.SELL,
        price: patientPrice,
        size: remaining,
      });
      intent.childOrderIds.push(orderId);
      intent.patientGtcOrderId = orderId;
      intent.patientGtcPlaced = true;
      intent.lastEscalationAt = Date.now();
      this.logger.info("Stage 3 patient GTC placed", {
        intentId: intent.intentId,
        price: `${Math.round(patientPrice * 100)}¢`,
        size: remaining.toFixed(1),
        orderId: orderId.slice(0, 12) + "...",
      });
    } catch (err) {
      this.logger.warn("Stage 3 GTC failed", { intentId: intent.intentId, error: (err as Error).message });
    }
  }

  /** Periodic timer — drives Stage 4 escalation for active intents */
  private async checkIntents(): Promise<void> {
    for (const intent of this.intents.values()) {
      if (intent.status !== "active") continue;

      // Check resolution
      if (await this.resolutionLookup.isResolved(intent.conditionId).catch(() => false)) {
        intent.status = "redeemed";
        intent.reason = "redeemed_in_check";
        await this.cancelPatientGtc(intent);
        this.complete(intent, "redeemed");
        continue;
      }

      // Re-query CLOB for the patient GTC's actual fill
      if (intent.patientGtcOrderId) {
        try {
          const filledNow = await this.clob.getFilledShares(intent.patientGtcOrderId);
          // Update intent with delta only — additive over previous reads
          const known = intent.filledShares - this.stage12Filled(intent);
          const delta = filledNow - Math.max(0, known);
          if (delta > 0) {
            this.recordFill(intent, delta, intent.avgFillPrice || 0);
          }
        } catch { /* keep retrying */ }
      }

      if (this.intentDone(intent)) {
        this.complete(intent, "patient_gtc_filled");
        continue;
      }

      const elapsed = Date.now() - intent.startedAt;

      // Stage 4 escalation tiers
      if (elapsed > 120_000 && this.config.sellForceFloorExit) {
        await this.forceFloorExit(intent);
      } else if (elapsed > 60_000 && Date.now() - intent.lastEscalationAt > 30_000) {
        await this.escalateFak(intent, this.config.sellEscalate60sCents);
      } else if (elapsed > 30_000 && Date.now() - intent.lastEscalationAt > 15_000) {
        await this.escalateFak(intent, this.config.sellEscalate30sCents);
      }

      // Hard abandon after configured hours
      if (elapsed > this.config.sellIntentAbandonHours * 60 * 60_000) {
        intent.status = "abandoned";
        intent.reason = "abandoned_timeout";
        await this.cancelPatientGtc(intent);
        this.complete(intent, "abandoned");
      }
    }
  }

  private async escalateFak(intent: SellIntent, slipCents: number): Promise<void> {
    const remaining = intent.targetShares - intent.filledShares;
    if (remaining < 1) return;
    const ob = await this.clob.getOrderbook(intent.tokenId).catch(() => null);
    if (!ob?.bestBid) return;
    const worstPrice = Math.max(0.01, ob.bestBid - slipCents / 100);
    if (worstPrice * 100 < this.config.minPriceCents) return;

    // Cancel patient GTC first to free reserved shares
    await this.cancelPatientGtc(intent);

    try {
      const result = await this.clob.placeMarketOrderFAK({
        tokenId: intent.tokenId,
        side: Side.SELL,
        amount: remaining,
        worstPrice,
      });
      if (result.orderIds[0]) intent.childOrderIds.push(result.orderIds[0]);
      const filled = await this.queryFakFill(result.orderIds[0]);
      this.recordFill(intent, filled, worstPrice);
      intent.lastEscalationAt = Date.now();
      this.logger.info("Stage 4 escalation FAK", {
        intentId: intent.intentId,
        slip: `${slipCents}¢`,
        filled: filled.toFixed(1),
        remaining: (intent.targetShares - intent.filledShares).toFixed(1),
      });

      // Re-place patient GTC for any remaining
      if (!this.intentDone(intent)) {
        await this.runStage3(intent);
      }
    } catch (err) {
      this.logger.warn("Escalation FAK failed", { intentId: intent.intentId, error: (err as Error).message });
    }
  }

  /** Final force-exit at min price — guaranteed exit at any non-zero bid */
  private async forceFloorExit(intent: SellIntent): Promise<void> {
    const remaining = intent.targetShares - intent.filledShares;
    if (remaining < 1) return;
    await this.cancelPatientGtc(intent);
    const worstPrice = this.config.minPriceCents / 100;
    try {
      const result = await this.clob.placeMarketOrderFAK({
        tokenId: intent.tokenId,
        side: Side.SELL,
        amount: remaining,
        worstPrice,
      });
      if (result.orderIds[0]) intent.childOrderIds.push(result.orderIds[0]);
      const filled = await this.queryFakFill(result.orderIds[0]);
      this.recordFill(intent, filled, worstPrice);
      this.logger.warn("Stage 4 FORCE-FLOOR exit", {
        intentId: intent.intentId,
        floorPrice: `${this.config.minPriceCents}¢`,
        filled: filled.toFixed(1),
        remaining: (intent.targetShares - intent.filledShares).toFixed(1),
      });
      if (this.intentDone(intent)) {
        this.complete(intent, "force_floor_filled");
      }
    } catch (err) {
      this.logger.warn("Force-floor failed", { intentId: intent.intentId, error: (err as Error).message });
    }
  }

  private async queryFakFill(orderId: string | undefined): Promise<number> {
    if (!orderId) return 0;
    try {
      return await this.clob.getFilledShares(orderId);
    } catch {
      return 0;
    }
  }

  private stage12Filled(intent: SellIntent): number {
    // All fills BEFORE patient GTC was placed
    return intent.patientGtcPlaced ? intent.filledShares - 0 : intent.filledShares;
  }

  private async cancelPatientGtc(intent: SellIntent): Promise<void> {
    if (!intent.patientGtcOrderId) return;
    try {
      await this.clob.cancelOrder(intent.patientGtcOrderId);
    } catch { /* ignore */ }
    intent.patientGtcOrderId = undefined;
    intent.patientGtcPlaced = false;
  }

  private recordFill(intent: SellIntent, filledShares: number, fillPrice: number): void {
    if (filledShares <= 0) return;
    intent.filledShares += filledShares;
    intent.totalProceedsUsd += filledShares * fillPrice;
    intent.avgFillPrice = intent.filledShares > 0 ? intent.totalProceedsUsd / intent.filledShares : 0;
  }

  private intentDone(intent: SellIntent): boolean {
    const epsilon = Math.max(1, intent.targetShares * 0.005);
    return intent.filledShares >= intent.targetShares - epsilon;
  }

  private complete(intent: SellIntent, reason: string): SellIntent {
    intent.status = "complete";
    intent.reason = reason;
    // Release any leftover reservation that didn't fill
    const unfilled = Math.max(0, intent.targetShares - intent.filledShares);
    if (unfilled > 0) {
      this.ledger.releasePendingSell(intent.leaderAddress, intent.tokenId, unfilled);
    }
    // Apply the SELL fills to the ledger
    if (intent.filledShares > 0) {
      this.ledger.applySellFill(
        intent.leaderAddress,
        intent.tokenId,
        intent.filledShares,
        intent.avgFillPrice,
        `intent:${intent.intentId}`,
      );
    }
    this.intents.delete(intent.intentId);
    if (this.onIntentCompleteCb) this.onIntentCompleteCb(intent);
    return intent;
  }

  private makeIntent(trade: TargetTrade, targetShares: number, reason?: string): SellIntent {
    return {
      intentId: `${trade.leaderAddress.slice(2, 10)}-${trade.tokenId.slice(0, 8)}-${Date.now()}`,
      leaderAddress: trade.leaderAddress,
      tokenId: trade.tokenId,
      conditionId: trade.conditionId,
      marketTitle: trade.title,
      outcome: trade.outcome,
      startedAt: Date.now(),
      targetShares,
      filledShares: 0,
      avgFillPrice: 0,
      totalProceedsUsd: 0,
      childOrderIds: [],
      attempts: 0,
      status: targetShares > 0 ? "active" : "complete",
      reason,
      lastEscalationAt: 0,
      patientGtcPlaced: false,
      trade,
    };
  }

  /** Get the cached leader pre-sell size; refreshes if stale. */
  async getLeaderPreSellSize(leader: string, tokenId: string, soldShares: number, queryFn: () => Promise<number>): Promise<number> {
    const key = `${leader}:${tokenId}`;
    const cached = this.leaderPosCache.get(key);
    if (cached && Date.now() - cached.ts < 5_000) {
      // Subtract this sell — back-to-back SELL handling
      cached.size = Math.max(0, cached.size - soldShares);
      return cached.size + soldShares; // pre-sell
    }
    try {
      const remaining = await queryFn();
      this.leaderPosCache.set(key, { size: remaining, ts: Date.now() });
      return remaining + soldShares;
    } catch {
      // Fallback: assume sell is 100% close (most aggressive)
      return soldShares;
    }
  }

  getActiveIntents(): SellIntent[] {
    return Array.from(this.intents.values()).filter((i) => i.status === "active");
  }
}
