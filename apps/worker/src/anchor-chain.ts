// The anchoring job's chain adapter (docs/spec/contracts.md, Board anchor;
// packages/core's `AnchorChain`): the L1 board anchor read over viem from
// one L1 node, and `anchor` calls sent through a sender the caller supplies,
// as the anchoring authority. Core decides what to send; this file only
// reads, checks and sends.
//
// Reads at one pinned block: `now()` pins the node's latest block, and the
// `anchored` calls that follow read the anchor's slots at that same block,
// so a run judges each window against the state at the time it judges by
// (T-49). A call is simulated from the authority before it is sent, so one
// the anchor would refuse costs no signatures or gas, and is confirmed in
// the anchor's state after its sender resolves: a call that reached the
// authority but not the anchor (a Safe transaction whose inner call failed
// without reverting) is a failure, never an anchor counted as made. Every
// read is of public chain data, and nothing here logs or throws what it read
// (T-10).

import { boardAnchorAbi } from "@abolishus/contracts/abi";
import { type AnchoringClock, type AnchorChain } from "@abolishus/core";
import { type Checkpoint, checkpointHash, encodeCheckpoint } from "@abolishus/crypto";
import {
  type Address,
  bytesToHex,
  concatBytes,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  type PublicClient,
} from "viem";

export interface AnchorChainOptions {
  /** One L1 node; its HTTP transport should time out well within the job's period. */
  readonly client: PublicClient;
  /** The node's chain, as `checkAnchorDeployment` checked it. */
  readonly chainId: bigint;
  readonly anchor: Address;
  /** The anchor's clock, as `checkAnchorDeployment` checked it. */
  readonly clock: AnchoringClock;
  /** The anchoring authority, as `checkAnchorDeployment` checked it: calls are simulated from it. */
  readonly authority: Address;
  /**
   * Sends `calldata` to the anchor from the authority (the Safe's
   * transaction, P4-1 part 2b-2), resolving once it is included; throws if
   * it wasn't sent or reverted.
   */
  readonly send: (calldata: Uint8Array) => Promise<void>;
}

interface Pin {
  readonly number: bigint;
  readonly timestamp: bigint;
}

/** The L1 board anchor as the anchoring job reads it and sends to it. */
export class ViemAnchorChain implements AnchorChain {
  readonly chainId: bigint;
  readonly clock: AnchoringClock;
  readonly #client: PublicClient;
  readonly #anchor: Address;
  readonly #authority: Address;
  readonly #send: (calldata: Uint8Array) => Promise<void>;
  #pin: Pin | undefined;
  // The highest block this adapter has read at. A node (or a load
  // balancer's other node) that later answers from below it is refused: its
  // older state could show a slot empty that an earlier call filled, or a
  // time before one already judged by (T-49).
  #seen: Pin = { number: 0n, timestamp: 0n };

  constructor(options: AnchorChainOptions) {
    const { epoch, period, deadline } = options.clock;
    if (period < 1n || epoch < 0n || deadline < 0n)
      throw new RangeError("the clock must have a period of at least 1 and no negative value");
    this.chainId = options.chainId;
    this.clock = { epoch, period, deadline };
    this.#client = options.client;
    this.#anchor = getAddress(options.anchor);
    this.#authority = getAddress(options.authority);
    this.#send = options.send;
  }

  get address(): Uint8Array {
    return hexToBytes(this.#anchor);
  }

  /** The latest block's timestamp; pins that block for the `anchored` calls that follow. */
  async now(): Promise<bigint> {
    this.#pin = undefined;
    const pin = await this.#latest();
    this.#pin = pin;
    return pin.timestamp;
  }

  /** Judged at the pin of the last `now()` call, or at a fresh one if there was none. */
  async anchored(electionId: Uint8Array, segment: number): Promise<Uint8Array | undefined> {
    if (electionId.length !== 32) throw new TypeError("electionId must be 32 bytes");
    if (!Number.isInteger(segment) || segment < 0 || segment > 2 ** 32 - 1)
      throw new RangeError("segment must be a u32");
    const pin = this.#pin ?? (await this.#latest());
    const held = await this.#hashOf(electionId, segment, pin.number);
    return /^0x0{64}$/.test(held) ? undefined : hexToBytes(held);
  }

  async anchor(checkpoints: readonly Checkpoint[]): Promise<void> {
    if (checkpoints.length === 0) throw new RangeError("an anchor call needs a checkpoint");
    const data = encodeFunctionData({
      abi: boardAnchorAbi,
      functionName: "anchor",
      args: [bytesToHex(concatBytes(checkpoints.map(encodeCheckpoint))), "0x"],
    });
    // Throws on a call the anchor would refuse now, before anything is signed.
    await this.#client.call({ account: this.#authority, to: this.#anchor, data });
    await this.#send(hexToBytes(data));
    // Confirmed at the node's latest block, at or above every block read so
    // far, so a sender that resolved without the anchor's state changing
    // fails here.
    const after = await this.#latest();
    for (const c of checkpoints) {
      const held = await this.#hashOf(c.election_id, c.segment, after.number);
      if (held !== bytesToHex(checkpointHash(c))) throw new Error("the call didn't anchor");
    }
  }

  async #latest(): Promise<Pin> {
    const block = await this.#client.getBlock({ blockTag: "latest" });
    const pin = { number: block.number, timestamp: block.timestamp };
    if (pin.number < this.#seen.number || pin.timestamp < this.#seen.timestamp)
      throw new Error("the node is behind blocks already read");
    this.#seen = pin;
    return pin;
  }

  #hashOf(electionId: Uint8Array, segment: number, blockNumber: bigint) {
    return this.#client.readContract({
      address: this.#anchor,
      abi: boardAnchorAbi,
      functionName: "checkpointHashOf",
      args: [bytesToHex(electionId), segment],
      blockNumber,
    });
  }
}

export interface AnchorDeployment {
  readonly chainId: bigint;
  readonly anchor: Address;
  readonly clock: AnchoringClock;
  readonly authority: Address;
}

/**
 * The startup check (P4-1 part 2b-1): the node is on the configured chain,
 * and the anchor's finalized code fixes exactly the configured clock and
 * authority, so the job takes and judges periods by the clock the anchor
 * judges by, and sends from the account it accepts (T-49, T-53). The
 * authority must have code that isn't an EIP-7702 delegation, as the
 * anchor's constructor requires; that it is the Safe the deployment record
 * names, with its owners, threshold and no module or guard, is part 2b-2's
 * check. Throws naming the mismatch.
 */
export async function checkAnchorDeployment(
  client: PublicClient,
  deployment: AnchorDeployment,
): Promise<void> {
  const chainId = BigInt(await client.getChainId());
  if (chainId !== deployment.chainId) throw new Error("the L1 node is on another chain");
  const blockNumber = (await client.getBlock({ blockTag: "finalized" })).number;
  const at = { address: deployment.anchor, abi: boardAnchorAbi, blockNumber } as const;
  const code = await client.getCode({ address: deployment.anchor, blockNumber });
  if (code === undefined || code === "0x") throw new Error("no anchor at the address");
  const [epoch, period, deadline, authority] = await Promise.all([
    client.readContract({ ...at, functionName: "epoch" }),
    client.readContract({ ...at, functionName: "period" }),
    client.readContract({ ...at, functionName: "deadline" }),
    client.readContract({ ...at, functionName: "authority" }),
  ]);
  const { clock } = deployment;
  if (epoch !== clock.epoch || period !== clock.period || deadline !== clock.deadline)
    throw new Error("the anchor fixes another clock");
  if (getAddress(authority) !== getAddress(deployment.authority))
    throw new Error("the anchor names another authority");
  const authorityCode = await client.getCode({ address: authority, blockNumber });
  if (authorityCode === undefined || authorityCode === "0x" || authorityCode.startsWith("0xef0100"))
    throw new Error("the authority is a single key");
}
