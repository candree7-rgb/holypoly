import type { Logger } from "../logger.js";
import type { ClobWsClient, BookSnapshot } from "../data/clob-ws.js";
import type { SimulatedFill } from "../types.js";
import { polymarketCryptoFee } from "../utils.js";

/**
 * DryRunEngine: Realistic fill simulation against the LIVE orderbook.
 *
 * When DRY_RUN=true, we still connect to the real CLOB WebSocket
 * (no auth needed for market channel) and simulate FOK fills against
 * the actual orderbook state.
 *
 * Conservative assumptions:
 * - FOK: only filled if FULL size available at or below maxPrice
 * - We do NOT have queue priority (we're not really in the book)
 * - Taker fees (2%) applied to all fills (realistic worst-case)
 * - Fills consume liquidity from the snapshot (subsequent orders see less depth)
 */
export class DryRunEngine {
  private virtualBalance: number;
  private virtualUpShares = 0;
  private virtualDnShares = 0;
  private virtualUpCost = 0;
  private virtualDnCost = 0;
  private virtualMergeProfit = 0;
  private totalTakerFees = 0;
  private fillLog: Array<{
    timestamp: number;
    side: "Up" | "Down";
    size: number;
    avgPrice: number;
    cost: number;
    type: "FOK" | "GTC";
  }> = [];
  private mergeLog: Array<{
    timestamp: number;
    merged: number;
    recovered: number;
    profit: number;
  }> = [];

  constructor(
    private clobWs: ClobWsClient,
    private takerFeeRate: number,
    initialBalance: number,
    private logger: Logger,
  ) {
    this.virtualBalance = initialBalance;
  }

  get balance(): number {
    return this.virtualBalance;
  }

  get upShares(): number {
    return this.virtualUpShares;
  }

  get dnShares(): number {
    return this.virtualDnShares;
  }

  get upCost(): number {
    return this.virtualUpCost;
  }

  get dnCost(): number {
    return this.virtualDnCost;
  }

  get mergeProfit(): number {
    return this.virtualMergeProfit;
  }

  get fees(): number {
    return this.totalTakerFees;
  }

  get fills() {
    return this.fillLog;
  }

  get merges() {
    return this.mergeLog;
  }

  /**
   * Simulate a FOK buy order against the LIVE orderbook.
   * FOK = Fill-or-Kill: entire size must be fillable or order is rejected.
   *
   * V3: No consumed liquidity subtracted — each order sees the fresh WS book.
   * The 2s sleep between orders + MM replenishment means the book is real-time.
   */
  simulateFokBuy(
    tokenId: string,
    size: number,
    maxPrice: number,
    side: "Up" | "Down",
  ): SimulatedFill {
    const book = this.clobWs.getBook(tokenId);
    if (!book || book.asks.length === 0) {
      this.logger.debug("DRY_RUN: No orderbook for FOK simulation", { tokenId: tokenId.slice(0, 12) });
      return { filled: false, filledSize: 0, avgPrice: 0, totalCost: 0, levelsUsed: 0, timestamp: Date.now() };
    }

    // Walk through LIVE asks directly — no consumed liquidity subtraction.
    // The WS book is real-time; between 2s-spaced orders, MMs replenish depth.
    let remaining = size;
    let totalCost = 0;
    let levelsUsed = 0;

    for (const level of book.asks) {
      if (level.price > maxPrice) break;

      const fillAtLevel = Math.min(remaining, level.size);
      if (fillAtLevel <= 0) continue;

      totalCost += fillAtLevel * level.price;
      remaining -= fillAtLevel;
      levelsUsed++;

      if (remaining <= 0) break;
    }

    // FOK: must fill entire size
    if (remaining > 0) {
      this.logger.debug("DRY_RUN: FOK rejected (insufficient depth)", {
        side,
        requested: size.toFixed(1),
        fillable: (size - remaining).toFixed(1),
        maxPrice: `${(maxPrice * 100).toFixed(0)}¢`,
      });
      return { filled: false, filledSize: 0, avgPrice: 0, totalCost: 0, levelsUsed: 0, timestamp: Date.now() };
    }

    const avgPrice = totalCost / size;
    // Polymarket crypto fee curve (not flat %)
    const fee = polymarketCryptoFee(size, avgPrice);
    const totalWithFee = totalCost + fee;

    // Update virtual state
    if (side === "Up") {
      this.virtualUpShares += size;
      this.virtualUpCost += totalWithFee;
    } else {
      this.virtualDnShares += size;
      this.virtualDnCost += totalWithFee;
    }
    this.virtualBalance -= totalWithFee;
    this.totalTakerFees += fee;

    this.fillLog.push({
      timestamp: Date.now(),
      side,
      size,
      avgPrice,
      cost: totalWithFee,
      type: "FOK",
    });

    this.logger.info("DRY_RUN: FOK filled", {
      side,
      size: size.toFixed(1),
      avgPrice: `${(avgPrice * 100).toFixed(1)}¢`,
      cost: `$${totalCost.toFixed(2)}`,
      fee: `$${fee.toFixed(3)}`,
      levelsUsed,
    });

    return {
      filled: true,
      filledSize: size,
      avgPrice,
      totalCost: totalWithFee,
      levelsUsed,
      timestamp: Date.now(),
    };
  }

  /**
   * Simulate a merge: burn equal Up+Down shares, recover $1.00/share.
   * Returns the number actually merged and profit.
   */
  simulateMerge(amount: number): { merged: number; recovered: number; profit: number } {
    const matched = Math.min(amount, this.virtualUpShares, this.virtualDnShares);
    if (matched <= 0) {
      return { merged: 0, recovered: 0, profit: 0 };
    }

    const recovered = matched * 1.0; // $1.00 per merged share

    // Calculate proportional cost for merged shares
    const totalShares = this.virtualUpShares + this.virtualDnShares;
    const totalCost = this.virtualUpCost + this.virtualDnCost;
    const costPerShare = totalShares > 0 ? totalCost / totalShares : 0;
    const mergedCost = matched * 2 * costPerShare; // 2 shares (1 up + 1 down) per merged unit
    // More accurate: use per-side avg cost
    const upAvgCost = this.virtualUpShares > 0 ? this.virtualUpCost / this.virtualUpShares : 0;
    const dnAvgCost = this.virtualDnShares > 0 ? this.virtualDnCost / this.virtualDnShares : 0;
    const actualMergedCost = matched * (upAvgCost + dnAvgCost);
    const profit = recovered - actualMergedCost;

    // Update virtual state
    this.virtualUpShares -= matched;
    this.virtualDnShares -= matched;
    // Proportionally reduce costs
    if (this.virtualUpShares > 0) {
      this.virtualUpCost -= matched * upAvgCost;
    } else {
      this.virtualUpCost = 0;
    }
    if (this.virtualDnShares > 0) {
      this.virtualDnCost -= matched * dnAvgCost;
    } else {
      this.virtualDnCost = 0;
    }
    this.virtualBalance += recovered;
    this.virtualMergeProfit += profit;

    this.mergeLog.push({
      timestamp: Date.now(),
      merged: matched,
      recovered,
      profit,
    });

    this.logger.info("DRY_RUN: Merge simulated", {
      merged: matched.toFixed(1),
      recovered: `$${recovered.toFixed(2)}`,
      profit: `$${profit.toFixed(3)}`,
      combinedCostCents: `${((upAvgCost + dnAvgCost) * 100).toFixed(1)}¢`,
      remainingUp: this.virtualUpShares.toFixed(1),
      remainingDn: this.virtualDnShares.toFixed(1),
    });

    return { merged: matched, recovered, profit };
  }

  /**
   * Simulate a GTC buy order — allows partial fills (unlike FOK).
   * V3: Uses fresh WS book directly, no consumed liquidity subtraction.
   */
  simulateGtcFill(
    tokenId: string,
    size: number,
    maxPrice: number,
    side: "Up" | "Down",
  ): { filled: boolean; filledSize: number; avgPrice: number; totalCost: number } {
    const book = this.clobWs.getBook(tokenId);
    if (!book || book.asks.length === 0) {
      this.logger.debug("DRY_RUN: No orderbook for GTC simulation", { tokenId: tokenId.slice(0, 12) });
      return { filled: false, filledSize: 0, avgPrice: 0, totalCost: 0 };
    }

    let remaining = size;
    let totalCost = 0;

    // Walk LIVE asks directly — no consumed subtraction (V3: MMs replenish between orders)
    for (const level of book.asks) {
      if (level.price > maxPrice) break;

      const fillAtLevel = Math.min(remaining, level.size);
      if (fillAtLevel <= 0) continue;

      totalCost += fillAtLevel * level.price;
      remaining -= fillAtLevel;
      if (remaining <= 0) break;
    }

    const filledSize = size - remaining;
    if (filledSize <= 0) {
      this.logger.debug("DRY_RUN: GTC no fills available", { side, maxPrice: `${(maxPrice * 100).toFixed(0)}¢` });
      return { filled: false, filledSize: 0, avgPrice: 0, totalCost: 0 };
    }

    const avgPrice = totalCost / filledSize;
    // Polymarket crypto fee curve (not flat %)
    const fee = polymarketCryptoFee(filledSize, avgPrice);
    const totalWithFee = totalCost + fee;

    // Update virtual state
    if (side === "Up") {
      this.virtualUpShares += filledSize;
      this.virtualUpCost += totalWithFee;
    } else {
      this.virtualDnShares += filledSize;
      this.virtualDnCost += totalWithFee;
    }
    this.virtualBalance -= totalWithFee;
    this.totalTakerFees += fee;

    this.fillLog.push({
      timestamp: Date.now(),
      side,
      size: filledSize,
      avgPrice,
      cost: totalWithFee,
      type: "GTC",
    });

    this.logger.info("DRY_RUN: GTC filled (partial ok)", {
      side,
      requested: size.toFixed(1),
      filled: filledSize.toFixed(1),
      avgPrice: `${(avgPrice * 100).toFixed(1)}¢`,
      cost: `$${totalCost.toFixed(2)}`,
      fee: `$${fee.toFixed(3)}`,
    });

    return { filled: true, filledSize, avgPrice, totalCost: totalWithFee };
  }

  /**
   * Simulate a limit order: post at limitPrice, wait up to timeoutMs,
   * check if the live ask drops to or below our limit price.
   * If filled → 0% maker fee. If not → return unfilled.
   *
   * In dry-run we check the current ask: if ask ≤ limitPrice, we assume
   * a fill would occur. This is conservative since in reality we'd need
   * to wait for the ask to cross our price.
   */
  async simulateLimitOrder(
    tokenId: string,
    size: number,
    limitPrice: number,
    side: "Up" | "Down",
    timeoutMs: number,
  ): Promise<{ filled: boolean; filledSize: number; avgPrice: number; totalCost: number }> {
    // Check periodically if the ask crosses our limit price
    const checkInterval = 200;
    const checks = Math.ceil(timeoutMs / checkInterval);
    const { sleep } = await import("../utils.js");

    for (let i = 0; i < checks; i++) {
      const book = this.clobWs.getBook(tokenId);
      if (book && book.asks.length > 0) {
        const bestAsk = book.asks[0].price;
        if (bestAsk <= limitPrice) {
          // Fill at the ask price (we're a maker sitting at limitPrice, we get filled at our price)
          const fillPrice = limitPrice;
          const totalCost = size * fillPrice; // 0% maker fee!

          if (side === "Up") {
            this.virtualUpShares += size;
            this.virtualUpCost += totalCost;
          } else {
            this.virtualDnShares += size;
            this.virtualDnCost += totalCost;
          }
          this.virtualBalance -= totalCost;
          // No fee for maker!

          this.fillLog.push({
            timestamp: Date.now(),
            side,
            size,
            avgPrice: fillPrice,
            cost: totalCost,
            type: "GTC",
          });

          this.logger.info("DRY_RUN: Limit filled (0% maker fee)", {
            side,
            size: size.toFixed(1),
            limitPrice: `${(limitPrice * 100).toFixed(1)}¢`,
            ask: `${(bestAsk * 100).toFixed(1)}¢`,
            cost: `$${totalCost.toFixed(2)}`,
          });

          return { filled: true, filledSize: size, avgPrice: fillPrice, totalCost };
        }
      }
      await sleep(checkInterval);
    }

    this.logger.debug("DRY_RUN: Limit order timed out", {
      side,
      limitPrice: `${(limitPrice * 100).toFixed(1)}¢`,
      timeoutMs,
    });
    return { filled: false, filledSize: 0, avgPrice: 0, totalCost: 0 };
  }

  /**
   * Get the current orderbook for pre-flight checks.
   * Returns null if no book available.
   */
  getBook(tokenId: string): BookSnapshot | null {
    return this.clobWs.getBook(tokenId);
  }

  /**
   * Simulate fill against asks to estimate average price at a given depth.
   * Used for pre-trade combined cost checks.
   */
  simulateDepth(tokenId: string, targetSize: number): { canFill: boolean; avgPrice: number; levelsAvailable: number } {
    const book = this.clobWs.getBook(tokenId);
    if (!book || book.asks.length === 0) {
      return { canFill: false, avgPrice: 0, levelsAvailable: 0 };
    }

    let remaining = targetSize;
    let totalCost = 0;

    for (const level of book.asks) {
      const fill = Math.min(remaining, level.size);
      if (fill <= 0) continue;
      totalCost += fill * level.price;
      remaining -= fill;
      if (remaining <= 0) break;
    }

    const filled = targetSize - remaining;
    return {
      canFill: remaining <= 0,
      avgPrice: filled > 0 ? totalCost / filled : 0,
      levelsAvailable: book.asks.length,
    };
  }

  /**
   * Get the live book view (V3: no consumed liquidity adjustment).
   * The WS book is real-time — between 2s-spaced orders, MMs replenish.
   */
  getBookView(tokenId: string): BookSnapshot | null {
    return this.clobWs.getBook(tokenId);
  }

  /**
   * Record a maker fill (V5). Maker fee = 0%.
   * Called by the executor when a DRY_RUN maker bid is "filled"
   * (bestAsk crossed down to our bid price).
   */
  recordMakerFill(side: "Up" | "Down", size: number, price: number): void {
    const cost = size * price; // 0% maker fee!

    if (side === "Up") {
      this.virtualUpShares += size;
      this.virtualUpCost += cost;
    } else {
      this.virtualDnShares += size;
      this.virtualDnCost += cost;
    }
    this.virtualBalance -= cost;
    // Note: NO fee added to totalTakerFees (maker = 0%)

    this.fillLog.push({
      timestamp: Date.now(),
      side,
      size,
      avgPrice: price,
      cost,
      type: "GTC",
    });

    this.logger.info("DRY_RUN: Maker fill (0% fee)", {
      side,
      size: size.toFixed(1),
      price: `${(price * 100).toFixed(1)}¢`,
      cost: `$${cost.toFixed(2)}`,
      fee: "$0.00 (maker)",
    });
  }

  /** Reset state for a new window */
  resetWindow(): void {
    this.virtualUpShares = 0;
    this.virtualDnShares = 0;
    this.virtualUpCost = 0;
    this.virtualDnCost = 0;
    this.virtualMergeProfit = 0;
    this.totalTakerFees = 0;
    this.fillLog = [];
    this.mergeLog = [];
  }

  /** Update balance (e.g. after fetching real balance for initial state) */
  setBalance(balance: number): void {
    this.virtualBalance = balance;
  }

}
