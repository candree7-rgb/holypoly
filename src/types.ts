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
  /** Set when position is sold before settlement (counter-signal) */
  sold?: boolean;
  soldPnl?: number;
}
