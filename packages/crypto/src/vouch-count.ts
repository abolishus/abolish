// Tier 1 counting across the deployment (docs/spec/vouching.md, Counting
// across the deployment; ADR 0014): which Tier 1 additions of a group
// registry count, and so which leaves each Tier 1 group's tier tree holds.
// Slots are deployment-wide, so every Tier 1 addition of the registry is
// decided in one replay, in log order, with each vouch's Tier 2 root rebuilt
// here from the registry's own Tier 2 records (T-06, T-02, T-13, T-22, T-52,
// T-71). The proofs are checked in batches first, then the order is walked.

import {
  applyGroupRecords,
  decodeGroupAddition,
  decodeGroupRemoval,
  type GroupHistoryReason,
  type GroupLogRecord,
  groupRegistryDomainSeparator,
} from "./group-registry.ts";
import { type MembershipProofCheck, verifyDecodedMembershipProofs } from "./membership-proof.ts";
import { PARAMETERS } from "./parameters.ts";
import { TierTreeBuilder } from "./tier-tree.ts";
import {
  precheckTier1Addition,
  proofFailure,
  type Tier1Addition,
  type Tier1AdditionResult,
  type VouchContext,
} from "./vouch.ts";

/** L2 blocks between the root grid's blocks: a vouch's `root_block` is a multiple of it. */
export const VOUCH_ROOT_INTERVAL = BigInt(PARAMETERS.VOUCH_ROOT_INTERVAL);
/** `W`: the most L2 blocks an addition's own block may be after a vouch's `root_block`. */
export const VOUCH_ROOT_WINDOW = BigInt(PARAMETERS.VOUCH_ROOT_WINDOW);

const MAX_U64 = (1n << 64n) - 1n;

/**
 * One event of the group registry, in the registry's log order (L2 block,
 * then position in the block), as the event accumulator binds them
 * ([[contracts]], Group registry, Verification; verifier 4.4). The caller
 * passes every event of the registry up to the block it needs, Tier 0
 * groups' included, and attributes each members record to the group its
 * event's `group_id` topic names.
 */
export type GroupRegistryEvent =
  | {
      readonly kind: "group-created";
      readonly block: bigint;
      readonly groupId: bigint;
      readonly tier: number;
    }
  | {
      readonly kind: "members-added" | "members-removed";
      readonly block: bigint;
      readonly groupId: bigint;
      readonly record: Uint8Array;
    }
  | {
      /** A Tier 1 addition record; the event that logs it is P3-3 part 3's. */
      readonly kind: "tier1-addition";
      readonly block: bigint;
      readonly record: Uint8Array;
    };

/** What a replay is judged under: the release's pins for the registry. */
export interface Tier1CountContext {
  /** The L2's chain ID and the registry's address: the vouches' binding and the EIP-712 domain. */
  readonly chainId: bigint;
  readonly registry: Uint8Array;
  /** The registrars and threshold the release pins, which sign Tier 2 groups' records. */
  readonly registrars: readonly Uint8Array[];
  readonly threshold: number;
}

/** Why a Tier 1 addition doesn't count, beyond the checks of one addition. */
export type Tier1CountError =
  | "group"
  | "root-grid"
  | "root-window"
  | "tier2-group"
  | "root-mismatch"
  | "slot-spent"
  | "member";

export type Tier1CountVerdict =
  | {
      readonly ok: true;
      readonly value: Tier1Addition;
      /** The leaf index the addition takes in its group: its earlier counted additions. */
      readonly index: number;
    }
  | Exclude<Tier1AdditionResult, { ok: true }>
  | { readonly ok: false; readonly error: "group" | "member" }
  | {
      readonly ok: false;
      readonly error: Exclude<Tier1CountError, "group" | "member">;
      readonly vouch: number;
    };

/**
 * The earliest event, in log order, that breaks a Tier 2 group's strict
 * replay: a members record its group's replay refuses (`applyGroupRecords`'
 * reasons), a members record of any group with no earlier `GroupCreated`
 * (`created`), or a second `GroupCreated` for a group (`duplicate-group`).
 * An honest registry on the release's bytecode logs none of them.
 */
export interface Tier1Break {
  /** The event's position in the events given. */
  readonly at: number;
  /** `b_R`: its L2 block. */
  readonly block: bigint;
  readonly groupId: bigint;
  readonly reason: GroupHistoryReason | "created" | "duplicate-group";
}

export interface Tier1Count {
  /**
   * The verdict of each Tier 1 addition in a block before `broken.block` (or
   * of every one, if nothing broke), in log order. Additions at or after
   * `b_R` are left undecided: every definition whose replay reaches them
   * fails `group-history`.
   */
  readonly additions: readonly {
    readonly at: number;
    readonly block: bigint;
    readonly verdict: Tier1CountVerdict;
  }[];
  readonly broken: Tier1Break | null;
  /** Each Tier 1 group's counted additions in order: the leaves of its tier tree. */
  readonly groups: ReadonlyMap<
    bigint,
    readonly { readonly commitment: bigint; readonly block: bigint }[]
  >;
}

interface Group {
  readonly at: number;
  readonly block: bigint;
  readonly tier: number;
}

interface Tier2Record extends GroupLogRecord {
  readonly at: number;
  readonly block: bigint;
}

function u64Arg(v: unknown, what: string): bigint {
  if (typeof v !== "bigint" || v < 0n || v > MAX_U64)
    throw new RangeError(`${what}: expected a bigint from 0 to 2^64 - 1`);
  return v;
}

function bytesArg(v: unknown, what: string): Uint8Array {
  if (!(v instanceof Uint8Array) || !ArrayBuffer.isView(v))
    throw new TypeError(`${what}: expected a Uint8Array`);
  return new Uint8Array(v);
}

/** The events, each field read once and checked, in non-decreasing block order. */
function readEvents(events: readonly GroupRegistryEvent[]): GroupRegistryEvent[] {
  if (!Array.isArray(events)) throw new TypeError("events: expected an array");
  let last = 0n;
  return events.slice().map((e: GroupRegistryEvent, at) => {
    if (e === null || typeof e !== "object")
      throw new TypeError(`events[${at}]: expected an object`);
    const { kind } = e;
    const block = u64Arg(e.block, `events[${at}].block`);
    // Log order is block order first: anything else is the caller's mistake,
    // not a chain's, since the accumulator binds each log's block.
    if (block < last) throw new RangeError(`events[${at}]: blocks must not decrease`);
    last = block;
    if (kind === "group-created") {
      const { groupId, tier } = e;
      if (!Number.isSafeInteger(tier) || tier < 0 || tier > 255)
        throw new RangeError(`events[${at}].tier: expected an integer from 0 to 255`);
      return { kind, block, groupId: u64Arg(groupId, `events[${at}].groupId`), tier };
    }
    if (kind === "members-added" || kind === "members-removed") {
      const { groupId, record } = e;
      return {
        kind,
        block,
        groupId: u64Arg(groupId, `events[${at}].groupId`),
        record: bytesArg(record, `events[${at}].record`),
      };
    }
    if (kind === "tier1-addition")
      return { kind, block, record: bytesArg(e.record, `events[${at}].record`) };
    throw new TypeError(`events[${at}]: unknown kind`);
  });
}

/**
 * Decides every Tier 1 addition of a group registry (docs/spec/vouching.md,
 * Counting across the deployment). `events` is every event the registry
 * logged up to the block the caller needs, in log order; no later event
 * changes an earlier addition's verdict, so one replay serves every
 * definition reaching no further.
 *
 * Each Tier 2 group is first replayed strictly, as verifier 2.4 replays it
 * (`applyGroupRecords` under the pinned registrars), and the earliest event
 * that breaks any Tier 2 history, at block `b_R`, stops the count there:
 * additions in blocks before `b_R` are decided, since no root they name can
 * depend on it, and none after (T-71). Then each Tier 1 addition, in order,
 * counts if it passes, with the first failure reported in this order (each
 * check over the vouches in record order before the next): the checks of one
 * addition but the proofs (`decode` to `duplicate-slot`); `group` (a Tier 1
 * group created earlier in the sequence); `root-grid`; `root-window`
 * (`root_block ≤ b_A ≤ root_block + W`); `tier2-group` (a Tier 2 group
 * created in a block at or before `root_block`); `root-mismatch` (the root
 * equals that group's tier-tree root over its records in blocks up to
 * `root_block`); `slot-spent` (no slot nullifier of an earlier counted
 * addition, in any Tier 1 group, compared as values, so a re-randomised copy
 * is caught; T-38); `member` (`C_V` isn't already a counted leaf of the
 * group); then `proof`. A counted addition appends `C_V` as its group's next
 * leaf and consumes its slot nullifiers for good; one that fails consumes
 * nothing, takes no index and fails nothing else (T-25, T-53).
 *
 * Each Tier 2 group a vouch names is replayed once, with its root taken at
 * every block named. Every proof is checked before the walk, in batches with
 * coefficients from the CSPRNG (`verifyDecodedMembershipProofs`), only for
 * additions that pass the checks before `slot-spent`, which need no counting
 * state; each proof's verdict is the one checking it alone gives (T-52).
 */
export function countTier1Additions(
  events: readonly GroupRegistryEvent[],
  ctx: Tier1CountContext,
): Tier1Count {
  if (ctx === null || typeof ctx !== "object") throw new TypeError("ctx: expected an object");
  // Each field read once, so a getter can't show one check one value and the next another.
  const { chainId, registry, registrars, threshold } = ctx;
  const vouchCtx: VouchContext = {
    chainId: u64Arg(chainId, "chainId"),
    registry: bytesArg(registry, "registry"),
  };
  const domainSeparator = groupRegistryDomainSeparator(vouchCtx.chainId, vouchCtx.registry);
  const list = readEvents(events);

  // Groups, by their first GroupCreated, and the earliest break among them.
  const groups = new Map<bigint, Group>();
  let broken: Tier1Break | null = null;
  const breakAt = (b: Tier1Break) => {
    if (broken === null || b.at < broken.at) broken = b;
  };
  for (const [at, e] of list.entries()) {
    if (e.kind !== "group-created") continue;
    if (groups.has(e.groupId))
      breakAt({ at, block: e.block, groupId: e.groupId, reason: "duplicate-group" });
    else groups.set(e.groupId, { at, block: e.block, tier: e.tier });
  }

  // Each Tier 2 group's records, replayed strictly over the whole sequence
  // given. A members record of a group with no earlier GroupCreated, of any
  // tier, breaks at its own block, so no later event can move a break earlier
  // (T-71).
  const tier2 = new Map<bigint, Tier2Record[]>();
  for (const [at, e] of list.entries()) {
    if (e.kind !== "members-added" && e.kind !== "members-removed") continue;
    const group = groups.get(e.groupId);
    if (group === undefined || group.at > at) {
      breakAt({ at, block: e.block, groupId: e.groupId, reason: "created" });
      continue;
    }
    if (group.tier !== 2) continue;
    const records = tier2.get(e.groupId) ?? [];
    records.push({
      at,
      block: e.block,
      kind: e.kind === "members-added" ? "add" : "remove",
      record: e.record,
    });
    tier2.set(e.groupId, records);
  }
  for (const [groupId, records] of tier2) {
    const replay = applyGroupRecords(records, {
      groupId,
      domainSeparator,
      tier: 2,
      registrars,
      threshold,
    });
    if (!replay.ok) {
      const record = records[replay.at] as Tier2Record;
      breakAt({ at: record.at, block: record.block, groupId, reason: replay.reason });
    }
  }
  const stop: bigint | null = (broken as Tier1Break | null)?.block ?? null;

  // The checks that need no counting state, for every addition before b_R:
  // first those up to `tier2-group`, collecting the Tier 2 roots they name.
  type Pre =
    | { readonly at: number; readonly block: bigint; readonly verdict: Tier1CountVerdict }
    | {
        readonly at: number;
        readonly block: bigint;
        readonly verdict: null;
        readonly value: Tier1Addition;
        readonly proofs: readonly MembershipProofCheck[];
      };
  const named = new Map<bigint, Set<bigint>>();
  const opened: Pre[] = [];
  for (const [at, e] of list.entries()) {
    if (e.kind !== "tier1-addition") continue;
    if (stop !== null && e.block >= stop) break;
    const p = upToTier2Group(at, e.block, e.record);
    if (p.verdict === null)
      for (const v of p.value.vouches) {
        const blocks = named.get(v.tier2GroupId) ?? new Set<bigint>();
        blocks.add(v.rootBlock);
        named.set(v.tier2GroupId, blocks);
      }
    opened.push(p);
  }
  function upToTier2Group(at: number, block: bigint, record: Uint8Array): Pre {
    const pre = precheckTier1Addition(record, vouchCtx);
    if (!pre.ok) return { at, block, verdict: pre.failure };
    const { groupId, vouches } = pre.value;
    const fail = (verdict: Tier1CountVerdict): Pre => ({ at, block, verdict });
    const group = groups.get(groupId);
    if (group?.tier !== 1 || group.at > at) return fail({ ok: false, error: "group" });
    for (const [i, v] of vouches.entries())
      if (v.rootBlock % VOUCH_ROOT_INTERVAL !== 0n)
        return fail({ ok: false, error: "root-grid", vouch: i });
    for (const [i, v] of vouches.entries())
      if (v.rootBlock > block || block - v.rootBlock > VOUCH_ROOT_WINDOW)
        return fail({ ok: false, error: "root-window", vouch: i });
    for (const [i, v] of vouches.entries()) {
      const t2 = groups.get(v.tier2GroupId);
      if (t2?.tier !== 2 || t2.block > v.rootBlock)
        return fail({ ok: false, error: "tier2-group", vouch: i });
    }
    return { at, block, verdict: null, value: pre.value, proofs: pre.proofs };
  }

  // Each named Tier 2 group replayed once, its root taken at every block a
  // vouch names (T-52). Every record applied is in a block before b_R, since
  // a root block is at most its addition's block, so the strict replay above
  // accepted it.
  const roots = new Map<string, bigint>();
  for (const [groupId, blocks] of named) {
    const tree = new TierTreeBuilder();
    const records = tier2.get(groupId) ?? [];
    let next = 0;
    for (const block of [...blocks].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))) {
      for (; next < records.length; next++) {
        const r = records[next] as Tier2Record;
        if (r.block > block) break;
        if (r.kind === "add") {
          const d = decodeGroupAddition(r.record);
          if (d.ok) for (const c of d.value.commitments) tree.append(c);
        } else {
          const d = decodeGroupRemoval(r.record);
          if (d.ok) for (const i of d.value.indices) tree.remove(Number(i));
        }
      }
      roots.set(`${groupId}:${block}`, tree.root());
    }
  }
  const pres = opened.map((p): Pre => {
    if (p.verdict !== null) return p;
    const mismatch = p.value.vouches.findIndex(
      (v) => v.root !== roots.get(`${v.tier2GroupId}:${v.rootBlock}`),
    );
    return mismatch < 0
      ? p
      : {
          at: p.at,
          block: p.block,
          verdict: { ok: false, error: "root-mismatch", vouch: mismatch },
        };
  });

  const verdicts = verifyDecodedMembershipProofs(
    pres.flatMap((p) => (p.verdict === null ? p.proofs : [])),
  );

  // The walk: slots and leaves, in order.
  const spent = new Set<bigint>();
  const leaves = new Map<bigint, { commitment: bigint; block: bigint }[]>();
  const members = new Map<bigint, Set<bigint>>();
  const additions: Tier1Count["additions"][number][] = [];
  let next = 0;
  for (const p of pres) {
    if (p.verdict !== null) {
      additions.push(p);
      continue;
    }
    const own = verdicts.slice(next, next + p.proofs.length);
    next += p.proofs.length;
    const { groupId, commitment, vouches } = p.value;
    const decide = (verdict: Tier1CountVerdict) =>
      additions.push({ at: p.at, block: p.block, verdict });
    const reused = vouches.findIndex((v) => spent.has(v.slotNullifier));
    if (reused >= 0) {
      decide({ ok: false, error: "slot-spent", vouch: reused });
      continue;
    }
    // No Tier 1 removal exists yet (P3-2), so every counted leaf is unremoved.
    const groupMembers = members.get(groupId) ?? new Set<bigint>();
    if (groupMembers.has(commitment)) {
      decide({ ok: false, error: "member" });
      continue;
    }
    const failure = proofFailure(own);
    if (failure !== null) {
      decide(failure);
      continue;
    }
    for (const v of vouches) spent.add(v.slotNullifier);
    groupMembers.add(commitment);
    members.set(groupId, groupMembers);
    const groupLeaves = leaves.get(groupId) ?? [];
    decide({ ok: true, value: p.value, index: groupLeaves.length });
    groupLeaves.push({ commitment, block: p.block });
    leaves.set(groupId, groupLeaves);
  }
  return { additions, broken, groups: leaves };
}

export type Tier1LeavesResult =
  | { readonly ok: true; readonly leaves: readonly bigint[] }
  | { readonly ok: false; readonly error: "group-history"; readonly broken: Tier1Break };

/**
 * A Tier 1 group's tier-tree leaves at L2 block `block`: its counted
 * additions in blocks up to `block`, in order. If the replay broke at a block
 * at or before `block`, every definition reaching it fails `group-history`,
 * naming the breaking event (docs/spec/vouching.md, A broken Tier 2 history).
 * `count` must come from events through at least `block`; whether `groupId`
 * is a Tier 1 group is the caller's check, from its `GroupCreated`.
 */
export function tier1Leaves(count: Tier1Count, groupId: bigint, block: bigint): Tier1LeavesResult {
  u64Arg(groupId, "groupId");
  u64Arg(block, "block");
  if (count.broken !== null && count.broken.block <= block)
    return { ok: false, error: "group-history", broken: count.broken };
  const leaves = (count.groups.get(groupId) ?? []).filter((l) => l.block <= block);
  return { ok: true, leaves: leaves.map((l) => l.commitment) };
}
