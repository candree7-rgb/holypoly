import { Logger } from "../logger.js";
import type { WindowInfo } from "../types.js";

/**
 * CLOB-based market discovery for 5-minute BTC Up/Down markets.
 *
 * These markets are NOT in the Gamma API — they live directly in the CLOB
 * with a predictable slug format: btc-updown-5m-{unix_timestamp}
 *
 * Each slug corresponds to a 5-minute window starting at that timestamp.
 * The CLOB endpoint GET /markets/{condition_id} returns full market data.
 */

interface ClobMarket {
  condition_id: string;
  question: string;
  market_slug: string;
  end_date_iso: string;
  active: boolean;
  closed: boolean;
  accepting_orders: boolean;
  neg_risk: boolean;
  minimum_order_size: number;
  minimum_tick_size: number;
  tokens: Array<{
    token_id: string;
    outcome: string;
    price: number;
    winner: boolean;
  }>;
  tags: string[];
}

export class MarketDiscovery {
  private clobHost: string;
  private currentMarket: WindowInfo | null = null;
  private currentSlug: string | null = null;

  constructor(clobHost: string, private logger: Logger) {
    this.clobHost = clobHost.replace(/\/$/, "");
  }

  /**
   * Find the currently active 5-minute BTC Up/Down market.
   *
   * Strategy: Calculate the current and next window timestamps,
   * construct the slug, and fetch directly from CLOB.
   */
  async findActive5MinBtcMarket(): Promise<WindowInfo | null> {
    const now = Math.floor(Date.now() / 1000);
    const windowSize = 300; // 5 minutes

    // Current window start (rounded down to 5-min boundary)
    const currentWindowStart = Math.floor(now / windowSize) * windowSize;

    // Try current window, then next window
    const candidates = [
      currentWindowStart,
      currentWindowStart + windowSize,
    ];

    for (const windowStart of candidates) {
      const slug = `btc-updown-5m-${windowStart}`;

      // Skip if we already have this market
      if (slug === this.currentSlug && this.currentMarket) {
        return this.currentMarket;
      }

      try {
        const market = await this.fetchMarketBySlug(slug);
        if (!market) continue;

        // Must be active and accepting orders
        if (!market.active || market.closed) continue;

        const upToken = market.tokens.find((t) => t.outcome === "Up");
        const downToken = market.tokens.find((t) => t.outcome === "Down");

        if (!upToken || !downToken) {
          this.logger.warn("Market missing Up/Down tokens", { slug });
          continue;
        }

        const windowEnd = windowStart + windowSize;

        this.currentSlug = slug;
        this.currentMarket = {
          conditionId: market.condition_id,
          upTokenId: upToken.token_id,
          downTokenId: downToken.token_id,
          openingPrice: 0, // Set from Chainlink at window start
          startTime: windowStart * 1000,
          endTime: windowEnd * 1000,
          negRisk: market.neg_risk,
        };

        this.logger.info("Found 5-min BTC market", {
          slug,
          conditionId: market.condition_id.slice(0, 16) + "...",
          window: `${new Date(windowStart * 1000).toISOString()} - ${new Date(windowEnd * 1000).toISOString()}`,
          upPrice: upToken.price,
          downPrice: downToken.price,
        });

        return this.currentMarket;
      } catch (err) {
        this.logger.debug("Market fetch failed", { slug, error: (err as Error).message });
      }
    }

    return null;
  }

  /**
   * Fetch a market from the CLOB by trying to find it via condition_id search.
   * Since CLOB doesn't support slug search directly, we construct
   * condition_id from the known slug pattern.
   */
  private async fetchMarketBySlug(slug: string): Promise<ClobMarket | null> {
    // The CLOB has a /markets endpoint but doesn't filter by slug well.
    // Instead, try the Gamma API which indexes these markets:
    try {
      const gammaUrl = `https://gamma-api.polymarket.com/markets?slug=${slug}&limit=1`;
      const resp = await fetch(gammaUrl, {
        headers: { Accept: "application/json", "User-Agent": "holypoly-bot" },
      });
      if (resp.ok) {
        const data = (await resp.json()) as Array<{
          conditionId: string;
          clobTokenIds: string;
          outcomes: string;
          endDateIso: string;
          active: boolean;
          closed: boolean;
          negRisk: boolean;
        }>;
        if (data.length > 0) {
          const m = data[0];
          const tokenIds = JSON.parse(m.clobTokenIds || "[]") as string[];
          const outcomes = JSON.parse(m.outcomes || "[]") as string[];
          return {
            condition_id: m.conditionId,
            question: "",
            market_slug: slug,
            end_date_iso: m.endDateIso,
            active: m.active,
            closed: m.closed,
            accepting_orders: m.active && !m.closed,
            neg_risk: m.negRisk,
            minimum_order_size: 5,
            minimum_tick_size: 0.01,
            tokens: tokenIds.map((id, i) => ({
              token_id: id,
              outcome: outcomes[i] || (i === 0 ? "Up" : "Down"),
              price: 0.5,
              winner: false,
            })),
            tags: ["5M"],
          };
        }
      }
    } catch {
      // Gamma failed, try CLOB directly
    }

    // Fallback: try CLOB /markets?market_slug=
    // Note: CLOB slug search is unreliable, but we can try
    try {
      const clobUrl = `${this.clobHost}/markets?market_slug=${slug}`;
      const resp = await fetch(clobUrl, {
        headers: { Accept: "application/json", "User-Agent": "holypoly-bot" },
      });
      if (resp.ok) {
        const data = (await resp.json()) as { data?: ClobMarket[] } | ClobMarket[];
        const markets = Array.isArray(data) ? data : (data.data || []);
        const match = markets.find((m) => m.market_slug === slug);
        if (match) return match;
      }
    } catch {
      // CLOB also failed
    }

    return null;
  }

  /**
   * Clear cached market (call when window ends).
   */
  clearCurrent(): void {
    this.currentMarket = null;
    this.currentSlug = null;
  }
}
