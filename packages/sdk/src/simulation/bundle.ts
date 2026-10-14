// The simulated election as the verifier's input (docs/spec/verifier.md,
// Bundle, format 4): the definition, the anchoring clock, the panel the
// ceremony ran under, the board copy, and the board anchor's storage in a
// simulated L1 state, from which the verifier reads every anchor and `now`
// with Merkle–Patricia proofs, as it reads a real deployment's
// (docs/spec/contracts.md, Board anchor, Verification). The anchor holds what
// the simulated authority anchored, at the slots of the contract's ERC-7201
// layout, so the verifier finds exactly those checkpoints, matched against
// the copy (T-23, T-24), and the authority's receipt-key record, from which
// the verifier's 2.9 judges the definition's receipt keys (T-26, T-71). The
// state is simulated: one account in the state
// trie, placeholder code, and a header whose other fields are zero
// (SIMULATION_STUBS).

import {
  type Anchor,
  type AnchorClock,
  checkpointHash,
  type ElectionDefinitionV4,
  encodeElectionDefinitionV4,
  type Panel,
} from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import { buildTrie, encodeRlp, uintBytes } from "./trie.ts";

export const BUNDLE_FORMAT_CEREMONY = "abolish-verifier-bundle/4";

// The anchor's storage layout, written here from docs/spec/contracts.md
// rather than imported from the verifier's reader, so a slot either side
// derives wrongly fails the run instead of agreeing with itself.

/** BoardAnchor's ERC-7201 namespace `abolish.board-anchor` (docs/spec/contracts.md, Board anchor). */
const ANCHOR_NAMESPACE = 0x16eba4501d0a9dddbfa03518d843c364be664629e6d99efb7169d8f090095b00n;

const word = (n: bigint) => {
  const b = new Uint8Array(32);
  for (let i = 31, x = n; i >= 0 && x > 0n; i--, x >>= 8n) b[i] = Number(x & 0xffn);
  return b;
};

/** Slot of `checkpointHash[electionId][segment]`: `keccak256(abi.encode(uint256(s), keccak256(abi.encode(election_id, A))))`. */
export function checkpointSlot(electionId: Uint8Array, segment: number): Uint8Array {
  const inner = keccak_256(concatBytes(electionId, word(ANCHOR_NAMESPACE)));
  return keccak_256(concatBytes(word(BigInt(segment)), inner));
}

/** Slot of `lowestSegmentPlusOne[electionId]`: `keccak256(abi.encode(election_id, A + 1))`. */
export function lowestSegmentSlot(electionId: Uint8Array): Uint8Array {
  return keccak_256(concatBytes(electionId, word(ANCHOR_NAMESPACE + 1n)));
}

/**
 * Slot of receipt key `p ‖ x`'s record: `keccak256(abi.encode(x,
 * keccak256(abi.encode(uint256(p), A + 4))))` (docs/spec/contracts.md, Board
 * anchor, Receipt keys).
 */
export function receiptKeySlot(key: Uint8Array): Uint8Array {
  if (key.length !== 33) throw new RangeError("simulation: a receipt key is 33 bytes");
  const inner = keccak_256(
    concatBytes(word(BigInt(key[0] as number)), word(ANCHOR_NAMESPACE + 4n)),
  );
  return keccak_256(concatBytes(key.subarray(1), inner));
}

// A storage value: the word's RLP without its leading zeros. Zero is never stored.
const storageValue = (w: Uint8Array) => {
  const first = w.findIndex((x) => x !== 0);
  if (first < 0) throw new RangeError("simulation: a zero storage word");
  return encodeRlp(w.subarray(first));
};

/**
 * Placeholder runtime code for the simulated anchor: a single INVALID
 * opcode. The verifier reads an account without code as absent, and nothing
 * here runs it.
 */
const PLACEHOLDER_CODE = Uint8Array.of(0xfe);

/** The simulated L1 block the bundle's proofs are against. */
export interface BundleBlock {
  readonly number: bigint;
  readonly timestamp: bigint;
}

/**
 * The RLP of a header with the 15 fields every fork has, all zero but the
 * state root, number and timestamp, which are all the verifier reads.
 */
export function simulatedHeader(block: BundleBlock, stateRoot: Uint8Array): Uint8Array {
  return encodeRlp([
    new Uint8Array(32), // parent hash
    new Uint8Array(32), // ommers hash
    new Uint8Array(20), // beneficiary
    stateRoot,
    new Uint8Array(32), // transactions root
    new Uint8Array(32), // receipts root
    new Uint8Array(256), // logs bloom
    uintBytes(0n), // difficulty
    uintBytes(block.number),
    uintBytes(0n), // gas limit
    uintBytes(0n), // gas used
    uintBytes(block.timestamp),
    new Uint8Array(), // extra data
    new Uint8Array(32), // mix hash
    new Uint8Array(8), // nonce
  ]);
}

export interface BundleInputs {
  readonly definition: ElectionDefinitionV4;
  readonly panel: Panel;
  readonly clock: AnchorClock;
  /** The board copy: every entry, encoded, in index order. */
  readonly entries: readonly Uint8Array[];
  /** Every anchor the authority made, in L1 order; those in blocks up to `block` are in its state. */
  readonly anchors: readonly Anchor[];
  /** The election's first segment `f`, from its creation event. */
  readonly firstSegment: number;
  /** The anchor's receipt-key record at `block`: each registered key with its word. */
  readonly receiptKeys: readonly { readonly key: Uint8Array; readonly word: Uint8Array }[];
  readonly block: BundleBlock;
}

/** A bundle's two files: `bundle.json`'s text and `board.bin`'s bytes. */
export interface VerifierBundle {
  readonly json: string;
  readonly board: Uint8Array;
}

/**
 * The format-4 bundle of an election whose anchor, at `l1_anchor`, holds the
 * given anchors and receipt-key record at `block`. The anchor's storage has
 * the lowest anchored segment plus one, each anchored segment's checkpoint
 * hash and each registered key's word; anchors in later blocks aren't in
 * that state yet.
 */
export function verifierBundle(inputs: BundleInputs): VerifierBundle {
  const { definition, panel, clock, entries, anchors, firstSegment, receiptKeys, block } = inputs;
  const electionId = definition.election_id;
  const held = anchors.filter((a) => a.anchoredAt <= block.timestamp);
  const storage: [Uint8Array, Uint8Array][] = held.map((a) => [
    checkpointSlot(electionId, a.checkpoint.segment),
    storageValue(checkpointHash(a.checkpoint)),
  ]);
  const lowest = held.reduce<number | undefined>(
    (m, a) => (m === undefined || a.checkpoint.segment < m ? a.checkpoint.segment : m),
    undefined,
  );
  if (lowest !== undefined)
    storage.push([lowestSegmentSlot(electionId), storageValue(word(BigInt(lowest) + 1n))]);
  for (const r of receiptKeys) storage.push([receiptKeySlot(r.key), storageValue(r.word)]);
  const storageTrie = buildTrie(storage);
  const account = encodeRlp([
    uintBytes(1n), // nonce: a contract's starts at 1 (EIP-161)
    uintBytes(0n), // balance
    storageTrie.root,
    keccak_256(PLACEHOLDER_CODE),
  ]);
  const stateTrie = buildTrie([[definition.l1_anchor, account]]);
  const decimal = (n: bigint | number) => n.toString();
  const json = JSON.stringify({
    format: BUNDLE_FORMAT_CEREMONY,
    definition: bytesToHex(encodeElectionDefinitionV4(definition)),
    clock: {
      epoch: decimal(clock.epoch),
      period: decimal(clock.period),
      deadline: decimal(clock.deadline),
      lastSegment: decimal(clock.lastSegment),
    },
    l1: {
      firstSegment: decimal(firstSegment),
      header: bytesToHex(simulatedHeader(block, stateTrie.root)),
      nodes: [...stateTrie.nodes, ...storageTrie.nodes].map(bytesToHex),
      // Every stored checkpoint is the copy's, so none is given apart.
      checkpoints: [],
    },
    panel: { threshold: decimal(panel.threshold), keys: panel.keys.map(bytesToHex) },
  });
  const board = new Uint8Array(entries.reduce((n, e) => n + e.length, 0));
  let at = 0;
  for (const e of entries) {
    board.set(e, at);
    at += e.length;
  }
  return { json, board };
}
