// The opening of a receipt commitment (docs/spec/receipts.md, Opening): the
// proof that the commitment `C` was in the calldata of a transaction in a
// finalized L1 block by `t_E`, checked from a beacon state the judge trusts
// and no old block, receipt or log from anyone, so it survives history
// expiry (EIP-4444). Its result is what `judgeReceipt` takes from `t_E` on,
// so a receipt key obtained after `t_E` forges nothing (T-69, T-26).
//
// Every hash here is a published one composed as the specs define:
// keccak-256 over the execution layer's RLP (the yellow paper), SHA-256 over
// the consensus layer's SSZ Merkle trees (the consensus specs), both from
// @noble/hashes.

import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  bytesFixed,
  bytesVar,
  type CodecValue,
  DecodeError,
  decode,
  encode,
  list,
  struct,
  u32,
  u64,
} from "./codec.ts";
import {
  calldataCarries,
  RECEIPT_COMMITMENT_SALT_LEN,
  receiptCommitment,
  type ReceiptOpeningCheck,
  type ReceiptOpeningErrorCode,
} from "./receipt-evidence.ts";
import { decodeRlp, type RlpItem, rlpEncodeUint, rlpUint } from "./rlp.ts";

/**
 * Receipt version 1's opening layout (docs/spec/receipts.md, Opening). The
 * bounds: the largest transaction the execution clients' pools relay
 * (128 KiB) plus its trie leaf's framing; 16 nodes, far deeper than any
 * block's transaction trie; and the header's 1 KiB, several times today's.
 */
export const RECEIPT_OPENING = struct([
  ["salt", bytesFixed(RECEIPT_COMMITMENT_SALT_LEN)],
  ["tx_index", u32],
  ["tx_proof", list(bytesVar(132_096), 16)],
  ["header", bytesVar(1024)],
  ["beacon_slot", u64],
  ["proposer_index", u64],
  ["parent_root", bytesFixed(32)],
  ["state_root", bytesFixed(32)],
  ["body_root", bytesFixed(32)],
  ["payload_proof", list(bytesFixed(32), 9)],
  ["summary_proof", list(bytesFixed(32), 13)],
]);

export type ReceiptOpening = CodecValue<typeof RECEIPT_OPENING>;

export function encodeReceiptOpening(opening: ReceiptOpening): Uint8Array {
  return encode(RECEIPT_OPENING, opening);
}

/** Strictly decodes an opening; throws `DecodeError`. */
export function decodeReceiptOpening(bytes: Uint8Array): ReceiptOpening {
  return decode(RECEIPT_OPENING, bytes);
}

/** A fork of the beacon chain the release knows, by name. */
export type BeaconForkName =
  | "phase0"
  | "altair"
  | "bellatrix"
  | "capella"
  | "deneb"
  | "electra"
  | "fulu"
  | "gloas";

export interface BeaconFork {
  readonly name: BeaconForkName;
  readonly epoch: bigint;
  /** `fork.current_version` in a state of this fork. */
  readonly version: Uint8Array;
}

/** An L1's beacon fork schedule as this release pins it, in activation order. */
export interface BeaconForkSchedule {
  readonly chainId: bigint;
  readonly forks: readonly BeaconFork[];
}

const SLOTS_PER_EPOCH = 32n;
/** `SLOTS_PER_HISTORICAL_ROOT`: the slots in one `block_roots` vector and one period. */
const PERIOD = 8192n;

const version = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (x) => parseInt(x, 16));
const schedule = (chainId: bigint, forks: readonly [BeaconForkName, bigint, string][]) =>
  Object.freeze({
    chainId,
    forks: Object.freeze(
      forks.map(([name, epoch, v]) => Object.freeze({ name, epoch, version: version(v) })),
    ),
  });

/**
 * The fork schedules this release pins (docs/spec/receipts.md, Fork schedule),
 * from the consensus specs' `configs/mainnet.yaml` and eth-clients/sepolia's
 * `metadata/config.yaml`. A fork listed without a payload index (Sepolia's
 * Gloas) is known, so its states are recognised, but not supported: an
 * opening judged from one is `opening-fork-unknown`.
 */
export const BEACON_FORK_SCHEDULES: readonly BeaconForkSchedule[] = Object.freeze([
  schedule(1n, [
    ["phase0", 0n, "00000000"],
    ["altair", 74_240n, "01000000"],
    ["bellatrix", 144_896n, "02000000"],
    ["capella", 194_048n, "03000000"],
    ["deneb", 269_568n, "04000000"],
    ["electra", 364_032n, "05000000"],
    ["fulu", 411_392n, "06000000"],
  ]),
  schedule(11_155_111n, [
    ["phase0", 0n, "90000069"],
    ["altair", 50n, "90000070"],
    ["bellatrix", 100n, "90000071"],
    ["capella", 56_832n, "90000072"],
    ["deneb", 132_608n, "90000073"],
    ["electra", 222_464n, "90000074"],
    ["fulu", 272_640n, "90000075"],
    ["gloas", 353_024n, "90000076"],
  ]),
]);

/**
 * The generalized index of `body.execution_payload.block_hash` under a beacon
 * block's `body_root`, by fork: `BeaconBlockBody` pads to 16 fields with the
 * payload at 9, and `ExecutionPayload`, with `block_hash` at 12, pads to 16
 * fields in Capella and 32 from Deneb on. Forks before Capella have no such
 * field to prove, and forks after Fulu aren't specified yet.
 */
const PAYLOAD_GINDEX: Partial<Record<BeaconForkName, number>> = {
  capella: 412,
  deneb: 812,
  electra: 812,
  fulu: 812,
};
const SUPPORTED_STATE_FORKS: ReadonlySet<BeaconForkName> = new Set([
  "capella",
  "deneb",
  "electra",
  "fulu",
]);

/**
 * What the judge takes from a finalized beacon state it trusts, on the chain
 * the election definition's `l1_chain_id` names (docs/spec/receipts.md,
 * Opening): from its own beacon node, or proven by SSZ branches from a
 * finalized state root its light client trusts. Only the entries an opening
 * names are needed.
 */
export interface TrustedBeaconState {
  readonly slot: bigint;
  /** `fork.current_version`. */
  readonly forkVersion: Uint8Array;
  /** `len(historical_summaries)`. */
  readonly historicalSummaryCount: number;
  /** `historical_summaries[i].block_summary_root`, by `i`, for the entries the judge holds. */
  readonly blockSummaryRoots: ReadonlyMap<number, Uint8Array>;
  /** `block_roots[i]`, by `i` (below 8192), for the entries the judge holds. */
  readonly blockRoots: ReadonlyMap<number, Uint8Array>;
}

export interface ReceiptOpeningInput {
  /** The opening as the voter kept it. */
  readonly opening: Uint8Array;
  /** The receipt's full encoding, record header included. */
  readonly receipt: Uint8Array;
  /** `t_E` (`disputeEnd`). */
  readonly disputeEnd: bigint;
  /** The election definition's `l1_chain_id`. */
  readonly l1ChainId: bigint;
  readonly state: TrustedBeaconState;
}

const U64_MAX = (1n << 64n) - 1n;

const copyBytes = (b: unknown, what: string) => {
  if (!(b instanceof Uint8Array) || !ArrayBuffer.isView(b))
    throw new TypeError(`${what} must be a Uint8Array`);
  return new Uint8Array(b);
};

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const fail = (code: ReceiptOpeningErrorCode | "opening-fork-unknown"): ReceiptOpeningCheck => ({
  ok: false,
  code,
});

function nibbles(b: Uint8Array): number[] {
  const out: number[] = [];
  for (const x of b) out.push(x >> 4, x & 0x0f);
  return out;
}

/** A child reference: a node's hash (32 bytes), or the node itself when its encoding is shorter. */
type Ref = { readonly hash: Uint8Array } | { readonly node: RlpItem };

function childRef(x: RlpItem | undefined): Ref | undefined {
  if (x === undefined) return undefined;
  // A node of 32 bytes or more is referenced by its hash, a shorter one inline.
  if (x.list) return x.raw.length < 32 ? { node: x } : undefined;
  return x.bytes.length === 32 ? { hash: x.bytes } : undefined;
}

/**
 * The value at key `RLP(txIndex)` of the Merkle Patricia trie whose root is
 * `root` (yellow paper, Appendix D), proven by `proof`, its hashed nodes in
 * path order from the root, or undefined if the proof doesn't prove one with
 * every node used. Inline nodes are read where their parents hold them.
 */
export function transactionTrieValue(
  root: Uint8Array,
  txIndex: number,
  proof: readonly Uint8Array[],
): Uint8Array | undefined {
  const r = copyBytes(root, "root");
  if (r.length !== 32) throw new RangeError("root must be 32 bytes");
  if (!Number.isInteger(txIndex) || txIndex < 0 || txIndex > 0xffffffff)
    throw new RangeError("txIndex must be a u32");
  if (!Array.isArray(proof)) throw new TypeError("proof must be an array");
  const nodes = proof.map((n, i) => copyBytes(n, `proof[${i}]`));
  const key = nibbles(rlpEncodeUint(txIndex));
  let k = 0;
  let used = 0;
  let ref: Ref = { hash: r };
  for (;;) {
    let node: RlpItem;
    if ("hash" in ref) {
      const enc = nodes[used];
      if (enc === undefined || !equalBytes(keccak_256(enc), ref.hash)) return undefined;
      // Only the root is hashed whatever its length; a shorter node is inline.
      if (used > 0 && enc.length < 32) return undefined;
      used++;
      const decoded = decodeRlp(enc);
      if (decoded === undefined) return undefined;
      node = decoded;
    } else node = ref.node;
    if (!node.list) return undefined;
    let value: RlpItem | undefined;
    let next: Ref | undefined;
    if (node.items.length === 17) {
      if (k === key.length) value = node.items[16];
      else next = childRef(node.items[key[k++] as number]);
    } else if (node.items.length === 2) {
      const [path, child] = node.items as [RlpItem, RlpItem];
      // Hex-prefix encoding: a flag nibble (bit 1: leaf, bit 0: odd length),
      // then a zero nibble if the path's length is even.
      if (path.list || path.bytes.length === 0) return undefined;
      const flag = (path.bytes[0] as number) >> 4;
      if (flag > 3) return undefined;
      const odd = (flag & 1) === 1;
      if (!odd && ((path.bytes[0] as number) & 0x0f) !== 0) return undefined;
      const p = nibbles(path.bytes).slice(odd ? 1 : 2);
      const rest = key.slice(k);
      if (flag >= 2) {
        if (p.length !== rest.length || p.some((x, i) => x !== rest[i])) return undefined;
        value = child;
      } else {
        if (p.length === 0 || p.length > rest.length || p.some((x, i) => x !== rest[i]))
          return undefined;
        k += p.length;
        next = childRef(child);
      }
    } else return undefined;
    if (value !== undefined) {
      if (value.list || value.bytes.length === 0 || used !== nodes.length) return undefined;
      return value.bytes.slice();
    }
    if (next === undefined) return undefined;
    ref = next;
  }
}

/** Each transaction type's field count and the index of its `data` (docs/spec/receipts.md, Commitment). */
const TX_LAYOUTS: ReadonlyMap<number, { readonly fields: number; readonly data: number }> = new Map(
  [
    [0x01, { fields: 11, data: 6 }],
    [0x02, { fields: 12, data: 7 }],
    [0x03, { fields: 14, data: 7 }],
    [0x04, { fields: 13, data: 7 }],
  ],
);
const LEGACY = { fields: 9, data: 5 };

/**
 * A transaction's calldata from its EIP-2718 encoding: a legacy
 * transaction's RLP list, or a type byte 0x01 to 0x04 and its RLP list; or
 * undefined for anything else.
 */
export function transactionCalldata(tx: Uint8Array): Uint8Array | undefined {
  const b = copyBytes(tx, "tx");
  const t = b[0];
  if (t === undefined) return undefined;
  const layout = t >= 0xc0 ? LEGACY : TX_LAYOUTS.get(t);
  if (layout === undefined) return undefined;
  const x = decodeRlp(t >= 0xc0 ? b : b.subarray(1));
  if (x === undefined || !x.list || x.items.length !== layout.fields) return undefined;
  const data = x.items[layout.data];
  return data === undefined || data.list ? undefined : data.bytes.slice();
}

/** The two header fields the opening reads, from a strictly decoded header. */
function headerFields(
  header: Uint8Array,
): { readonly transactionsRoot: Uint8Array; readonly timestamp: bigint } | undefined {
  const x = decodeRlp(header);
  if (x === undefined || !x.list || x.items.length < 12) return undefined;
  const root = x.items[4] as RlpItem;
  const timestamp = rlpUint(x.items[11] as RlpItem, 8);
  if (root.list || root.bytes.length !== 32 || timestamp === undefined) return undefined;
  return { transactionsRoot: root.bytes, timestamp };
}

/** `is_valid_merkle_branch` of the consensus specs, with SHA-256. */
function isValidMerkleBranch(
  leaf: Uint8Array,
  branch: readonly Uint8Array[],
  index: bigint,
  root: Uint8Array,
): boolean {
  let value = leaf;
  for (const [i, sibling] of branch.entries()) {
    const m = new Uint8Array(64);
    if ((index >> BigInt(i)) & 1n) {
      m.set(sibling);
      m.set(value, 32);
    } else {
      m.set(value);
      m.set(sibling, 32);
    }
    value = sha256(m);
  }
  return equalBytes(value, root);
}

/** `hash_tree_root` of a `BeaconBlockHeader`: five fields padded to eight leaves. */
function beaconBlockHeaderRoot(o: ReceiptOpening): Uint8Array {
  const uint64 = (v: bigint) => {
    const b = new Uint8Array(32);
    for (let i = 0; i < 8; i++) b[i] = Number((v >> BigInt(8 * i)) & 0xffn);
    return b;
  };
  let layer: Uint8Array[] = [
    uint64(o.beacon_slot),
    uint64(o.proposer_index),
    o.parent_root,
    o.state_root,
    o.body_root,
    new Uint8Array(32),
    new Uint8Array(32),
    new Uint8Array(32),
  ];
  while (layer.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const m = new Uint8Array(64);
      m.set(layer[i] as Uint8Array);
      m.set(layer[i + 1] as Uint8Array, 32);
      next.push(sha256(m));
    }
    layer = next;
  }
  return layer[0] as Uint8Array;
}

/** The fork active at `slot` under `schedule`. */
function forkAt(schedule: BeaconForkSchedule, slot: bigint): BeaconFork {
  let active = schedule.forks[0] as BeaconFork;
  for (const f of schedule.forks) if (f.epoch * SLOTS_PER_EPOCH <= slot) active = f;
  return active;
}

function checkState(state: TrustedBeaconState): void {
  if (state === null || typeof state !== "object") throw new TypeError("state must be an object");
  const { slot, forkVersion, historicalSummaryCount, blockSummaryRoots, blockRoots } = state;
  if (typeof slot !== "bigint" || slot < 0n || slot > U64_MAX)
    throw new RangeError("state.slot must be a u64 bigint");
  if (copyBytes(forkVersion, "state.forkVersion").length !== 4)
    throw new RangeError("state.forkVersion must be 4 bytes");
  if (!Number.isSafeInteger(historicalSummaryCount) || historicalSummaryCount < 0)
    throw new RangeError("state.historicalSummaryCount must be a natural number");
  if (!(blockSummaryRoots instanceof Map) || !(blockRoots instanceof Map))
    throw new TypeError("state.blockSummaryRoots and state.blockRoots must be Maps");
}

/** A state entry the opening names; the judge must hold it, so a missing one is the caller's error. */
function stateEntry(map: ReadonlyMap<number, Uint8Array>, i: number, what: string): Uint8Array {
  const root = map.get(i);
  if (root === undefined)
    throw new RangeError(`state.${what} lacks entry ${i}, which the opening names`);
  const r = copyBytes(root, `state.${what}[${i}]`);
  if (r.length !== 32) throw new RangeError(`state.${what}[${i}] must be 32 bytes`);
  return r;
}

const capellaFirstSlot = (schedule: BeaconForkSchedule) =>
  (schedule.forks.find((f) => f.name === "capella") as BeaconFork).epoch * SLOTS_PER_EPOCH;

/** The state entry step 6 reads, by the summary proof's length; none for any other length. */
export type StateEntryNamed =
  | { readonly summaryIndex: number }
  | { readonly blockRootIndex: number };

function stateEntryNamed(o: ReceiptOpening, capellaSlot: bigint): StateEntryNamed | undefined {
  if (o.summary_proof.length === 13)
    return o.beacon_slot < capellaSlot
      ? undefined
      : { summaryIndex: Number(o.beacon_slot / PERIOD - capellaSlot / PERIOD) };
  if (o.summary_proof.length === 0) return { blockRootIndex: Number(o.beacon_slot % PERIOD) };
  return undefined;
}

/**
 * Which entry of the judge's state an opening's step 6 reads, so a
 * light-client judge proves just that one (docs/spec/receipts.md, Fork
 * schedule): `historical_summaries[summaryIndex]` for a 13-hash
 * `summary_proof`, `block_roots[blockRootIndex]` for an empty one.
 * Undefined if the opening doesn't decode, `l1ChainId` has no schedule, or
 * it names no entry (its slot is before Capella, or its proof has another
 * length); `checkReceiptOpening` then needs neither.
 */
export function receiptOpeningStateEntry(
  opening: Uint8Array,
  l1ChainId: bigint,
): StateEntryNamed | undefined {
  let o: ReceiptOpening;
  try {
    o = decodeReceiptOpening(opening);
  } catch (e) {
    if (e instanceof DecodeError) return undefined;
    throw e;
  }
  const schedule = BEACON_FORK_SCHEDULES.find((s) => s.chainId === l1ChainId);
  if (schedule === undefined) return undefined;
  return stateEntryNamed(o, capellaFirstSlot(schedule));
}

/**
 * Checks an opening (docs/spec/receipts.md, Opening), in order, the first
 * failure being the result:
 *
 * 1. `opening-decode`: the opening, or its header's RLP, doesn't decode strictly.
 * 2. `opening-transaction`: the trie proof doesn't prove a transaction of a
 *    listed type at `tx_index` under the header's `transactionsRoot`, or its
 *    calldata's length isn't a multiple of 32.
 * 3. `opening-commitment`: no aligned word of the calldata is `C`.
 * 4. `opening-late`: the header's timestamp is after `t_E`.
 * 5. `opening-payload`: `keccak256(header)` isn't proven as the beacon
 *    block's `execution_payload.block_hash` under `body_root` at its fork's
 *    index and depth, or `beacon_slot` is before Capella or not before the
 *    state's slot.
 * 6. `opening-canonical`: the beacon block header's root isn't the state's
 *    record of the block at `beacon_slot`, through the period's
 *    `block_summary_root` (13 hashes) or `block_roots` (none).
 *
 * `opening-fork-unknown` instead of the rest of 5, and 6, when this release
 * can't check them, decided right after the slot check and before any
 * payload check: no schedule for `l1ChainId`, or a state whose fork version
 * is unknown or after Fulu (and so, `beacon_slot` being earlier, its fork is
 * a checked one whenever the state's is). That is a property of
 * the judge, never of the opening (`judgeReceipt` leaves the receipt
 * unjudged). Throws on a state that isn't one of the chain's: a known fork
 * version that isn't its slot's, or a missing entry the opening names.
 */
export function checkReceiptOpening(input: ReceiptOpeningInput): ReceiptOpeningCheck {
  const { disputeEnd, l1ChainId, state } = input;
  if (typeof disputeEnd !== "bigint" || disputeEnd < 0n || disputeEnd > U64_MAX)
    throw new RangeError("disputeEnd must be a u64 bigint");
  if (typeof l1ChainId !== "bigint" || l1ChainId < 0n || l1ChainId > U64_MAX)
    throw new RangeError("l1ChainId must be a u64 bigint");
  checkState(state);
  const receipt = copyBytes(input.receipt, "receipt");

  // 1.
  let o: ReceiptOpening;
  try {
    o = decodeReceiptOpening(input.opening);
  } catch (e) {
    if (e instanceof DecodeError) return fail("opening-decode");
    throw e;
  }
  const header = headerFields(o.header);
  if (header === undefined) return fail("opening-decode");

  // 2. and 3.
  const tx = transactionTrieValue(header.transactionsRoot, o.tx_index, o.tx_proof);
  const data = tx === undefined ? undefined : transactionCalldata(tx);
  if (data === undefined || data.length % 32 !== 0) return fail("opening-transaction");
  if (!calldataCarries(data, receiptCommitment(o.salt, receipt))) return fail("opening-commitment");

  // 4.
  if (header.timestamp > disputeEnd) return fail("opening-late");

  // 5. No block at or after the state's slot is its ancestor.
  if (o.beacon_slot >= state.slot) return fail("opening-payload");
  const schedule = BEACON_FORK_SCHEDULES.find((s) => s.chainId === l1ChainId);
  if (schedule === undefined) return fail("opening-fork-unknown");
  // The state's fork first: under a fork this release doesn't know, an
  // honest opening's payload branch may follow another layout, so no
  // payload failure is reported from such a state.
  const known = schedule.forks.find((f) => equalBytes(f.version, state.forkVersion));
  if (known === undefined) return fail("opening-fork-unknown");
  if (known !== forkAt(schedule, state.slot))
    throw new RangeError("state.forkVersion isn't the version of its slot's fork");
  if (!SUPPORTED_STATE_FORKS.has(known.name)) return fail("opening-fork-unknown");
  const capellaSlot = capellaFirstSlot(schedule);
  if (o.beacon_slot < capellaSlot) return fail("opening-payload");
  // beacon_slot is before the state's slot, so its fork is Capella to Fulu too.
  const gindex = PAYLOAD_GINDEX[forkAt(schedule, o.beacon_slot).name] as number;
  const depth = Math.floor(Math.log2(gindex));
  if (
    o.payload_proof.length !== depth ||
    !isValidMerkleBranch(
      keccak_256(o.header),
      o.payload_proof,
      BigInt(gindex - 2 ** depth),
      o.body_root,
    )
  )
    return fail("opening-payload");

  // 6.
  const root = beaconBlockHeaderRoot(o);
  const entry = stateEntryNamed(o, capellaSlot);
  if (entry === undefined) return fail("opening-canonical");
  if ("summaryIndex" in entry) {
    const i = entry.summaryIndex;
    if (i >= state.historicalSummaryCount) return fail("opening-canonical");
    const summary = stateEntry(state.blockSummaryRoots, i, "blockSummaryRoots");
    if (!isValidMerkleBranch(root, o.summary_proof, o.beacon_slot % PERIOD, summary))
      return fail("opening-canonical");
  } else {
    // block_roots holds the 8192 slots before the state's.
    if (state.slot > o.beacon_slot + PERIOD) return fail("opening-canonical");
    if (!equalBytes(root, stateEntry(state.blockRoots, entry.blockRootIndex, "blockRoots")))
      return fail("opening-canonical");
  }
  return { ok: true };
}
