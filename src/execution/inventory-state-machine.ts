/**
 * Inventory State Machine for Stargate-style two-sided executor.
 *
 * States per executor_spec.md:
 *   FLAT -> FIRST_LEG_ACQUIRED -> BALANCING -> NEAR_BALANCED -> MERGE_READY
 *   Any state -> DEFENSIVE_REBALANCE (triggered by time/skew)
 *   Any state -> STOP_BUILD (triggered by quality/time)
 *
 * Pair Quality Bands:
 *   IDEAL < 94c | GOOD < 97c | ACCEPTABLE < 100c | DEFENSIVE < 103c | TOXIC >= 103c
 */

import type { TradeSide } from "../types.js";

// ── State Enum ──

export type InventoryState =
  | "FLAT"
  | "FIRST_LEG_ACQUIRED"
  | "BALANCING"
  | "NEAR_BALANCED"
  | "MERGE_READY"
  | "DEFENSIVE_REBALANCE"
  | "STOP_BUILD";

// ── Pair Quality Bands ──

export type PairQualityBand = "IDEAL" | "GOOD" | "ACCEPTABLE" | "DEFENSIVE" | "TOXIC";

export function classifyPairQuality(combinedCents: number): PairQualityBand {
  if (combinedCents < 94) return "IDEAL";
  if (combinedCents < 97) return "GOOD";
  if (combinedCents < 100) return "ACCEPTABLE";
  if (combinedCents < 103) return "DEFENSIVE";
  return "TOXIC";
}

// ── Fill Decision Record ──

export interface FillDecision {
  tick: number;
  state: InventoryState;
  regime: string;
  chosenSide: TradeSide | null;
  reason: string;
  /** Why the OTHER side was not chosen (null if chosen side is the only option) */
  altReason: string | null;
  pairBand: PairQualityBand | null;
  filledUp: number;
  filledDn: number;
  combinedCents: number;
  imbalanceRatio: number;
  unpairedDurationMs: number;
  timeRemainingS: number;
}

// ── State Machine Config ──

export interface StateMachineConfig {
  /** Max ratio between sides before DEFENSIVE_REBALANCE (e.g. 1.5) */
  nearBalancedRatio: number;
  /** Seconds of unpaired exposure before forcing DEFENSIVE_REBALANCE */
  defensiveUnpairedS: number;
  /** Seconds remaining before STOP_BUILD */
  stopBuildTimeS: number;
  /** Min matched shares to consider MERGE_READY */
  mergeReadyMinShares: number;
  /** Combined cents above which we enter STOP_BUILD */
  stopBuildCombinedCents: number;
  /** Combined cents above which DEFENSIVE_REBALANCE triggers even with OK time */
  defensiveCombinedCents: number;
}

export const DEFAULT_SM_CONFIG: StateMachineConfig = {
  nearBalancedRatio: 1.3,
  defensiveUnpairedS: 20,
  stopBuildTimeS: 50,
  mergeReadyMinShares: 10,
  stopBuildCombinedCents: 103,
  defensiveCombinedCents: 100,
};

// ── State Machine ──

export class InventoryStateMachine {
  private _state: InventoryState = "FLAT";
  private _prevState: InventoryState = "FLAT";
  private _transitions: Array<{ from: InventoryState; to: InventoryState; reason: string; tick: number }> = [];
  private _decisions: FillDecision[] = [];

  constructor(private cfg: StateMachineConfig = DEFAULT_SM_CONFIG) {}

  get state(): InventoryState {
    return this._state;
  }

  get prevState(): InventoryState {
    return this._prevState;
  }

  get transitions(): ReadonlyArray<{ from: InventoryState; to: InventoryState; reason: string; tick: number }> {
    return this._transitions;
  }

  get decisions(): ReadonlyArray<FillDecision> {
    return this._decisions;
  }

  recordDecision(d: FillDecision): void {
    this._decisions.push(d);
  }

  /**
   * Evaluate current inventory and timing to determine the correct state.
   * Called after every fill and periodically during the loop.
   */
  evaluate(ctx: {
    filledUp: number;
    filledDn: number;
    costUp: number;
    costDn: number;
    unpairedStartMs: number | null;
    timeRemainingS: number;
    mergeMinSize: number;
    tick: number;
  }): InventoryState {
    const { filledUp, filledDn, costUp, costDn, unpairedStartMs, timeRemainingS, mergeMinSize, tick } = ctx;
    const paired = Math.min(filledUp, filledDn);
    const imbalance = Math.abs(filledUp - filledDn);
    const hasBothSides = filledUp > 0 && filledDn > 0;
    const hasAnySide = filledUp > 0 || filledDn > 0;

    // Combined cents (only meaningful when both sides have fills)
    const avgUp = filledUp > 0 ? costUp / filledUp : 0;
    const avgDn = filledDn > 0 ? costDn / filledDn : 0;
    const combinedCents = hasBothSides ? (avgUp + avgDn) * 100 : Infinity;
    const band = hasBothSides ? classifyPairQuality(combinedCents) : null;

    // Unpaired duration
    const unpairedDurationMs = unpairedStartMs !== null ? Date.now() - unpairedStartMs : 0;
    const unpairedDurationS = unpairedDurationMs / 1000;

    // Imbalance ratio (how skewed are we?)
    const bigger = Math.max(filledUp, filledDn);
    const smaller = Math.min(filledUp, filledDn);
    const ratio = smaller > 0 ? bigger / smaller : (bigger > 0 ? Infinity : 1);

    let newState: InventoryState;
    let reason: string;

    // ── STOP_BUILD checks (highest priority terminal) ──
    if (hasAnySide && timeRemainingS <= this.cfg.stopBuildTimeS) {
      newState = "STOP_BUILD";
      reason = `time_remaining=${timeRemainingS.toFixed(0)}s <= ${this.cfg.stopBuildTimeS}s`;
    } else if (hasBothSides && band === "TOXIC") {
      newState = "STOP_BUILD";
      reason = `pair_quality=TOXIC (${combinedCents.toFixed(1)}c)`;
    }
    // ── DEFENSIVE_REBALANCE checks ──
    else if (hasAnySide && !hasBothSides && unpairedDurationS > this.cfg.defensiveUnpairedS) {
      newState = "DEFENSIVE_REBALANCE";
      reason = `unpaired_too_long=${unpairedDurationS.toFixed(0)}s (only one side)`;
    } else if (hasBothSides && imbalance > 0 && unpairedDurationS > this.cfg.defensiveUnpairedS) {
      newState = "DEFENSIVE_REBALANCE";
      reason = `unpaired_duration=${unpairedDurationS.toFixed(0)}s > ${this.cfg.defensiveUnpairedS}s`;
    } else if (hasBothSides && band === "DEFENSIVE") {
      newState = "DEFENSIVE_REBALANCE";
      reason = `pair_quality=DEFENSIVE (${combinedCents.toFixed(1)}c)`;
    }
    // ── Normal state flow ──
    else if (!hasAnySide) {
      newState = "FLAT";
      reason = "no_inventory";
    } else if (!hasBothSides) {
      newState = "FIRST_LEG_ACQUIRED";
      reason = `one_side_only: Up=${filledUp} Dn=${filledDn}`;
    } else if (paired >= Math.max(mergeMinSize, this.cfg.mergeReadyMinShares) && ratio <= this.cfg.nearBalancedRatio) {
      newState = "MERGE_READY";
      reason = `paired=${paired} ratio=${ratio.toFixed(2)} band=${band}`;
    } else if (ratio <= this.cfg.nearBalancedRatio) {
      newState = "NEAR_BALANCED";
      reason = `ratio=${ratio.toFixed(2)} <= ${this.cfg.nearBalancedRatio}`;
    } else {
      newState = "BALANCING";
      reason = `ratio=${ratio.toFixed(2)} imbalance=${imbalance}`;
    }

    // Record transition
    if (newState !== this._state) {
      this._transitions.push({ from: this._state, to: newState, reason, tick });
      this._prevState = this._state;
      this._state = newState;
    }

    return this._state;
  }

  /**
   * What actions are allowed in the current state?
   */
  getAllowedActions(): {
    canAccumulate: boolean;
    canAccumulateLongSide: boolean;
    mustPrioritizeShortSide: boolean;
    canMerge: boolean;
    canStartNewFirstLeg: boolean;
  } {
    switch (this._state) {
      case "FLAT":
        return {
          canAccumulate: true,
          canAccumulateLongSide: true,
          mustPrioritizeShortSide: false,
          canMerge: false,
          canStartNewFirstLeg: true,
        };
      case "FIRST_LEG_ACQUIRED":
        return {
          canAccumulate: true,
          canAccumulateLongSide: false, // do NOT stack same side
          mustPrioritizeShortSide: true,
          canMerge: false,
          canStartNewFirstLeg: false,
        };
      case "BALANCING":
        return {
          canAccumulate: true,
          canAccumulateLongSide: false, // only short side unless justified
          mustPrioritizeShortSide: true,
          canMerge: false,
          canStartNewFirstLeg: false,
        };
      case "NEAR_BALANCED":
        return {
          canAccumulate: true,
          canAccumulateLongSide: true, // can fine-tune either side
          mustPrioritizeShortSide: false,
          canMerge: true,
          canStartNewFirstLeg: false,
        };
      case "MERGE_READY":
        return {
          canAccumulate: true, // can still add if window is attractive
          canAccumulateLongSide: true,
          mustPrioritizeShortSide: false,
          canMerge: true,
          canStartNewFirstLeg: false,
        };
      case "DEFENSIVE_REBALANCE":
        return {
          canAccumulate: true, // only short side
          canAccumulateLongSide: false,
          mustPrioritizeShortSide: true,
          canMerge: true,
          canStartNewFirstLeg: false,
        };
      case "STOP_BUILD":
        return {
          canAccumulate: false,
          canAccumulateLongSide: false,
          mustPrioritizeShortSide: true, // rebalance leftovers
          canMerge: true,
          canStartNewFirstLeg: false,
        };
    }
  }

  /**
   * Given current inventory, which side is "short" (fewer shares)?
   */
  getShortSide(filledUp: number, filledDn: number): TradeSide | null {
    if (filledUp < filledDn) return "Up";
    if (filledDn < filledUp) return "Down";
    return null; // balanced
  }

  /**
   * Summary for logging.
   */
  summary(filledUp: number, filledDn: number, costUp: number, costDn: number): {
    state: InventoryState;
    paired: number;
    unpairedUp: number;
    unpairedDn: number;
    combinedCents: number;
    pairBand: PairQualityBand | null;
    transitionCount: number;
  } {
    const paired = Math.min(filledUp, filledDn);
    const avgUp = filledUp > 0 ? costUp / filledUp : 0;
    const avgDn = filledDn > 0 ? costDn / filledDn : 0;
    const hasBoth = filledUp > 0 && filledDn > 0;
    const combinedCents = hasBoth ? (avgUp + avgDn) * 100 : 0;
    return {
      state: this._state,
      paired,
      unpairedUp: filledUp - paired,
      unpairedDn: filledDn - paired,
      combinedCents,
      pairBand: hasBoth ? classifyPairQuality(combinedCents) : null,
      transitionCount: this._transitions.length,
    };
  }
}
