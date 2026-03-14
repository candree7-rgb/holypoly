import { Logger } from "../logger.js";
import type { Position } from "../types.js";

/**
 * Polymarket Data API client for querying positions (used by redeem).
 */
export class DataApiClient {
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
      throw new Error(`Data API error ${resp.status}: ${text}`);
    }
    return (await resp.json()) as T;
  }

  /**
   * Get USDC balance for a profile address.
   * Queries the CLOB balance endpoint.
   */
  async getBalance(user: string): Promise<number> {
    try {
      // Polymarket data-api provides balance info
      const url = `${this.host}/balance?user=${user}`;
      const data = await this.fetchJson<{ balance?: number; usdc_balance?: number }>(url);
      return data.balance ?? data.usdc_balance ?? 0;
    } catch {
      // Fallback: try profile endpoint
      try {
        const url = `${this.host}/profile?user=${user}`;
        const data = await this.fetchJson<{ portfolio_value?: number; collateral_balance?: number }>(url);
        return data.collateral_balance ?? data.portfolio_value ?? 0;
      } catch (err) {
        this.logger.warn("Failed to fetch balance", { error: (err as Error).message });
        return 0;
      }
    }
  }

  async getPositions(user: string, redeemable?: boolean, limit = 200): Promise<Position[]> {
    const params = new URLSearchParams();
    params.set("user", user);
    params.set("limit", String(limit));
    if (redeemable !== undefined) params.set("redeemable", redeemable ? "true" : "false");
    const url = `${this.host}/positions?${params}`;
    try {
      return await this.fetchJson<Position[]>(url);
    } catch (err) {
      this.logger.warn("Failed to fetch positions", { error: (err as Error).message });
      return [];
    }
  }
}
