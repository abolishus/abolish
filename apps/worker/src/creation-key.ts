// The creation key's operator commands (the poll-creation runbook, Funding,
// Rotation and Compromise; [[0032-poll-creation-operations]]; P2-22 part
// 3b-3): `status`, what the chain and the database say of the key, and
// `sweep`, which sends its whole balance, less the fees, to the funding
// account. The worker's own jobs never call these; an operator runs them in
// the `worker-create` service, with its variables (creation-key-cli.ts).
//
// T-72: the status sets the key's included nonces against its ledger, so a
// transaction the worker didn't send shows up, and the sweep caps what a
// thief still holding the key can take at what lands before it. T-65:
// nothing here prints or throws the key, a signed transaction or a node's
// answer.

import { type CreationKeyRecords, creationKeyRecords } from "@abolishus/core";
import type { Sql } from "postgres";
import {
  type Address,
  bytesToHex,
  BaseError,
  ContractFunctionRevertedError,
  getAddress,
  type Hex,
  hexToBytes,
  isAddress,
  parseAbi,
  type PublicClient,
  serializeTransaction,
} from "viem";
import { BASE_FEE_HEADROOM, CREATE_CALLDATA, creationAccount } from "./poll-create-chain.ts";

/** The OP Stack's `GasPriceOracle` predeploy, which prices a transaction's L1 data and operator fees. */
const GAS_PRICE_ORACLE: Address = "0x420000000000000000000000000000000000000F";

const gasPriceOracleAbi = parseAbi([
  "function getL1Fee(bytes) view returns (uint256)",
  "function getOperatorFee(uint256) view returns (uint256)",
]);

/** A plain transfer's gas, which an account without code takes exactly. */
const TRANSFER_GAS = 21_000n;

/**
 * How many of the oracle's fee the sweep leaves behind: the L1 fee moves
 * with L1's base fee between the estimate and inclusion, and an OP Stack
 * node refuses a transaction whose balance doesn't cover it.
 */
const SWEEP_FEE_HEADROOM = 2n;

/**
 * The L1 data fee and the operator fee an OP Stack chain charges for `tx`
 * (its unsigned bytes) beside gas, or 0 on a chain with no oracle, which
 * charges neither (a local Anvil). An oracle from before the operator fee
 * prices only the L1 data.
 */
async function extraFees(client: PublicClient, tx: Hex, gas: bigint): Promise<bigint> {
  const code = await client.getCode({ address: GAS_PRICE_ORACLE });
  if (code === undefined || code === "0x") return 0n;
  const l1 = await client.readContract({
    address: GAS_PRICE_ORACLE,
    abi: gasPriceOracleAbi,
    functionName: "getL1Fee",
    args: [tx],
  });
  let operator = 0n;
  try {
    operator = await client.readContract({
      address: GAS_PRICE_ORACLE,
      abi: gasPriceOracleAbi,
      functionName: "getOperatorFee",
      args: [gas],
    });
  } catch (e) {
    // Only the oracle refusing the call means it predates the fee; a
    // timeout or a refused request wraps the same way and must not price
    // the fee at 0.
    if (!(e instanceof BaseError && e.walk((c) => c instanceof ContractFunctionRevertedError)))
      throw e;
  }
  return l1 + operator;
}

/** What the chain says of the creation key. */
export interface CreationKeyChainState {
  readonly address: Address;
  /** At the node's latest block, in wei. */
  readonly balance: bigint;
  readonly nonces: {
    readonly finalized: bigint;
    readonly latest: bigint;
    readonly pending: bigint;
  };
  /**
   * One creation's cost at the latest base fee and tip, with the L1 and
   * operator fees, in wei: what the runbook's float is counted in.
   */
  readonly creationCost: bigint;
}

/** The key's balance, nonce counts and the current cost of one creation, from one L2 node. */
export async function creationKeyChainState(
  client: PublicClient,
  options: { readonly chainId: bigint; readonly registry: Address; readonly key: Uint8Array },
): Promise<CreationKeyChainState> {
  const { address } = creationAccount(options.key);
  const registry = getAddress(options.registry);
  const count = (blockTag: "finalized" | "latest" | "pending") =>
    client.getTransactionCount({ address, blockTag }).then((n) => BigInt(n));
  const [finalized, latest, pending, balance, gas, block, tip] = await Promise.all([
    count("finalized"),
    count("latest"),
    count("pending"),
    client.getBalance({ address, blockTag: "latest" }),
    client.estimateGas({ account: address, to: registry, data: CREATE_CALLDATA }),
    client.getBlock({ blockTag: "latest" }),
    client.estimateMaxPriorityFeePerGas(),
  ]);
  if (block.baseFeePerGas === null) throw new Error("the L2 has no base fee");
  const extra = await extraFees(
    client,
    serializeTransaction({
      type: "eip1559",
      chainId: Number(options.chainId),
      nonce: Number(pending),
      to: registry,
      data: CREATE_CALLDATA,
      gas,
      maxFeePerGas: block.baseFeePerGas * BASE_FEE_HEADROOM + tip,
      maxPriorityFeePerGas: tip,
    }),
    gas,
  );
  return {
    address,
    balance,
    nonces: { finalized, latest, pending },
    creationCost: gas * (block.baseFeePerGas + tip) + extra,
  };
}

/**
 * The status command's report, as JSON-ready values: the chain's view, the
 * database's, and the runbook's two checks, whether the balance is below a
 * day's ceiling of creations (Funding) and whether the key has
 * transactions the worker didn't record (Compromise).
 */
export function creationKeyReport(
  chain: CreationKeyChainState,
  records: CreationKeyRecords,
  dailyCeiling: number,
) {
  return {
    key: chain.address,
    balance: chain.balance.toString(),
    creationCost: chain.creationCost.toString(),
    creationsAffordable: (chain.creationCost === 0n
      ? 0n
      : chain.balance / chain.creationCost
    ).toString(),
    dailyCeiling,
    belowDailyCeiling: chain.balance < BigInt(dailyCeiling) * chain.creationCost,
    nonces: {
      finalized: chain.nonces.finalized.toString(),
      latest: chain.nonces.latest.toString(),
      pending: chain.nonces.pending.toString(),
    },
    ledger: {
      recorded: records.recorded,
      unincluded: records.unincluded,
      unfinalized: records.unfinalized,
      lastDay: records.lastDay,
    },
    unrecorded: records.unrecorded.toString(),
    pollCount: records.pollCount,
    polls: records.polls.map((p) => ({
      id: p.id,
      state: p.state,
      electionId: p.electionId === null ? null : bytesToHex(p.electionId),
    })),
  };
}

export interface SweepOptions {
  /** One L2 node. */
  readonly client: PublicClient;
  /** The database the creation step records the key's transactions in. */
  readonly sql: Sql;
  /** The node's chain, as `checkPollCreationDeployment` checked it. */
  readonly chainId: bigint;
  /** The creation key's 32 bytes. */
  readonly key: Uint8Array;
  /** The funding account. */
  readonly to: Address;
}

export interface Sweep {
  readonly hash: Hex;
  /** Wei sent to the funding account. */
  readonly value: bigint;
}

/**
 * Signs and sends one transfer of the key's whole balance at the node's
 * latest block, less the most the transfer can cost in gas and twice its
 * L1 and operator fees, to `to`. Refuses while the node holds a pending
 * transaction of the key: the transfer would wait behind it, priced on a
 * balance that transaction can still spend. Refuses too while the ledger
 * holds a creation at a nonce the node hasn't included (one it dropped, or
 * a running worker's): the sweep would take that nonce, and its poll would
 * fail as `creation-replaced`, the runbook's sign of compromise. Returns
 * once the node took it.
 */
export async function sweepCreationKey(options: SweepOptions): Promise<Sweep> {
  const { client } = options;
  const account = creationAccount(options.key);
  const to = getAddress(options.to);
  if (to === account.address) throw new Error("the funding account is the creation key");
  if (hexToBytes(to).every((b) => b === 0))
    throw new Error("the funding account is the zero address");
  const [latest, pending] = await Promise.all([
    client.getTransactionCount({ address: account.address, blockTag: "latest" }),
    client.getTransactionCount({ address: account.address, blockTag: "pending" }),
  ]);
  if (pending !== latest)
    throw new Error(
      `the key has ${pending - latest} pending transaction(s); stop the creation queues and wait for them to land or drop`,
    );
  const { unincluded } = await creationKeyRecords(
    options.sql,
    hexToBytes(account.address),
    // Only `latest` is read here; finality doesn't bear on the sweep.
    { finalized: 0n, latest: BigInt(latest) },
    new Date(0),
  );
  if (unincluded > 0)
    throw new Error(
      `the ledger has ${unincluded} creation(s) the node hasn't included; run the creation queue until they land`,
    );
  const [balance, block, tip, estimate] = await Promise.all([
    client.getBalance({ address: account.address, blockTag: "latest" }),
    client.getBlock({ blockTag: "latest" }),
    client.estimateMaxPriorityFeePerGas(),
    // 1 wei, not 0: a funding contract's receive path can differ for a
    // transfer of value.
    client.estimateGas({ account: account.address, to, value: 1n }),
  ]);
  if (block.baseFeePerGas === null) throw new Error("the L2 has no base fee");
  // An account without code takes exactly a transfer's gas; a contract's
  // receive path gets headroom, and what it doesn't use stays on the key.
  const gas = estimate === TRANSFER_GAS ? estimate : (estimate * 120n) / 100n;
  const fees = {
    maxFeePerGas: block.baseFeePerGas * BASE_FEE_HEADROOM + tip,
    maxPriorityFeePerGas: tip,
  };
  const unsigned = {
    type: "eip1559",
    chainId: Number(options.chainId),
    nonce: latest,
    to,
    gas,
    ...fees,
  } as const;
  const extra = await extraFees(client, serializeTransaction({ ...unsigned, value: balance }), gas);
  const value = balance - gas * fees.maxFeePerGas - extra * SWEEP_FEE_HEADROOM;
  if (value <= 0n) throw new Error("nothing to sweep: the balance doesn't cover the fees");
  const tx = await account.signTransaction({ ...unsigned, value });
  const hash = await client.sendRawTransaction({ serializedTransaction: tx });
  return { hash, value };
}

/** A command line for the creation key's commands. */
export type CreationKeyCommand =
  | { readonly command: "status" }
  | { readonly command: "sweep"; readonly to: Address };

export const CREATION_KEY_USAGE =
  "usage: creation-key status | creation-key sweep <funding address>";

/** Parses the arguments after the script's name; throws the usage on anything else. */
export function parseCreationKeyCommand(args: readonly string[]): CreationKeyCommand {
  if (args.length === 1 && args[0] === "status") return { command: "status" };
  if (args.length === 2 && args[0] === "sweep") {
    const to = args[1] as string;
    // A full address only, so a typo can't sweep to a guess: strict
    // checksums for mixed case, as wallets print them.
    if (/^0x[0-9a-fA-F]{40}$/.test(to) && isAddress(to, { strict: true }) && !/^0x0{40}$/.test(to))
      return { command: "sweep", to: getAddress(to) };
    // Never echoed: a key pasted in its place would land in the logs (T-65).
    throw new Error(`the funding address isn't a full address\n${CREATION_KEY_USAGE}`);
  }
  throw new Error(CREATION_KEY_USAGE);
}
