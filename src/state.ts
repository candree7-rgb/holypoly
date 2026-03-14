import { promises as fs } from "fs";
import path from "path";
import type { WindowResult } from "./types.js";

export interface State {
  /** Daily P&L tracking */
  dailyPnl: {
    day: string;
    totalPnl: number;
    windowsTraded: number;
    wins: number;
    losses: number;
  };
  /** Weekly P&L tracking */
  weeklyPnl: {
    week: string;
    totalPnl: number;
  };
  /** Consecutive losing windows counter */
  losingStreak: number;
  /** Pause until timestamp (ms) if streak triggered */
  pauseUntil: number;
  /** Recent window results for analysis */
  recentWindows: WindowResult[];
  /** Redeem attempt timestamps by conditionId */
  redeemAttempts: Record<string, number>;
  /** Current window state for crash recovery */
  currentWindow: {
    startTime: number;
    ordersPlaced: number;
  } | null;
}

const dayKeyUtc = (date = new Date()): string => {
  const y = date.getUTCFullYear();
  const m = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const d = `${date.getUTCDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const weekKeyUtc = (date = new Date()): string => {
  const y = date.getUTCFullYear();
  const start = new Date(date);
  start.setUTCDate(date.getUTCDate() - date.getUTCDay());
  const m = `${start.getUTCMonth() + 1}`.padStart(2, "0");
  const d = `${start.getUTCDate()}`.padStart(2, "0");
  return `${y}-W${m}${d}`;
};

const defaultState = (): State => ({
  dailyPnl: { day: "", totalPnl: 0, windowsTraded: 0, wins: 0, losses: 0 },
  weeklyPnl: { week: "", totalPnl: 0 },
  losingStreak: 0,
  pauseUntil: 0,
  recentWindows: [],
  redeemAttempts: {},
  currentWindow: null,
});

export const loadState = async (filePath: string): Promise<State> => {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<State>;
    return { ...defaultState(), ...parsed };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultState();
    throw err;
  }
};

export const saveState = async (filePath: string, state: State): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2));
};

export const ensureDaily = (state: State, now = new Date()): void => {
  const key = dayKeyUtc(now);
  if (state.dailyPnl.day !== key) {
    state.dailyPnl = { day: key, totalPnl: 0, windowsTraded: 0, wins: 0, losses: 0 };
  }
};

export const ensureWeekly = (state: State, now = new Date()): void => {
  const key = weekKeyUtc(now);
  if (state.weeklyPnl.week !== key) {
    state.weeklyPnl = { week: key, totalPnl: 0 };
  }
};

export const recordWindowResult = (state: State, result: WindowResult): void => {
  const now = new Date();
  ensureDaily(state, now);
  ensureWeekly(state, now);

  state.dailyPnl.windowsTraded++;
  if (result.pnl !== null) {
    state.dailyPnl.totalPnl += result.pnl;
    state.weeklyPnl.totalPnl += result.pnl;
    if (result.pnl > 0) {
      state.dailyPnl.wins++;
      state.losingStreak = 0;
    } else {
      state.dailyPnl.losses++;
      state.losingStreak++;
    }
  }

  state.recentWindows.push(result);
  // Keep last 100 windows
  if (state.recentWindows.length > 100) {
    state.recentWindows = state.recentWindows.slice(-100);
  }
};

export const markRedeemAttempt = (state: State, conditionId: string): void => {
  state.redeemAttempts[conditionId] = Math.floor(Date.now() / 1000);
};
