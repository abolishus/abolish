// The group registry's records, EIP-712 digests and registrar approvals
// (docs/spec/contracts.md, Group registry), for the verifier, which rebuilds
// each tier tree from the registry's events (docs/spec/verifier.md 2.4), and
// for the signing service. The contract applies the same rules to the same
// bytes, and both are checked against docs/spec/vectors/group-registry.json.
// Keccak-256 is @noble/hashes'; secp256k1 public-key recovery is
// @noble/curves'. This module only fixes the encodings and the checks.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { BN254_R, EncodeError, Reader, Writer } from "./codec.ts";

/** `MAX_BATCH`: the most commitments or indices one record carries. */
export const GROUP_REGISTRY_MAX_BATCH = 256;

/** `MAX_REGISTRARS`: the largest registrar set a registry pins. */
export const GROUP_REGISTRY_MAX_REGISTRARS = 16;

/**
 * `Poseidon2(0, 1)` (circomlib's two-input Poseidon, the tier tree's hash):
 * the commitment of the public secret `s = 0`, so never a member
 * (docs/spec/membership.md, Commitments and removals).
 */
export const POSEIDON2_ZERO_ONE =
  0x1bd20834f5de9830c643778a2e88a3a1363c8b9ac083d36d75bf87c49953e65en;

/** The EIP-712 domain type the registry signs under. */
export const GROUP_REGISTRY_DOMAIN_TYPE =
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
/** The EIP-712 type of an addition's approval. */
export const ADD_MEMBERS_TYPE =
  "AddMembers(uint64 groupId,uint8 tier,uint64 firstIndex,uint256[] commitments)";
/** The EIP-712 type of a removal's approval. */
export const REMOVE_MEMBERS_TYPE =
  "RemoveMembers(uint64 groupId,uint8 tier,uint64 size,uint64[] indices)";

const DOMAIN_NAME = "Abolish group registry";
const DOMAIN_VERSION = "1";

const N = secp256k1.Point.Fn.ORDER;
const HALF_N = (N - 1n) / 2n;
const MAX_U64 = (1n << 64n) - 1n;
const MAX_U256 = (1n << 256n) - 1n;
const ADDITION_HEADER = 18; // u64(group_id) ‖ u64(first_index) ‖ u16(count)
const REMOVAL_HEADER = 18; // u64(group_id) ‖ u64(size) ‖ u16(count)
const APPROVAL = 66; // u8(seat) ‖ bytes[32](r) ‖ bytes[32](s) ‖ u8(v)

const utf8 = new TextEncoder();
const keccak = keccak_256;
const DOMAIN_TYPE_HASH = keccak(utf8.encode(GROUP_REGISTRY_DOMAIN_TYPE));
const ADD_MEMBERS_TYPE_HASH = keccak(utf8.encode(ADD_MEMBERS_TYPE));
const REMOVE_MEMBERS_TYPE_HASH = keccak(utf8.encode(REMOVE_MEMBERS_TYPE));

/** One registrar's signature in a record, as the record carries it. */
export interface GroupApproval {
  readonly seat: number;
  readonly r: bigint;
  readonly s: bigint;
  readonly v: number;
}

/** A decoded `addMembers` record. */
export interface GroupAddition {
  readonly groupId: bigint;
  readonly firstIndex: bigint;
  readonly commitments: readonly bigint[];
  readonly approvals: readonly GroupApproval[];
}

/** A decoded `removeMembers` record. */
export interface GroupRemoval {
  readonly groupId: bigint;
  /** The group's member count when the registrars signed; every index is below it. */
  readonly size: bigint;
  readonly indices: readonly bigint[];
  readonly approvals: readonly GroupApproval[];
}

/** The stateless decode errors of docs/spec/vectors/group-registry.json. */
export type GroupRecordError =
  | "length"
  | "batch"
  | "forbidden-commitment"
  | "index-order"
  | "index-range";

export type GroupRecordResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: GroupRecordError };

/** Why a record's approvals don't authorise it (rules 7 and 8). */
export type GroupApprovalError = "approvals" | "seat" | "signature";

export type GroupApprovalResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: Extract<GroupApprovalError, "approvals"> }
  | {
      readonly ok: false;
      readonly error: Exclude<GroupApprovalError, "approvals">;
      /** The failing approval's seat, as the record gives it. */
      readonly seat: number;
    };

/**
 * Whether `value` may never be a member: not a canonical `field<bn254>`, or
 * 0, 1 or `Poseidon2(0, 1)`, the commitment of the public secret 0, which
 * would let anyone prove membership (docs/spec/membership.md; T-04, T-06).
 */
export function isForbiddenCommitment(value: bigint): boolean {
  if (typeof value !== "bigint") throw new TypeError("isForbiddenCommitment: expected a bigint");
  return value < 2n || value >= BN254_R || value === POSEIDON2_ZERO_ONE;
}

function bigEndian(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

function word(v: bigint): Uint8Array {
  const b = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

function u64Of(r: Reader): bigint {
  return bigEndian(r.take(8));
}

function readApprovals(r: Reader): GroupApproval[] {
  const approvals: GroupApproval[] = [];
  for (let n = r.uint(1); n > 0; n--)
    approvals.push({
      seat: r.uint(1),
      r: bigEndian(r.take(32)),
      s: bigEndian(r.take(32)),
      v: r.uint(1),
    });
  return approvals;
}

// The count is the u16 at `header − 2` and the approvals byte follows the
// body, so the exact length is known before anything else is read (T-17,
// T-52): a record either has exactly that length or is refused as `length`.
function exactLength(bytes: Uint8Array, header: number, item: number): boolean {
  if (bytes.length < header + 1) return false;
  const count = ((bytes[header - 2] ?? 0) << 8) | (bytes[header - 1] ?? 0);
  const approvalsAt = header + item * count;
  if (bytes.length < approvalsAt + 1) return false;
  return bytes.length === approvalsAt + 1 + APPROVAL * (bytes[approvalsAt] ?? 0);
}

function copyRecord(bytes: unknown): Uint8Array {
  if (!(bytes instanceof Uint8Array) || !ArrayBuffer.isView(bytes))
    throw new TypeError("group record: expected a Uint8Array");
  // Copied once, so the length checked is the length read.
  return new Uint8Array(bytes);
}

/**
 * Decodes an `addMembers` record, applying the registry's stateless checks in
 * its order: length, batch, commitments. The checks that need the registry's
 * state (the group and its tier, the position) and the approvals
 * (`checkGroupApprovals`) are the caller's.
 */
export function decodeGroupAddition(bytes: Uint8Array): GroupRecordResult<GroupAddition> {
  const b = copyRecord(bytes);
  if (!exactLength(b, ADDITION_HEADER, 32)) return { ok: false, error: "length" };
  const r = new Reader(b);
  const groupId = u64Of(r);
  const firstIndex = u64Of(r);
  const count = r.uint(2);
  if (count < 1 || count > GROUP_REGISTRY_MAX_BATCH) return { ok: false, error: "batch" };
  const commitments: bigint[] = [];
  for (let i = 0; i < count; i++) {
    const c = bigEndian(r.take(32));
    if (isForbiddenCommitment(c)) return { ok: false, error: "forbidden-commitment" };
    commitments.push(c);
  }
  const approvals = readApprovals(r);
  r.end();
  return { ok: true, value: { groupId, firstIndex, commitments, approvals } };
}

/**
 * Decodes a `removeMembers` record, applying the registry's stateless checks
 * in its order: length, batch, then index by index, greater than the one
 * before and below the signed `size`. Whether `size` is at most the group's
 * member count and an index is not yet removed needs the registry's state,
 * and the approvals are `checkGroupApprovals`'.
 */
export function decodeGroupRemoval(bytes: Uint8Array): GroupRecordResult<GroupRemoval> {
  const b = copyRecord(bytes);
  if (!exactLength(b, REMOVAL_HEADER, 8)) return { ok: false, error: "length" };
  const r = new Reader(b);
  const groupId = u64Of(r);
  const size = u64Of(r);
  const count = r.uint(2);
  if (count < 1 || count > GROUP_REGISTRY_MAX_BATCH) return { ok: false, error: "batch" };
  const indices: bigint[] = [];
  for (let i = 0; i < count; i++) {
    const index = u64Of(r);
    // Strictly increasing: a record removes each leaf once, and has one order.
    const last = indices.at(-1);
    if (last !== undefined && index <= last) return { ok: false, error: "index-order" };
    // Below the signed size: every index named was a member's when signed, so
    // a removal signed ahead of an addition can't later remove whoever lands
    // there (T-06).
    if (index >= size) return { ok: false, error: "index-range" };
    indices.push(index);
  }
  const approvals = readApprovals(r);
  r.end();
  return { ok: true, value: { groupId, size, indices, approvals } };
}

function checkU64(v: unknown, what: string): bigint {
  if (typeof v !== "bigint" || v < 0n || v > MAX_U64)
    throw new EncodeError(`${what}: expected a bigint from 0 to 2^64 - 1`);
  return v;
}

function checkBatch(items: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(items)) throw new EncodeError(`${what}: expected an array`);
  if (items.length < 1 || items.length > GROUP_REGISTRY_MAX_BATCH)
    throw new EncodeError(`${what}: expected 1 to ${GROUP_REGISTRY_MAX_BATCH} entries`);
  return items.slice();
}

function writeApprovals(w: Writer, approvals: readonly GroupApproval[]): void {
  if (!Array.isArray(approvals) || approvals.length > 255)
    throw new EncodeError("approvals: expected at most 255");
  w.uint(1, approvals.length);
  for (const a of approvals.slice()) {
    const { seat, r, s, v } = a;
    w.uint(1, seat);
    for (const x of [r, s]) {
      if (typeof x !== "bigint" || x < 0n || x > MAX_U256)
        throw new EncodeError("approval: r and s must be 256-bit unsigned bigints");
      w.bytes(word(x));
    }
    w.uint(1, v);
  }
}

/**
 * The `addMembers` record of `addition`. Throws `EncodeError` for anything
 * `decodeGroupAddition` would refuse, so it accepts exactly the decodable
 * records; seats and signatures are encoded as given.
 */
export function encodeGroupAddition(addition: GroupAddition): Uint8Array {
  const { groupId, firstIndex, commitments, approvals } = addition;
  const w = new Writer();
  w.bytes(word(checkU64(groupId, "groupId")).subarray(24));
  w.bytes(word(checkU64(firstIndex, "firstIndex")).subarray(24));
  const items = checkBatch(commitments, "commitments");
  w.uint(2, items.length);
  for (const c of items) {
    if (typeof c !== "bigint" || isForbiddenCommitment(c))
      throw new EncodeError("commitments: a forbidden commitment");
    w.bytes(word(c));
  }
  writeApprovals(w, approvals);
  return w.finish();
}

/** The `removeMembers` record of `removal`; see `encodeGroupAddition`. */
export function encodeGroupRemoval(removal: GroupRemoval): Uint8Array {
  const { groupId, size, indices, approvals } = removal;
  const w = new Writer();
  w.bytes(word(checkU64(groupId, "groupId")).subarray(24));
  const bound = checkU64(size, "size");
  w.bytes(word(bound).subarray(24));
  const items = checkBatch(indices, "indices");
  w.uint(2, items.length);
  let last = -1n;
  for (const x of items) {
    const index = checkU64(x, "indices");
    if (index <= last) throw new EncodeError("indices: must be strictly increasing");
    if (index >= bound) throw new EncodeError("indices: must be below size");
    last = index;
    w.bytes(word(index).subarray(24));
  }
  writeApprovals(w, approvals);
  return w.finish();
}

function uintArg(v: unknown, max: bigint, what: string): bigint {
  if (typeof v !== "bigint" || v < 0n || v > max)
    throw new RangeError(`${what}: expected a bigint from 0 to ${max}`);
  return v;
}

function bytesArg(x: unknown, length: number, what: string): Uint8Array {
  if (!(x instanceof Uint8Array) || !ArrayBuffer.isView(x))
    throw new TypeError(`${what}: expected ${length} bytes`);
  const copy = new Uint8Array(x);
  if (copy.length !== length) throw new TypeError(`${what}: expected ${length} bytes`);
  return copy;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function tierArg(tier: unknown): bigint {
  if (!Number.isSafeInteger(tier) || (tier as number) < 0 || (tier as number) > 255)
    throw new RangeError("tier: expected an integer from 0 to 255");
  return BigInt(tier as number);
}

/** EIP-712 `encodeData` of a `uint256[]` or `uint64[]`: keccak of the words. */
function arrayHash(values: readonly unknown[], max: bigint, what: string): Uint8Array {
  if (!Array.isArray(values)) throw new TypeError(`${what}: expected an array`);
  return keccak(concat(values.slice().map((v: unknown) => word(uintArg(v, max, what)))));
}

/**
 * `hashStruct(domain)` for name "Abolish group registry", version "1", the
 * chain and the registry's 20-byte address. Binding both means a signed batch
 * can't be replayed on another chain or deployment (T-30, T-32). The chain ID
 * is a `u64`, as for every contract.
 */
export function groupRegistryDomainSeparator(chainId: bigint, registry: Uint8Array): Uint8Array {
  const id = uintArg(chainId, MAX_U64, "chainId");
  const address = new Uint8Array(32);
  address.set(bytesArg(registry, 20, "registry"), 12);
  return keccak(
    concat([
      DOMAIN_TYPE_HASH,
      keccak(utf8.encode(DOMAIN_NAME)),
      keccak(utf8.encode(DOMAIN_VERSION)),
      word(id),
      address,
    ]),
  );
}

/** The `AddMembers` message an addition's registrars sign. */
export interface AddMembersMessage {
  readonly groupId: bigint;
  /** The group's tier from its `GroupCreated` event, never from a definition. */
  readonly tier: number;
  readonly firstIndex: bigint;
  readonly commitments: readonly bigint[];
}

/** The `RemoveMembers` message a removal's registrars sign. */
export interface RemoveMembersMessage {
  readonly groupId: bigint;
  readonly tier: number;
  readonly size: bigint;
  readonly indices: readonly bigint[];
}

/**
 * `hashStruct(AddMembers)`. Binding the tier and the position makes a signed
 * batch land in one group of one tier, at one place, at most once (T-06, T-13).
 */
export function addMembersStructHash(message: AddMembersMessage): Uint8Array {
  const { groupId, tier, firstIndex, commitments } = message;
  return keccak(
    concat([
      ADD_MEMBERS_TYPE_HASH,
      word(uintArg(groupId, MAX_U64, "groupId")),
      word(tierArg(tier)),
      word(uintArg(firstIndex, MAX_U64, "firstIndex")),
      arrayHash(commitments, MAX_U256, "commitments"),
    ]),
  );
}

/**
 * `hashStruct(RemoveMembers)`. Binding `size` bounds the indices a signed
 * removal can ever name to members present when it was signed (T-06).
 */
export function removeMembersStructHash(message: RemoveMembersMessage): Uint8Array {
  const { groupId, tier, size, indices } = message;
  return keccak(
    concat([
      REMOVE_MEMBERS_TYPE_HASH,
      word(uintArg(groupId, MAX_U64, "groupId")),
      word(tierArg(tier)),
      word(uintArg(size, MAX_U64, "size")),
      arrayHash(indices, MAX_U64, "indices"),
    ]),
  );
}

function eip712Digest(domainSeparator: Uint8Array, structHash: Uint8Array): Uint8Array {
  return keccak(
    concat([
      Uint8Array.of(0x19, 0x01),
      bytesArg(domainSeparator, 32, "domainSeparator"),
      structHash,
    ]),
  );
}

/** `keccak256(0x19 ‖ 0x01 ‖ domainSeparator ‖ hashStruct(AddMembers))`. */
export function groupAdditionDigest(
  domainSeparator: Uint8Array,
  message: AddMembersMessage,
): Uint8Array {
  return eip712Digest(domainSeparator, addMembersStructHash(message));
}

/** `keccak256(0x19 ‖ 0x01 ‖ domainSeparator ‖ hashStruct(RemoveMembers))`. */
export function groupRemovalDigest(
  domainSeparator: Uint8Array,
  message: RemoveMembersMessage,
): Uint8Array {
  return eip712Digest(domainSeparator, removeMembersStructHash(message));
}

/** The Ethereum address of a secp256k1 public key: the last 20 bytes of keccak(x ‖ y). */
function addressOf(point: InstanceType<typeof secp256k1.Point>): Uint8Array {
  return keccak(point.toBytes(false).subarray(1)).subarray(12);
}

/**
 * `ecrecover(digest, v, r, s)` after the registry's encoding rules: `v` 27 or
 * 28, `1 ≤ r < N`, `1 ≤ s ≤ (N − 1) / 2`. Null for anything outside them or
 * with no point to recover. The low-s rule gives each signature one encoding
 * (EIP-2, T-31): `(r, N − s)` with the other `v` recovers the same key.
 */
function recoverAddress(digest: Uint8Array, a: GroupApproval): Uint8Array | null {
  const { r, s, v } = a;
  if (v !== 27 && v !== 28) return null;
  if (typeof r !== "bigint" || typeof s !== "bigint") return null;
  if (r < 1n || r >= N || s < 1n || s > HALF_N) return null;
  try {
    // The digest is signed as is (no prehash). Only recovery ids 0 and 1:
    // ecrecover's v can't express an R with x = r + N.
    const point = new secp256k1.Signature(r, s, v - 27).recoverPublicKey(digest);
    return addressOf(point);
  } catch {
    // r with no curve point at x = r, or a recovered identity: ecrecover
    // returns the zero address, which is no registrar.
    return null;
  }
}

// Public data, so timing doesn't matter; written without early exit anyway.
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return d === 0;
}

function checkedRegistrars(registrars: readonly Uint8Array[], threshold: number): Uint8Array[] {
  if (!Array.isArray(registrars)) throw new TypeError("registrars: expected an array");
  // Copied once, so the set checked is the set compared against.
  const set = registrars.map((x: unknown, i) => bytesArg(x, 20, `registrar ${i + 1}`));
  const n = set.length;
  if (n < 2 || n > GROUP_REGISTRY_MAX_REGISTRARS)
    throw new RangeError(`registrars: need 2 to ${GROUP_REGISTRY_MAX_REGISTRARS}`);
  // T-62: a threshold of 1 would let one key add or remove members.
  if (!Number.isSafeInteger(threshold) || threshold < 2 || threshold > n)
    throw new RangeError("registrars: need 2 ≤ threshold ≤ n");
  let last = 0n;
  for (const [i, a] of set.entries()) {
    const value = bigEndian(a);
    // Nonzero and strictly ascending: no address repeats, and the set has one order.
    if (value <= last) throw new RangeError(`registrar ${i + 1}: zero or out of order`);
    last = value;
  }
  return set;
}

/**
 * Rules 7 and 8 of docs/spec/contracts.md, Group registry, Additions, over a
 * record's `digest`: at least `threshold` approvals; then, one by one in
 * record order, each seat greater than the last and within 1..n (so each
 * registrar counts once), and each signature canonical and recovering that
 * seat's registrar. Every approval must verify, including any beyond the
 * threshold (T-06, T-62). `registrars` and `threshold` are the set the
 * verifier's release pins, never the one `RegistrarsPinned` logs (T-71); a
 * pinned set that breaks the deployment rules throws.
 */
export function checkGroupApprovals(
  digest: Uint8Array,
  approvals: readonly GroupApproval[],
  registrars: readonly Uint8Array[],
  threshold: number,
): GroupApprovalResult {
  const set = checkedRegistrars(registrars, threshold);
  const d = bytesArg(digest, 32, "digest");
  if (!Array.isArray(approvals)) throw new TypeError("approvals: expected an array");
  const list = approvals.slice();
  if (list.length < threshold) return { ok: false, error: "approvals" };
  let last = 0;
  for (const a of list) {
    // Each field read once, so the seat checked is the seat whose key is compared.
    const { seat, r, s, v } = a;
    if (!Number.isSafeInteger(seat) || seat <= last || seat > set.length)
      return { ok: false, error: "seat", seat };
    last = seat;
    const signer = recoverAddress(d, { seat, r, s, v });
    // `seat` is within 1..n, so the registrar exists.
    if (signer === null || !equalBytes(signer, set[seat - 1] as Uint8Array))
      return { ok: false, error: "signature", seat };
  }
  return { ok: true };
}
