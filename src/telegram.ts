import type { Logger } from "./logger.js";

/**
 * Telegram alerts — ported from Polymoly's telegram_bot.py.
 * Uses native fetch (Node 18+), no extra dependencies.
 * All methods are safe to call even when unconfigured (no-op).
 */
export class TelegramNotifier {
  private enabled: boolean;
  private apiUrl: string;
  /** Dedup: track last send time per alert type to prevent flooding */
  private lastAlertTime: Map<string, number> = new Map();
  /** Minimum interval between same-type alerts (ms) */
  private alertCooldownMs = 30000; // 30s dedup window
  /** Max alerts per 5-minute window */
  private alertCount = 0;
  private alertWindowStart = Date.now();
  private maxAlertsPerWindow = 15;

  private prefix: string;

  constructor(
    private token: string | undefined,
    private chatId: string | undefined,
    private logger: Logger,
    prefix = "🍷",
  ) {
    this.prefix = prefix;
    this.enabled = Boolean(token && chatId);
    this.apiUrl = token
      ? `https://api.telegram.org/bot${token}/sendMessage`
      : "";

    if (this.enabled) {
      logger.info("Telegram alerts enabled");
    } else {
      logger.info("Telegram alerts disabled (no token/chat_id)");
    }
  }

  /**
   * Check if this alert type should be sent (dedup + throttle).
   * Returns false if same alert type sent within cooldown, or global rate exceeded.
   */
  private shouldSend(alertType: string): boolean {
    const now = Date.now();

    // Reset 5-minute window
    if (now - this.alertWindowStart > 300000) {
      this.alertCount = 0;
      this.alertWindowStart = now;
    }

    // Global throttle
    if (this.alertCount >= this.maxAlertsPerWindow) {
      this.logger.debug("Telegram throttled", { alertType, count: this.alertCount });
      return false;
    }

    // Per-type dedup
    const lastTime = this.lastAlertTime.get(alertType) ?? 0;
    if (now - lastTime < this.alertCooldownMs) {
      this.logger.debug("Telegram dedup", { alertType, lastAgo: `${((now - lastTime) / 1000).toFixed(0)}s` });
      return false;
    }

    this.lastAlertTime.set(alertType, now);
    this.alertCount++;
    return true;
  }

  /** Send a message with Markdown, fallback to plaintext on error. */
  async send(message: string, alertType?: string): Promise<boolean> {
    if (!this.enabled) return false;
    if (alertType && !this.shouldSend(alertType)) return false;

    const prefixed = `${this.prefix} ${message}`;

    try {
      let resp = await fetch(this.apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: prefixed,
          parse_mode: "Markdown",
        }),
      });

      if (!resp.ok) {
        this.logger.warn("Telegram API error, retrying without Markdown", {
          status: resp.status,
        });
        // Retry without parse_mode (Markdown might be the issue)
        resp = await fetch(this.apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: this.chatId,
            text: prefixed,
          }),
        });
        if (!resp.ok) {
          this.logger.warn("Telegram plaintext retry also failed", {
            status: resp.status,
          });
          return false;
        }
      }
      return true;
    } catch (err) {
      this.logger.warn("Telegram send failed", {
        error: (err as Error).message,
      });
      return false;
    }
  }

  // ------------------------------------------------------------------
  // Pre-built alert templates
  // ------------------------------------------------------------------

  async alertStartup(
    dryRun: boolean,
    balance: number,
    buyAmountPct: number,
  ): Promise<void> {
    const mode = dryRun ? "📝 DRY RUN" : "💰 LIVE";
    const buyAmount = (balance * buyAmountPct) / 100;
    await this.send(
      `🚀 *Bot Started* (${mode})\n` +
        `Balance: $${balance.toFixed(2)} | Buy: $${buyAmount.toFixed(2)} (${buyAmountPct}%)`,
    );
  }

  async alertTrade(
    side: string,
    priceCents: number,
    marketType: "CURRENT" | "NEXT",
    orderType: "MARKET" | "LIMIT",
    amount: number,
    balance: number,
    btcPrice: number,
    timeLeft: number,
  ): Promise<void> {
    await this.send(
      `🟢 *${side.toUpperCase()}* @ ${priceCents.toFixed(1)}¢ (${marketType})\n` +
        `${orderType} | $${amount.toFixed(2)} | Bal: $${balance.toFixed(2)}\n` +
        `BTC: $${btcPrice.toFixed(2)} | ${timeLeft.toFixed(0)}s left`,
    );
  }

  async alertSettlement(
    winner: string,
    totalPnl: number,
    ordersWon: number,
    ordersTotal: number,
    dailyPnl: number,
    dailyWins: number,
    dailyLosses: number,
  ): Promise<void> {
    const emoji = totalPnl >= 0 ? "✅" : "❌";
    const result = totalPnl >= 0 ? "WIN" : "LOSS";
    const sign = totalPnl >= 0 ? "+" : "";
    await this.send(
      `${emoji} *${result}* ${sign}$${totalPnl.toFixed(2)}\n` +
        `${winner} won | ${ordersWon}/${ordersTotal} orders won\n` +
        `Daily: ${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(2)} (${dailyWins}W/${dailyLosses}L)`,
    );
  }

  async alertCircuitBreaker(reason: string): Promise<void> {
    await this.send(`🚨 *CIRCUIT BREAKER*\n${reason}`);
  }

  async alertError(error: string): Promise<void> {
    await this.send(`⚠️ *ERROR*\n${error}`, `error:${error.slice(0, 30)}`);
  }

  async alertHedge(
    hedgeSide: string,
    entryPriceCents: number,
    triggerPriceCents: number,
    hedgePriceCents: number,
    lockedLoss: number,
  ): Promise<void> {
    await this.send(
      `🛡 *HEDGE* ${hedgeSide}\n` +
        `Entry: ${entryPriceCents.toFixed(1)}¢ → Trigger: ${triggerPriceCents.toFixed(1)}¢\n` +
        `Hedge @ ${hedgePriceCents.toFixed(1)}¢ | Locked loss: -$${lockedLoss.toFixed(2)}`,
    );
  }

  async alertEdgeEntry(
    side: string,
    edgeCents: number,
    fairUp: number,
    regime: string,
    confidence: number,
    amount: number,
    numOrders: number,
  ): Promise<void> {
    await this.send(
      `⚡ *EDGE ${side.toUpperCase()}* ${edgeCents.toFixed(1)}¢\n` +
        `Fair: ${fairUp}¢ | Conf: ${(confidence * 100).toFixed(0)}% | Vol: ${regime}\n` +
        `$${amount.toFixed(2)} × ${numOrders} orders`,
    );
  }
}
