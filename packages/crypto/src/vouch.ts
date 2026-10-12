// Tier 1 vouches (docs/spec/vouching.md, ADR 0014): the binding, the two
// scopes and messages, the vouch and Tier 1 addition record, and the checks of
// one addition on its own. Which Tier 2 roots count, slot consumption across
// the deployment and the root window are P3-3 part 2b's.

import { DecodeError, Reader, encode, fieldBn254, u16, u64, u8 } from "./codec.ts";
import { ds } from "./domain-separation.ts";
import { isForbiddenCommitment } from "./group-registry.ts";
import { H } from "./group.ts";
import { semaphoreField } from "./membership.ts";
import { PARAMETERS } from "./parameters.ts";
import {
  MEMBERSHIP_PROOF_LENGTH,
  encodeMembershipProof,
  membershipProof,
  verifyMembershipProof,
} from "./membership-proof.ts";

/** `k`: the vouches a Tier 1 addition carries. */
export const VOUCH_K = PARAMETERS.VOUCH_K;
/** `L`: each Tier 2 secret's slots, `0` to `L − 1`, across the deployment. */
export const VOUCH_SLOTS = PARAMETERS.VOUCH_SLOTS;
/** A vouch's encoded length. */
export const VOUCH_LENGTH = 8 + 8 + 32 + 2 + 32 + 32 + 2 * MEMBERSHIP_PROOF_LENGTH;
const ADDITION_HEADER = 8 + 32 + 1;

/** Where a Tier 1 addition was logged: the L2's chain ID and the group registry's address. */
export interface VouchContext {
  readonly chainId: bigint;
  readonly registry: Uint8Array;
}

export interface Vouch {
  readonly tier2GroupId: bigint;
  readonly rootBlock: bigint;
  readonly root: bigint;
  readonly slot: number;
  readonly voucheeNullifier: bigint;
  readonly slotNullifier: bigint;
  /** `membership_proof` bytes, as the record carries them (proofs are malleable; T-38). */
  readonly voucheeProof: Uint8Array;
  readonly slotProof: Uint8Array;
}

export interface Tier1Addition {
  readonly groupId: bigint;
  readonly commitment: bigint;
  readonly vouches: readonly Vouch[];
}

export type Tier1AdditionDecodeResult =
  | { readonly ok: true; readonly value: Tier1Addition }
  | { readonly ok: false; readonly error: "length" }
  | { readonly ok: false; readonly error: "non-canonical"; readonly offset: number };

export type Tier1AdditionResult =
  | { readonly ok: true; readonly value: Tier1Addition }
  | { readonly ok: false; readonly error: "decode"; readonly decode: Tier1AdditionDecodeResult }
  | { readonly ok: false; readonly error: "forbidden-commitment" | "vouch-count" }
  | {
      readonly ok: false;
      readonly error: "slot" | "root" | "duplicate-voucher" | "duplicate-slot";
      readonly vouch: number;
    }
  | {
      readonly ok: false;
      readonly error: "proof";
      readonly vouch: number;
      readonly which: "vouchee" | "slot";
    };

function context(ctx: VouchContext): { chainId: bigint; registry: Uint8Array } {
  if (ctx === null || typeof ctx !== "object")
    throw new TypeError("vouch context: expected an object");
  // Read once, so a getter can't show the checks one value and the hash another.
  const { chainId, registry } = ctx;
  if (typeof chainId !== "bigint" || chainId < 0n || chainId >= 2n ** 64n)
    throw new RangeError("vouch context: chainId must be a u64");
  if (!(registry instanceof Uint8Array) || !ArrayBuffer.isView(registry))
    throw new TypeError("vouch context: registry must be 20 bytes");
  const copy = new Uint8Array(registry);
  if (copy.length !== 20) throw new TypeError("vouch context: registry must be 20 bytes");
  return { chainId, registry: copy };
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

/** `binding = u64(chain_id) ‖ bytes[20](registry) ‖ u64(group_id)`. */
function binding(ctx: { chainId: bigint; registry: Uint8Array }, groupId: bigint): Uint8Array {
  return concat([encode(u64, ctx.chainId), ctx.registry, encode(u64, groupId)]);
}

/**
 * `S_V = H(DS("abolish/v1/vouch", binding ‖ encode(C_V)))`: one nullifier per
 * voucher secret and vouchee in this group, so `k` distinct vouchee
 * nullifiers are `k` distinct Tier 2 secrets (T-02, T-06).
 */
export function vouchScope(ctx: VouchContext, groupId: bigint, commitment: bigint): Uint8Array {
  return H(
    ds(
      "abolish/v1/vouch",
      concat([binding(context(ctx), groupId), encode(fieldBn254, commitment)]),
    ),
  );
}

/**
 * `S_j = H(DS("abolish/v1/vouch-slot", u64(chain_id) ‖ bytes[20](registry) ‖ u16(j)))`.
 * No group in it: a slot bound to a group would let an operator hand every
 * voucher `L` fresh slots by creating another Tier 1 group (ADR 0014, T-06).
 */
export function vouchSlotScope(ctx: VouchContext, slot: number): Uint8Array {
  const c = context(ctx);
  return H(
    ds("abolish/v1/vouch-slot", concat([encode(u64, c.chainId), c.registry, encode(u16, slot)])),
  );
}

/** Role `0` names the vouchee proof's message, `1` the slot proof's. */
export type VouchRole = 0 | 1;

/**
 * `M = H(DS("abolish/v1/vouch-message", u8(role) ‖ binding ‖ encode(C_V) ‖
 * u64(tier2_group_id) ‖ u64(root_block) ‖ encode(ν_other)))`: each proof binds
 * the vouchee, the root it names and the other proof's nullifier, so neither
 * proof can be paired with another or moved (T-02, T-32).
 */
export function vouchMessage(
  ctx: VouchContext,
  role: VouchRole,
  groupId: bigint,
  commitment: bigint,
  tier2GroupId: bigint,
  rootBlock: bigint,
  otherNullifier: bigint,
): Uint8Array {
  if (role !== 0 && role !== 1) throw new RangeError("vouchMessage: role must be 0 or 1");
  return H(
    ds(
      "abolish/v1/vouch-message",
      concat([
        encode(u8, role),
        binding(context(ctx), groupId),
        encode(fieldBn254, commitment),
        encode(u64, tier2GroupId),
        encode(u64, rootBlock),
        encode(fieldBn254, otherNullifier),
      ]),
    ),
  );
}

// A proof is decoded for strictness (every point canonical, on its curve and
// in its subgroup; T-05, T-31) and kept as the bytes the record carries.
function readProof(r: Reader): Uint8Array {
  const at = r.offset;
  const bytes = new Uint8Array(r.take(MEMBERSHIP_PROOF_LENGTH));
  try {
    membershipProof.read(new Reader(bytes));
  } catch (e) {
    if (e instanceof DecodeError) throw new DecodeError(e.code, at + e.offset);
    throw e;
  }
  return bytes;
}

function readVouch(r: Reader): Vouch {
  return {
    tier2GroupId: u64.read(r),
    rootBlock: u64.read(r),
    root: fieldBn254.read(r),
    slot: r.uint(2),
    voucheeNullifier: fieldBn254.read(r),
    slotNullifier: fieldBn254.read(r),
    voucheeProof: readProof(r),
    slotProof: readProof(r),
  };
}

/**
 * Decodes a Tier 1 addition record strictly:
 * `u64(group_id) ‖ field<bn254>(C_V) ‖ u8(vouches) ‖ vouch × vouches`. The
 * length is checked against the count byte before anything else is read, so
 * a hostile length costs nothing to refuse (T-52, T-17); then every field
 * element must be canonical and every proof point valid (T-31).
 */
export function decodeTier1Addition(bytes: Uint8Array): Tier1AdditionDecodeResult {
  if (!(bytes instanceof Uint8Array) || !ArrayBuffer.isView(bytes))
    throw new TypeError("decodeTier1Addition: expected a Uint8Array");
  // Copied once, so the length checked is the length read.
  const b = new Uint8Array(bytes);
  if (b.length < ADDITION_HEADER) return { ok: false, error: "length" };
  const count = b[ADDITION_HEADER - 1] as number;
  if (b.length !== ADDITION_HEADER + VOUCH_LENGTH * count) return { ok: false, error: "length" };
  const r = new Reader(b);
  try {
    const groupId = u64.read(r);
    const commitment = fieldBn254.read(r);
    r.uint(1);
    const vouches: Vouch[] = [];
    for (let i = 0; i < count; i++) vouches.push(readVouch(r));
    r.end();
    return { ok: true, value: { groupId, commitment, vouches } };
  } catch (e) {
    // The length is exact, so the only decode failure left is a value.
    if (e instanceof DecodeError && e.code === "non-canonical")
      return { ok: false, error: "non-canonical", offset: e.offset };
    throw e;
  }
}

/** Encodes a Tier 1 addition record; every accepted encoding re-encodes to itself. */
export function encodeTier1Addition(addition: Tier1Addition): Uint8Array {
  const { groupId, commitment, vouches } = addition;
  if (!Array.isArray(vouches)) throw new TypeError("encodeTier1Addition: vouches must be an array");
  const parts = [encode(u64, groupId), encode(fieldBn254, commitment), encode(u8, vouches.length)];
  for (const v of vouches as readonly Vouch[]) {
    const voucheeProof = encodeMembershipProof(membershipProof.read(new Reader(v.voucheeProof)));
    const slotProof = encodeMembershipProof(membershipProof.read(new Reader(v.slotProof)));
    parts.push(
      encode(u64, v.tier2GroupId),
      encode(u64, v.rootBlock),
      encode(fieldBn254, v.root),
      encode(u16, v.slot),
      encode(fieldBn254, v.voucheeNullifier),
      encode(fieldBn254, v.slotNullifier),
      voucheeProof,
      slotProof,
    );
  }
  return concat(parts);
}

// The position of the first vouch whose `field` repeats an earlier vouch's.
function firstRepeat(
  vouches: readonly Vouch[],
  field: "voucheeNullifier" | "slotNullifier",
): number {
  const seen = new Set<bigint>();
  for (const [i, v] of vouches.entries()) {
    if (seen.has(v[field])) return i;
    seen.add(v[field]);
  }
  return -1;
}

/**
 * The checks of one Tier 1 addition on its own (docs/spec/vouching.md, Checks
 * of one addition), in the spec's order, reporting the first failure and the
 * failing vouch's position: decoding, a forbidden commitment, exactly `k`
 * vouches, every slot below `L`, every root nonzero, pairwise-distinct
 * vouchee nullifiers (distinct vouchers, T-02), pairwise-distinct slot
 * nullifiers (one slot funds one vouch), then both proofs of each vouch under
 * the pinned key with every scope and message recomputed here, never taken
 * from the record (T-06, T-32). The cheap checks come before any pairing
 * (T-52). Passing says nothing about the deployment: whether each root is a
 * Tier 2 root within the window, and whether its slots are unspent, are part
 * 2b's.
 */
export function checkTier1Addition(record: Uint8Array, ctx: VouchContext): Tier1AdditionResult {
  const c = context(ctx);
  const decoded = decodeTier1Addition(record);
  if (!decoded.ok) return { ok: false, error: "decode", decode: decoded };
  const { groupId, commitment, vouches } = decoded.value;
  if (isForbiddenCommitment(commitment)) return { ok: false, error: "forbidden-commitment" };
  if (vouches.length !== VOUCH_K) return { ok: false, error: "vouch-count" };
  for (const [i, v] of vouches.entries())
    if (v.slot >= VOUCH_SLOTS) return { ok: false, error: "slot", vouch: i };
  for (const [i, v] of vouches.entries())
    if (v.root === 0n) return { ok: false, error: "root", vouch: i };
  const voucher = firstRepeat(vouches, "voucheeNullifier");
  if (voucher >= 0) return { ok: false, error: "duplicate-voucher", vouch: voucher };
  const slot = firstRepeat(vouches, "slotNullifier");
  if (slot >= 0) return { ok: false, error: "duplicate-slot", vouch: slot };
  const voucheeScope = semaphoreField(vouchScope(c, groupId, commitment));
  for (const [i, v] of vouches.entries()) {
    const message = (role: VouchRole, other: bigint) =>
      semaphoreField(
        vouchMessage(c, role, groupId, commitment, v.tier2GroupId, v.rootBlock, other),
      );
    const voucheeOk = verifyMembershipProof(v.voucheeProof, {
      root: v.root,
      nullifier: v.voucheeNullifier,
      message: message(0, v.slotNullifier),
      scope: voucheeScope,
    });
    if (!voucheeOk) return { ok: false, error: "proof", vouch: i, which: "vouchee" };
    const slotOk = verifyMembershipProof(v.slotProof, {
      root: v.root,
      nullifier: v.slotNullifier,
      message: message(1, v.voucheeNullifier),
      scope: semaphoreField(vouchSlotScope(c, v.slot)),
    });
    if (!slotOk) return { ok: false, error: "proof", vouch: i, which: "slot" };
  }
  return { ok: true, value: decoded.value };
}
