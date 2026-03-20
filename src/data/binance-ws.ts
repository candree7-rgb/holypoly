import WebSocket from "ws";
import { Logger } from "../logger.js";

export interface BinanceTick {
  price: number;
  timestamp: number;
}

/**
 * Direct Binance WebSocket for fastest BTC price.
 * Connects to btcusdt@trade stream (~100ms updates, no API key needed).
 */
export class BinanceWsClient {
  private ws: WebSocket | null = null;
  private lastTick: BinanceTick | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private running = false;
  private onTickCallbacks: ((tick: BinanceTick) => void)[] = [];

  constructor(private logger: Logger) {}

  get price(): number | null {
    return this.lastTick?.price ?? null;
  }

  get timestamp(): number | null {
    return this.lastTick?.timestamp ?? null;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  onTick(cb: (tick: BinanceTick) => void): void {
    this.onTickCallbacks.push(cb);
  }

  offTick(cb: (tick: BinanceTick) => void): void {
    const idx = this.onTickCallbacks.indexOf(cb);
    if (idx >= 0) this.onTickCallbacks.splice(idx, 1);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(): void {
    if (!this.running) return;

    const url = "wss://stream.binance.com:9443/ws/btcusdt@trade";
    this.logger.debug("Binance WS connecting", { url });

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.logger.info("Binance WS connected");
      this.reconnectDelay = 1000;
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          e: string; // event type
          p: string; // price
          T: number; // trade time (ms)
        };
        if (msg.e === "trade") {
          const tick: BinanceTick = {
            price: parseFloat(msg.p),
            timestamp: msg.T,
          };
          this.lastTick = tick;
          for (const cb of this.onTickCallbacks) {
            cb(tick);
          }
        }
      } catch {
        // ignore malformed messages
      }
    });

    this.ws.on("close", () => {
      this.logger.warn("Binance WS disconnected");
      this.scheduleReconnect();
    });

    this.ws.on("error", (err: Error) => {
      this.logger.error("Binance WS error", { error: err.message });
      this.ws?.close();
    });
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    this.logger.info("Binance WS reconnecting", { delayMs: this.reconnectDelay });
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }
}
