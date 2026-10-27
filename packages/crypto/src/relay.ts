// The L1 relay (docs/spec/contracts.md, L1 relay; ADR 0030, Forced ballots):
// the record framing it checks, the call hash it stores per call under
// abolish/v1/relay-call, the deposit it makes to the board through the L2's
// portal, the address that deposit comes from on L2, and its event. A forced
// ballot's window is judged by the L1 block the relay recorded, and verifier
// 4.5 matches each relayed ballot on the board with exactly one recorded call,
// so a deposit forged from the relay's aliased address by L2 governance
// matches none (T-50, T-71, T-35). The rolling call (Rolling ballots) is the
// same call with the root a rolling ballot was proved against beside the
// record, under abolish/v1/relay-rolling-call, so neither call's word matches
// the other's relayed event (T-31).

import { keccak_256 } from "@noble/hashes/sha3.js";
import { ds } from "./domain-separation.ts";
import { H } from "./group.ts";
import { PARAMETERS } from "./parameters.ts";

const U64_MAX = (1n << 64n) - 1n;

/** The most `data` bytes the L2's portal takes in one deposit (docs/adr/0004-l2-choice.md). */
export const PORTAL_MAX_DATA = 120_000;

// The deposit's calldata before the record: the selector, five head words
// and the record's length word.
const DEPOSIT_HEAD = 4 + 32 * 6;
// The rolling deposit's: one word more, the root's.
const ROLLING_DEPOSIT_HEAD = DEPOSIT_HEAD + 32;

/**
 * `MAX_RELAY_RECORD`: the longest record the relay takes, the longest whose
 * deposit data (`DEPOSIT_HEAD` bytes and the record padded to whole words)
 * fits `PORTAL_MAX_DATA`. Longer ones are refused on L1
 * before anything is recorded, so a recorded call always deposited (T-52).
 */
export const MAX_RELAY_RECORD: number = PARAMETERS.MAX_RELAY_RECORD;

/**
 * `MAX_ROLLING_RELAY_RECORD`: the rolling call's bound, 32 bytes below
 * `MAX_RELAY_RECORD` since its deposit carries the root's word too (T-52).
 */
export const MAX_ROLLING_RELAY_RECORD: number = PARAMETERS.MAX_ROLLING_RELAY_RECORD;

/** `alias(a) = (a + 0x1111…1111) mod 2¹⁶⁰`, the portal's L2 sender for a contract caller on L1. */
export const ALIAS_OFFSET = 0x1111000000000000000000000000000000001111n;

export const RELAY_SIGNATURE = "relayBallot(uint64,bytes)";
export const RELAY_DEPOSIT_SIGNATURE = "submitRelayedBallot(uint64,uint64,uint64,uint64,bytes)";
export const RELAY_EVENT_SIGNATURE = "BallotRelayed(bytes32,uint64,bytes32)";
export const RELAY_ROLLING_SIGNATURE = "relayRollingBallot(uint64,bytes32,bytes)";
export const RELAY_ROLLING_DEPOSIT_SIGNATURE =
  "submitRelayedRollingBallot(uint64,uint64,uint64,uint64,bytes32,bytes)";

const selector = (signature: string) => keccak_256(new TextEncoder().encode(signature)).slice(0, 4);

const RELAY_SELECTOR = selector(RELAY_SIGNATURE);
const DEPOSIT_SELECTOR = selector(RELAY_DEPOSIT_SIGNATURE);
const ROLLING_SELECTOR = selector(RELAY_ROLLING_SIGNATURE);
const ROLLING_DEPOSIT_SELECTOR = selector(RELAY_ROLLING_DEPOSIT_SIGNATURE);
const EVENT_TOPIC0 = keccak_256(new TextEncoder().encode(RELAY_EVENT_SIGNATURE));

const BALLOT_TYPE = 0x0002;

/** Why the relay refuses a record, in the order it checks (contracts.md, L1 relay, Relaying). */
export type RelayFramingCode = "relay-too-large" | "relay-truncated" | "relay-record-type";

export type RelayFraming =
  | { readonly ok: true; readonly definitionHash: Uint8Array }
  | { readonly ok: false; readonly code: RelayFramingCode };

/**
 * The relay's framing: at most `MAX_RELAY_RECORD` bytes, at least the 35 of
 * a ballot record's type, version and definition hash, and type `0x0002`.
 * Nothing else is read; the board judges the rest (T-52).
 */
export function frameRelayRecord(record: Uint8Array): RelayFraming {
  return frameWithin(record, MAX_RELAY_RECORD);
}

/**
 * The rolling call's framing (Rolling ballots, steps 2 and 3): the first
 * call's, with `MAX_ROLLING_RELAY_RECORD` as the bound. The root is never
 * read: the board judges it (T-52).
 */
export function frameRollingRelayRecord(record: Uint8Array): RelayFraming {
  return frameWithin(record, MAX_ROLLING_RELAY_RECORD);
}

function frameWithin(record: Uint8Array, max: number): RelayFraming {
  if (!(record instanceof Uint8Array)) throw new TypeError("record must be a Uint8Array");
  if (record.length > max) return { ok: false, code: "relay-too-large" };
  if (record.length < 35) return { ok: false, code: "relay-truncated" };
  if ((((record[0] ?? 0) << 8) | (record[1] ?? 0)) !== BALLOT_TYPE)
    return { ok: false, code: "relay-record-type" };
  return { ok: true, definitionHash: record.slice(3, 35) };
}

function u64Bytes(name: string, v: bigint): Uint8Array {
  if (typeof v !== "bigint" || v < 0n || v > U64_MAX)
    throw new RangeError(`${name} must be a bigint from 0 to 2^64 - 1`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v);
  return out;
}

function word(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31, x = v; i >= 0; i--, x >>= 8n) out[i] = Number(x & 0xffn);
  return out;
}

const readWord = (b: Uint8Array, at: number) => {
  let v = 0n;
  for (let i = at; i < at + 32; i++) v = (v << 8n) | BigInt(b[i] ?? 0);
  return v;
};

const pad32 = (n: number) => n + ((32 - (n % 32)) % 32);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function address(name: string, a: Uint8Array): Uint8Array {
  if (!(a instanceof Uint8Array) || a.length !== 20)
    throw new TypeError(`${name} must be a 20-byte Uint8Array`);
  return a;
}

function rootWord(root: Uint8Array): Uint8Array {
  if (!(root instanceof Uint8Array) || root.length !== 32)
    throw new TypeError("root must be a 32-byte Uint8Array");
  return root;
}

/** One call as the relay records it. */
export interface RelayCall {
  /** The L1's EIP-155 chain ID, the definition's `l1_chain_id`. */
  readonly l1ChainId: bigint;
  /** The relay's address, the definition's `l1_relay`. */
  readonly relay: Uint8Array;
  /** The relay's count of calls before this one. */
  readonly index: bigint;
  /** The number and timestamp of the L1 block the call ran in: the stamp. */
  readonly l1Block: bigint;
  readonly l1Timestamp: bigint;
  /**
   * The deposit's gas limit, the caller's: bound so a verifier can tell a
   * call that gave too little gas from a deposit suppressed on L2.
   */
  readonly gasLimit: bigint;
  /** The record the call carried, as sent. */
  readonly record: Uint8Array;
}

/**
 * `H(DS("abolish/v1/relay-call", u64(l1_chain_id) ‖ bytes[20](relay) ‖
 * u64(index) ‖ u64(l1_block) ‖ u64(l1_timestamp) ‖ u64(gas_limit) ‖
 * record))`, the word the
 * relay stores for the call. It binds the whole record, not its ballot hash,
 * which leaves out the membership proof and the L1 reference: so the only
 * relayed event that matches it carries the bytes the caller sent (T-71,
 * T-31). It hashes any bytes, so a verifier can recompute it from an event
 * whose record the relay never framed and find it unmatched.
 */
export function relayCallHash(call: RelayCall): Uint8Array {
  if (!(call.record instanceof Uint8Array)) throw new TypeError("record must be a Uint8Array");
  return H(
    ds(
      "abolish/v1/relay-call",
      concat([
        u64Bytes("l1ChainId", call.l1ChainId),
        address("relay", call.relay),
        u64Bytes("index", call.index),
        u64Bytes("l1Block", call.l1Block),
        u64Bytes("l1Timestamp", call.l1Timestamp),
        u64Bytes("gasLimit", call.gasLimit),
        call.record,
      ]),
    ),
  );
}

/** One rolling call as the relay records it: a call's fields and the root it carried. */
export interface RelayRollingCall extends RelayCall {
  /** The root's word as sent, any 32 bytes: the relay never judges it. */
  readonly root: Uint8Array;
}

/**
 * `H(DS("abolish/v1/relay-rolling-call", u64(l1_chain_id) ‖ bytes[20](relay)
 * ‖ u64(index) ‖ u64(l1_block) ‖ u64(l1_timestamp) ‖ u64(gas_limit) ‖
 * bytes[32](root) ‖ record))`, the word the relay stores for a rolling call.
 * The root is bound, so a deposit forged with another root matches no call,
 * and the tag is its own, so no `RelayedBallotSubmitted` matches it nor any
 * `RelayedRollingBallotSubmitted` a first call's word (T-71, T-31).
 */
export function relayRollingCallHash(call: RelayRollingCall): Uint8Array {
  if (!(call.record instanceof Uint8Array)) throw new TypeError("record must be a Uint8Array");
  return H(
    ds(
      "abolish/v1/relay-rolling-call",
      concat([
        u64Bytes("l1ChainId", call.l1ChainId),
        address("relay", call.relay),
        u64Bytes("index", call.index),
        u64Bytes("l1Block", call.l1Block),
        u64Bytes("l1Timestamp", call.l1Timestamp),
        u64Bytes("gasLimit", call.gasLimit),
        rootWord(call.root),
        call.record,
      ]),
    ),
  );
}

/**
 * The deposit's `data`, `abi.encodeCall(submitRelayedBallot, (index,
 * l1_block, l1_timestamp, gas_limit, record))`: `196 + pad32(len(record))`
 * bytes.
 */
export function relayDepositData(
  index: bigint,
  l1Block: bigint,
  l1Timestamp: bigint,
  gasLimit: bigint,
  record: Uint8Array,
): Uint8Array {
  for (const [name, v] of [
    ["index", index],
    ["l1Block", l1Block],
    ["l1Timestamp", l1Timestamp],
    ["gasLimit", gasLimit],
  ] as const)
    u64Bytes(name, v);
  if (!(record instanceof Uint8Array)) throw new TypeError("record must be a Uint8Array");
  const out = new Uint8Array(DEPOSIT_HEAD + pad32(record.length));
  out.set(
    concat([
      DEPOSIT_SELECTOR,
      word(index),
      word(l1Block),
      word(l1Timestamp),
      word(gasLimit),
      word(0xa0n),
      word(BigInt(record.length)),
      record,
    ]),
  );
  return out;
}

/**
 * The rolling deposit's `data`, `abi.encodeCall(submitRelayedRollingBallot,
 * (index, l1_block, l1_timestamp, gas_limit, root, record))`: `228 +
 * pad32(len(record))` bytes, the record's offset `0xc0`.
 */
export function relayRollingDepositData(
  index: bigint,
  l1Block: bigint,
  l1Timestamp: bigint,
  gasLimit: bigint,
  root: Uint8Array,
  record: Uint8Array,
): Uint8Array {
  for (const [name, v] of [
    ["index", index],
    ["l1Block", l1Block],
    ["l1Timestamp", l1Timestamp],
    ["gasLimit", gasLimit],
  ] as const)
    u64Bytes(name, v);
  rootWord(root);
  if (!(record instanceof Uint8Array)) throw new TypeError("record must be a Uint8Array");
  const out = new Uint8Array(ROLLING_DEPOSIT_HEAD + pad32(record.length));
  out.set(
    concat([
      ROLLING_DEPOSIT_SELECTOR,
      word(index),
      word(l1Block),
      word(l1Timestamp),
      word(gasLimit),
      root,
      word(0xc0n),
      word(BigInt(record.length)),
      record,
    ]),
  );
  return out;
}

/** The address a deposit from the L1 contract `l1` comes from on L2. */
export function l2Alias(l1: Uint8Array): Uint8Array {
  let v = 0n;
  for (const b of address("l1", l1)) v = (v << 8n) | BigInt(b);
  return word((v + ALIAS_OFFSET) % (1n << 160n)).slice(12);
}

/** `relayBallot(gasLimit, record)`'s calldata, as a client sends it. */
export function relayBallotCalldata(gasLimit: bigint, record: Uint8Array): Uint8Array {
  u64Bytes("gasLimit", gasLimit);
  if (!(record instanceof Uint8Array)) throw new TypeError("record must be a Uint8Array");
  const out = new Uint8Array(4 + 32 * 3 + pad32(record.length));
  out.set(
    concat([RELAY_SELECTOR, word(gasLimit), word(0x40n), word(BigInt(record.length)), record]),
  );
  return out;
}

/**
 * The relay's calldata rule: exactly the ABI encoding of `(uint64, bytes)`,
 * a gas limit below 2⁶⁴, the record's offset `0x40`, zero padding and nothing
 * after, so a call carries no bytes the record doesn't (T-17). `null` if any
 * part differs.
 */
export function decodeRelayBallotCalldata(
  calldata: Uint8Array,
): { readonly gasLimit: bigint; readonly record: Uint8Array } | null {
  if (!(calldata instanceof Uint8Array)) throw new TypeError("calldata must be a Uint8Array");
  if (calldata.length < 4 + 32 * 3) return null;
  if (RELAY_SELECTOR.some((b, i) => calldata[i] !== b)) return null;
  const gasLimit = readWord(calldata, 4);
  const length = readWord(calldata, 68);
  if (gasLimit > U64_MAX || readWord(calldata, 36) !== 0x40n) return null;
  if (length > BigInt(calldata.length) || calldata.length !== 100 + pad32(Number(length)))
    return null;
  const end = 100 + Number(length);
  if (calldata.subarray(end).some((b) => b !== 0)) return null;
  return { gasLimit, record: calldata.slice(100, end) };
}

/** `relayRollingBallot(gasLimit, root, record)`'s calldata, as a client sends it. */
export function relayRollingBallotCalldata(
  gasLimit: bigint,
  root: Uint8Array,
  record: Uint8Array,
): Uint8Array {
  u64Bytes("gasLimit", gasLimit);
  rootWord(root);
  if (!(record instanceof Uint8Array)) throw new TypeError("record must be a Uint8Array");
  const out = new Uint8Array(4 + 32 * 4 + pad32(record.length));
  out.set(
    concat([
      ROLLING_SELECTOR,
      word(gasLimit),
      root,
      word(0x60n),
      word(BigInt(record.length)),
      record,
    ]),
  );
  return out;
}

/**
 * The rolling call's calldata rule (Rolling ballots, step 1): exactly the ABI
 * encoding of `(uint64, bytes32, bytes)`, a gas limit below 2⁶⁴, the root's
 * word any 32 bytes, the record's offset `0x60`, zero padding and nothing
 * after (T-17). `null` if any part differs.
 */
export function decodeRelayRollingBallotCalldata(calldata: Uint8Array): {
  readonly gasLimit: bigint;
  readonly root: Uint8Array;
  readonly record: Uint8Array;
} | null {
  if (!(calldata instanceof Uint8Array)) throw new TypeError("calldata must be a Uint8Array");
  if (calldata.length < 4 + 32 * 4) return null;
  if (ROLLING_SELECTOR.some((b, i) => calldata[i] !== b)) return null;
  const gasLimit = readWord(calldata, 4);
  const length = readWord(calldata, 100);
  if (gasLimit > U64_MAX || readWord(calldata, 68) !== 0x60n) return null;
  if (length > BigInt(calldata.length) || calldata.length !== 132 + pad32(Number(length)))
    return null;
  const end = 132 + Number(length);
  if (calldata.subarray(end).some((b) => b !== 0)) return null;
  return { gasLimit, root: calldata.slice(36, 68), record: calldata.slice(132, end) };
}

/** `BallotRelayed(definitionHash, index, callHash)`: its topics and data as the relay emits it. */
export function relayEvent(
  definitionHash: Uint8Array,
  index: bigint,
  callHash: Uint8Array,
): { readonly topics: readonly Uint8Array[]; readonly data: Uint8Array } {
  for (const [name, v] of [
    ["definitionHash", definitionHash],
    ["callHash", callHash],
  ] as const)
    if (!(v instanceof Uint8Array) || v.length !== 32)
      throw new TypeError(`${name} must be a 32-byte Uint8Array`);
  u64Bytes("index", index);
  return {
    topics: [EVENT_TOPIC0.slice(), definitionHash.slice(), word(index)],
    data: callHash.slice(),
  };
}
