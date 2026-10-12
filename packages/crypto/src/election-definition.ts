// The election definition, record type 0x0001 versions 1 and 3
// (docs/spec/election-definition.md): the layouts, and the well-formedness
// rules a decoded definition must also meet. Version 2 is never assigned: a
// frozen vector uses it as the version with no layout. Its hash, registered on L2 before
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
import { RECORD_TYPES, recordType } from "./record.ts";
import { foldRegions } from "./regional-cells.ts";

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

// The fields before and after `electorate`, the same in every version.
const HEAD = [
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
] as const;

const TAIL = [
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
] as const;

const electionDefinitionV1 = struct([
  ...HEAD,
  ["electorate", list(tierGroup, 3)],
  ...TAIL,
] as const);

const regionGroup = struct([
  ["group_id", u64],
  ["region", u16],
] as const);

const cell = struct([
  ["root", fieldBn254],
  ["members", u64],
] as const);

/** Version 3's per-tier limits (docs/spec/election-definition.md, Layout (version 3)). */
export const DEFINITION_V3_LIMITS = Object.freeze({
  groupsPerTier: 1024,
  regionsPerTier: 1024,
  // The range of the u8 `cell` in tally-opening version 1 and the summed-share
  // message: a partition with more cells couldn't be opened.
  cells: 256,
} as const);

const tierElectorate = struct([
  ["tier", enum8(TIERS)],
  ["root_l2_block", u64],
  ["groups", list(regionGroup, DEFINITION_V3_LIMITS.groupsPerTier)],
  ["regions", list(u64, DEFINITION_V3_LIMITS.regionsPerTier)],
  ["cells", list(cell, DEFINITION_V3_LIMITS.cells)],
] as const);

// Version 1's fields, in order, with the electorate replaced by regional
// cells (0019-regional-cells).
const electionDefinitionV3 = struct([
  ...HEAD,
  ["electorate", list(tierElectorate, 3)],
  ...TAIL,
] as const);

/** Record type 0x0001, versions 1 and 3 (docs/spec/election-definition.md). */
export const ELECTION_DEFINITION = recordType(RECORD_TYPES.electionDefinition, {
  1: electionDefinitionV1,
  3: electionDefinitionV3,
});

export type ElectionDefinition = CodecValue<typeof electionDefinitionV1>;
export type ElectionDefinitionV3 = CodecValue<typeof electionDefinitionV3>;
export type TierElectorate = CodecValue<typeof tierElectorate>;

// Version 1's limits, written out rather than read from PARAMETERS: raising a
// protocol-wide limit is a new record version (parameters.md), so it must
// never change what version 1 accepts. A test ties them to PARAMETERS.
export const DEFINITION_V1_LIMITS = Object.freeze({ maxOptions: 64, maxTrustees: 16 } as const);

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
  return headRule(d) ?? electorateV1Rule(d) ?? tailRule(d);
}

/** The well-formedness rule codes of version 3, in checking order: version 1's, with `cells` after `electorate`. */
export type ElectionDefinitionV3Rule = ElectionDefinitionRule | "cells";

/**
 * Version 3's `electionDefinitionRule`: version 1's rules, with `electorate`
 * read for regional cells and `cells` after it (docs/spec/election-definition.md,
 * Well-formedness). `cells` checks the stated cells against the fold of the
 * stated region counts, so the floor on every split tier follows from the
 * counts, which the verifier checks against the board (2.4; T-16, T-34).
 */
export function electionDefinitionV3Rule(
  d: ElectionDefinitionV3,
): ElectionDefinitionV3Rule | undefined {
  return headRule(d) ?? electorateV3Rule(d) ?? cellsRule(d) ?? tailRule(d);
}

type Head = Pick<
  ElectionDefinition,
  "profile" | "election_type" | "option_count" | "min_selections" | "max_selections"
>;

function headRule(d: Head): ElectionDefinitionRule | undefined {
  const pinnedTypes = d.profile.pins.map((p) => p.record_type);
  if (d.profile.protocol_major !== 1) return "protocol-major";
  if (!strictlyAscending(pinnedTypes)) return "profile-order";
  if (
    pinnedTypes.length !== REQUIRED_TYPES.length ||
    !pinnedTypes.every((t, i) => t === REQUIRED_TYPES[i])
  )
    return "profile-types";
  if (d.profile.pins.some((p) => p.version < 1)) return "profile-version";
  if (d.option_count < 2 || d.option_count > DEFINITION_V1_LIMITS.maxOptions) return "option-count";
  if (
    d.min_selections > d.max_selections ||
    d.max_selections > d.option_count ||
    d.max_selections < 1 ||
    // A blank plurality ballot is valid (0003-tally-scheme), so plurality is
    // exactly the range [0, 1].
    (d.election_type === ELECTION_TYPES.plurality &&
      (d.min_selections !== 0 || d.max_selections !== 1))
  )
    return "selections";
  return undefined;
}

function electorateV1Rule(d: ElectionDefinition): ElectionDefinitionRule | undefined {
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
  return undefined;
}

function electorateV3Rule(d: ElectionDefinitionV3): ElectionDefinitionRule | undefined {
  const tiers = d.electorate.map((t) => t.tier);
  if (tiers.length === 0 || !strictlyAscending(tiers)) return "electorate";
  const seen = new Set<bigint>();
  for (const t of d.electorate) {
    if (t.groups.length === 0 || t.regions.length === 0) return "electorate";
    // Ascending group IDs put each group in one region; distinct across tiers
    // puts it in one tier, so no member is counted in two cells (T-01, G-2).
    for (const [i, g] of t.groups.entries()) {
      if (i > 0 && (t.groups[i - 1] as (typeof t.groups)[number]).group_id >= g.group_id)
        return "electorate";
      if (seen.has(g.group_id)) return "electorate";
      seen.add(g.group_id);
    }
    const named = new Set(t.groups.map((g) => g.region));
    if (t.groups.some((g) => g.region >= t.regions.length) || named.size !== t.regions.length)
      return "electorate";
    if (t.regions.some((n) => n < 1n)) return "electorate";
  }
  return undefined;
}

function cellsRule(d: ElectionDefinitionV3): ElectionDefinitionV3Rule | undefined {
  let total = 0;
  const roots = new Set<bigint>();
  for (const t of d.electorate) {
    const derived = foldRegions(t.regions);
    if (derived.length !== t.cells.length) return "cells";
    for (const [i, regions] of derived.entries()) {
      const stated = t.cells[i] as (typeof t.cells)[number];
      // Over unbounded integers: a sum above u64 never equals a stated count.
      const sum = regions.reduce((n, r) => n + (t.regions[r] as bigint), 0n);
      if (stated.members !== sum) return "cells";
      roots.add(stated.root);
    }
    total += t.cells.length;
  }
  // Distinct roots keep one membership proof from fitting two cells (T-01,
  // T-16); 256 cells is the range of the tally opening's u8 `cell`.
  if (roots.size !== total || total > DEFINITION_V3_LIMITS.cells) return "cells";
  return undefined;
}

type Tail = Pick<
  ElectionDefinition,
  | "threshold"
  | "panel_size"
  | "election_registry"
  | "board"
  | "trustee_registry"
  | "group_registry"
  | "l1_anchor"
  | "l1_relay"
  | "l2_chain_id"
  | "l1_chain_id"
  | "opens_at"
  | "closes_at"
  | "l1_inclusion_bound"
>;

function tailRule(d: Tail): ElectionDefinitionRule | undefined {
  // At least two trustees must combine shares: a 1-of-n panel lets one party
  // open every voter's sharing alone, which the brief forbids (T-14).
  if (
    d.threshold < 2 ||
    d.threshold > d.panel_size ||
    d.panel_size > DEFINITION_V1_LIMITS.maxTrustees
  )
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
  // The close rule's deadline is closes_at + δ; it must not overflow a u64.
  if (d.opens_at >= d.closes_at || d.closes_at + BigInt(d.l1_inclusion_bound) >= 1n << 64n)
    return "timing";
  return undefined;
}
