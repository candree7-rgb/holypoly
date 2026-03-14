import type { Logger } from "../logger.js";
import type { WindowInfo } from "../types.js";
import type { GammaClient } from "../data/gamma.js";

/**
 * Manages 5-minute window lifecycle.
 * Detects new windows, tracks timing phases, and handles transitions.
 */
export class WindowManager {
  private currentWindow: WindowInfo | null = null;
  private lastPollTime = 0;
  private pollIntervalMs = 10000; // Poll Gamma every 10s for new windows

  constructor(
    private gamma: GammaClient,
    private logger: Logger
  ) {}

  get current(): WindowInfo | null {
    return this.currentWindow;
  }

  /**
   * Check if we need a new window and fetch it if so.
   * Returns the current active window or null.
   */
  async tick(): Promise<WindowInfo | null> {
    const now = Date.now();

    // If we have a current window that hasn't ended, keep it
    if (this.currentWindow && now < this.currentWindow.endTime) {
      return this.currentWindow;
    }

    // If current window just ended, log it
    if (this.currentWindow && now >= this.currentWindow.endTime) {
      this.logger.info("Window ended", {
        conditionId: this.currentWindow.conditionId.slice(0, 10) + "...",
      });
      this.currentWindow = null;
    }

    // Rate-limit Gamma API polls
    if (now - this.lastPollTime < this.pollIntervalMs) {
      return null;
    }
    this.lastPollTime = now;

    // Fetch new window from Gamma
    const window = await this.gamma.findActive5MinBtcMarket();
    if (!window) return null;

    // Check if it's actually a new window (not the same one)
    if (this.currentWindow?.conditionId === window.conditionId) {
      return this.currentWindow;
    }

    this.currentWindow = window;
    this.logger.info("New window detected", {
      conditionId: window.conditionId.slice(0, 10) + "...",
      upToken: window.upTokenId.slice(0, 10) + "...",
      downToken: window.downTokenId.slice(0, 10) + "...",
      endsAt: new Date(window.endTime).toISOString(),
    });

    return window;
  }

  /**
   * Get seconds remaining in current window.
   */
  timeRemaining(): number {
    if (!this.currentWindow) return 0;
    return Math.max(0, (this.currentWindow.endTime - Date.now()) / 1000);
  }

  /**
   * Get seconds elapsed since window start.
   */
  timeElapsed(): number {
    if (!this.currentWindow) return 0;
    return Math.max(0, (Date.now() - this.currentWindow.startTime) / 1000);
  }

  /**
   * Set the opening price for the current window (from Binance at window start).
   */
  setOpeningPrice(price: number): void {
    if (this.currentWindow) {
      this.currentWindow.openingPrice = price;
      this.logger.info("Window opening price set", {
        price: price.toFixed(2),
      });
    }
  }

  /**
   * Check if we're in the entry phase (entryDelay < elapsed < endTime - 30s).
   */
  isEntryPhase(entryDelaySeconds: number): boolean {
    const elapsed = this.timeElapsed();
    const remaining = this.timeRemaining();
    return elapsed >= entryDelaySeconds && remaining > 30;
  }
}
