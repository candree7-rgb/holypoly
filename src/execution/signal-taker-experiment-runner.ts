import type { Config } from "../config.js";
import type { ClobService } from "../data/clob.js";
import type { ClobWsClient } from "../data/clob-ws.js";
import type { BinanceWsClient } from "../data/binance-ws.js";
import type { RedeemService } from "../data/redeem.js";
import type { Logger } from "../logger.js";
import type { TelegramNotifier } from "../telegram.js";
import type { WindowExecutionResult, WindowInfo } from "../types.js";
import { SignalTakerExecutor, type SignalExecutorVariantOptions } from "./signal-taker-executor.js";

interface VariantDefinition {
  name: string;
  options: SignalExecutorVariantOptions;
}

interface VariantStats {
  windows: number;
  windowsTraded: number;
  skipped: number;
  tradeCount: number;
  mergeCount: number;
  pnl: number;
  pairedCosts: number[];
  mergesGt100: number;
  mergesGt105: number;
  mergesGt110: number;
  mergesGt120: number;
  hedgeCompleted: number;
  hedgeFailed: number;
  unpairedLeftovers: number;
  avgUnpairedDurationS: number[];
}

export class SignalTakerExperimentRunner {
  private stats = new Map<string, VariantStats>();

  constructor(
    private clob: ClobService,
    private clobWs: ClobWsClient,
    private binance: BinanceWsClient,
    private redeem: RedeemService | null,
    private config: Config,
    private logger: Logger,
    private telegram: TelegramNotifier,
  ) {}

  private defaults(): VariantStats {
    return {
      windows: 0,
      windowsTraded: 0,
      skipped: 0,
      tradeCount: 0,
      mergeCount: 0,
      pnl: 0,
      pairedCosts: [],
      mergesGt100: 0,
      mergesGt105: 0,
      mergesGt110: 0,
      mergesGt120: 0,
      hedgeCompleted: 0,
      hedgeFailed: 0,
      unpairedLeftovers: 0,
      avgUnpairedDurationS: [],
    };
  }

  private buildVariantCatalog(): Record<string, VariantDefinition> {
    return {
      baseline: { name: "baseline", options: { name: "baseline" } },
      small_first_leg: { name: "small_first_leg", options: { name: "small_first_leg", firstLegMultiplier: 0.18, firstLegMinShares: 20, firstLegMaxShares: 31 } },
      hedgeability_gate_only: { name: "hedgeability_gate_only", options: { name: "hedgeability_gate_only", enableHedgeabilityGate: true, enableBalancingOnlyMode: false } },
      balancing_only_only: { name: "balancing_only_only", options: { name: "balancing_only_only", enableHedgeabilityGate: false, enableBalancingOnlyMode: true } },
      short_unpaired_timeout: { name: "short_unpaired_timeout", options: { name: "short_unpaired_timeout", unpairedTimeoutS: 15 } },
      late_window_no_new_unpaired: { name: "late_window_no_new_unpaired", options: { name: "late_window_no_new_unpaired", lateWindowNoNewUnpairedS: 90 } },
      regime_confidence_filter: { name: "regime_confidence_filter", options: { name: "regime_confidence_filter", enableRegimeConfidenceFilter: true } },
      combo_quality: {
        name: "combo_quality",
        options: {
          name: "combo_quality",
          firstLegMultiplier: 0.20,
          firstLegMinShares: 24,
          firstLegMaxShares: 36,
          enableHedgeabilityGate: true,
          enableBalancingOnlyMode: true,
          unpairedTimeoutS: 18,
          lateWindowNoNewUnpairedS: 90,
        },
      },
      combo_tail_guard: {
        name: "combo_tail_guard",
        options: {
          name: "combo_tail_guard",
          firstLegMultiplier: 0.16,
          firstLegMinShares: 20,
          firstLegMaxShares: 31,
          enableHedgeabilityGate: true,
          enableBalancingOnlyMode: true,
          unpairedTimeoutS: 12,
          lateWindowNoNewUnpairedS: 120,
          enableRegimeConfidenceFilter: true,
        },
      },
    };
  }

  private activeVariants(): VariantDefinition[] {
    const catalog = this.buildVariantCatalog();
    const requested = this.config.signalExperimentVariants.split(",").map((v) => v.trim()).filter(Boolean);
    const variants = requested.map((id) => catalog[id]).filter((v): v is VariantDefinition => Boolean(v));
    return variants.length > 0 ? variants : [catalog.baseline];
  }

  async executeWindow(window: WindowInfo, balance: number): Promise<WindowExecutionResult> {
    const variants = this.activeVariants();
    this.logger.info("Signal experiment window start", {
      variants: variants.map((v) => v.name),
      window: `${new Date(window.startTime).toISOString()}-${new Date(window.endTime).toISOString()}`,
    });

    const runs = await Promise.all(
      variants.map(async (variant) => {
        const exec = new SignalTakerExecutor(
          this.clob,
          this.clobWs,
          this.binance,
          this.redeem,
          this.config,
          this.logger,
          this.telegram,
          variant.options,
        );
        const result = await exec.executeWindow(window, balance);
        return { variant: variant.name, result };
      }),
    );

    for (const { variant, result } of runs) {
      this.record(variant, result);
    }
    this.logScoreboard();

    const baseline = runs.find((r) => r.variant === "baseline") ?? runs[0];
    return baseline.result;
  }

  private record(name: string, result: WindowExecutionResult): void {
    const stats = this.stats.get(name) ?? this.defaults();
    stats.windows += 1;
    if (result.skipped) stats.skipped += 1;
    if (result.orderFills.length > 0) {
      stats.windowsTraded += 1;
      stats.tradeCount += result.orderFills.length;
    }
    stats.mergeCount += result.totalMerged > 0 ? 1 : 0;
    stats.pnl += result.totalMergeProfit;
    if (Number.isFinite(result.avgCombinedCents) && result.totalMerged > 0) {
      stats.pairedCosts.push(result.avgCombinedCents);
      if (result.avgCombinedCents > 100) stats.mergesGt100 += 1;
      if (result.avgCombinedCents > 105) stats.mergesGt105 += 1;
      if (result.avgCombinedCents > 110) stats.mergesGt110 += 1;
      if (result.avgCombinedCents > 120) stats.mergesGt120 += 1;
    }
    const hedgeComplete = result.totalUpShares > 0 && result.totalDnShares > 0 && result.remainingUp === 0 && result.remainingDn === 0;
    if (hedgeComplete) stats.hedgeCompleted += 1;
    if ((result.totalUpShares > 0 || result.totalDnShares > 0) && !hedgeComplete) stats.hedgeFailed += 1;
    if (result.remainingUp > 0 || result.remainingDn > 0) stats.unpairedLeftovers += 1;
    const pairedShares = Math.min(result.totalUpShares, result.totalDnShares);
    const unpaired = Math.abs(result.totalUpShares - result.totalDnShares);
    if (pairedShares > 0 && unpaired > 0) {
      stats.avgUnpairedDurationS.push(this.config.maxNakedDurationS);
    }
    this.stats.set(name, stats);
  }

  private logScoreboard(): void {
    for (const [name, s] of this.stats.entries()) {
      const sorted = [...s.pairedCosts].sort((a, b) => a - b);
      const median = sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];
      const worst = sorted.length === 0 ? 0 : sorted[sorted.length - 1];
      const avgPaired = sorted.length === 0 ? 0 : sorted.reduce((sum, n) => sum + n, 0) / sorted.length;
      const hedgeCompletionRate = s.windowsTraded > 0 ? (s.hedgeCompleted / s.windowsTraded) * 100 : 0;
      const skipRate = s.windows > 0 ? (s.skipped / s.windows) * 100 : 0;
      const pnlPerTradedWindow = s.windowsTraded > 0 ? s.pnl / s.windowsTraded : 0;
      const avgUnpairedDuration = s.avgUnpairedDurationS.length > 0
        ? s.avgUnpairedDurationS.reduce((sum, n) => sum + n, 0) / s.avgUnpairedDurationS.length
        : 0;
      this.logger.info("EXPERIMENT SCOREBOARD", {
        variant: name,
        windows: s.windows,
        windowsTraded: s.windowsTraded,
        tradeCount: s.tradeCount,
        skipRate: `${skipRate.toFixed(1)}%`,
        pnl: `$${s.pnl.toFixed(2)}`,
        pnlPerTradedWindow: `$${pnlPerTradedWindow.toFixed(2)}`,
        mergeCount: s.mergeCount,
        hedgeCompletionRate: `${hedgeCompletionRate.toFixed(1)}%`,
        avgPairedCost: `${avgPaired.toFixed(1)}¢`,
        medianPairedCost: `${median.toFixed(1)}¢`,
        worstPairedCost: `${worst.toFixed(1)}¢`,
        mergesGt100: s.mergesGt100,
        mergesGt105: s.mergesGt105,
        mergesGt110: s.mergesGt110,
        mergesGt120: s.mergesGt120,
        unpairedLeftovers: s.unpairedLeftovers,
        avgUnpairedDurationS: avgUnpairedDuration.toFixed(1),
      });
    }
  }
}
