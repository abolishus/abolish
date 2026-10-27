// Check 2.4's recount (docs/spec/verifier.md, Electorate): each fixed tier of
// a definition rebuilt from the group registry's records up to the tier's
// `root_l2_block`, every listed group replayed strictly under the registry
// and registrars the release pins, the regions counted and the cells folded
// and rooted by `@abolishus/crypto`'s `statedTierElectorate`, the code a
// poll's creator states the electorate with and the ballot client recounts
// it with, and compared with what the definition states. So a definition
// can't overstate a tier's anonymity set, put a group under another tier's
// label or name a root no registered history reaches (T-13, T-16, T-06,
// T-71).
//
// The records are the caller's: the registry's whole log in order of `n`
// (a trustee node's finalized L2 read, docs/spec/ceremony.md, step 3) or
// the subset a board carries. This decides only what they show: whether
// they are the registry's own, and all of them, is the caller's to know
// (the accumulator's replay, 4.4), so a pass here is a pass over those
// records, never 2.4's pass on its own. Tier 1 and Tier 2 tiers and rolling
// electorates are left unverifiable: a Tier 1 group's leaves are the
// additions the deployment's count takes, which needs the registry's whole
// Tier 1 and Tier 2 history ([[vouching]]), Tier 2 has no addition path yet
// (P3-4), and a rolling tier's roots are its steps' (P2-17).

import {
  type AnyElectionDefinitionRecord,
  type ContractEventRecord,
  type ContractEventVersion,
  type ElectionDefinitionV7Record,
  ELECTORATE_MODES,
  pinnedVersion,
  RECORD_TYPES,
  statedTierElectorate,
  type TierElectorate,
  TierMembershipError,
} from "@abolishus/crypto";

/** The group registry and its registrars, as the release pins them. */
export interface GroupRegistryRelease {
  /** The L2's chain ID. */
  readonly chainId: bigint;
  /** The group registry, 20 bytes. */
  readonly registry: Uint8Array;
  /** Its registrars, in ascending order as `RegistrarsPinned` logs them, and their threshold. */
  readonly registrars: readonly Uint8Array[];
  readonly threshold: number;
}

/** Why 2.4's recount fails a definition. */
export type ElectorateFailure =
  /** The definition names another L2 or group registry than the release pins. */
  | "group-registry"
  /** A record of the registry fails the event check, two differ at one `n`, or blocks go backwards. */
  | "group-records"
  /** The registry logs other registrars or another threshold than the release pins. */
  | "registrars"
  /** A listed group has no creation by the tier's `root_l2_block`, or more than one. */
  | "group-created"
  /** A listed group was created for another tier than the one listing it. */
  | "group-tier"
  /** A listed group's records break its strict replay ([[contracts]], Group registry, Verification). */
  | "group-history"
  /** A recounted region, cell root or member count differs from the definition's. */
  | "electorate";

export type ElectorateOutcome =
  | { readonly status: "pass" }
  | {
      readonly status: "fail";
      readonly code: ElectorateFailure;
      /**
       * The tier's position in the definition's `electorate`, and the group,
       * region or cell concerned; `{}` for `group-registry`.
       */
      readonly at: ElectorateAt | Record<string, never>;
    }
  | {
      readonly status: "unverifiable";
      /**
       * `tier-unsupported` for a Tier 1 or Tier 2 tier, `rolling` for a
       * rolling electorate, `unsupported-version` for a contract-event pin
       * this release doesn't read.
       */
      readonly code: "tier-unsupported" | "rolling" | "unsupported-version";
      readonly at: ElectorateAt | Record<string, never>;
    };

export type ElectorateAt =
  | { readonly tier: number }
  | { readonly tier: number; readonly group: bigint }
  | { readonly tier: number; readonly region: number }
  | { readonly tier: number; readonly cell: number };

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// The contract-event versions crypto's group-registry read takes, as 4.4's
// event check reads them (src/events.ts).
const isReadable = (v: number | undefined): v is ContractEventVersion =>
  v !== undefined && Number.isInteger(v) && v >= 1 && v <= 11;

/**
 * A fixed tier as the recount reads it, and the definition's statement of
 * it: version 1's one group per tier is a tier of one group in one region,
 * stated as one cell whose root and members are the tier's `root` and
 * `group_size`, so both layouts are recounted by one code.
 */
function fixedTiers(
  definition: AnyElectionDefinitionRecord | ElectionDefinitionV7Record,
): readonly TierElectorate[] | "rolling" {
  if (definition.version === 1)
    return definition.value.electorate.map((t) => ({
      tier: t.tier,
      root_l2_block: t.root_l2_block,
      groups: [{ group_id: t.group_id, region: 0 }],
      regions: [t.group_size],
      cells: [{ root: t.root, members: t.group_size }],
    }));
  if (definition.version === 7 && definition.value.electorate_mode !== ELECTORATE_MODES.fixed)
    return "rolling";
  return definition.value.electorate;
}

/**
 * 2.4's recount of every fixed tier of `definition` from `records`, the
 * group registry's records in order of `n` (others' are ignored), under
 * `release`. The first tier, in the definition's order, that fails gives the
 * outcome; otherwise the first that can't be decided; otherwise it passes.
 * `definition` must be well formed (2.1): its tiers' groups ascend and
 * name regions it has. Throws `TypeError` or `RangeError` for malformed
 * arguments.
 */
export function electorateCheck(
  definition: AnyElectionDefinitionRecord | ElectionDefinitionV7Record,
  records: readonly ContractEventRecord[],
  release: GroupRegistryRelease,
): ElectorateOutcome {
  const d = definition.value;
  const tiers = fixedTiers(definition);
  if (tiers === "rolling") return { status: "unverifiable", code: "rolling", at: {} };
  const version = pinnedVersion(d, RECORD_TYPES.contractEvent);
  if (!isReadable(version)) return { status: "unverifiable", code: "unsupported-version", at: {} };
  // T-71: a registry the release doesn't pin is anyone's, and a self-paid
  // group in it needs no registrar's signature, so its records prove nothing.
  if (d.l2_chain_id !== release.chainId || !equal(d.group_registry, release.registry))
    return { status: "fail", code: "group-registry", at: {} };
  const pins = {
    version,
    chainId: release.chainId,
    registry: release.registry,
    registrars: release.registrars,
    threshold: release.threshold,
  };
  let undecided: ElectorateOutcome | undefined;
  for (const [i, tier] of tiers.entries()) {
    let recount: TierElectorate;
    try {
      recount = statedTierElectorate(
        records,
        { tier: tier.tier, root_l2_block: tier.root_l2_block, groups: tier.groups },
        pins,
      );
    } catch (e) {
      if (!(e instanceof TierMembershipError)) throw e;
      const failed = failure(e, i);
      if (failed.status === "fail") return failed;
      undecided ??= failed;
      continue;
    }
    const mismatch = compare(tier, recount, i);
    if (mismatch !== undefined) return mismatch;
  }
  return undecided ?? { status: "pass" };
}

function failure(e: TierMembershipError, tier: number): ElectorateOutcome {
  const at = e.group === undefined ? { tier } : { tier, group: e.group };
  switch (e.code) {
    case "tier-unsupported":
      return { status: "unverifiable", code: "tier-unsupported", at };
    // A region with no counted member: no definition can state it (every
    // `regions` entry is at least 1), and a tier of no member is `Z_32`'s.
    case "empty":
      return { status: "fail", code: "electorate", at };
    case "board-event":
      return { status: "fail", code: "group-records", at };
    case "registrars":
    case "group-created":
    case "group-tier":
    case "group-history":
      return { status: "fail", code: e.code, at };
    // The recount's own refusals only; a voter's are never thrown here.
    case "electorate":
    case "not-a-member":
    case "moved":
      throw new Error(`statedTierElectorate threw ${e.code}`);
    default: {
      const unknown: never = e.code;
      throw new Error(`unmapped recount refusal ${String(unknown)}`);
    }
  }
}

/** The first region, cell root or cell count where the definition differs from the recount. */
function compare(
  stated: TierElectorate,
  recount: TierElectorate,
  tier: number,
): ElectorateOutcome | undefined {
  const fail = (at: ElectorateAt): ElectorateOutcome => ({
    status: "fail",
    code: "electorate",
    at,
  });
  if (stated.regions.length !== recount.regions.length) return fail({ tier });
  for (const [region, n] of recount.regions.entries())
    if (stated.regions[region] !== n) return fail({ tier, region });
  if (stated.cells.length !== recount.cells.length) return fail({ tier });
  for (const [cell, c] of recount.cells.entries()) {
    const s = stated.cells[cell] as (typeof stated.cells)[number];
    if (s.root !== c.root || s.members !== c.members) return fail({ tier, cell });
  }
  return undefined;
}
