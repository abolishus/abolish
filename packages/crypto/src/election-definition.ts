// The election definition, record type 0x0001 version 1
// (docs/spec/election-definition.md): the layout, and the well-formedness
// rules a decoded definition must also meet. Its hash, registered on L2 before
// voting opens and bound into every ballot and proof, is what stops an
// election's rules changing or differing between voters (T-34).

import {
  bytesFixed,
  type CodecValue,
  enum8,
  fieldBn254,
  list,
  struct,
  u16,
  u32,
  u64,
  u8,
} from "./codec.ts";
import { PARAMETERS } from "./parameters.ts";
import { RECORD_TYPES, recordType } from "./record.ts";

const address = bytesFixed(20);
const hash = bytesFixed(32);

const recordPin = struct([
  ["record_type", u16],
  ["version", u8],
] as const);

const profile = struct([
  ["protocol_major", u8],
  ["pins", list(recordPin, 64)],
] as const);

/** The identity tiers of the brief: 0 passkey, 1 vouched, 2 ZK proof of personhood. */
export const TIERS = Object.freeze([0, 1, 2] as const);

const tierGroup = struct([
  ["tier", enum8(TIERS)],
  ["group_id", u64],
  ["root", fieldBn254],
  ["root_l2_block", u64],
  ["group_size", u64],
] as const);

export const ELECTION_TYPES = Object.freeze({ plurality: 1, approval: 2 } as const);
export const TALLY_SCHEMES = Object.freeze({ pedersenVss: 1 } as const);

const electionDefinitionV1 = struct([
  ["profile", profile],
  ["election_id", hash],
  ["l2_chain_id", u64],
  ["l1_chain_id", u64],
  ["election_registry", address],
  ["board", address],
  ["trustee_registry", address],
  ["group_registry", address],
  ["l1_anchor", address],
  ["l1_relay", address],
  ["election_type", enum8([ELECTION_TYPES.plurality, ELECTION_TYPES.approval])],
  ["tally_scheme", enum8([TALLY_SCHEMES.pedersenVss])],
  ["option_count", u16],
  ["min_selections", u16],
  ["max_selections", u16],
  ["electorate", list(tierGroup, TIERS.length)],
  ["membership_vk_hash", hash],
  ["panel_id", hash],
  ["threshold", u8],
  ["panel_size", u8],
  ["ceremony_transcript_hash", hash],
  ["opens_at", u64],
  ["closes_at", u64],
  ["l1_inclusion_bound", u32],
  ["sequencing_window", u64],
  ["max_sequencer_drift", u64],
  ["display_text_commitment", hash],
] as const);

/** Record type 0x0001. Version 1 is a draft (docs/spec/versioning.md, Draft layouts). */
export const ELECTION_DEFINITION = recordType(RECORD_TYPES.electionDefinition, {
  1: electionDefinitionV1,
});

export type ElectionDefinition = CodecValue<typeof electionDefinitionV1>;

/** The well-formedness rule codes of docs/spec/election-definition.md, in checking order. */
export type ElectionDefinitionRule =
  | "protocol-major"
  | "profile-order"
  | "profile-types"
  | "profile-version"
  | "option-count"
  | "selections"
  | "electorate"
  | "panel"
  | "chain"
  | "timing";

// Plurality and approval use exactly the types 0x0001 to 0x0009. Fixed here,
// not derived from RECORD_TYPES, so registering a new type can't change which
// version-1 definitions are well formed.
const REQUIRED_TYPES: readonly number[] = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9]);

function strictlyAscending(xs: readonly number[]): boolean {
  for (let i = 1; i < xs.length; i++) if ((xs[i - 1] as number) >= (xs[i] as number)) return false;
  return true;
}

const isZero = (b: Uint8Array) => b.every((x) => x === 0);
const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
const pairwiseDistinct = (xs: readonly Uint8Array[]) =>
  xs.every((a, i) => xs.slice(i + 1).every((b) => !sameBytes(a, b)));

/**
 * The first well-formedness rule a decoded definition breaks, or `undefined`
 * if it is well formed. A failure fails the election ([[verifier]] 2.x); it
 * never makes the bytes undecodable. Whether the verifier supports each pinned
 * version, and everything checked against the chain or the board, is outside
 * these rules.
 */
export function electionDefinitionRule(d: ElectionDefinition): ElectionDefinitionRule | undefined {
  const pinnedTypes = d.profile.pins.map((p) => p.record_type);
  if (d.profile.protocol_major !== 1) return "protocol-major";
  if (!strictlyAscending(pinnedTypes)) return "profile-order";
  if (
    pinnedTypes.length !== REQUIRED_TYPES.length ||
    !pinnedTypes.every((t, i) => t === REQUIRED_TYPES[i])
  )
    return "profile-types";
  if (d.profile.pins.some((p) => p.version < 1)) return "profile-version";
  if (d.option_count < 2 || d.option_count > PARAMETERS.MAX_OPTIONS) return "option-count";
  if (
    d.min_selections > d.max_selections ||
    d.max_selections > d.option_count ||
    d.max_selections < 1 ||
    (d.election_type === ELECTION_TYPES.plurality && d.max_selections !== 1)
  )
    return "selections";
  // Ascending tiers make the tiers-only partition one cell per tier, none
  // repeated (verifier 2.8; T-29, T-36). Distinct roots keep two cells from
  // sharing one membership proof, which would let a voter's claimed tier pick
  // the cell, merging them (T-01, T-16).
  const tiers = d.electorate.map((g) => g.tier);
  const groupIds = new Set(d.electorate.map((g) => g.group_id));
  const roots = new Set(d.electorate.map((g) => g.root));
  if (
    tiers.length === 0 ||
    !strictlyAscending(tiers) ||
    groupIds.size !== tiers.length ||
    roots.size !== tiers.length ||
    d.electorate.some((g) => g.group_size < 1n)
  )
    return "electorate";
  // At least two trustees must combine shares: a 1-of-n panel lets one party
  // open every voter's sharing alone, which the brief forbids (T-14).
  if (d.threshold < 2 || d.threshold > d.panel_size || d.panel_size > PARAMETERS.MAX_TRUSTEES)
    return "panel";
  const l2 = [d.election_registry, d.board, d.trustee_registry, d.group_registry];
  const l1 = [d.l1_anchor, d.l1_relay];
  if (
    d.l2_chain_id === 0n ||
    d.l1_chain_id === 0n ||
    d.l2_chain_id === d.l1_chain_id ||
    [...l2, ...l1].some(isZero) ||
    !pairwiseDistinct(l2) ||
    !pairwiseDistinct(l1)
  )
    return "chain";
  if (d.opens_at >= d.closes_at) return "timing";
  return undefined;
}
