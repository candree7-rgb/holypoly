import type { Logger } from "./logger.js";

/**
 * Telegram alerts — ported from Polymoly's telegram_bot.py.
 * Uses native fetch (Node 18+), no extra dependencies.
 * All methods are safe to call even when unconfigured (no-op).
 */
export class TelegramNotifier {
  private enabled: boolean;
  private apiUrl: string;

  constructor(
    private token: string | undefined,
    private chatId: string | undefined,
    private logger: Logger,
  ) {
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

  /** Send a message with Markdown, fallback to plaintext on error. */
  async send(message: string): Promise<boolean> {
    if (!this.enabled) return false;

    try {
      let resp = await fetch(this.apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: message,
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
            text: message,
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

  async alertSkip(
    side: string,
    currentPriceCents: number | null,
    nextLimitCents: number,
    reason: string,
  ): Promise<void> {
    const price = currentPriceCents ? `${currentPriceCents.toFixed(1)}¢` : "N/A";
    await this.send(
      `⏭️ *SKIP* ${side.toUpperCase()} current @ ${price} (${reason})\n` +
        `→ NEXT @ ${nextLimitCents}¢ limit`,
    );
  }

  async alertSell(
    side: string,
    entryPrice: number,
    sellPrice: number,
    pnl: number,
  ): Promise<void> {
    const emoji = pnl >= 0 ? "🟢" : "🔴";
    const sign = pnl >= 0 ? "+" : "";
    await this.send(
      `${emoji} *SOLD* ${side.toUpperCase()} ${entryPrice.toFixed(1)}¢ → ${sellPrice.toFixed(1)}¢ (${sign}$${pnl.toFixed(2)})`,
    );
  }

  async alertCircuitBreaker(reason: string): Promise<void> {
    await this.send(`🚨 *CIRCUIT BREAKER*\n${reason}`);
  }

  async alertError(error: string): Promise<void> {
    await this.send(`⚠️ *ERROR*\n${error}`);
  }
}
