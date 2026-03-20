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
  start_time_ms?: number;
  end_time_ms?: number;
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
        const market = await this.fetchMarketBySlug(slug, windowStart, windowSize);
        if (!market) continue;

        // Must be active and accepting orders
        if (!market.active || market.closed) continue;

        const upToken = market.tokens.find((t) => t.outcome === "Up");
        const downToken = market.tokens.find((t) => t.outcome === "Down");

        if (!upToken || !downToken) {
          this.logger.warn("Market missing Up/Down tokens", { slug });
          continue;
        }

        // Use precise timestamps from Gamma API if available, else calculate from slug
        const startMs = market.start_time_ms ?? windowStart * 1000;
        const endMs = market.end_time_ms ?? (windowStart + windowSize) * 1000;

        this.currentSlug = slug;
        this.currentMarket = {
          conditionId: market.condition_id,
          upTokenId: upToken.token_id,
          downTokenId: downToken.token_id,
          openingPrice: 0, // Set from Chainlink at window start
          startTime: startMs,
          endTime: endMs,
          negRisk: market.neg_risk,
        };

        this.logger.info("Found 5-min BTC market", {
          slug,
          conditionId: market.condition_id.slice(0, 16) + "...",
          window: `${new Date(startMs).toISOString()} - ${new Date(endMs).toISOString()}`,
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
  private async fetchMarketBySlug(slug: string, windowStartSec: number, windowSizeSec: number): Promise<ClobMarket | null> {
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
          outcomePrices: string;
          endDateIso: string;
          endDate: string;
          eventStartTime: string;
          active: boolean;
          closed: boolean;
          negRisk: boolean;
        }>;
        if (data.length > 0) {
          const m = data[0];
          const tokenIds = JSON.parse(m.clobTokenIds || "[]") as string[];
          const outcomes = JSON.parse(m.outcomes || "[]") as string[];
          const prices = JSON.parse(m.outcomePrices || "[]") as string[];

          // Use precise timestamps from Gamma API
          const startMs = m.eventStartTime
            ? new Date(m.eventStartTime).getTime()
            : windowStartSec * 1000;
          const endMs = m.endDate
            ? new Date(m.endDate).getTime()
            : startMs + windowSizeSec * 1000;

          return {
            condition_id: m.conditionId,
            question: "",
            market_slug: slug,
            end_date_iso: m.endDate || m.endDateIso,
            start_time_ms: startMs,
            end_time_ms: endMs,
            active: m.active,
            closed: m.closed,
            accepting_orders: m.active && !m.closed,
            neg_risk: m.negRisk,
            minimum_order_size: 5,
            minimum_tick_size: 0.01,
            tokens: tokenIds.map((id, i) => ({
              token_id: id,
              outcome: outcomes[i] || (i === 0 ? "Up" : "Down"),
              price: prices[i] ? parseFloat(prices[i]) : 0.5,
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
   * Find a specific 5-minute BTC market by window start timestamp.
   * Used for early entry into next market windows.
   */
  async findMarketByTimestamp(windowStartSec: number): Promise<WindowInfo | null> {
    const slug = `btc-updown-5m-${windowStartSec}`;
    const windowSize = 300;

    try {
      const market = await this.fetchMarketBySlug(slug, windowStartSec, windowSize);
      if (!market) return null;

      const upToken = market.tokens.find((t) => t.outcome === "Up");
      const downToken = market.tokens.find((t) => t.outcome === "Down");

      if (!upToken || !downToken) {
        this.logger.warn("Market missing Up/Down tokens", { slug });
        return null;
      }

      const startMs = market.start_time_ms ?? windowStartSec * 1000;
      const endMs = market.end_time_ms ?? (windowStartSec + windowSize) * 1000;

      return {
        conditionId: market.condition_id,
        upTokenId: upToken.token_id,
        downTokenId: downToken.token_id,
        openingPrice: 0,
        startTime: startMs,
        endTime: endMs,
        negRisk: market.neg_risk,
      };
    } catch (err) {
      this.logger.debug("Market fetch by timestamp failed", {
        slug,
        error: (err as Error).message,
      });
      return null;
    }
  }

  /**
   * Clear cached market (call when window ends).
   */
  clearCurrent(): void {
    this.currentMarket = null;
    this.currentSlug = null;
  }
}
