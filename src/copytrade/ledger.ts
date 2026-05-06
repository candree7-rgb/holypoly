import type { Logger } from "../logger.js";

export interface LedgerEntry {
  leaderAddress: string;
  tokenId: string;
  conditionId: string;
  /** Net shares held attributable to this leader */
  shares: number;
  /** Sum of cost basis (BUYs - SELLs) in USD */
  costBasisUsd: number;
  /** Shares we've decided to sell but order not yet finalized */
  pendingSellShares: number;
  buyFills: number;
  sellFills: number;
  lastBuyAt: number;
  lastSellAt: number;
}

/**
 * Per-leader position ledger. Source of truth for SELL sizing.
 *
 * Why per-leader?
 *   When 2 leaders trade the same token, our wallet holds the SUM of both
 *   positions. A SELL signal from leader A should only sell A's portion,
 *   leaving B's intact. The on-chain `/positions` endpoint can't distinguish.
 *
 * Idempotency:
 *   Every fill carries a unique fillKey. `appliedFills` set ensures the
 *   same physical fill is never applied twice (prevents double-attribution
 *   when both API and chain WS see the same settlement).
 *
 * Reconciliation:
 *   `reconcile(tokenId, onChainShares)` only ever SHRINKS ledger entries
 *   if their sum exceeds on-chain truth. Never grows them — surplus
 *   on-chain shares are attributed to a synthetic "unknown" bucket so
 *   we never refuse to SELL what we own.
 */
export class PositionLedger {
  private entries: Map<string, LedgerEntry> = new Map();
  private appliedFills: Set<string> = new Set();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  private key(leader: string, tokenId: string): string {
    return `${leader.toLowerCase()}:${tokenId}`;
  }

  get(leader: string, tokenId: string): LedgerEntry | null {
    return this.entries.get(this.key(leader, tokenId)) ?? null;
  }

  ensure(leader: string, tokenId: string, conditionId: string): LedgerEntry {
    const k = this.key(leader, tokenId);
    let entry = this.entries.get(k);
    if (!entry) {
      entry = {
        leaderAddress: leader.toLowerCase(),
        tokenId,
        conditionId,
        shares: 0,
        costBasisUsd: 0,
        pendingSellShares: 0,
        buyFills: 0,
        sellFills: 0,
        lastBuyAt: 0,
        lastSellAt: 0,
      };
      this.entries.set(k, entry);
    }
    return entry;
  }

  applyBuyFill(
    leader: string,
    tokenId: string,
    conditionId: string,
    shares: number,
    price: number,
    fillKey: string,
  ): void {
    if (shares <= 0) return;
    if (this.appliedFills.has(fillKey)) return;
    this.appliedFills.add(fillKey);

    const entry = this.ensure(leader, tokenId, conditionId);
    entry.shares += shares;
    entry.costBasisUsd += shares * price;
    entry.buyFills++;
    entry.lastBuyAt = Date.now();

    this.logger.info("Ledger: BUY fill applied", {
      leader: leader.slice(0, 8) + "...",
      tokenId: tokenId.slice(0, 12) + "...",
      shares: shares.toFixed(1),
      price: `${Math.round(price * 100)}¢`,
      ledgerShares: entry.shares.toFixed(1),
    });
  }

  applySellFill(
    leader: string,
    tokenId: string,
    shares: number,
    price: number,
    fillKey: string,
  ): void {
    if (shares <= 0) return;
    if (this.appliedFills.has(fillKey)) return;
    this.appliedFills.add(fillKey);

    const entry = this.entries.get(this.key(leader, tokenId));
    if (!entry) {
      this.logger.warn("Ledger: SELL fill on missing entry", {
        leader: leader.slice(0, 8) + "...",
        tokenId: tokenId.slice(0, 12) + "...",
      });
      return;
    }

    // Reduce shares; cost basis reduces proportionally
    const sharesToRemove = Math.min(shares, entry.shares);
    const avgEntryPrice = entry.shares > 0 ? entry.costBasisUsd / entry.shares : 0;
    entry.shares -= sharesToRemove;
    entry.costBasisUsd -= sharesToRemove * avgEntryPrice;
    entry.pendingSellShares = Math.max(0, entry.pendingSellShares - sharesToRemove);
    entry.sellFills++;
    entry.lastSellAt = Date.now();

    this.logger.info("Ledger: SELL fill applied", {
      leader: leader.slice(0, 8) + "...",
      tokenId: tokenId.slice(0, 12) + "...",
      shares: sharesToRemove.toFixed(1),
      price: `${Math.round(price * 100)}¢`,
      remaining: entry.shares.toFixed(1),
    });
  }

  /** Reserve shares for a SELL we're about to place. Decrement on fill or rollback. */
  reservePendingSell(leader: string, tokenId: string, shares: number): boolean {
    const entry = this.entries.get(this.key(leader, tokenId));
    if (!entry) return false;
    const available = entry.shares - entry.pendingSellShares;
    if (available < shares) {
      this.logger.warn("Ledger: insufficient shares for SELL reservation", {
        leader: leader.slice(0, 8) + "...",
        requested: shares.toFixed(1),
        available: available.toFixed(1),
      });
      return false;
    }
    entry.pendingSellShares += shares;
    return true;
  }

  releasePendingSell(leader: string, tokenId: string, shares: number): void {
    const entry = this.entries.get(this.key(leader, tokenId));
    if (!entry) return;
    entry.pendingSellShares = Math.max(0, entry.pendingSellShares - shares);
  }

  /** Available shares (not already reserved for a pending SELL) */
  availableShares(leader: string, tokenId: string): number {
    const entry = this.entries.get(this.key(leader, tokenId));
    if (!entry) return 0;
    return Math.max(0, entry.shares - entry.pendingSellShares);
  }

  /** Sum of all leaders' attributed shares for this token */
  totalSharesByToken(tokenId: string): number {
    let total = 0;
    for (const e of this.entries.values()) {
      if (e.tokenId === tokenId) total += e.shares;
    }
    return total;
  }

  entriesByToken(tokenId: string): LedgerEntry[] {
    const out: LedgerEntry[] = [];
    for (const e of this.entries.values()) {
      if (e.tokenId === tokenId) out.push(e);
    }
    return out;
  }

  allEntries(): LedgerEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Reconcile against on-chain truth. Only shrinks entries — never grows.
   * If ledgerSum > onChainShares: scale all leader entries pro-rata DOWN.
   * If ledgerSum < onChainShares: do nothing (chalk it up to unknown attribution;
   * the next SELL signal will close those shares anyway).
   */
  reconcile(tokenId: string, onChainShares: number): void {
    const entries = this.entriesByToken(tokenId);
    if (entries.length === 0) return;
    const ledgerSum = entries.reduce((s, e) => s + e.shares, 0);
    if (ledgerSum <= onChainShares * 1.005) return; // 0.5% slack
    const scale = onChainShares / ledgerSum;
    this.logger.warn("Ledger: reconciling shares DOWN", {
      tokenId: tokenId.slice(0, 12) + "...",
      ledgerSum: ledgerSum.toFixed(1),
      onChain: onChainShares.toFixed(1),
      scale: scale.toFixed(4),
    });
    for (const e of entries) {
      e.shares = e.shares * scale;
      e.costBasisUsd = e.costBasisUsd * scale;
      e.pendingSellShares = Math.min(e.pendingSellShares, e.shares);
    }
  }

  /** Prune the appliedFills set when it grows too large. */
  pruneAppliedFills(maxSize = 5000): void {
    if (this.appliedFills.size > maxSize) {
      const arr = Array.from(this.appliedFills);
      this.appliedFills = new Set(arr.slice(-Math.floor(maxSize / 2)));
    }
  }

  getStats(): { totalEntries: number; totalShares: number; totalCostBasis: number; pendingSells: number } {
    let totalShares = 0;
    let totalCostBasis = 0;
    let pendingSells = 0;
    for (const e of this.entries.values()) {
      totalShares += e.shares;
      totalCostBasis += e.costBasisUsd;
      pendingSells += e.pendingSellShares;
    }
    return {
      totalEntries: this.entries.size,
      totalShares,
      totalCostBasis,
      pendingSells,
    };
  }
}
