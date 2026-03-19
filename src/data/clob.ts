import {
  ApiKeyCreds,
  AssetType,
  ClobClient,
  OrderType,
  Side,
  TickSize,
} from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { Logger } from "../logger.js";

export interface ClobConfig {
  host: string;
  chainId: number;
  privateKey: string;
  signatureType: number;
  funderAddress?: string;
  apiCreds?: ApiKeyCreds;
}

export interface MarketMeta {
  tickSize: TickSize;
  minOrderSize: number;
  negRisk: boolean;
}

export interface OrderbookLevel {
  price: number;
  size: number;
}

export interface OrderbookSnapshot {
  asks: OrderbookLevel[];
  bids: OrderbookLevel[];
  bestAsk: number | null;
  bestBid: number | null;
  /** Total bid depth (USDC) across all levels */
  bidDepthUsd: number;
  /** Total ask depth (USDC) across all levels */
  askDepthUsd: number;
  /** Bid/Ask imbalance ratio: >1 = more buy pressure, <1 = more sell pressure */
  depthImbalance: number;
}

export class ClobService {
  private client: ClobClient;
  private logger: Logger;
  private metaCache: Map<string, { meta: MarketMeta; ts: number }> = new Map();

  private static isValidCreds(creds: unknown): creds is ApiKeyCreds {
    if (!creds || typeof creds !== "object") return false;
    const c = creds as ApiKeyCreds;
    return Boolean(c.key && c.secret && c.passphrase);
  }

  private constructor(client: ClobClient, logger: Logger) {
    this.client = client;
    this.logger = logger;
  }

  static async init(config: ClobConfig, logger: Logger): Promise<ClobService> {
    const signer = new Wallet(config.privateKey);
    const temp = new ClobClient(
      config.host,
      config.chainId,
      signer,
      undefined,
      config.signatureType,
      config.funderAddress,
    );

    let creds = config.apiCreds;
    if (!creds) {
      logger.info("Deriving Polymarket API keys");
      const derived = await temp.deriveApiKey();
      if (ClobService.isValidCreds(derived)) {
        creds = derived;
        logger.info("Derived API keys.");
      } else {
        logger.warn("No existing API keys found, attempting create");
        const created = await temp.createApiKey();
        if (ClobService.isValidCreds(created)) {
          creds = created;
          logger.info("Created API keys.");
        } else {
          throw new Error(
            "Unable to create or derive API keys. Check SIGNATURE_TYPE, PRIVATE_KEY, and PROFILE_ADDRESS.",
          );
        }
      }
    }

    const client = new ClobClient(
      config.host,
      config.chainId,
      signer,
      creds,
      config.signatureType,
      config.funderAddress,
    );
    return new ClobService(client, logger);
  }

  /**
   * Get USDC balance from Polymarket account.
   * Uses the CLOB getBalanceAllowance endpoint (L2 authenticated).
   */
  async getBalance(): Promise<number> {
    try {
      const result = await this.client.getBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
      });
      // Balance is returned in micro-USDC (6 decimals), convert to USD
      const raw = parseFloat(result.balance) || 0;
      return raw / 1e6;
    } catch (err) {
      this.logger.warn("Failed to get balance", { error: (err as Error).message });
      return 0;
    }
  }

  async getMarketMeta(tokenId: string): Promise<MarketMeta> {
    const cached = this.metaCache.get(tokenId);
    const now = Date.now();
    if (cached && now - cached.ts < 5 * 60 * 1000) return cached.meta;

    const ob = await this.client.getOrderBook(tokenId);
    const meta: MarketMeta = {
      tickSize: ob.tick_size as TickSize,
      minOrderSize: Number(ob.min_order_size),
      negRisk: Boolean(ob.neg_risk),
    };
    this.metaCache.set(tokenId, { meta, ts: now });
    return meta;
  }

  /**
   * Get orderbook snapshot for a token.
   */
  async getOrderbook(tokenId: string): Promise<OrderbookSnapshot> {
    const ob = await this.client.getOrderBook(tokenId);
    const asks: OrderbookLevel[] = (ob.asks || []).map((a: { price: string; size: string }) => ({
      price: parseFloat(a.price),
      size: parseFloat(a.size),
    })).sort((a: OrderbookLevel, b: OrderbookLevel) => a.price - b.price);

    const bids: OrderbookLevel[] = (ob.bids || []).map((b: { price: string; size: string }) => ({
      price: parseFloat(b.price),
      size: parseFloat(b.size),
    })).sort((a: OrderbookLevel, b: OrderbookLevel) => b.price - a.price);

    const bidDepthUsd = bids.reduce((sum, b) => sum + b.price * b.size, 0);
    const askDepthUsd = asks.reduce((sum, a) => sum + a.price * a.size, 0);
    const depthImbalance = askDepthUsd > 0 ? bidDepthUsd / askDepthUsd : bidDepthUsd > 0 ? 10 : 1;

    return {
      asks,
      bids,
      bestAsk: asks.length > 0 ? asks[0].price : null,
      bestBid: bids.length > 0 ? bids[0].price : null,
      bidDepthUsd,
      askDepthUsd,
      depthImbalance,
    };
  }

  private roundToTick(price: number, tickSize: TickSize, side: Side): number {
    const tick = Number(tickSize);
    if (!Number.isFinite(tick) || tick <= 0) return price;
    const factor = 1 / tick;
    const raw = price * factor;
    const rounded = side === Side.BUY ? Math.floor(raw) : Math.ceil(raw);
    const result = rounded / factor;
    const decimals = tickSize.includes("0.0001")
      ? 4
      : tickSize.includes("0.001")
        ? 3
        : tickSize.includes("0.01")
          ? 2
          : 1;
    return Number(result.toFixed(decimals));
  }

  /**
   * Place a single limit order. Used in batch order placement.
   */
  async placeLimitOrder(params: {
    tokenId: string;
    side: Side;
    price: number;
    size: number;
  }): Promise<void> {
    const { tokenId, side } = params;
    const meta = await this.getMarketMeta(tokenId);

    const price = this.roundToTick(params.price, meta.tickSize, side);
    const size = params.size;

    if (size < meta.minOrderSize) {
      this.logger.warn("Order size below minimum", {
        tokenId,
        size,
        min: meta.minOrderSize,
      });
      return;
    }

    const resp = await this.client.createAndPostOrder(
      {
        tokenID: tokenId,
        price,
        side,
        size,
      },
      { tickSize: meta.tickSize, negRisk: meta.negRisk },
      OrderType.GTC,
    );
    if (resp?.error) {
      throw new Error(resp.error);
    }
    if (resp?.status && resp.status >= 400) {
      throw new Error(`Order failed (status ${resp.status})`);
    }
  }

  /**
   * Place a FOK (Fill or Kill) market order — fills immediately or not at all.
   * Use for winner entry to prevent stale fills after edge evaporates.
   */
  async placeMarketOrderFOK(params: {
    tokenId: string;
    side: Side;
    amount: number; // USD amount for BUY, shares for SELL
    worstPrice?: number; // max price willing to pay (price protection)
  }): Promise<{ filled: boolean; orderIds: string[] }> {
    const meta = await this.getMarketMeta(params.tokenId);

    try {
      const resp = await this.client.createAndPostMarketOrder(
        {
          tokenID: params.tokenId,
          side: params.side,
          amount: params.amount,
          ...(params.worstPrice ? { price: this.roundToTick(params.worstPrice, meta.tickSize, params.side) } : {}),
        },
        { tickSize: meta.tickSize, negRisk: meta.negRisk },
        OrderType.FOK,
      );

      const orderIds: string[] = [];
      if (resp?.orderID) orderIds.push(resp.orderID);
      const filled = !resp?.error && orderIds.length > 0;

      this.logger.info("FOK order result", {
        tokenId: params.tokenId.slice(0, 12) + "...",
        side: params.side,
        amount: params.amount,
        filled,
      });

      return { filled, orderIds };
    } catch (err) {
      this.logger.warn("FOK order failed", { error: (err as Error).message });
      return { filled: false, orderIds: [] };
    }
  }

  /**
   * Place multiple limit orders in a single API call via POST /orders.
   * Signs all orders first, then posts them as one batch.
   * @param orderType - GTC (default) for resting orders, FOK for immediate fill
   */
  async placeBatchOrders(orders: Array<{
    tokenId: string;
    side: Side;
    price: number;
    size: number;
  }>, orderType: OrderType = OrderType.GTC): Promise<{ placed: number; failed: number; orderIds: string[] }> {
    if (orders.length === 0) return { placed: 0, failed: 0, orderIds: [] };

    // Get meta for tick size rounding (cache hit after first call)
    const firstMeta = await this.getMarketMeta(orders[0].tokenId);

    // Sign all orders
    const signedArgs: Array<{ order: import("@polymarket/clob-client").SignedOrder; orderType: OrderType }> = [];
    let skipped = 0;

    for (const order of orders) {
      const meta = await this.getMarketMeta(order.tokenId);
      const price = this.roundToTick(order.price, meta.tickSize, order.side);

      if (order.size < meta.minOrderSize) {
        this.logger.warn("Order size below minimum", {
          tokenId: order.tokenId,
          size: order.size,
          min: meta.minOrderSize,
        });
        skipped++;
        continue;
      }

      try {
        const signed = await this.client.createOrder(
          { tokenID: order.tokenId, price, side: order.side, size: order.size },
          { tickSize: meta.tickSize, negRisk: meta.negRisk },
        );
        signedArgs.push({ order: signed, orderType });
      } catch (err) {
        this.logger.warn("Order signing failed", {
          tokenId: order.tokenId,
          error: (err as Error).message,
        });
        skipped++;
      }
    }

    if (signedArgs.length === 0) {
      return { placed: 0, failed: skipped, orderIds: [] };
    }

    // Post all signed orders in one API call
    try {
      const resp = await this.client.postOrders(signedArgs);
      this.logger.info("Batch posted", {
        submitted: signedArgs.length,
        response: resp,
      });
      // Extract order IDs from response (array of OrderResponse or similar)
      const orderIds: string[] = [];
      if (Array.isArray(resp)) {
        for (const r of resp) {
          if (r?.orderID) orderIds.push(r.orderID);
        }
      }
      return { placed: signedArgs.length, failed: skipped, orderIds };
    } catch (err) {
      this.logger.error("Batch post failed", { error: (err as Error).message });
      return { placed: 0, failed: orders.length, orderIds: [] };
    }
  }

  /**
   * Cancel a specific order by ID.
   */
  async cancelOrder(orderId: string): Promise<void> {
    try {
      await this.client.cancelOrder({ orderID: orderId });
      this.logger.debug("Order cancelled", { orderId: orderId.slice(0, 12) + "..." });
    } catch (err) {
      this.logger.warn("Failed to cancel order", {
        orderId: orderId.slice(0, 12) + "...",
        error: (err as Error).message,
      });
    }
  }

  /**
   * Get filled shares for a specific order.
   */
  async getFilledShares(orderId: string): Promise<number> {
    try {
      const order = await this.client.getOrder(orderId);
      return parseFloat(order.size_matched) || 0;
    } catch (err) {
      this.logger.warn("Failed to get fill status", {
        orderId: orderId.slice(0, 12) + "...",
        error: (err as Error).message,
      });
      return 0;
    }
  }

  /**
   * Query actual fill data for placed orders using the trades endpoint.
   * Uses getTrades() for actual execution prices (not limit prices).
   * Falls back to getOrder() if trades lookup fails.
   */
  async getOrderFills(orderIds: string[], conditionId?: string): Promise<Array<{
    orderID: string;
    sizeMatched: number;
    price: number;
    costFilled: number;
    tokenId: string;
  }>> {
    const fills: Array<{ orderID: string; sizeMatched: number; price: number; costFilled: number; tokenId: string }> = [];
    const orderIdSet = new Set(orderIds);

    // Try trades endpoint first for actual execution prices
    if (conditionId) {
      try {
        const trades = await this.client.getTrades({ market: conditionId });
        for (const trade of trades) {
          // Check if we're the taker on this trade
          if (orderIdSet.has(trade.taker_order_id)) {
            const size = parseFloat(trade.size) || 0;
            const price = parseFloat(trade.price) || 0;
            if (size > 0) {
              fills.push({
                orderID: trade.taker_order_id,
                sizeMatched: size,
                price,
                costFilled: size * price,
                tokenId: trade.asset_id,
              });
            }
            continue;
          }

          // Check if we're the maker on this trade
          for (const makerOrder of trade.maker_orders) {
            if (orderIdSet.has(makerOrder.order_id)) {
              const size = parseFloat(makerOrder.matched_amount) || 0;
              const price = parseFloat(makerOrder.price) || 0;
              if (size > 0) {
                fills.push({
                  orderID: makerOrder.order_id,
                  sizeMatched: size,
                  price,
                  costFilled: size * price,
                  tokenId: trade.asset_id,
                });
              }
            }
          }
        }

        if (fills.length > 0) {
          this.logger.info("Using trades endpoint for accurate fill prices", {
            tradeCount: fills.length,
          });
          return fills;
        }
      } catch (err) {
        this.logger.warn("Failed to query trades, falling back to order-based fills", {
          error: (err as Error).message,
        });
      }
    }

    // Fallback: use order data (limit price, may differ from actual fill price)
    for (const id of orderIds) {
      try {
        const order = await this.client.getOrder(id);
        const sizeMatched = parseFloat(order.size_matched) || 0;
        const price = parseFloat(order.price) || 0;
        fills.push({
          orderID: id,
          sizeMatched,
          price,
          costFilled: sizeMatched * price,
          tokenId: order.asset_id,
        });
      } catch (err) {
        this.logger.warn("Failed to query order fill", {
          orderID: id,
          error: (err as Error).message,
        });
      }
    }
    return fills;
  }
}
