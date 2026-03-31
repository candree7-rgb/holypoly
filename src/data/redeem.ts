import { BuilderConfig, BuilderApiKeyCreds } from "@polymarket/builder-signing-sdk";
import { RelayClient, RelayerTxType, Transaction } from "@polymarket/builder-relayer-client";
import { createWalletClient, encodeFunctionData, prepareEncodeFunctionData, http, zeroHash, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { Logger } from "../logger.js";
import type { Position } from "../types.js";
import { toBaseUnits } from "../utils.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CTF_ADDRESS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

const ctfRedeemAbi = [
  {
    constant: false,
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "indexSets", type: "uint256[]" },
    ],
    name: "redeemPositions",
    outputs: [],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const nrAdapterRedeemAbi = [
  {
    inputs: [
      { internalType: "bytes32", name: "_conditionId", type: "bytes32" },
      { internalType: "uint256[]", name: "_amounts", type: "uint256[]" },
    ],
    name: "redeemPositions",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const ctfMergeAbi = [
  {
    constant: false,
    inputs: [
      { name: "collateralToken", type: "address" },
      { name: "parentCollectionId", type: "bytes32" },
      { name: "conditionId", type: "bytes32" },
      { name: "partition", type: "uint256[]" },
      { name: "amount", type: "uint256" },
    ],
    name: "mergePositions",
    outputs: [],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const nrAdapterMergeAbi = [
  {
    inputs: [
      { internalType: "bytes32", name: "_conditionId", type: "bytes32" },
      { internalType: "uint256", name: "_amount", type: "uint256" },
    ],
    name: "mergePositions",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const ctfRedeemFn = prepareEncodeFunctionData({
  abi: ctfRedeemAbi,
  functionName: "redeemPositions",
});

const ctfMergeFn = prepareEncodeFunctionData({
  abi: ctfMergeAbi,
  functionName: "mergePositions",
});

const nrMergeFn = prepareEncodeFunctionData({
  abi: nrAdapterMergeAbi,
  functionName: "mergePositions",
});

const nrRedeemFn = prepareEncodeFunctionData({
  abi: nrAdapterRedeemAbi,
  functionName: "redeemPositions",
});

export interface RedeemConfig {
  relayerUrl: string;
  chainId: number;
  privateKey: string;
  rpcUrl: string;
  txType: "SAFE" | "PROXY";
  builderCreds?: BuilderApiKeyCreds;
  builderSigningUrl?: string;
  builderSigningToken?: string;
}

export class RedeemService {
  private client: RelayClient;
  private logger: Logger;

  private constructor(client: RelayClient, logger: Logger) {
    this.client = client;
    this.logger = logger;
  }

  static init(config: RedeemConfig, logger: Logger): RedeemService {
    if (config.chainId !== 137) {
      throw new Error(`Unsupported chainId for redeem: ${config.chainId}`);
    }
    const account = privateKeyToAccount(config.privateKey as Hex);
    const wallet = createWalletClient({
      account,
      chain: polygon,
      transport: http(config.rpcUrl),
    });

    let builderConfig: BuilderConfig | undefined;
    if (config.builderCreds) {
      builderConfig = new BuilderConfig({ localBuilderCreds: config.builderCreds });
    } else if (config.builderSigningUrl && config.builderSigningToken) {
      builderConfig = new BuilderConfig({
        remoteBuilderConfig: {
          url: config.builderSigningUrl,
          token: config.builderSigningToken,
        },
      });
    }

    const txType = config.txType === "SAFE" ? RelayerTxType.SAFE : RelayerTxType.PROXY;
    const client = new RelayClient(config.relayerUrl, config.chainId, wallet, builderConfig, txType);
    return new RedeemService(client, logger);
  }

  private async execute(tx: Transaction, description: string): Promise<string | null> {
    try {
      const response = await this.client.execute([tx], description);
      const result = await response.wait();
      if (!result?.transactionHash) return null;
      return result.transactionHash;
    } catch (err) {
      const msg = (err as Error).message ?? "";
      this.logger.warn("Redeem transaction failed", { error: msg });
      // Re-throw rate limit errors so callers can back off
      if (msg.includes("429") || msg.includes("Too Many") || msg.includes("quota exceeded")) {
        throw err;
      }
      return null;
    }
  }

  private createCtfRedeem(conditionId: string): Transaction {
    const calldata = encodeFunctionData({
      ...ctfRedeemFn,
      args: [USDC_ADDRESS as Hex, zeroHash, conditionId as Hex, [1n, 2n]],
    });
    return { to: CTF_ADDRESS, data: calldata, value: "0" };
  }

  private createNegRiskRedeem(conditionId: string, amounts: bigint[]): Transaction {
    const calldata = encodeFunctionData({
      ...nrRedeemFn,
      args: [conditionId as Hex, amounts],
    });
    return { to: NEG_RISK_ADAPTER, data: calldata, value: "0" };
  }

  async redeemPositions(positions: Position[]): Promise<string[]> {
    const byCondition: Record<string, Position[]> = {};
    for (const pos of positions) {
      if (!pos.redeemable) continue;
      if (!byCondition[pos.conditionId]) byCondition[pos.conditionId] = [];
      byCondition[pos.conditionId].push(pos);
    }

    // Build ALL transactions, then submit in a single relayer call (1 quota unit)
    const txs: Transaction[] = [];
    const conditionIds: string[] = [];
    for (const [conditionId, group] of Object.entries(byCondition)) {
      const isNegRisk = group.some((p) => p.negativeRisk);
      const tx = isNegRisk
        ? this.createNegRiskRedeem(conditionId, this.buildNegRiskAmounts(group))
        : this.createCtfRedeem(conditionId);
      txs.push(tx);
      conditionIds.push(conditionId);
    }

    if (txs.length === 0) return [];

    this.logger.info("Submitting batched redeem", { conditions: txs.length, conditionIds });

    try {
      const response = await this.client.execute(txs, "redeem positions");
      const result = await response.wait();
      if (!result?.transactionHash) return [];
      this.logger.info("Batch redeem executed", { txHash: result.transactionHash, conditions: txs.length });
      return [result.transactionHash];
    } catch (err) {
      const msg = (err as Error).message ?? "";
      this.logger.warn("Redeem transaction failed", { error: msg });
      if (msg.includes("429") || msg.includes("Too Many") || msg.includes("quota exceeded")) {
        throw err;
      }
      return [];
    }
  }

  /**
   * Merge equal amounts of Up+Down shares back into USDC collateral.
   * Burns `amount` shares from each outcome → returns `amount` × $1.00 USDC.
   */
  async mergePositions(conditionId: string, amount: number, negRisk: boolean): Promise<string | null> {
    const amountBase = toBaseUnits(amount, 6);
    const tx = negRisk
      ? this.createNegRiskMerge(conditionId, amountBase)
      : this.createCtfMerge(conditionId, amountBase);

    const txHash = await this.execute(tx, "merge positions");
    if (txHash) {
      this.logger.info("Merge executed", { conditionId, amount, txHash });
    }
    return txHash;
  }

  private createCtfMerge(conditionId: string, amount: bigint): Transaction {
    const calldata = encodeFunctionData({
      ...ctfMergeFn,
      args: [USDC_ADDRESS as Hex, zeroHash, conditionId as Hex, [1n, 2n], amount],
    });
    return { to: CTF_ADDRESS, data: calldata, value: "0" };
  }

  private createNegRiskMerge(conditionId: string, amount: bigint): Transaction {
    const calldata = encodeFunctionData({
      ...nrMergeFn,
      args: [conditionId as Hex, amount],
    });
    return { to: NEG_RISK_ADAPTER, data: calldata, value: "0" };
  }

  private buildNegRiskAmounts(group: Position[]): bigint[] {
    const amounts: bigint[] = [0n, 0n];
    for (const pos of group) {
      const idx = pos.outcomeIndex === 0 ? 0 : 1;
      amounts[idx] = amounts[idx] + toBaseUnits(pos.size, 6);
    }
    return amounts;
  }
}
