import type { Logger } from "../logger.js";
import type { TradeSide } from "../types.js";

/**
 * ArbManager: Tracks per-window position state for the hybrid strategy.
 *
 * Responsibilities:
 * - Track shares per side (Up/Down) and cost basis
 * - Calculate unhedged exposure
 * - Determine if a new round-trip is allowed
 * - Compute locked profit from balanced pairs
 * - Enforce max unhedged exposure limit
 */

export interface PositionState {
  upShares: number;
  downShares: number;
  upCostUsd: number;
  downCostUsd: number;
  roundTrips: number;
  /** Shares that are balanced (min of up/down) */
  balancedShares: number;
  /** Shares without opposite side coverage */
  unhedgedShares: number;
  /** Which side has excess shares (null if balanced) */
  unhedgedSide: TradeSide | null;
  /** Locked profit from balanced pairs: balancedShares * $1.00 - proportional cost */
  lockedProfit: number;
  /** Total cost basis across all positions */
  totalCost: number;
}

export interface ArbManagerConfig {
  maxRoundTripsPerWindow: number;
  maxUnhedgedPct: number;        // max unhedged as % of balance
  maxWindowExposurePct: number;  // max total cost as % of balance
  minProfitCents: number;        // min profit per pair to complete arb
  emergencyBalanceAfterMs: number; // force balance after this many ms
}

export class ArbManager {
  private upShares = 0;
  private downShares = 0;
  private upCostUsd = 0;
  private downCostUsd = 0;
  private roundTrips = 0;
  private windowConditionId: string | null = null;
  private lastEntryTime = 0;

  constructor(
    private config: ArbManagerConfig,
    private logger: Logger,
  ) {}

  /** Reset on new window */
  reset(conditionId: string): void {
    this.upShares = 0;
    this.downShares = 0;
    this.upCostUsd = 0;
    this.downCostUsd = 0;
    this.roundTrips = 0;
    this.windowConditionId = conditionId;
    this.lastEntryTime = 0;
  }

  /** Record a sell-back: we sold our winner position, remove it from state */
  recordSellBack(side: TradeSide, shares: number): void {
    if (side === "Up") {
      const pricePer = this.upShares > 0 ? this.upCostUsd / this.upShares : 0;
      this.upShares = Math.max(0, this.upShares - shares);
      this.upCostUsd = this.upShares * pricePer;
    } else {
      const pricePer = this.downShares > 0 ? this.downCostUsd / this.downShares : 0;
      this.downShares = Math.max(0, this.downShares - shares);
      this.downCostUsd = this.downShares * pricePer;
    }
    this.logger.info("Sell-back recorded", {
      side,
      shares: shares.toFixed(2),
      remaining: `Up=${this.upShares.toFixed(1)} Down=${this.downShares.toFixed(1)}`,
    });
  }

  /** Record a fill on one side */
  recordFill(side: TradeSide, shares: number, costUsd: number): void {
    if (side === "Up") {
      this.upShares += shares;
      this.upCostUsd += costUsd;
    } else {
      this.downShares += shares;
      this.downCostUsd += costUsd;
    }

    // Check if we just completed a round-trip (became balanced)
    const prevUnhedged = Math.abs(
      (this.upShares - shares * (side === "Up" ? 1 : 0)) -
      (this.downShares - shares * (side === "Down" ? 1 : 0)),
    );
    const newUnhedged = Math.abs(this.upShares - this.downShares);

    if (prevUnhedged > 0.01 && newUnhedged < 0.01) {
      this.roundTrips++;
      this.logger.info("Arb round-trip completed", {
        roundTrip: this.roundTrips,
        lockedProfit: `+$${this.getLockedProfit().toFixed(2)}`,
        totalCost: `$${this.getTotalCost().toFixed(2)}`,
      });
    }
  }

  /** Get current position state */
  getState(): PositionState {
    const balanced = Math.min(this.upShares, this.downShares);
    const unhedged = Math.abs(this.upShares - this.downShares);
    const unhedgedSide: TradeSide | null =
      unhedged < 0.01 ? null : this.upShares > this.downShares ? "Up" : "Down";

    return {
      upShares: this.upShares,
      downShares: this.downShares,
      upCostUsd: this.upCostUsd,
      downCostUsd: this.downCostUsd,
      roundTrips: this.roundTrips,
      balancedShares: balanced,
      unhedgedShares: unhedged,
      unhedgedSide,
      lockedProfit: this.getLockedProfit(),
      totalCost: this.getTotalCost(),
    };
  }

  /** Can we start a new edge entry? */
  canEnterNewTrade(currentBalance: number): { allowed: boolean; reason?: string } {
    const state = this.getState();

    // Must be balanced before new entry
    if (state.unhedgedShares > 0.01) {
      return { allowed: false, reason: `Unhedged ${state.unhedgedSide} shares: ${state.unhedgedShares.toFixed(1)}` };
    }

    // Max round-trips
    if (this.roundTrips >= this.config.maxRoundTripsPerWindow) {
      return { allowed: false, reason: `Max round-trips reached (${this.roundTrips}/${this.config.maxRoundTripsPerWindow})` };
    }

    // Max window exposure
    const maxExposure = currentBalance * this.config.maxWindowExposurePct / 100;
    if (state.totalCost >= maxExposure) {
      return { allowed: false, reason: `Window exposure limit (${state.totalCost.toFixed(2)}/${maxExposure.toFixed(2)})` };
    }

    return { allowed: true };
  }

  /** Check if unhedged exposure exceeds limit */
  isOverExposed(currentBalance: number): boolean {
    const state = this.getState();
    const maxUnhedgedUsd = currentBalance * this.config.maxUnhedgedPct / 100;
    const unhedgedCost = state.unhedgedSide === "Up"
      ? (state.unhedgedShares / this.upShares) * this.upCostUsd
      : state.unhedgedSide === "Down"
        ? (state.unhedgedShares / this.downShares) * this.downCostUsd
        : 0;
    return unhedgedCost > maxUnhedgedUsd;
  }

  /** Calculate the target price for the loser side to lock in profit */
  getLoserTargetPriceCents(winnerAvgPriceCents: number): number {
    // loser must cost ≤ (100 - winner - minProfit) to guarantee profit
    return 100 - winnerAvgPriceCents - this.config.minProfitCents;
  }

  /** Get number of shares needed to balance */
  getSharesToBalance(): { side: TradeSide; shares: number } | null {
    const state = this.getState();
    if (!state.unhedgedSide || state.unhedgedShares < 0.01) return null;

    const neededSide: TradeSide = state.unhedgedSide === "Up" ? "Down" : "Up";
    return { side: neededSide, shares: state.unhedgedShares };
  }

  /** Time since last entry (for emergency balancing timeout) */
  setEntryTime(): void {
    this.lastEntryTime = Date.now();
  }

  getTimeSinceEntry(): number {
    if (this.lastEntryTime === 0) return 0;
    return Date.now() - this.lastEntryTime;
  }

  needsEmergencyBalance(): boolean {
    if (this.lastEntryTime === 0) return false;
    const state = this.getState();
    if (state.unhedgedShares < 0.01) return false;
    return this.getTimeSinceEntry() > this.config.emergencyBalanceAfterMs;
  }

  private getLockedProfit(): number {
    const balanced = Math.min(this.upShares, this.downShares);
    if (balanced < 0.01) return 0;

    // Proportional cost for balanced portion
    const upProportion = this.upShares > 0 ? balanced / this.upShares : 0;
    const downProportion = this.downShares > 0 ? balanced / this.downShares : 0;
    const balancedCost = this.upCostUsd * upProportion + this.downCostUsd * downProportion;

    // Deduct 2% taker fee on both sides
    const fees = balancedCost * 0.02;

    // Balanced pairs pay $1.00 per share at settlement
    return balanced - balancedCost - fees;
  }

  private getTotalCost(): number {
    return this.upCostUsd + this.downCostUsd;
  }

  get hasPosition(): boolean {
    return this.upShares > 0.01 || this.downShares > 0.01;
  }

  get isBalanced(): boolean {
    return Math.abs(this.upShares - this.downShares) < 0.01;
  }

  get conditionId(): string | null {
    return this.windowConditionId;
  }
}
