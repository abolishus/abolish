// The Tier 0 batch job's chain adapter (docs/spec/registration.md, The batch;
// packages/core's `Tier0Chain`): the group registry read over viem from one
// L2 node, and records sent through a submitter the caller supplies. Core
// decides; this file only reads and sends.
//
// Reads at one pinned block pair: `group()` pins the node's finalized and
// latest blocks, and the `additionAt` calls that follow judge against that
// same pair, so one group's step 1 never mixes a count from one block with an
// addition from another (core still tolerates such a mix; T-06). Every read
// is of public chain data, and nothing here logs or throws what it read
// (T-10, T-13).

import { groupRegistryAbi } from "@abolishus/contracts/abi";
import { decodeGroupAddition } from "@abolishus/crypto";
import type {
  Tier0Chain,
  Tier0GroupState,
  Tier0IndexRead,
  Tier0LoggedAddition,
} from "@abolishus/core";
import { type Address, getAddress, hexToBytes, type PublicClient } from "viem";
import { privateKeyToAddress } from "viem/accounts";

/** The most blocks one `eth_getLogs` call spans: providers cap ranges. */
export const TIER0_LOG_RANGE = 10_000n;

export interface Tier0ChainOptions {
  /** One L2 node; its HTTP transport should time out well within core's `TIER0_BATCH_LOCK_MS`. */
  readonly client: PublicClient;
  readonly registry: Address;
  /** The registry's deployment block: no log of it is older. */
  readonly fromBlock: bigint;
  /**
   * Sends an addition record to the registry's `addMembers`, resolving once
   * it is taken (the paymaster's bundler, docs/spec/contracts.md,
   * Registration paymaster).
   */
  readonly submit: (record: Uint8Array) => Promise<void>;
  /** Blocks per log query; `TIER0_LOG_RANGE` unless a provider allows fewer. */
  readonly logRange?: bigint;
}

interface Pin {
  readonly finalized: bigint;
  readonly latest: bigint;
}

/** The group registry as the Tier 0 batch job reads it. */
export class ViemTier0Chain implements Tier0Chain {
  readonly #client: PublicClient;
  readonly #registry: Address;
  readonly #from: bigint;
  readonly #submit: (record: Uint8Array) => Promise<void>;
  readonly #range: bigint;
  #pin: Pin | undefined;
  // The highest blocks this adapter has read at. A node (or a load
  // balancer's other node) that later answers from below them is refused:
  // an index read there could miss a batch of ours already finished, and
  // let its commitments be signed again (T-06).
  #seen: Pin = { finalized: 0n, latest: 0n };

  constructor(options: Tier0ChainOptions) {
    const range = options.logRange ?? TIER0_LOG_RANGE;
    if (range < 1n) throw new RangeError("logRange must be at least one block");
    if (options.fromBlock < 0n) throw new RangeError("fromBlock must not be negative");
    this.#client = options.client;
    this.#registry = getAddress(options.registry);
    this.#from = options.fromBlock;
    this.#submit = options.submit;
    this.#range = range;
  }

  async tier0Commitments(): Promise<Tier0IndexRead> {
    const latest = await this.#client.getBlockNumber({ cacheTime: 0 });
    this.#advance({ finalized: this.#seen.finalized, latest });
    const tier0 = new Set<bigint>();
    for (const log of await this.#logs("GroupCreated", { tier: 0 }, latest))
      tier0.add(log.args.groupId);
    const all: bigint[] = [];
    for (const log of await this.#logs("MembersAdded", {}, latest)) {
      if (!tier0.has(log.args.groupId)) continue;
      all.push(...addition(log.args.record).commitments);
    }
    return { block: latest, commitments: all };
  }

  /**
   * Pins the node's finalized and latest blocks for this group's reads: the
   * `additionAt` calls that follow `group()` judge against the same pair.
   */
  async group(groupId: bigint): Promise<Tier0GroupState> {
    this.#pin = undefined;
    const pin = await this.#pinBlocks();
    this.#pin = pin;
    // The tier from finalized history only: registrars sign for a group
    // once its creation is final (docs/spec/contracts.md, Groups).
    const created = await this.#logs("GroupCreated", { groupId }, pin.finalized);
    if (created.length !== 1) throw new Error("the group's creation isn't final");
    const tier = (created[0] as (typeof created)[number]).args.tier;
    const [finalTier, finalExists, finalizedSize] = await this.#groupOf(groupId, pin.finalized);
    const [, , latestSize] = await this.#groupOf(groupId, pin.latest);
    // The view and the event are the same contract's: a disagreement is a
    // node to distrust, never a group to sign into.
    if (!finalExists || finalTier !== tier) throw new Error("the node's reads disagree");
    return { tier, finalizedSize, latestSize };
  }

  /** Judged at the pin of the last `group()` call, or at a fresh one if there was none. */
  async additionAt(groupId: bigint, firstIndex: bigint): Promise<Tier0LoggedAddition | null> {
    const pin = this.#pin ?? (await this.#pinBlocks());
    const logs = await this.#logs("MembersAdded", { groupId, firstIndex }, pin.latest);
    // The registry adds at a position once (WrongPosition); two logs there
    // mean a node not to read from.
    if (logs.length > 1) throw new Error("two additions at one position");
    const log = logs[0];
    if (log === undefined) return null;
    const record = hexToBytes(log.args.record);
    const decoded = addition(log.args.record);
    if (decoded.groupId !== groupId || decoded.firstIndex !== firstIndex)
      throw new Error("an addition logged under another position");
    return { record, block: log.blockNumber, final: log.blockNumber <= pin.finalized };
  }

  submit(record: Uint8Array): Promise<void> {
    return this.#submit(record.slice());
  }

  async #pinBlocks(): Promise<Pin> {
    const [finalized, latest] = await Promise.all([
      this.#client.getBlock({ blockTag: "finalized" }),
      this.#client.getBlock({ blockTag: "latest" }),
    ]);
    if (finalized.number > latest.number) throw new Error("the node's finalized block leads");
    const pin = { finalized: finalized.number, latest: latest.number };
    this.#advance(pin);
    return pin;
  }

  #advance(pin: Pin) {
    if (pin.latest < this.#seen.latest || pin.finalized < this.#seen.finalized)
      throw new Error("the node is behind blocks already read");
    this.#seen = pin;
  }

  #groupOf(groupId: bigint, blockNumber: bigint) {
    return this.#client.readContract({
      address: this.#registry,
      abi: groupRegistryAbi,
      functionName: "groupOf",
      args: [groupId],
      blockNumber,
    });
  }

  /** Every log of `eventName` matching `args` from the deployment block to `toBlock`, in order. */
  async #logs<E extends "GroupCreated" | "MembersAdded">(
    eventName: E,
    args: E extends "GroupCreated"
      ? { groupId?: bigint; tier?: number }
      : { groupId?: bigint; firstIndex?: bigint },
    toBlock: bigint,
  ) {
    const out = [];
    for (let from = this.#from; from <= toBlock; from += this.#range) {
      const to = from + this.#range - 1n < toBlock ? from + this.#range - 1n : toBlock;
      const logs = await this.#client.getContractEvents({
        address: this.#registry,
        abi: groupRegistryAbi,
        eventName,
        args,
        fromBlock: from,
        toBlock: to,
        strict: true,
        // One generic call for both events: viem can't narrow the args type
        // through `E`, so the result is typed by `RegistryLog` instead.
      } as never);
      // A node that answers with logs outside the asked range, or pending,
      // is refused rather than read; so is one repeating another range's.
      for (const log of logs as unknown as RegistryLog<E>[]) {
        if (log.blockNumber === null || log.blockNumber < from || log.blockNumber > to)
          throw new Error("a log outside the asked range");
        out.push(log);
      }
    }
    return out as (RegistryLog<E> & { blockNumber: bigint })[];
  }
}

type RegistryLog<E> = E extends "GroupCreated"
  ? { readonly blockNumber: bigint | null; readonly args: { groupId: bigint; tier: number } }
  : {
      readonly blockNumber: bigint | null;
      readonly args: { groupId: bigint; firstIndex: bigint; record: `0x${string}` };
    };

/** The registry logs only records it accepted; one that doesn't decode is a node not to trust. */
function addition(record: `0x${string}`) {
  const decoded = decodeGroupAddition(hexToBytes(record));
  if (!decoded.ok) throw new Error("a logged addition doesn't decode");
  return decoded.value;
}

export interface Tier0Deployment {
  readonly chainId: bigint;
  readonly registry: Address;
  /** The registry's deployment block, as `Tier0ChainOptions.fromBlock`. */
  readonly fromBlock: bigint;
  readonly registrars: readonly Address[];
  readonly threshold: number;
  /** The service's keys, by seat. */
  readonly signers: readonly { readonly seat: number; readonly secretKey: Uint8Array }[];
}

/**
 * The startup check (P3-2 part 4d-2b): the node is on the configured chain;
 * the registry's finalized state pins exactly the configured registrars and
 * threshold; `fromBlock` is its deployment block (no code before it, and its
 * constructor's `RegistrarsPinned`, the registry's first log, read from it),
 * so the index misses none of its additions; and each signer's key is its
 * seat's registrar. So a misconfigured job refuses to start rather than sign
 * records the registry refuses, or commitments already live (T-06, T-62).
 * Throws naming the mismatch, never a key.
 */
export async function checkTier0Deployment(
  client: PublicClient,
  deployment: Tier0Deployment,
): Promise<void> {
  const chainId = BigInt(await client.getChainId());
  if (chainId !== deployment.chainId) throw new Error("the L2 node is on another chain");
  const blockNumber = (await client.getBlock({ blockTag: "finalized" })).number;
  const at = { address: deployment.registry, abi: groupRegistryAbi, blockNumber } as const;
  const [registrars, threshold] = await Promise.all([
    client.readContract({ ...at, functionName: "registrars" }),
    client.readContract({ ...at, functionName: "threshold" }),
  ]);
  const same = (a: readonly Address[], b: readonly Address[]) =>
    a.length === b.length && a.every((x, i) => getAddress(x) === getAddress(b[i] as Address));
  if (!same(registrars, deployment.registrars))
    throw new Error("the registry pins other registrars");
  if (threshold !== deployment.threshold) throw new Error("the registry pins another threshold");
  const { fromBlock } = deployment;
  const before =
    fromBlock === 0n
      ? undefined
      : await client.getCode({ address: deployment.registry, blockNumber: fromBlock - 1n });
  const pinned = await client.getContractEvents({
    address: deployment.registry,
    abi: groupRegistryAbi,
    eventName: "RegistrarsPinned",
    fromBlock,
    toBlock: fromBlock,
    strict: true,
  });
  const deployedThere =
    (before === undefined || before === "0x") &&
    pinned.length === 1 &&
    pinned[0]?.args.threshold === threshold &&
    same(pinned[0].args.registrars, registrars);
  if (!deployedThere) throw new Error("fromBlock isn't the registry's deployment block");
  for (const { seat, secretKey } of deployment.signers) {
    const registrar = registrars[seat - 1];
    let address: Address | undefined;
    try {
      address = privateKeyToAddress(`0x${Buffer.from(secretKey).toString("hex")}`);
    } catch {
      // viem's message for an out-of-range key quotes the key.
    }
    if (registrar === undefined || address === undefined || getAddress(registrar) !== address)
      throw new Error(`the key for seat ${seat} isn't that seat's registrar`);
  }
}
