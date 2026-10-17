// Reading one of our L2 contracts' storage under an output root posted on L1
// (docs/spec/contracts.md, Event accumulator, Output root): the L2 header
// that the root commits to, through its block hash, and account and storage
// proofs under that header's state root. A reader that holds the root from
// L1 trusts the L2 node that served the rest for nothing: the header, the
// message passer's storage root and every trie node are checked against the
// root (T-71, T-34). Only Keccak-256 comes from a library; the root's
// preimage is the OP Stack's published version 0, composed here.

import type { ProvenEventAccumulator } from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes } from "@noble/hashes/utils.js";
import {
  contractStorageRoot,
  decodeHeader,
  L1Error,
  type L1Header,
  NodePool,
  RlpError,
  storageWord,
  word,
} from "./l1.ts";

/**
 * The accumulator's base slot, the ERC-7201 namespace `abolish.event-accumulator`
 * (docs/spec/contracts.md, Rules for every contract): the accumulator at `S`,
 * the count at `S + 1`.
 */
export const ACCUMULATOR_SLOT = 0x1073a090f5464cb55b258e445c2f90eb0f9b00fb8b1700430d20b9c53b939600n;

/** Why storage couldn't be read under an output root. */
export type OutputRootErrorCode =
  /** The header and message-passer root don't hash to the output root. */
  | "output-root"
  /** The header isn't one canonical RLP header. */
  | "l2-header"
  /** A trie node the walk needs is missing. */
  | "l2-proof-missing"
  /** A trie node, account or stored value isn't well formed. */
  | "l2-proof-malformed"
  /** The state proves no account with code at the address. */
  | "l2-contract-absent"
  /** The proven count isn't a `u64`. */
  | "l2-count";

export class OutputRootError extends Error {
  override readonly name = "OutputRootError";
  readonly code: OutputRootErrorCode;
  constructor(code: OutputRootErrorCode) {
    super(code);
    this.code = code;
  }
}

/** What storage is read from: everything but the root may come from an L2 node. */
export interface OutputRootEvidence {
  /** The output root, 32 bytes, as a dispute game on L1 claims it. */
  readonly outputRoot: Uint8Array;
  /** The L2ToL1MessagePasser's storage root at the block, 32 bytes. */
  readonly messagePasserStorageRoot: Uint8Array;
  /** The L2 block's header, RLP-encoded. */
  readonly header: Uint8Array;
  /** Trie nodes, as `eth_getProof` returns them: the account proof and each storage proof. */
  readonly nodes: readonly Uint8Array[];
}

const VERSION_0 = new Uint8Array(32);

/**
 * The version-0 output root: `keccak256(version ‖ state_root ‖
 * message_passer_storage_root ‖ block_hash)`, each 32 bytes, the version all
 * zero (OP Stack specification, Proposals, L2 Output Commitment Construction).
 */
export function outputRootV0(
  stateRoot: Uint8Array,
  messagePasserStorageRoot: Uint8Array,
  blockHash: Uint8Array,
): Uint8Array {
  for (const [b, what] of [
    [stateRoot, "stateRoot"],
    [messagePasserStorageRoot, "messagePasserStorageRoot"],
    [blockHash, "blockHash"],
  ] as const)
    if (!(b instanceof Uint8Array) || b.length !== 32)
      throw new RangeError(`${what} must be 32 bytes`);
  return keccak_256(concatBytes(VERSION_0, stateRoot, messagePasserStorageRoot, blockHash));
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The words at `slots` of the contract at `address`, and the block they were read at. */
export interface StorageAtOutputRoot {
  readonly block: L1Header;
  readonly words: readonly Uint8Array[];
}

/**
 * The 32-byte words at `slots` (each 32 bytes) of the contract at `address`
 * (20 bytes) in the state after the L2 block the output root commits to. The
 * header's hash is the root's block hash and its state root the root's, so
 * neither can be chosen apart from the root; the block's number and
 * timestamp come from that header. An absent slot reads as zero; an account
 * that is absent or has no code is `l2-contract-absent` (docs/spec/contracts.md,
 * Event accumulator, Verification and Output root).
 */
export function storageAtOutputRoot(
  evidence: OutputRootEvidence,
  address: Uint8Array,
  slots: readonly Uint8Array[],
): StorageAtOutputRoot {
  if (!(address instanceof Uint8Array) || address.length !== 20)
    throw new RangeError("address must be 20 bytes");
  for (const slot of slots)
    if (!(slot instanceof Uint8Array) || slot.length !== 32)
      throw new RangeError("a slot must be 32 bytes");
  if (!(evidence.outputRoot instanceof Uint8Array) || evidence.outputRoot.length !== 32)
    throw new RangeError("outputRoot must be 32 bytes");
  // The node serves this one: a root of another length is no preimage of
  // the root, and refused as one rather than as the caller's error.
  const mp = evidence.messagePasserStorageRoot;
  if (!(mp instanceof Uint8Array) || mp.length !== 32) throw new OutputRootError("output-root");
  let block: L1Header;
  try {
    block = decodeHeader(evidence.header);
  } catch (e) {
    if (e instanceof RlpError) throw new OutputRootError("l2-header");
    throw e;
  }
  const claimed = outputRootV0(block.stateRoot, mp, block.hash);
  if (!equal(claimed, evidence.outputRoot)) throw new OutputRootError("output-root");
  try {
    const nodes = new NodePool(evidence.nodes);
    const root = contractStorageRoot(nodes, block.stateRoot, address);
    if (root === undefined) throw new OutputRootError("l2-contract-absent");
    return { block, words: slots.map((slot) => storageWord(nodes.get(root, keccak_256(slot)))) };
  } catch (e) {
    if (e instanceof L1Error)
      throw new OutputRootError(
        e.code === "l1-proof-missing" ? "l2-proof-missing" : "l2-proof-malformed",
      );
    throw e;
  }
}

/** A proven accumulator, with the block's hash and timestamp from its header. */
export interface OutputRootAccumulator extends ProvenEventAccumulator {
  readonly blockHash: Uint8Array;
  readonly timestamp: bigint;
}

/**
 * The event accumulator and count of the contract at `address` after the L2
 * block the output root commits to (`S` and `S + 1`), for
 * `checkEventAccumulatorProof`. A count word with any of its top 192 bits set
 * isn't a count the contract can write: `l2-count`.
 */
export function accumulatorAtOutputRoot(
  evidence: OutputRootEvidence,
  address: Uint8Array,
): OutputRootAccumulator {
  const { block, words } = storageAtOutputRoot(evidence, address, [
    word(ACCUMULATOR_SLOT),
    word(ACCUMULATOR_SLOT + 1n),
  ]);
  const [accumulator, countWord] = words as [Uint8Array, Uint8Array];
  if (countWord.subarray(0, 24).some((x) => x !== 0)) throw new OutputRootError("l2-count");
  let count = 0n;
  for (const x of countWord.subarray(24)) count = (count << 8n) | BigInt(x);
  return {
    block: block.number,
    timestamp: block.timestamp,
    blockHash: block.hash,
    accumulator,
    count,
  };
}
