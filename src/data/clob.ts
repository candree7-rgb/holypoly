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
      return parseFloat(result.balance) || 0;
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

    return {
      asks,
      bids,
      bestAsk: asks.length > 0 ? asks[0].price : null,
      bestBid: bids.length > 0 ? bids[0].price : null,
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
   * Place multiple limit orders as a batch.
   * Each order is placed individually but in rapid succession.
   */
  async placeBatchOrders(orders: Array<{
    tokenId: string;
    side: Side;
    price: number;
    size: number;
  }>): Promise<{ placed: number; failed: number }> {
    let placed = 0;
    let failed = 0;

    for (const order of orders) {
      try {
        await this.placeLimitOrder(order);
        placed++;
        this.logger.info("Order placed", {
          tokenId: order.tokenId,
          side: order.side === Side.BUY ? "BUY" : "SELL",
          price: order.price,
          size: order.size,
        });
      } catch (err) {
        failed++;
        this.logger.warn("Order failed", {
          tokenId: order.tokenId,
          error: (err as Error).message,
        });
      }
    }

    return { placed, failed };
  }
}
