import {
  ApiKeyCreds,
  AssetType,
  ClobClient,
  OrderType,
  Side,
  TickSize,
} from "@polymarket/clob-client-v2";
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
    // V2 SDK uses options-object constructor, `chain` instead of `chainId`
    const temp = new ClobClient({
      host: config.host,
      chain: config.chainId,
      signer,
      signatureType: config.signatureType,
      funderAddress: config.funderAddress,
    });

    let creds = config.apiCreds;
    if (!creds) {
      logger.info("Deriving Polymarket V2 API keys");
      // V2 has a single combined method that derives or creates as needed
      const derived = await temp.createOrDeriveApiKey();
      if (ClobService.isValidCreds(derived)) {
        creds = derived;
        logger.info("V2 API keys ready.");
      } else {
        throw new Error(
          "Unable to create or derive V2 API keys. Check SIGNATURE_TYPE, PRIVATE_KEY, and FUNDER_ADDRESS.",
        );
      }
    }

    const builderCode = process.env.POLY_BUILDER_CODE;
    const client = new ClobClient({
      host: config.host,
      chain: config.chainId,
      signer,
      creds,
      signatureType: config.signatureType,
      funderAddress: config.funderAddress,
      ...(builderCode ? { builderConfig: { builderCode } } : {}),
    });
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
    // Use integer math to avoid floating-point precision issues
    const factor = Math.round(1 / tick);
    const raw = Math.round(price * factor * 1e8) / 1e8; // avoid fp drift
    // Round toward fill: BUY rounds UP (willing to pay more), SELL rounds DOWN (willing to accept less)
    const rounded = side === Side.BUY ? Math.ceil(raw) : Math.floor(raw);
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
  }): Promise<{ orderId: string }> {
    const { tokenId, side } = params;
    const meta = await this.getMarketMeta(tokenId);

    const price = this.roundToTick(params.price, meta.tickSize, side);
    const size = params.size;

    if (size < meta.minOrderSize) {
      throw new Error(`Order size ${size} below minimum ${meta.minOrderSize}`);
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
    return { orderId: (resp as Record<string, unknown>)?.orderID as string ?? "" };
  }

  /**
   * Place a limit order (GTC, maker = 0% fee) and wait for fill.
   * If not filled within timeoutMs, cancel and fallback to FOK (taker).
   * Returns whether the fill was maker (0% fee) or taker.
   */
  async placeLimitThenFOK(params: {
    tokenId: string;
    side: Side;
    price: number;
    size: number;
    timeoutMs?: number;
  }): Promise<{ filled: boolean; orderIds: string[]; maker: boolean }> {
    const timeoutMs = params.timeoutMs ?? 1500;
    const meta = await this.getMarketMeta(params.tokenId);
    const price = this.roundToTick(params.price, meta.tickSize, params.side);

    if (params.size < meta.minOrderSize) {
      this.logger.warn("Order size below minimum", {
        tokenId: params.tokenId,
        size: params.size,
        min: meta.minOrderSize,
      });
      return { filled: false, orderIds: [], maker: false };
    }

    // Step 1: Place limit order (maker = 0% fee on Polymarket crypto markets)
    let orderId: string | null = null;
    try {
      const resp = await this.client.createAndPostOrder(
        {
          tokenID: params.tokenId,
          price,
          side: params.side,
          size: params.size,
        },
        { tickSize: meta.tickSize, negRisk: meta.negRisk },
        OrderType.GTC,
      );
      if (resp?.error) throw new Error(resp.error);
      orderId = resp?.orderID ?? null;
    } catch (err) {
      this.logger.warn("Limit order placement failed, trying FOK", {
        error: (err as Error).message,
      });
    }

    if (!orderId) {
      // Limit order failed — fallback to FOK immediately
      const fokResult = await this.placeMarketOrderFOK({
        tokenId: params.tokenId,
        side: params.side,
        amount: params.size * price,
        worstPrice: price + 0.01,
      });
      return { ...fokResult, maker: false };
    }

    // Step 2: Poll for fill within timeout
    const pollInterval = 300;
    const maxPolls = Math.ceil(timeoutMs / pollInterval);
    for (let i = 0; i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, pollInterval));
      try {
        const filled = await this.getFilledShares(orderId);
        if (filled >= params.size * 0.95) {
          this.logger.info("Limit order filled (maker, 0% fee)", {
            tokenId: params.tokenId.slice(0, 12) + "...",
            price,
            size: params.size,
            filled,
          });
          return { filled: true, orderIds: [orderId], maker: true };
        }
      } catch {
        // poll error, continue
      }
    }

    // Step 3: Not filled — cancel limit order and fallback to FOK
    this.logger.info("Limit order not filled, cancelling → FOK fallback", {
      tokenId: params.tokenId.slice(0, 12) + "...",
      timeoutMs,
    });
    await this.cancelOrder(orderId);

    // Check if partially filled before FOK
    let partialShares = 0;
    try {
      partialShares = await this.getFilledShares(orderId);
    } catch {
      // ignore
    }

    const remainingSize = params.size - partialShares;
    if (remainingSize < meta.minOrderSize) {
      // Mostly filled as maker — good enough
      return { filled: partialShares > 0, orderIds: [orderId], maker: true };
    }

    // FOK for remaining unfilled portion
    const fokResult = await this.placeMarketOrderFOK({
      tokenId: params.tokenId,
      side: params.side,
      amount: remainingSize * price,
      worstPrice: price + 0.01,
    });

    const allOrderIds = [orderId, ...fokResult.orderIds];
    return {
      filled: fokResult.filled || partialShares > 0,
      orderIds: allOrderIds,
      maker: false, // mixed or taker
    };
  }

  /**
   * Place a FOK (Fill or Kill) market order — fills immediately or not at all.
   * Use as fallback when limit order doesn't fill, or for emergency exits.
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
   * Place a FAK (Fill-And-Kill) market order — fills whatever is available, cancels rest.
   * Unlike FOK (all-or-nothing), FAK allows partial fills.
   * Per docs.polymarket.com: "Fills as many shares as available immediately,
   * then cancels any unfilled remainder."
   */
  async placeMarketOrderFAK(params: {
    tokenId: string;
    side: Side;
    amount: number; // USD amount for BUY, shares for SELL
    worstPrice?: number; // slippage protection, not target price
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
        OrderType.FAK,
      );

      const orderIds: string[] = [];
      if (resp?.orderID) orderIds.push(resp.orderID);
      const filled = !resp?.error && orderIds.length > 0;

      this.logger.info("FAK order result", {
        tokenId: params.tokenId.slice(0, 12) + "...",
        side: params.side,
        amount: params.amount,
        filled,
      });

      return { filled, orderIds };
    } catch (err) {
      this.logger.warn("FAK order failed", { error: (err as Error).message });
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
    const signedArgs: Array<{ order: import("@polymarket/clob-client-v2").SignedOrder; orderType: OrderType }> = [];
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
