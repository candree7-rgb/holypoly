import express from "express";
import type { Logger } from "./logger.js";

export type SignalDirection = "up" | "down";
export type SignalAsset = "btc" | "eth";

export interface WebhookSignal {
  direction: SignalDirection;
  asset: SignalAsset;
}

type SignalHandler = (signal: WebhookSignal) => void;

/**
 * Express webhook server for TradingView alerts.
 *
 * Accepts POST /webhook with body containing direction + optional asset.
 *
 * Supported formats:
 *   Plain text:  "UP", "DOWN", "BTC UP", "ETH DOWN"
 *   TradingView: "BTC Trend Bullish", "ETH Trend Bearish"
 *   JSON:        { "direction": "up", "asset": "btc" }
 *                { "message": "BTC UP" }
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

    // Parse signal from various formats
    const signal = parseSignal(req.body);

    if (!signal) {
      const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      logger.warn("Unknown webhook signal", { body });
      res.status(400).json({ error: "Unknown signal", body });
      return;
    }

    logger.info("Webhook signal received", {
      direction: signal.direction,
      asset: signal.asset,
      raw: typeof req.body === "string" ? req.body : JSON.stringify(req.body),
    });

    if (handler) {
      // Fire and forget — don't block the webhook response
      Promise.resolve()
        .then(() => handler!(signal))
        .catch((err) => {
          logger.error("Signal handler error", {
            error: (err as Error).message,
          });
        });
    }

    res.json({ ok: true, direction: signal.direction, asset: signal.asset });
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

/**
 * Parse direction and asset from webhook body.
 * Supports plain text, JSON with message field, or structured JSON.
 */
function parseSignal(body: unknown): WebhookSignal | null {
  // Structured JSON: { direction: "up", asset: "btc" }
  if (typeof body === "object" && body !== null) {
    const obj = body as Record<string, unknown>;

    if (typeof obj.direction === "string") {
      const dir = obj.direction.toLowerCase();
      if (dir === "up" || dir === "down") {
        const asset = parseAsset(String(obj.asset ?? ""));
        return { direction: dir, asset };
      }
    }

    // JSON with message field
    if (typeof obj.message === "string") {
      return parseTextSignal(obj.message);
    }

    // Try stringifying as fallback
    return parseTextSignal(JSON.stringify(body));
  }

  // Plain text
  if (typeof body === "string") {
    return parseTextSignal(body);
  }

  return null;
}

function parseTextSignal(text: string): WebhookSignal | null {
  const upper = text.toUpperCase();

  let direction: SignalDirection | null = null;
  if (/\bUP\b|BULLISH/i.test(upper)) direction = "up";
  else if (/\bDOWN\b|BEARISH/i.test(upper)) direction = "down";

  if (!direction) return null;

  const asset = parseAsset(text);
  return { direction, asset };
}

function parseAsset(text: string): SignalAsset {
  if (/\beth\b/i.test(text)) return "eth";
  return "btc"; // default to BTC
}
