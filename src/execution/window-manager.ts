import type { Logger } from "../logger.js";
import type { WindowInfo } from "../types.js";
import type { MarketDiscovery } from "../data/gamma.js";

/**
 * Manages 5-minute window lifecycle.
 * Detects new windows, tracks timing phases, and handles transitions.
 */
export class WindowManager {
  private currentWindow: WindowInfo | null = null;
  private lastPollTime = 0;
  private pollIntervalMs = 5000; // Poll every 5s for new windows

  constructor(
    private discovery: MarketDiscovery,
    private logger: Logger
  ) {}

  get current(): WindowInfo | null {
    return this.currentWindow;
  }

  /**
   * Check if we need a new window and fetch it if so.
   */
  async tick(): Promise<WindowInfo | null> {
    const now = Date.now();

    // If current window hasn't ended, keep it
    if (this.currentWindow && now < this.currentWindow.endTime) {
      return this.currentWindow;
    }

    // Window ended — clear
    if (this.currentWindow && now >= this.currentWindow.endTime) {
      this.logger.info("Window ended", {
        conditionId: this.currentWindow.conditionId.slice(0, 16) + "...",
      });
      this.currentWindow = null;
      this.discovery.clearCurrent();
    }

    // Rate-limit polls
    if (now - this.lastPollTime < this.pollIntervalMs) {
      return null;
    }
    this.lastPollTime = now;

    // Fetch new window
    const window = await this.discovery.findActive5MinBtcMarket();
    if (!window) return null;

    // New window?
    if (this.currentWindow?.conditionId === window.conditionId) {
      return this.currentWindow;
    }

    this.currentWindow = window;
    return window;
  }

  timeRemaining(): number {
    if (!this.currentWindow) return 0;
    return Math.max(0, (this.currentWindow.endTime - Date.now()) / 1000);
  }

  timeElapsed(): number {
    if (!this.currentWindow) return 0;
    return Math.max(0, (Date.now() - this.currentWindow.startTime) / 1000);
  }

  setOpeningPrice(price: number): void {
    if (this.currentWindow) {
      this.currentWindow.openingPrice = price;
      this.logger.info("Opening price set", { price: price.toFixed(2) });
    }
  }

  isEntryPhase(entryDelaySeconds: number): boolean {
    const elapsed = this.timeElapsed();
    const remaining = this.timeRemaining();
    return elapsed >= entryDelaySeconds && remaining > 30;
  }
}
