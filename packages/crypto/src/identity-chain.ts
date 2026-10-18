// The identity chain behind a Tier 2 query's `comm_in` (docs/spec/identity-
// chain.md; docs/adr/0010-tier2-identity-provider.md, Amendment, part 2b-4d):
// the identity-chain record (0x0024), a CSCA's fingerprint, each of the five
// sub-proofs' public inputs in circuit order, and the identity-chain check up
// to its proofs. The proofs themselves are verified by the circuits' verifier
// against the public inputs built here, under the keys named here (P3-4 part
// 2b-4d-2). Anchor-set roots and the parameter commitments are Poseidon2
// sponges, which this package doesn't implement: a seat takes them as the
// release pins them.

import {
  BN254_R,
  bytesFixed,
  bytesVar,
  type CodecValue,
  DecodeError,
  type DecodeErrorCode,
  fieldBn254,
  struct,
  u64,
} from "./codec.ts";
import { ds } from "./domain-separation.ts";
import { H } from "./group.ts";
import { MAX_NULLIFIER_PROOF } from "./nullifier-query.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";

const DAY = 86_400n;

const recordV1 = struct([
  ["proof_date", u64],
  ["anchor_root", fieldBn254],
  ["dsc_key", bytesFixed(32)],
  ["comm_dsc", fieldBn254],
  ["dsc_proof", bytesVar(MAX_NULLIFIER_PROOF)],
  ["id_key", bytesFixed(32)],
  ["comm_id", fieldBn254],
  ["id_proof", bytesVar(MAX_NULLIFIER_PROOF)],
  ["integrity_key", bytesFixed(32)],
  ["integrity_proof", bytesVar(MAX_NULLIFIER_PROOF)],
  ["age_proof", bytesVar(MAX_NULLIFIER_PROOF)],
  ["nationality_proof", bytesVar(MAX_NULLIFIER_PROOF)],
] as const);

/** An identity-chain record, version 1 (docs/spec/identity-chain.md, Record). */
export type IdentityChainRecord = CodecValue<typeof recordV1>;

/** Record type `0x0024`. Never on the board; the Tier 2 key fixes its version. */
export const IDENTITY_CHAIN = recordType(RECORD_TYPES.identityChain, { 1: recordV1 });

const SCHEMA = new RecordSchema([IDENTITY_CHAIN]);

export function encodeIdentityChain(record: IdentityChainRecord): Uint8Array {
  return SCHEMA.encode(IDENTITY_CHAIN, 1, record);
}

/** Strictly decodes a record under version 1, the version the Tier 2 key fixes. */
export function decodeIdentityChain(bytes: Uint8Array, pinned: 1): IdentityChainRecord {
  return SCHEMA.decode(IDENTITY_CHAIN, bytes, pinned).value;
}

/**
 * A CSCA's fingerprint in its anchor-set leaf:
 * `int(H(DS("abolish/v1/identity-chain/csca", der))) >> 8`, below BN254's `r`.
 * Ours, since sub-circuit A binds it without comparing it with anything: it
 * names the certificate a leaf stands for, so a third party recomputes a set's
 * root from the certificates alone (T-21, T-06).
 */
export function cscaFingerprint(der: Uint8Array): bigint {
  if (!(der instanceof Uint8Array)) throw new TypeError("cscaFingerprint: der must be bytes");
  let v = 0n;
  for (const b of H(ds("abolish/v1/identity-chain/csca", der))) v = (v << 8n) | BigInt(b);
  return v >> 8n;
}

/** One anchor set the release pins for the deployment's issuer, by root and interval. */
export interface AnchorSetPin {
  readonly root: bigint;
  /** A UTC midnight, in Unix seconds. */
  readonly validFrom: bigint;
  /** A UTC midnight, in Unix seconds; the set covers `[validFrom, validUntil)`. */
  readonly validUntil: bigint;
}

/**
 * What a deployment's release pins for the identity chain (docs/spec/identity-
 * chain.md, Anchor sets, Circuit set and Requirements on the disclosure
 * proofs). Every value is the release's, for the deployment's one issuer: a
 * seat never takes any of them from a record (T-05, T-06, T-21).
 */
export interface IdentityChainPins {
  /** The issuer's anchor sets only: a MOCK deployment's are ZKR's, a `USA` one's US CSCAs'. */
  readonly anchors: readonly AnchorSetPin[];
  /** Each role's verification keys by their sha256; a key is in exactly one role's list. */
  readonly dscKeys: readonly Uint8Array[];
  readonly idKeys: readonly Uint8Array[];
  readonly integrityKeys: readonly Uint8Array[];
  /** The one age key and the one nationality key, by their sha256. */
  readonly ageKey: Uint8Array;
  readonly nationalityKey: Uint8Array;
  /** `P_age = Sponge(1, 2, 18, 0)[0]`. */
  readonly ageCommitment: bigint;
  /** `P_nat(c)` over the issuer's code and 199 empty ones. */
  readonly nationalityCommitment: bigint;
  /** `t`: 4 (`NONE_NULLIFIER`) for issuer `USA`, 2 (`NON_SALTED_MOCK_NULLIFIER`) for ZKR. */
  readonly nullifierType: 2 | 4;
}

export type ChainProofRole = "dsc" | "id" | "integrity" | "age" | "nationality";

/** One sub-proof as the proof check takes it: the key named, the proof and its public inputs. */
export interface ChainProof {
  readonly role: ChainProofRole;
  /** The sha256 of the verification key it must verify under. */
  readonly key: Uint8Array;
  readonly proof: Uint8Array;
  /** In the circuit's order, its outputs last, each supplied by the checker. */
  readonly publicInputs: readonly bigint[];
}

export type IdentityChainCode = DecodeErrorCode | "chain-date" | "chain-anchor" | "chain-circuit";

export type IdentityChainResult =
  | {
      readonly ok: true;
      readonly record: IdentityChainRecord;
      /** The five proofs in the check's order: `dsc`, `id`, `integrity`, `age`, `nationality`. */
      readonly proofs: readonly ChainProof[];
    }
  | { readonly ok: false; readonly code: IdentityChainCode };

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const pinned = (keys: readonly Uint8Array[], key: Uint8Array) =>
  keys.some((k) => sameBytes(k, key));

const isField = (v: unknown): v is bigint => typeof v === "bigint" && v >= 0n && v < BN254_R;

/**
 * The public inputs of the five proofs, in the spec's order: each link takes
 * the previous link's output, the integrity proof outputs the query's
 * `comm_in`, and both disclosure proofs take `comm_in`, `proof_date`, scopes
 * of 0, their parameter commitment, `t`, and the hash-only form's nullifier
 * and `oprf_pk_hash` of 0, so no client-chosen value and no chip-recomputable
 * nullifier reaches a seat (T-13, T-17).
 */
export function identityChainProofs(
  pins: IdentityChainPins,
  record: IdentityChainRecord,
  commIn: bigint,
): readonly ChainProof[] {
  if (!isField(commIn)) throw new RangeError("identityChainProofs: comm_in must be below r");
  const date = record.proof_date;
  const t = BigInt(pins.nullifierType);
  return [
    {
      role: "dsc",
      key: record.dsc_key,
      proof: record.dsc_proof,
      publicInputs: [record.anchor_root, record.comm_dsc],
    },
    {
      role: "id",
      key: record.id_key,
      proof: record.id_proof,
      publicInputs: [record.comm_dsc, record.comm_id],
    },
    {
      role: "integrity",
      key: record.integrity_key,
      proof: record.integrity_proof,
      publicInputs: [record.comm_id, commIn],
    },
    {
      role: "age",
      key: pins.ageKey,
      proof: record.age_proof,
      publicInputs: [commIn, date, 0n, 0n, pins.ageCommitment, t, 0n, 0n],
    },
    {
      role: "nationality",
      key: pins.nationalityKey,
      proof: record.nationality_proof,
      publicInputs: [commIn, date, 0n, 0n, pins.nationalityCommitment, t, 0n, 0n],
    },
  ];
}

/**
 * The identity-chain check (docs/spec/identity-chain.md, Identity-chain check)
 * up to `chain-dsc`, in its order, against the seat's clock (`now`, Unix
 * seconds), the release's pins and `commIn`, the `comm_in` of the query the
 * seat has already checked, proof included. `ok` means only that the five
 * proofs may be checked, in the order given, each under the key it names; a
 * seat answers only once every one verifies (T-03, T-21).
 */
export function checkIdentityChain(
  pins: IdentityChainPins,
  now: bigint,
  commIn: bigint,
  bytes: Uint8Array,
): IdentityChainResult {
  if (typeof now !== "bigint" || now < 0n)
    throw new RangeError("checkIdentityChain: now must be a non-negative bigint");
  if (!isField(commIn)) throw new RangeError("checkIdentityChain: comm_in must be below r");
  let record: IdentityChainRecord;
  try {
    record = decodeIdentityChain(bytes, 1);
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, code: e.code };
    throw e;
  }
  const date = record.proof_date;
  // A midnight within a day of the seat's own UTC day: the circuits read the
  // date as a day, and a stale chain can't be kept for later (T-03).
  const today = now - (now % DAY);
  if (date % DAY !== 0n || date < today - DAY || date > today + DAY)
    return { ok: false, code: "chain-date" };
  // Only the issuer's own sets, by root and the interval covering the date;
  // they never overlap, so the date names one set (T-06, T-21).
  if (
    !pins.anchors.some(
      (a) => a.root === record.anchor_root && a.validFrom <= date && date < a.validUntil,
    )
  )
    return { ok: false, code: "chain-anchor" };
  // Each key in its own role's list: a key of another role is refused, even
  // one the release pins (T-05).
  if (
    !pinned(pins.dscKeys, record.dsc_key) ||
    !pinned(pins.idKeys, record.id_key) ||
    !pinned(pins.integrityKeys, record.integrity_key)
  )
    return { ok: false, code: "chain-circuit" };
  return { ok: true, record, proofs: identityChainProofs(pins, record, commIn) };
}
