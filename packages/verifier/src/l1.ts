// Reading the board anchor from L1 state (docs/spec/verifier.md, Anchors
// from L1; docs/spec/contracts.md, Board anchor, Verification): strict RLP,
// the block header, Merkle–Patricia trie proofs and the anchor's slots. A
// verifier never trusts a node's answer about the anchor, nor a list of logs
// an RPC node could shorten: it proves every word it reads against the state
// root of one finalized L1 block, whose time is `now` (T-24, T-36). Only
// Keccak-256 comes from a library (@noble/hashes); RLP and the trie are
// Ethereum's published encodings, composed here.

import {
  type Anchor,
  type AnchorClock,
  type Checkpoint,
  checkpointHash,
  copyCheckpoints,
} from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";

/** RLP that isn't the one canonical encoding of an item. */
export class RlpError extends Error {
  override readonly name = "RlpError";
}

export type Rlp =
  | { readonly list: false; readonly bytes: Uint8Array; readonly raw: Uint8Array }
  | { readonly list: true; readonly items: readonly Rlp[]; readonly raw: Uint8Array };

// Trie nodes nest only through embedded nodes under 32 bytes, and a header
// is one list, so nothing honest comes close.
const MAX_DEPTH = 16;

function item(b: Uint8Array, at: number, depth: number): { item: Rlp; end: number } {
  if (depth > MAX_DEPTH) throw new RlpError("nested too deeply");
  const p = b[at];
  if (p === undefined) throw new RlpError("truncated");
  if (p < 0x80)
    return {
      item: { list: false, bytes: b.slice(at, at + 1), raw: b.slice(at, at + 1) },
      end: at + 1,
    };
  let start: number;
  let length: number;
  const short = p < 0xb8 || (p >= 0xc0 && p < 0xf8);
  if (short) {
    start = at + 1;
    length = p - (p < 0xc0 ? 0x80 : 0xc0);
  } else {
    const n = p - (p < 0xc0 ? 0xb7 : 0xf7);
    if (at + 1 + n > b.length) throw new RlpError("truncated");
    if (b[at + 1] === 0) throw new RlpError("length with a leading zero");
    length = 0;
    for (let i = 0; i < n; i++) length = length * 256 + (b[at + 1 + i] as number);
    if (length < 56) throw new RlpError("long form for a short item");
    start = at + 1 + n;
  }
  const end = start + length;
  if (end > b.length) throw new RlpError("truncated");
  const raw = b.slice(at, end);
  if (p < 0xc0) {
    const bytes = b.slice(start, end);
    if (length === 1 && (bytes[0] as number) < 0x80)
      throw new RlpError("single byte not encoded as itself");
    return { item: { list: false, bytes, raw }, end };
  }
  const items: Rlp[] = [];
  for (let i = start; i < end;) {
    const next = item(b, i, depth + 1);
    if (next.end > end) throw new RlpError("item overruns its list");
    items.push(next.item);
    i = next.end;
  }
  return { item: { list: true, items, raw }, end };
}

/** Decodes exactly one RLP item, rejecting every non-canonical form and trailing bytes. */
export function decodeRlp(bytes: Uint8Array): Rlp {
  const { item: it, end } = item(bytes, 0, 0);
  if (end !== bytes.length) throw new RlpError("trailing bytes");
  return it;
}

/** A canonical RLP integer: big-endian, no leading zero, at most `maxBytes` bytes. */
function rlpUint(it: Rlp | undefined, maxBytes: number): bigint {
  if (it === undefined || it.list) throw new RlpError("expected an integer");
  if (it.bytes.length > maxBytes) throw new RlpError("integer too large");
  if (it.bytes[0] === 0) throw new RlpError("integer with a leading zero");
  let v = 0n;
  for (const x of it.bytes) v = (v << 8n) | BigInt(x);
  return v;
}

function rlpBytes32(it: Rlp | undefined): Uint8Array {
  if (it === undefined || it.list || it.bytes.length !== 32)
    throw new RlpError("expected 32 bytes");
  return it.bytes;
}

/** The fields of an L1 block header the verifier uses, and the header's hash. */
export interface L1Header {
  readonly hash: Uint8Array;
  readonly parentHash: Uint8Array;
  readonly stateRoot: Uint8Array;
  readonly number: bigint;
  readonly timestamp: bigint;
}

/**
 * Decodes an execution-layer block header: an RLP list of at least the 15
 * fields every fork has, each a byte string. Its hash is Keccak-256 of the
 * bytes given, so the hash names exactly these bytes, whatever later forks
 * append (T-36).
 */
export function decodeHeader(bytes: Uint8Array): L1Header {
  const h = decodeRlp(bytes);
  if (!h.list || h.items.length < 15)
    throw new RlpError("a header is a list of at least 15 fields");
  if (h.items.some((f) => f.list)) throw new RlpError("a header field is a list");
  return {
    hash: keccak_256(bytes),
    parentHash: rlpBytes32(h.items[0]),
    stateRoot: rlpBytes32(h.items[3]),
    number: rlpUint(h.items[8], 8),
    timestamp: rlpUint(h.items[11], 8),
  };
}

/** Why a word couldn't be read from L1 state. Each leaves 4.2 unverifiable, never failed. */
export type L1ErrorCode =
  | "l1-proof-missing"
  | "l1-proof-malformed"
  | "l1-anchor-absent"
  | "l1-range-too-long"
  | "l1-checkpoint-unknown";

export class L1Error extends Error {
  override readonly name = "L1Error";
  readonly code: L1ErrorCode;
  /** The segment whose word nothing matched, for `l1-checkpoint-unknown`. */
  readonly segment: number | undefined;
  constructor(code: L1ErrorCode, segment?: number) {
    super(segment === undefined ? code : `${code} at segment ${segment}`);
    this.code = code;
    this.segment = segment;
  }
}

const EMPTY_TRIE = keccak_256(Uint8Array.of(0x80));
const NO_CODE = keccak_256(new Uint8Array());

/**
 * The most segment words one run reads: about 120 years of hourly periods
 * (sooner under a shorter period).
 * Until the clock and `f` are pinned they come from the bundle, so without a
 * bound a bundle of a few hundred bytes could keep a verifier proving empty
 * slots for hours.
 */
export const MAX_SEGMENTS_READ = 1_048_576;

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

function nibbles(b: Uint8Array): number[] {
  const out: number[] = [];
  for (const x of b) out.push(x >> 4, x & 0x0f);
  return out;
}

/** A pool of trie nodes, looked up by their Keccak-256 hash, as `eth_getProof` returns them. */
export class NodePool {
  readonly #nodes = new Map<string, Uint8Array>();
  constructor(nodes: readonly Uint8Array[]) {
    for (const n of nodes) this.#nodes.set(bytesToHex(keccak_256(n)), n);
  }

  /**
   * The value at `key` in the trie under `root`, or undefined if the nodes
   * prove there is none (Ethereum Yellow Paper, Appendix D). A node the walk
   * needs and the pool lacks is `l1-proof-missing`; a node that isn't a
   * well-formed trie node is `l1-proof-malformed`: the state root commits to
   * every node, so neither can come from L1 itself.
   */
  get(root: Uint8Array, key: Uint8Array): Uint8Array | undefined {
    if (equal(root, EMPTY_TRIE)) return undefined;
    const path = nibbles(key);
    let at = 0;
    let node = this.#node(root);
    for (;;) {
      if (node.length === 17) {
        // Keys here are all 32 bytes, so a value never sits in a branch.
        const nibble = path[at];
        if (nibble === undefined) throw new L1Error("l1-proof-malformed");
        const child = node[nibble] as Rlp;
        if (!child.list && child.bytes.length === 0) return undefined;
        node = this.#child(child);
        at += 1;
        continue;
      }
      if (node.length !== 2) throw new L1Error("l1-proof-malformed");
      const [encodedPath, next] = node as [Rlp, Rlp];
      if (encodedPath.list || encodedPath.bytes.length === 0)
        throw new L1Error("l1-proof-malformed");
      // Hex-prefix encoding: the first nibble is the flag (2 for a leaf, 1
      // for an odd length), and an even path pads it with a zero nibble.
      const flag = (encodedPath.bytes[0] as number) >> 4;
      if (flag > 3) throw new L1Error("l1-proof-malformed");
      const all = nibbles(encodedPath.bytes);
      if ((flag & 1) === 0 && all[1] !== 0) throw new L1Error("l1-proof-malformed");
      const segment = all.slice((flag & 1) === 1 ? 1 : 2);
      const matches = segment.every((n, i) => path[at + i] === n);
      if (flag >= 2) {
        if (next.list || next.bytes.length === 0) throw new L1Error("l1-proof-malformed");
        // A leaf whose path ends elsewhere proves this key absent.
        return matches && at + segment.length === path.length ? next.bytes : undefined;
      }
      if (segment.length === 0) throw new L1Error("l1-proof-malformed");
      if (!matches) return undefined;
      at += segment.length;
      node = this.#child(next);
    }
  }

  #node(hash: Uint8Array): readonly Rlp[] {
    const bytes = this.#nodes.get(bytesToHex(hash));
    if (bytes === undefined) throw new L1Error("l1-proof-missing");
    return this.#items(bytes);
  }

  #items(bytes: Uint8Array): readonly Rlp[] {
    let n: Rlp;
    try {
      n = decodeRlp(bytes);
    } catch (e) {
      if (e instanceof RlpError) throw new L1Error("l1-proof-malformed");
      throw e;
    }
    if (!n.list) throw new L1Error("l1-proof-malformed");
    return n.items;
  }

  // A child is a node's hash, or the node itself when its encoding is
  // shorter than 32 bytes.
  #child(ref: Rlp): readonly Rlp[] {
    if (!ref.list && ref.bytes.length === 32) return this.#node(ref.bytes);
    if (ref.list && ref.raw.length < 32) return ref.items;
    throw new L1Error("l1-proof-malformed");
  }
}

/** What a run proves the anchor's slots from (docs/spec/verifier.md, Bundle, format 2). */
export interface L1Evidence {
  readonly header: L1Header;
  /** The board anchor's address, 20 bytes. */
  readonly anchor: Uint8Array;
  /** The election's first segment `f` (docs/spec/contracts.md, Board anchor, Verification). */
  readonly firstSegment: number;
  readonly nodes: NodePool;
  /** Checkpoints for words no copy matches, from their logs or anywhere: only their hash counts. */
  readonly checkpoints: readonly Checkpoint[];
}

/** One anchor read from state, and where its checkpoint came from. */
export interface StateAnchor {
  readonly anchor: Anchor;
  readonly hash: Uint8Array;
  readonly source: "copy" | "checkpoint";
}

/** The ERC-7201 namespace `abolish.board-anchor` (docs/spec/contracts.md, Board anchor). */
export const ANCHOR_NAMESPACE = 0x16eba4501d0a9dddbfa03518d843c364be664629e6d99efb7169d8f090095b00n;

/** `n` as a 32-byte big-endian word, as a storage slot is named. */
export const word = (n: bigint) => {
  const b = new Uint8Array(32);
  for (let i = 31; i >= 0 && n > 0n; i--, n >>= 8n) b[i] = Number(n & 0xffn);
  return b;
};

/** `keccak256(abi.encode(election_id, A + 1))`: the lowest anchored segment plus one. */
export function lowestSegmentSlot(electionId: Uint8Array): Uint8Array {
  return keccak_256(concatBytes(electionId, word(ANCHOR_NAMESPACE + 1n)));
}

/** `keccak256(abi.encode(uint256(s), keccak256(abi.encode(election_id, A))))`. */
export function checkpointSlot(electionId: Uint8Array, segment: number): Uint8Array {
  const inner = keccak_256(concatBytes(electionId, word(ANCHOR_NAMESPACE)));
  return keccak_256(concatBytes(word(BigInt(segment)), inner));
}

/**
 * `keccak256(abi.encode(x, keccak256(abi.encode(uint256(p), A + 4))))`: the
 * receipt-key record of the 33-byte key `p ‖ x` (docs/spec/contracts.md,
 * Board anchor, Receipt keys).
 */
export function receiptKeySlot(key: Uint8Array): Uint8Array {
  if (key.length !== 33) throw new RangeError("a receipt key is 33 bytes");
  const inner = keccak_256(
    concatBytes(word(BigInt(key[0] as number)), word(ANCHOR_NAMESPACE + 4n)),
  );
  return keccak_256(concatBytes(key.subarray(1), inner));
}

/** The 32-byte word at `slot`, from a storage trie value: RLP of the word with its leading zeros removed. */
export function storageWord(value: Uint8Array | undefined): Uint8Array {
  if (value === undefined) return new Uint8Array(32);
  let it: Rlp;
  try {
    it = decodeRlp(value);
  } catch (e) {
    if (e instanceof RlpError) throw new L1Error("l1-proof-malformed");
    throw e;
  }
  // Zero is never stored, so an empty or zero-led value is no trie's.
  if (it.list || it.bytes.length === 0 || it.bytes.length > 32 || it.bytes[0] === 0)
    throw new L1Error("l1-proof-malformed");
  const w = new Uint8Array(32);
  w.set(it.bytes, 32 - it.bytes.length);
  return w;
}

/**
 * The storage root of the account at `address` in the state trie under
 * `stateRoot`, or undefined if the nodes prove there is no account there or
 * it has no code. An account without code (an EOA, say) can't be one of our
 * contracts, so a wrong address reads as absent, never as empty storage.
 */
export function contractStorageRoot(
  nodes: NodePool,
  stateRoot: Uint8Array,
  address: Uint8Array,
): Uint8Array | undefined {
  const account = nodes.get(stateRoot, keccak_256(address));
  if (account === undefined) return undefined;
  try {
    const a = decodeRlp(account);
    if (!a.list || a.items.length !== 4) throw new RlpError("an account is 4 fields");
    rlpUint(a.items[0], 8);
    rlpUint(a.items[1], 32);
    const root = rlpBytes32(a.items[2]);
    return equal(rlpBytes32(a.items[3]), NO_CODE) ? undefined : root;
  } catch (e) {
    if (e instanceof RlpError) throw new L1Error("l1-proof-malformed");
    throw e;
  }
}

/** The anchor account's storage root, from the state trie. */
function storageRoot(l1: Pick<L1Evidence, "header" | "anchor" | "nodes">): Uint8Array {
  const root = contractStorageRoot(l1.nodes, l1.header.stateRoot, l1.anchor);
  // Absent, or without code: unverifiable, never every segment unanchored.
  if (root === undefined) throw new L1Error("l1-anchor-absent");
  return root;
}

/**
 * Every anchor of an election, read from the board anchor's state at the
 * header's block (docs/spec/contracts.md, Board anchor, Verification). It
 * proves the lowest-segment word, then the word of every segment from
 * `max(lowest, f)` to the seal whose period has ended by the block's time.
 * A non-zero word takes the checkpoint the copy gives after that segment if
 * its hash matches, else a given checkpoint with that hash, and its
 * `anchoredAt` is the end of its period: the anchor stored it only inside its
 * window, so that gives the board checks the same result as the true time. A
 * word nothing matches is `l1-checkpoint-unknown`: unverifiable until someone
 * produces the checkpoint, from its log (T-24, T-53).
 */
export function anchorsFromState(
  l1: L1Evidence,
  electionId: Uint8Array,
  encodedEntries: readonly Uint8Array[],
  clock: AnchorClock,
): StateAnchor[] {
  const root = storageRoot(l1);
  const read = (slot: Uint8Array) => storageWord(l1.nodes.get(root, keccak_256(slot)));
  let lowestPlusOne = 0n;
  for (const x of read(lowestSegmentSlot(electionId)))
    lowestPlusOne = (lowestPlusOne << 8n) | BigInt(x);
  if (lowestPlusOne === 0n) return [];
  const now = l1.header.timestamp;
  if (now < clock.epoch + clock.period) return [];
  // The last segment whose period has ended by `now`: no later one can be
  // anchored yet.
  const ended = (now - clock.epoch) / clock.period - 1n;
  const last = ended < BigInt(clock.lastSegment) ? ended : BigInt(clock.lastSegment);
  let first = lowestPlusOne - 1n;
  if (first < BigInt(l1.firstSegment)) first = BigInt(l1.firstSegment);
  if (first > last) return [];
  if (last - first + 1n > BigInt(MAX_SEGMENTS_READ)) throw new L1Error("l1-range-too-long");
  const words: [number, Uint8Array][] = [];
  // A loop over segments, at most the election's length in periods.
  for (let s = Number(first); s <= Number(last); s++) {
    const w = read(checkpointSlot(electionId, s));
    if (w.some((x) => x !== 0)) words.push([s, w]);
  }
  const fromCopy = copyCheckpoints(
    electionId,
    encodedEntries,
    words.map(([s]) => s),
  );
  const given = new Map(l1.checkpoints.map((c) => [bytesToHex(checkpointHash(c)), c]));
  return words.map(([s, w]): StateAnchor => {
    const anchoredAt = clock.epoch + (BigInt(s) + 1n) * clock.period;
    const copy = fromCopy.get(s);
    if (copy !== undefined && equal(checkpointHash(copy), w))
      return { anchor: { checkpoint: copy, anchoredAt }, hash: w, source: "copy" };
    // The hash binds the election and segment, so a checkpoint matching the
    // word is the one the anchor stored.
    const cp = given.get(bytesToHex(w));
    if (cp !== undefined)
      return { anchor: { checkpoint: cp, anchoredAt }, hash: w, source: "checkpoint" };
    throw new L1Error("l1-checkpoint-unknown", s);
  });
}

/**
 * The checkpoint word of each of `segments` for an election, in the order
 * given, read from the board anchor's state at the header's block: all zero
 * where nothing was anchored. A creator's per-slot check reads these before
 * its election's ceremony (docs/spec/contracts.md, Board anchor,
 * Verification, Pre-creation anchors), with the same proofs a verifier
 * takes: no node can show a stored word as empty under a header it gave.
 * Which header that is, and so which block, rests on whatever the caller
 * trusts for L1's finalized chain (T-69).
 */
export function checkpointWords(
  l1: Pick<L1Evidence, "header" | "anchor" | "nodes">,
  electionId: Uint8Array,
  segments: readonly number[],
): Uint8Array[] {
  if (electionId.length !== 32) throw new RangeError("an election identifier is 32 bytes");
  const root = storageRoot(l1);
  return segments.map((s) => {
    if (!Number.isInteger(s) || s < 0 || s > 0xffffffff)
      throw new RangeError("a segment is a u32");
    return storageWord(l1.nodes.get(root, keccak_256(checkpointSlot(electionId, s))));
  });
}

/**
 * Each key's receipt-key record word, read from the board anchor's state at
 * the header's block (docs/spec/verifier.md, Receipt keys from L1), in the
 * order given: the word, or the L1 error that kept it from being read. One
 * key's missing proof doesn't stop the others, so a later key's failure is
 * still found (2.9). The account itself is read first, and an error there
 * throws, since no word can be read without it.
 */
export function receiptKeyWords(
  l1: L1Evidence,
  keys: readonly Uint8Array[],
): (Uint8Array | L1Error)[] {
  const root = storageRoot(l1);
  return keys.map((key) => {
    try {
      return storageWord(l1.nodes.get(root, keccak_256(receiptKeySlot(key))));
    } catch (e) {
      if (e instanceof L1Error) return e;
      throw e;
    }
  });
}
