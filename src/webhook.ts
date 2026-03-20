import express from "express";
import type { Logger } from "./logger.js";

export type SignalDirection = "up" | "down";

type SignalHandler = (direction: SignalDirection) => void;

/**
 * Express webhook server for TradingView alerts.
 *
 * Expects POST /webhook with body containing "Bullish" or "Bearish".
 * TradingView alert messages:
 *   - "BTC Trend Bullish"
 *   - "BTC Trend Bearish"
 */
export function createWebhookServer(
  port: number,
  logger: Logger,
  secret?: string,
) {
  const app = express();
  app.use(express.json());
  app.use(express.text());

  let handler: SignalHandler | null = null;

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.post("/webhook", (req, res) => {
    // Optional secret check
    if (secret) {
      const headerSecret = req.headers["x-webhook-secret"];
      if (headerSecret !== secret) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }

    // Parse TradingView alert — could be JSON or plain text
    let body: string;
    if (typeof req.body === "string") {
      body = req.body;
    } else if (req.body?.message) {
      body = req.body.message;
    } else {
      body = JSON.stringify(req.body);
    }

    let direction: SignalDirection | null = null;
    if (/bullish/i.test(body)) direction = "up";
    else if (/bearish/i.test(body)) direction = "down";

    if (!direction) {
      logger.warn("Unknown webhook signal", { body });
      res.status(400).json({ error: "Unknown signal", body });
      return;
    }

    logger.info("Webhook signal received", { direction, body });

    if (handler) {
      // Fire and forget — don't block the webhook response
      Promise.resolve()
        .then(() => handler!(direction!))
        .catch((err) => {
          logger.error("Signal handler error", {
            error: (err as Error).message,
          });
        });
    }

    res.json({ ok: true, direction });
  });

  return {
    start: () => {
      app.listen(port, () => {
        logger.info(`Webhook server listening on port ${port}`);
      });
    },
    onSignal: (cb: SignalHandler) => {
      handler = cb;
    },
  };
}
