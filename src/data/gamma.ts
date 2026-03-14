import { Logger } from "../logger.js";
import type { WindowInfo } from "../types.js";

interface GammaMarket {
  condition_id: string;
  question: string;
  tokens: Array<{
    token_id: string;
    outcome: string;
  }>;
  neg_risk: boolean;
  end_date_iso: string;
  start_date_iso?: string;
  description?: string;
  active: boolean;
  closed: boolean;
  game_start_time?: string;
  // 5-min markets have specific tags/slugs
  slug?: string;
  events?: Array<{
    slug?: string;
    title?: string;
  }>;
}

interface GammaEvent {
  slug: string;
  title: string;
  markets: GammaMarket[];
}

/**
 * Polymarket Gamma API client for discovering active 5-minute BTC markets.
 */
export class GammaClient {
  private host: string;

  constructor(host: string, private logger: Logger) {
    this.host = host.replace(/\/$/, "");
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "holypoly-bot",
        Accept: "application/json",
      },
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Gamma API error ${resp.status}: ${text}`);
    }
    return (await resp.json()) as T;
  }

  /**
   * Find the currently active 5-minute BTC Up/Down market.
   * Returns null if no active market found.
   */
  async findActive5MinBtcMarket(): Promise<WindowInfo | null> {
    try {
      // Search for active BTC 5-minute markets
      const params = new URLSearchParams({
        active: "true",
        closed: "false",
        limit: "10",
        order: "end_date_iso",
        ascending: "true",
      });

      // Try the events endpoint first for 5-min crypto markets
      const eventsUrl = `${this.host}/events?${params}&slug=bitcoin-5-minute`;
      let markets: GammaMarket[] = [];

      try {
        const events = await this.fetchJson<GammaEvent[]>(eventsUrl);
        for (const event of events) {
          markets.push(...(event.markets || []));
        }
      } catch {
        // Fallback: search markets directly
        const marketsUrl = `${this.host}/markets?${params}&tag=btc-5min`;
        markets = await this.fetchJson<GammaMarket[]>(marketsUrl);
      }

      // If still no markets, try broader search
      if (markets.length === 0) {
        const broadUrl = `${this.host}/markets?active=true&closed=false&limit=20&order=end_date_iso&ascending=true`;
        const allMarkets = await this.fetchJson<GammaMarket[]>(broadUrl);
        markets = allMarkets.filter((m) => {
          const q = (m.question || "").toLowerCase();
          return (
            q.includes("bitcoin") &&
            (q.includes("up or down") || q.includes("5 min") || q.includes("5-min"))
          );
        });
      }

      if (markets.length === 0) {
        this.logger.debug("No active 5-min BTC market found");
        return null;
      }

      // Find the earliest ending active market (= current window)
      const now = Date.now();
      const active = markets
        .filter((m) => m.active && !m.closed)
        .filter((m) => new Date(m.end_date_iso).getTime() > now)
        .sort((a, b) => new Date(a.end_date_iso).getTime() - new Date(b.end_date_iso).getTime());

      if (active.length === 0) {
        this.logger.debug("No upcoming 5-min BTC market window");
        return null;
      }

      const market = active[0];
      const upToken = market.tokens.find(
        (t) => t.outcome.toLowerCase() === "up" || t.outcome.toLowerCase() === "yes"
      );
      const downToken = market.tokens.find(
        (t) => t.outcome.toLowerCase() === "down" || t.outcome.toLowerCase() === "no"
      );

      if (!upToken || !downToken) {
        this.logger.warn("Market missing Up/Down tokens", {
          conditionId: market.condition_id,
          tokens: market.tokens.map((t) => t.outcome),
        });
        return null;
      }

      const endTime = new Date(market.end_date_iso).getTime();
      const startTime = endTime - 5 * 60 * 1000; // 5 minutes before end

      return {
        conditionId: market.condition_id,
        upTokenId: upToken.token_id,
        downTokenId: downToken.token_id,
        openingPrice: 0, // Will be set from Chainlink at window start
        startTime,
        endTime,
        negRisk: market.neg_risk,
      };
    } catch (err) {
      this.logger.error("Gamma API error", { error: (err as Error).message });
      return null;
    }
  }

  /**
   * Get the orderbook prices for a token.
   */
  async getMarketPrices(tokenId: string): Promise<{ bestAsk: number; bestBid: number } | null> {
    try {
      // Use CLOB for orderbook data — this is just a helper to check Gamma
      return null;
    } catch {
      return null;
    }
  }
}
