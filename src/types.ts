export type TradeSide = "Up" | "Down";

export interface WindowInfo {
  /** Condition ID of the active 5-min market */
  conditionId: string;
  /** Token ID for "Up" outcome */
  upTokenId: string;
  /** Token ID for "Down" outcome */
  downTokenId: string;
  /** BTC price at window open (Price to Beat) */
  openingPrice: number;
  /** Window start timestamp (ms) */
  startTime: number;
  /** Window end timestamp (ms) */
  endTime: number;
  /** Whether this is a neg-risk market */
  negRisk: boolean;
}

export interface GridOrder {
  side: TradeSide;
  tokenId: string;
  price: number; // in cents (0-100)
  amount: number; // USD amount per order
}

export interface WindowResult {
  windowStart: number;
  traded: boolean;
  orders: GridOrder[];
  fillCount: number;
  primarySide: TradeSide | null;
  pnl: number | null; // null until settled
  winner: TradeSide | null;
}

export interface Position {
  conditionId: string;
  asset: string;
  outcomeIndex: number;
  size: number;
  avgPrice?: number;
  curPrice?: number;
  redeemable?: boolean;
  negativeRisk?: boolean;
  outcome?: string;
}

// === Merge-Arb Strategy Types (V3) ===

/** Result of a single buy order in the V3 accumulate loop */
export interface OrderFill {
  orderNum: number;
  side: TradeSide;
  filledSize: number;
  avgPrice: number;
  totalCost: number;
  fee: number;
  timestamp: number;
}

/** Result of a single Up+Down pair execution (legacy, kept for DB compat) */
export interface PairResult {
  pairNum: number;
  upFilled: number;
  upCost: number;
  upPrice: number;
  dnFilled: number;
  dnCost: number;
  dnPrice: number;
  /** Combined cost in cents (upPrice + dnPrice) */
  combinedCents: number;
  /** Absolute share imbalance |up - down| */
  imbalance: number;
}

/** Result of a merge operation */
export interface MergeResult {
  merged: number;
  recovered: number;
  profit: number;
  timestamp: number;
}

/** Complete result of one window's merge-arb execution */
export interface WindowExecutionResult {
  conditionId: string;
  windowStart: number;
  windowEnd: number;
  /** V3: individual order fills */
  orderFills: OrderFill[];
  /** Legacy pair grouping (for DB compat) */
  pairs: PairResult[];
  merges: MergeResult[];
  totalUpShares: number;
  totalDnShares: number;
  totalUpCost: number;
  totalDnCost: number;
  totalMerged: number;
  totalMergeProfit: number;
  remainingUp: number;
  remainingDn: number;
  totalCost: number;
  avgCombinedCents: number;
  takerFees: number;
  dryRun: boolean;
  skipped: boolean;
  skipReason?: string;
}

/** Simulated FOK fill result (used by DryRunEngine) */
export interface SimulatedFill {
  filled: boolean;
  filledSize: number;
  avgPrice: number;
  totalCost: number;
  levelsUsed: number;
  timestamp: number;
}

/** Tracks a live position entered via webhook signal */
export interface ActivePosition {
  conditionId: string;
  side: TradeSide;
  tokenId: string;
  entryPriceCents: number;
  shares: number;
  costUsd: number;
  orderIds: string[];
  openingPrice: number;
  windowStart: number;
  windowEnd: number;
  balanceBefore: number;
}
