// The creation step's chain adapter (packages/core's `PollCreationChain` and
// `PollRegistrationChain`; [[0032-poll-creation-operations]], rules 1, 4 and
// 12; P2-22 parts 3a and 5b): the creation key signs `createElection()`, and
// later each poll's `registerCeremony(record)` and
// `registerDefinition(definition)`, here, sends them to one L2 node and reads
// their receipts. Core decides what to sign and when a poll moves on; this
// file only signs, sends and reads.
//
// A creation or a registration counts only from finalized history, and only
// as the event the release's registry emits for it: the receipt is the key's
// own call to the configured registry, its block is the node's block at that
// height, and its one `ElectionCreated` names the key as creator and the
// identifier the registry's counter gives (docs/spec/contracts.md, Election
// identifier), or its one `DefinitionRegistered` names the definition the
// registry admitted. Anything else is a node not to read from, never a poll
// to move (T-25, T-34). The key is used for nothing but signing, and nothing
// here logs or throws it, the transactions or the node's answers (T-65,
// T-72).

import { electionRegistryAbi, trusteeRegistryAbi } from "@abolishus/contracts/abi";
import type {
  CreationStatus,
  PollCreationChain,
  PollRegistrationChain,
  RegistrationStatus,
  SignedCreation,
} from "@abolishus/core";
import { electionId, type Panel, panelId } from "@abolishus/crypto";
import {
  type Address,
  BaseError,
  bytesToHex,
  ContractFunctionExecutionError,
  encodeFunctionData,
  getAddress,
  type Hex,
  hexToBytes,
  keccak256,
  parseEventLogs,
  type PublicClient,
  type TransactionReceipt,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
} from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";

/** `createElection()`'s calldata: its selector alone, as the registry requires. */
export const CREATE_CALLDATA = encodeFunctionData({
  abi: electionRegistryAbi,
  functionName: "createElection",
});

/**
 * Headroom over the node's gas estimate, in percent: the counter's slot and
 * the event accumulator cost the same for every creation, so a little covers
 * a node's estimate being slightly low.
 */
const GAS_HEADROOM = 120n;

/**
 * `registerDefinition`'s gas limit, as a base and a cost per byte of its
 * definition. Its gas can't be estimated when it is signed: core signs it
 * beside the ceremony's registration, before either is sent, and until the
 * ceremony lands the registry refuses it (`CeremonyNotRecorded`). Its cost
 * is the definition's decoding, rules and parameters, and the event that
 * carries it whole, all linear in its length; the Anvil test measures a
 * definition's use against this. Only gas used is paid.
 */
export const DEFINITION_GAS_BASE = 1_500_000n;
export const DEFINITION_GAS_PER_BYTE = 600n;

/** How many of the latest base fee a transaction's fee cap allows, before its tip. */
export const BASE_FEE_HEADROOM = 3n;

/** A node's answer to a transaction it already holds, which is a send that took. */
const ALREADY_KNOWN = /already known|known transaction|already imported/i;

export interface PollCreationChainOptions {
  /** One L2 node. */
  readonly client: PublicClient;
  /** The node's chain, as `checkPollCreationDeployment` checked it. */
  readonly chainId: bigint;
  readonly registry: Address;
  /** The election registry's trustee registry, as `checkPollCreationDeployment` read it. */
  readonly trusteeRegistry: Address;
  /** The creation key's 32 bytes (`CREATE_KEY`). */
  readonly key: Uint8Array;
}

/** The creation key on the election and trustee registries, as the creation and registration steps use it. */
export class ViemPollCreationChain implements PollCreationChain, PollRegistrationChain {
  readonly #client: PublicClient;
  readonly #chainId: bigint;
  readonly #registry: Address;
  readonly #trusteeRegistry: Address;
  readonly #account: PrivateKeyAccount;

  constructor(options: PollCreationChainOptions) {
    this.#client = options.client;
    this.#chainId = options.chainId;
    this.#registry = getAddress(options.registry);
    this.#trusteeRegistry = getAddress(options.trusteeRegistry);
    this.#account = creationAccount(options.key);
  }

  get creator(): Uint8Array {
    return hexToBytes(this.#account.address);
  }

  async nonces() {
    const count = (blockTag: "finalized" | "latest" | "pending") =>
      this.#client
        .getTransactionCount({ address: this.#account.address, blockTag })
        .then((n) => BigInt(n));
    const [finalized, latest, pending] = await Promise.all([
      count("finalized"),
      count("latest"),
      count("pending"),
    ]);
    return { finalized, latest, pending };
  }

  async signCreation(nonce: bigint): Promise<SignedCreation> {
    return this.#sign(nonce, this.#registry, CREATE_CALLDATA);
  }

  async signCeremony(nonce: bigint, record: Uint8Array): Promise<SignedCreation> {
    const data = encodeFunctionData({
      abi: trusteeRegistryAbi,
      functionName: "registerCeremony",
      args: [bytesToHex(record)],
    });
    return this.#sign(nonce, this.#trusteeRegistry, data);
  }

  async signDefinition(nonce: bigint, definition: Uint8Array): Promise<SignedCreation> {
    const data = encodeFunctionData({
      abi: electionRegistryAbi,
      functionName: "registerDefinition",
      args: [bytesToHex(definition)],
    });
    const gas = DEFINITION_GAS_BASE + DEFINITION_GAS_PER_BYTE * BigInt(definition.length);
    return this.#sign(nonce, this.#registry, data, gas);
  }

  /** Signs a call to `to` at `nonce`, with `gas` or the node's estimate and headroom. */
  async #sign(nonce: bigint, to: Address, data: Hex, gas?: bigint): Promise<SignedCreation> {
    if (nonce < 0n || nonce > BigInt(Number.MAX_SAFE_INTEGER))
      throw new RangeError("the nonce is out of range");
    const [estimate, block, tip] = await Promise.all([
      gas ?? this.#client.estimateGas({ account: this.#account.address, to, data }),
      this.#client.getBlock({ blockTag: "latest" }),
      this.#client.estimateMaxPriorityFeePerGas(),
    ]);
    if (block.baseFeePerGas === null) throw new Error("the L2 has no base fee");
    const tx = await this.#account.signTransaction({
      type: "eip1559",
      chainId: Number(this.#chainId),
      nonce: Number(nonce),
      to,
      data,
      gas: gas ?? (estimate * GAS_HEADROOM) / 100n,
      // Nothing replaces a transaction stuck under a fee rise, and it would
      // hold every later nonce of the key, so the cap is several base fees
      // ahead; EIP-1559 charges only the base fee and the tip.
      maxFeePerGas: block.baseFeePerGas * BASE_FEE_HEADROOM + tip,
      maxPriorityFeePerGas: tip,
    });
    return { tx: hexToBytes(tx), hash: hexToBytes(keccak256(tx)) };
  }

  async broadcast(tx: Uint8Array): Promise<void> {
    try {
      await this.#client.sendRawTransaction({ serializedTransaction: bytesToHex(tx) });
    } catch (e) {
      if (e instanceof BaseError && e.walk((c) => ALREADY_KNOWN.test((c as Error).message))) return;
      throw e;
    }
  }

  async creation(hash: Uint8Array): Promise<CreationStatus> {
    const final = await this.#finalReceipt(hash, this.#registry);
    if (!("receipt" in final)) return final;
    const { receipt } = final;
    if (receipt.status !== "success") return { state: "reverted" };
    const created = parseEventLogs({
      abi: electionRegistryAbi,
      eventName: "ElectionCreated",
      logs: receipt.logs.filter((l) => getAddress(l.address) === this.#registry),
      strict: true,
    });
    const event = created.length === 1 ? created[0] : undefined;
    if (event === undefined || getAddress(event.args.creator) !== this.#account.address)
      throw new Error("the creation has no ElectionCreated of its own");
    // The identifier is the registry's counter's, so a node can't hand the
    // poll another election's (T-25).
    const id = electionId(this.#chainId, hexToBytes(this.#registry), event.args.counter);
    if (bytesToHex(id) !== event.args.electionId.toLowerCase())
      throw new Error("the event's identifier isn't the counter's");
    return {
      state: "created",
      electionId: id,
      block: receipt.blockNumber,
      l1OriginTimestamp: event.args.l1OriginTimestamp,
    };
  }

  async registration(hash: Uint8Array): Promise<RegistrationStatus> {
    const final = await this.#finalReceipt(hash, this.#registry);
    if (!("receipt" in final)) return final;
    const { receipt } = final;
    if (receipt.status !== "success") return { state: "reverted" };
    const registered = parseEventLogs({
      abi: electionRegistryAbi,
      eventName: "DefinitionRegistered",
      logs: receipt.logs.filter((l) => getAddress(l.address) === this.#registry),
      strict: true,
    });
    // One successful `registerDefinition` emits exactly one. Core compares
    // its election and definition hash with the poll's approved definition
    // (T-34), so a node can only fail the poll here, never move it.
    if (registered.length !== 1)
      throw new Error("the registration has no DefinitionRegistered of its own");
    const { electionId: id, definitionHash } = registered[0]!.args;
    return {
      state: "registered",
      electionId: hexToBytes(id),
      definitionHash: hexToBytes(definitionHash),
      block: receipt.blockNumber,
    };
  }

  /**
   * The receipt of the key's transaction `hash` to `to`, once final; or
   * whether the node knows it at all. Throws on a receipt that isn't the
   * node's chain's or isn't that call's.
   */
  async #finalReceipt(
    hash: Uint8Array,
    to: Address,
  ): Promise<
    { readonly state: "unknown" | "included" } | { readonly receipt: TransactionReceipt }
  > {
    const finalized = await this.#client.getBlock({ blockTag: "finalized" });
    let receipt;
    try {
      receipt = await this.#client.getTransactionReceipt({ hash: bytesToHex(hash) });
    } catch (e) {
      if (!(e instanceof TransactionReceiptNotFoundError)) throw e;
      // A node behind a load balancer can miss a receipt another of its
      // backends has; core fails a poll as replaced only on `unknown`, so
      // that is said only when the transaction is missing too.
      try {
        await this.#client.getTransaction({ hash: bytesToHex(hash) });
        return { state: "included" };
      } catch (e2) {
        if (e2 instanceof TransactionNotFoundError) return { state: "unknown" };
        throw e2;
      }
    }
    if (receipt.blockNumber > finalized.number) return { state: "included" };
    // At or below the finalized height, the receipt's block is the node's
    // block there; one that isn't is a node mixing forks.
    const block = await this.#client.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash !== receipt.blockHash) throw new Error("the receipt isn't in the node's chain");
    if (
      receipt.transactionHash !== bytesToHex(hash) ||
      getAddress(receipt.from) !== this.#account.address ||
      receipt.to === null ||
      getAddress(receipt.to) !== to
    )
      throw new Error("the receipt isn't the transaction's");
    return { receipt };
  }
}

/** The key as an account; a malformed key is refused without quoting it. */
export function creationAccount(key: Uint8Array): PrivateKeyAccount {
  if (key.length !== 32) throw new Error("the creation key must be 32 bytes");
  try {
    return privateKeyToAccount(bytesToHex(key) as Hex);
  } catch {
    // viem's message for an out-of-range key quotes the key.
    throw new Error("the creation key isn't a valid key");
  }
}

export interface PollCreationDeployment {
  readonly chainId: bigint;
  readonly registry: Address;
  /** The L1 and the board anchor the per-slot check reads (`CREATE_L1_CHAIN_ID`, `CREATE_ANCHOR`). */
  readonly l1ChainId: bigint;
  readonly anchor: Address;
  /** The default panel whose ceremonies the registration step registers (`CREATE_PANEL_*`). */
  readonly panel: Panel;
}

/**
 * The startup check: the node is on the configured chain, and the address
 * holds, in finalized state, a registry that numbers its elections for this
 * chain and address as the release's does (`electionIdAt(0)`), so creations
 * go to the registry our definitions will name and are read back from it
 * (T-34), and that names the configured L1 and board anchor, so the per-slot
 * check reads the anchor every stub of these identifiers will pin (P2-22
 * part 4b), and whose trustee registry pins the default panel at its
 * threshold, so the ceremonies registered there are ones the registry's
 * definitions can name (T-37, part 5b). Returns that trustee registry, the
 * one `registerCeremony` goes to. Throws naming the mismatch, never the URL
 * or a key.
 */
export async function checkPollCreationDeployment(
  client: PublicClient,
  deployment: PollCreationDeployment,
): Promise<{ readonly trusteeRegistry: Address }> {
  // Throws on a panel that isn't one, before anything is read.
  const panel = panelId(deployment.panel);
  const chainId = BigInt(await client.getChainId());
  if (chainId !== deployment.chainId) throw new Error("the L2 node is on another chain");
  const blockNumber = (await client.getBlock({ blockTag: "finalized" })).number;
  const code = await client.getCode({ address: deployment.registry, blockNumber });
  if (code === undefined || code === "0x") throw new Error("no election registry at the address");
  let first: Hex;
  try {
    first = await client.readContract({
      address: deployment.registry,
      abi: electionRegistryAbi,
      functionName: "electionIdAt",
      args: [0n],
      blockNumber,
    });
  } catch (e) {
    if (e instanceof ContractFunctionExecutionError)
      throw new Error("the address isn't an election registry");
    throw e;
  }
  const want = electionId(deployment.chainId, hexToBytes(getAddress(deployment.registry)), 0n);
  if (first.toLowerCase() !== bytesToHex(want))
    throw new Error("the registry numbers its elections for another chain or address");
  const at = { address: deployment.registry, abi: electionRegistryAbi, blockNumber } as const;
  const [l1ChainId, anchor, trusteeRegistry] = await Promise.all([
    client.readContract({ ...at, functionName: "l1ChainId" }),
    client.readContract({ ...at, functionName: "l1Anchor" }),
    client.readContract({ ...at, functionName: "trusteeRegistry" }),
  ]);
  if (l1ChainId !== deployment.l1ChainId) throw new Error("the registry names another L1");
  if (getAddress(anchor) !== getAddress(deployment.anchor))
    throw new Error("the registry names another board anchor");
  // The identifier binds the threshold, the size and every key in seat
  // order, so a non-empty entry under it is this panel, as the stub step
  // checks (T-37). Its quorum must be rule 7's `max(k, n − 1)`, the
  // approvals core collects: a higher one refuses every registration.
  let pinned: readonly [number, number, number];
  try {
    pinned = await client.readContract({
      address: trusteeRegistry,
      abi: trusteeRegistryAbi,
      functionName: "panelOf",
      args: [bytesToHex(panel)],
      blockNumber,
    });
  } catch (e) {
    if (e instanceof ContractFunctionExecutionError)
      throw new Error("the registry's trustee registry isn't one");
    throw e;
  }
  const [threshold, size, quorum] = pinned;
  const { keys } = deployment.panel;
  if (size !== keys.length || threshold !== deployment.panel.threshold)
    throw new Error("the trustee registry doesn't pin the panel");
  if (quorum !== Math.max(threshold, keys.length - 1))
    throw new Error("the trustee registry pins the panel at another quorum than rule 7's");
  return { trusteeRegistry: getAddress(trusteeRegistry) };
}
