// The ballot client's tier from the board (docs/spec/membership.md, Tier tree
// and Cell tree; docs/spec/contracts.md, Group registry, Verification;
// P2-21 part 3): the leaves of the voter's cell, rebuilt on the device from
// the group-registry events the election's board carries, never a path or a
// leaf index asked of a server (T-10, T-13). Each listed Tier 0 group, signed
// or self-paid, is replayed strictly, as the verifier replays it (2.4), so a
// rewritten history is refused here too (T-71). A Tier 1 group's leaves are its boarded
// additions, which the board carries exactly as counted (verifier 4.4, Tier 1
// boarding): whether each counts rests on the archive, which the client
// doesn't read, so the definition's root, checked over these leaves, is what
// binds them (T-06, T-53). The regions and cells are recounted under the
// first-occurrence rule (signed groups first, then self-paid additions in
// chain order) and compared with the definition the client checked;
// and the voter's own commitment must be counted in the region it registered
// in, or the client alarms instead of voting in a cell it didn't choose (G-2,
// T-06, T-16; 0019-regional-cells, Consequences). The cell's root is checked
// by `membershipProverInput`, over the leaves returned here.

import {
  type ContractEventRecord,
  type ContractEventVersion,
  encodeContractEvent,
} from "./contract-event.ts";
import type { TierElectorate } from "./election-definition.ts";
import {
  applyGroupRecords,
  applySelfPaidRecords,
  type GroupLogRecord,
  GroupRecordReplay,
  groupRegistryDomainSeparator,
  isForbiddenCommitment,
  type SelfPaidLogRecord,
} from "./group-registry.ts";
import type { RollingTierEvent } from "./rolling-tier-tree.ts";
import { deriveTierCells, firstOccurrence, foldRegions, regionCounts } from "./regional-cells.ts";
import { type GroupRegistryEvent, groupRegistryEvents } from "./vouch-count.ts";

/** What the board's group-registry events are read and replayed under. */
export interface GroupRegistryPins {
  /** The contract-event version the definition's profile pins for `0x0008`. */
  readonly version: ContractEventVersion;
  /** The definition's `l2_chain_id`. */
  readonly chainId: bigint;
  /** The definition's `group_registry`, 20 bytes. */
  readonly registry: Uint8Array;
  /** The registrars and threshold the release pins, never the ones a `RegistrarsPinned` logs. */
  readonly registrars: readonly Uint8Array[];
  readonly threshold: number;
}

/** Which check refused: each is a reason the client shows, never a retry. */
export type TierMembershipErrorCode =
  /** A group-registry record on the board fails the event check, two differ at one `n`, or blocks go backwards. */
  | "board-event"
  /** A boarded `RegistrarsPinned` names other registrars or another threshold than the release pins. */
  | "registrars"
  /**
   * A listed group has no creation (`GroupCreated` or `SelfPaidGroupCreated`)
   * on the board by the tier's `root_l2_block`, or more than one of either kind.
   */
  | "group-created"
  /** A listed group was created for another tier. */
  | "group-tier"
  /**
   * A listed Tier 0 group's records break its replayed history
   * (`applyGroupRecords` for a signed group, `applySelfPaidRecords` for a
   * self-paid one), name it before its creation or are of the other kind's
   * records, or a listed Tier 1 group's boarded additions hold one no count
   * takes: one before the group's creation, a forbidden commitment, or one
   * already its leaf.
   */
  | "group-history"
  /** A Tier 2 group: the registry has no Tier 2 addition path yet (P3-4). */
  | "tier-unsupported"
  /** The recounted regions or cells differ from the definition's. */
  | "electorate"
  /**
   * A region of the tier a creator states has no counted member at
   * `root_l2_block`, so no definition can state it (every `regions` entry is
   * at least 1, docs/spec/election-definition.md, Well-formedness).
   */
  | "empty"
  /** The voter's commitment isn't a live leaf of the group it registered in by `root_l2_block`. */
  | "not-a-member"
  /**
   * The voter's commitment is counted in a group of another region (a signed
   * group, or a self-paid copy added earlier), so the first-occurrence rule
   * moved it out of the region it registered in
   * (docs/spec/membership.md, Cell tree). An alarm, never a vote in that cell.
   */
  | "moved";

export class TierMembershipError extends Error {
  override readonly name = "TierMembershipError";
  constructor(
    readonly code: TierMembershipErrorCode,
    /** The group the refusal concerns, where there is one. */
    readonly group?: bigint,
  ) {
    super(group === undefined ? code : `${code} (group ${group})`);
  }
}

/** The voter's cell, ready for `membershipProverInput`. */
export interface TierMembership {
  /** The cell's position in the tier's `cells`. */
  readonly cell: number;
  /** The cell's root as the definition states it: the root the proof is made against. */
  readonly root: bigint;
  /**
   * The cell tree's leaves in order: its groups' leaves after the
   * first-occurrence rule, concatenated in ascending `group_id`. Iterable
   * again and again, never copied into one list.
   */
  readonly leaves: Iterable<bigint>;
}

const MAX_U64 = (1n << 64n) - 1n;

/** Most groups and regions one tier lists (docs/spec/election-definition.md, Layout (version 3)). */
const MAX_TIER_GROUPS = 1024;

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function u64At(b: Uint8Array, at: number): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(at, false);
}

function fieldAt(b: Uint8Array, at: number): bigint {
  let v = 0n;
  for (const x of b.subarray(at, at + 32)) v = (v << 8n) | BigInt(x);
  return v;
}

/**
 * A listed Tier 1 group's leaves: its `Tier1MemberAdded` records in blocks up
 * to `rootBlock`, each one leaf, in log order (docs/spec/vouching.md, Counted
 * additions). The event check has already decoded each record strictly, so
 * `group_id` and `C_V` are read at their offsets. Whether an addition counts
 * needs the registry's whole Tier 1 and Tier 2 history from the archive, so
 * no vouch is checked here; the board must carry exactly the counted ones
 * (verifier 4.4, Tier 1 boarding), and a board that doesn't fails the
 * definition's root or counts. One a count never takes (logged before the
 * group's `GroupCreated`, at `created` in `events`, or a forbidden or
 * repeated commitment) is refused at once. `MembersAdded` and
 * `MembersRemoved` naming the group change nothing in it.
 */
function tier1GroupLeaves(
  events: readonly GroupRegistryEvent[],
  created: number,
  id: bigint,
  rootBlock: bigint,
): bigint[] {
  const leaves: bigint[] = [];
  const seen = new Set<bigint>();
  for (const [at, e] of events.entries()) {
    if (e.block > rootBlock) break; // blocks never decrease along the sequence
    if (e.kind !== "tier1-addition" || u64At(e.record, 0) !== id) continue;
    const commitment = fieldAt(e.record, 8);
    if (at < created || isForbiddenCommitment(commitment) || seen.has(commitment))
      throw new TierMembershipError("group-history", id);
    seen.add(commitment);
    leaves.push(commitment);
  }
  return leaves;
}

/**
 * The registry's records among the board's, in log order (`n`): the board
 * carries a subset of a shared sequence in an order no spec fixes yet
 * (verifier 4.4, Residuals), so it is sorted here; a record boarded twice is
 * read once, and two different records at one `n` refuse.
 */
function registryRecords(
  records: readonly ContractEventRecord[],
  pins: GroupRegistryPins,
): ContractEventRecord[] {
  const byN = new Map<bigint, { record: ContractEventRecord; bytes: Uint8Array }>();
  for (const [at, record] of records.slice().entries()) {
    if (record === null || typeof record !== "object")
      throw new TypeError(`records[${at}]: expected an object`);
    if (!(record.contract instanceof Uint8Array) || !equalBytes(record.contract, pins.registry))
      continue;
    let bytes: Uint8Array;
    try {
      bytes = encodeContractEvent(record, pins.version);
    } catch {
      throw new TierMembershipError("board-event");
    }
    const seen = byN.get(record.n);
    if (seen === undefined) byN.set(record.n, { record, bytes });
    else if (!equalBytes(seen.bytes, bytes)) throw new TierMembershipError("board-event");
  }
  const sorted = [...byN.values()]
    .map((r) => r.record)
    .sort((a, b) => (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
  // The accumulator binds blocks that never decrease along `n`; a board that
  // shows otherwise is refused, not passed on as the caller's mistake.
  for (let i = 1; i < sorted.length; i++)
    if (
      (sorted[i] as ContractEventRecord).l2_block < (sorted[i - 1] as ContractEventRecord).l2_block
    )
      throw new TierMembershipError("board-event");
  return sorted;
}

/**
 * A tier's `groups` as both directions read them: at least one, in strictly
 * ascending `group_id`, each naming one of `regionCount` regions.
 */
function checkGroups(groups: TierElectorate["groups"], regionCount: number): void {
  if (!Array.isArray(groups) || groups.length === 0)
    throw new RangeError("tier.groups: expected at least one group");
  for (let i = 1; i < groups.length; i++)
    if ((groups[i - 1]?.group_id as bigint) >= (groups[i]?.group_id as bigint))
      throw new RangeError("tier.groups: expected strictly ascending group_id");
  if (
    groups.some((g) => !Number.isSafeInteger(g.region) || g.region < 0 || g.region >= regionCount)
  )
    throw new RangeError("tier.groups: a group names a region the tier doesn't have");
}

/** A listed group's leaves before the first-occurrence rule, with a self-paid group's chain positions. */
interface ListedGroup {
  readonly leaves: readonly bigint[];
  /** Each leaf's position in the registry's log order, for a self-paid group only (`firstOccurrence`). */
  readonly chainOrder?: readonly bigint[];
}

/** The registry's events in log order, each with its record's L2 timestamp, under the pins read once. */
interface RegistryRead {
  readonly events: readonly GroupRegistryEvent[];
  /** `timestamps[i]` is the `l2_timestamp` of the record `events[i]` was read from. */
  readonly timestamps: readonly bigint[];
  readonly domainSeparator: Uint8Array;
  readonly registrars: readonly Uint8Array[];
  readonly threshold: number;
}

/**
 * The registry's records among `records`, read through the event check under
 * `pins`, with every boarded `RegistrarsPinned` compared with the release's.
 * Throws `TierMembershipError` (`board-event`, `registrars`).
 */
function readRegistry(
  records: readonly ContractEventRecord[],
  pins: GroupRegistryPins,
): RegistryRead {
  // Each field read once, so a getter can't show one check a value and the next another.
  const { version, chainId, registry, registrars, threshold } = pins;
  if (!(registry instanceof Uint8Array) || registry.length !== 20)
    throw new RangeError("pins.registry: expected 20 bytes");
  const pinned = { version, chainId, registry: new Uint8Array(registry), registrars, threshold };

  const sorted = registryRecords(records, pinned);
  const read = groupRegistryEvents(sorted, pinned.registry, version);
  if (!read.ok) throw new TierMembershipError("board-event");
  // The board need not carry `RegistrarsPinned` (verifier 4.4 doesn't require
  // it): every record is replayed under the release's registrars whatever it
  // says, so one is only compared, never relied on.
  for (const p of read.pinned)
    if (
      p.threshold !== threshold ||
      p.registrars.length !== registrars.length ||
      p.registrars.some((r, i) => !equalBytes(r, registrars[i] as Uint8Array))
    )
      throw new TierMembershipError("registrars");
  // Every record but a `RegistrarsPinned` is one event, in the same order.
  const pinnedAt = new Set(read.pinned.map((p) => p.at));
  const timestamps = sorted.flatMap((r, i) => (pinnedAt.has(i) ? [] : [r.l2_timestamp]));
  return {
    events: read.events,
    timestamps,
    domainSeparator: groupRegistryDomainSeparator(chainId, pinned.registry),
    registrars,
    threshold,
  };
}

/**
 * Each of `groups`' leaves at `rootBlock`, in the order listed, before the
 * first-occurrence rule: a signed Tier 0 group replayed strictly from its
 * records under the release's registrars, a self-paid group replayed
 * strictly from its `SelfPaidMemberAdded` records (`applySelfPaidRecords`),
 * with each leaf's position in log order for the ranking, and a Tier 1
 * group's boarded additions (`tier1GroupLeaves`). A group's kind is the
 * event that created it, exactly one of either kind by `rootBlock`; a record
 * naming the group before that creation, or one of the other kind (a
 * `MembersAdded` or `MembersRemoved` naming a self-paid group, a
 * `SelfPaidMemberAdded` naming a signed Tier 0 group), is a history the
 * registry can't log and fails the group (docs/spec/contracts.md, Group
 * registry, Verification; T-71). Throws `TierMembershipError`.
 */
function listedGroupLeaves(
  records: readonly ContractEventRecord[],
  tierId: number,
  rootBlock: bigint,
  groups: TierElectorate["groups"],
  pins: GroupRegistryPins,
): ListedGroup[] {
  const read = readRegistry(records, pins);
  const { domainSeparator, registrars, threshold } = read;
  // Events up to the tier's block, at their positions in the registry's log
  // order, and each listed group's creations and records, bucketed in one
  // pass: a paid flood of self-paid events is read once, not once per group (T-52).
  const upTo: GroupRegistryEvent[] = [];
  const listed = new Map(
    groups.map(({ group_id: id }) => [
      id,
      {
        created: [] as { at: number; tier: number; selfPaid: boolean }[],
        naming: [] as { at: number; e: GroupRegistryEvent }[],
      },
    ]),
  );
  for (const e of read.events) {
    if (e.block > rootBlock) break; // blocks never decrease along the sequence
    const at = upTo.push(e) - 1;
    if (e.kind === "tier1-addition") continue; // a Tier 1 group's leaves are read by tier1GroupLeaves
    const bucket = listed.get(e.groupId);
    if (bucket === undefined) continue;
    if (e.kind === "group-created" || e.kind === "self-paid-group-created")
      bucket.created.push({
        at,
        tier: e.kind === "group-created" ? e.tier : 0,
        selfPaid: e.kind !== "group-created",
      });
    else bucket.naming.push({ at, e });
  }
  return groups.map(({ group_id: id }): ListedGroup => {
    const { created, naming } = listed.get(id) as NonNullable<ReturnType<typeof listed.get>>;
    const only = created[0];
    if (only === undefined || created.length !== 1)
      throw new TierMembershipError("group-created", id);
    if (only.tier !== tierId) throw new TierMembershipError("group-tier", id);
    if (only.tier === 1) return { leaves: tier1GroupLeaves(upTo, only.at, id, rootBlock) };
    if (only.tier !== 0) throw new TierMembershipError("tier-unsupported", id);
    if (naming.some((r) => r.at < only.at)) throw new TierMembershipError("group-history", id);
    if (only.selfPaid) {
      const log: SelfPaidLogRecord[] = [];
      const chainOrder: bigint[] = [];
      for (const { at, e } of naming) {
        if (e.kind !== "self-paid-addition") throw new TierMembershipError("group-history", id);
        log.push({ index: e.index, record: e.record });
        chainOrder.push(BigInt(at));
      }
      const replay = applySelfPaidRecords(log, { groupId: id });
      if (!replay.ok) throw new TierMembershipError("group-history", id);
      return { leaves: replay.leaves, chainOrder };
    }
    const log: GroupLogRecord[] = [];
    for (const { e } of naming) {
      if (e.kind === "members-added") {
        // The event's `firstIndex` topic must be the record's own, checked
        // before the replay, as the verifier does (`position`).
        if (e.record.length >= 16 && e.firstIndex !== u64At(e.record, 8))
          throw new TierMembershipError("group-history", id);
        log.push({ kind: "add", record: e.record });
      } else if (e.kind === "members-removed") log.push({ kind: "remove", record: e.record });
      else throw new TierMembershipError("group-history", id);
    }
    const replay = applyGroupRecords(log, {
      groupId: id,
      domainSeparator,
      tier: tierId,
      registrars,
      threshold,
    });
    if (!replay.ok) throw new TierMembershipError("group-history", id);
    return { leaves: replay.leaves };
  });
}

/**
 * The voter's cell in a fixed Tier 0 or Tier 1 tier, from the election board's
 * contract-event records (`records`, any order, other contracts' included),
 * the tier's electorate from a definition the client checked (`tier`,
 * definition version 3 to 6), the voter's identity commitment
 * (`identityCommitment`) and the group it registered in (`group`).
 *
 * Every listed Tier 0 group is replayed strictly from its records in blocks
 * up to the tier's `root_l2_block`, as the verifier's 2.4 does: a signed
 * group's `MembersAdded` and `MembersRemoved` under the release's
 * registrars, a self-paid group's `SelfPaidMemberAdded` against its logged
 * indices; a listed Tier 1 group's leaves are its boarded `Tier1MemberAdded`
 * records in those blocks, with no vouch checked; the regions and cells are
 * recounted under the first-occurrence rule and must equal the definition's; the voter's commitment must be a live
 * leaf of `group` and be counted in `group`'s region. The cell's root isn't
 * recomputed here: `membershipProverInput` checks it over the returned
 * leaves in the same pass that builds the path. Throws
 * `TierMembershipError`; malformed arguments throw `TypeError` or
 * `RangeError`.
 */
export function tierMembership(
  records: readonly ContractEventRecord[],
  tier: TierElectorate,
  commitment: bigint,
  group: bigint,
  pins: GroupRegistryPins,
): TierMembership {
  if (!Array.isArray(records)) throw new TypeError("records: expected an array");
  if (tier === null || typeof tier !== "object") throw new TypeError("tier: expected an object");
  if (pins === null || typeof pins !== "object") throw new TypeError("pins: expected an object");
  if (typeof commitment !== "bigint" || isForbiddenCommitment(commitment))
    throw new RangeError("commitment: expected one that isn't forbidden");
  if (typeof group !== "bigint" || group < 0n || group > MAX_U64)
    throw new RangeError("group: expected a u64");
  const { tier: tierId, root_l2_block: rootBlock, groups, regions, cells } = tier;
  checkGroups(groups, regions.length);
  const raw = listedGroupLeaves(records, tierId, rootBlock, groups, pins);

  const at = groups.findIndex((g) => g.group_id === group);
  if (at < 0 || !(raw[at] as ListedGroup).leaves.includes(commitment))
    throw new TierMembershipError("not-a-member", group);

  const counted = firstOccurrence(
    raw.map((g) => g.leaves),
    raw.map((g) => g.chainOrder),
  );
  const members = regionCounts({ groups, regions }, counted);
  if (members.some((n, r) => n !== regions[r])) throw new TierMembershipError("electorate");
  const fold = foldRegions(members);
  if (
    fold.length !== cells.length ||
    fold.some((rs, c) => cells[c]?.members !== rs.reduce((n, r) => n + (members[r] as bigint), 0n))
  )
    throw new TierMembershipError("electorate");

  // One occurrence of the commitment survives the ranking: the group holding it is its home.
  const home = counted.findIndex((leaves) => leaves.includes(commitment));
  const region = (groups[home] as (typeof groups)[number]).region;
  if (region !== (groups[at] as (typeof groups)[number]).region)
    throw new TierMembershipError("moved", groups[home]?.group_id);
  const cell = fold.findIndex((rs) => rs.includes(region));
  const inCell = new Set(fold[cell]);
  const cellLeaves = groups.flatMap((g, i) =>
    inCell.has(g.region) ? [counted[i] as bigint[]] : [],
  );
  return Object.freeze({
    cell,
    root: (cells[cell] as (typeof cells)[number]).root,
    leaves: Object.freeze({
      *[Symbol.iterator]() {
        for (const leaves of cellLeaves) yield* leaves;
      },
    }),
  });
}

/** A fixed tier as its creator chooses it: which groups, in which regions, read at which block. */
export interface TierChoice {
  readonly tier: number;
  readonly root_l2_block: bigint;
  /**
   * The tier's groups in strictly ascending `group_id`, each naming its
   * region; the regions are numbered from 0 and every one is named.
   */
  readonly groups: TierElectorate["groups"];
}

/**
 * The electorate a creator states for a fixed Tier 0 tier
 * (docs/spec/election-definition.md, Layout (version 3), Regional cells;
 * P2-22 part 3b-2), from the group registry's own event sequence up to the
 * tier's `root_l2_block` (`records`: the registry's records in order of
 * `n`, as its event accumulator authenticates them; other contracts'
 * records are ignored). Each listed group is replayed strictly, exactly as
 * `tierMembership` and the verifier's 2.4 replay it; the regions are counted
 * and the cells folded and rooted by `deriveTierCells`, the code the ballot
 * client's recount and `tierElectorateMismatch` share. So a definition
 * stating what this returns passes 2.4's recount over the same history, and
 * the creator never states a count or root of its own (T-13, T-16, T-34).
 *
 * Only Tier 0: a Tier 1 group's leaves are the additions the deployment's
 * count takes (docs/spec/vouching.md, Counting across the deployment), which
 * this doesn't decide, so a Tier 1 or Tier 2 choice is refused
 * (`tier-unsupported`) rather than stated from additions that may not count.
 * Throws `TierMembershipError`: `empty` when a region has no counted member,
 * and the replay's codes for a history that isn't the release's; malformed
 * arguments throw `TypeError` or `RangeError`.
 */
export function statedTierElectorate(
  records: readonly ContractEventRecord[],
  choice: TierChoice,
  pins: GroupRegistryPins,
): TierElectorate {
  if (!Array.isArray(records)) throw new TypeError("records: expected an array");
  if (choice === null || typeof choice !== "object")
    throw new TypeError("choice: expected an object");
  if (pins === null || typeof pins !== "object") throw new TypeError("pins: expected an object");
  // Each field read once, so a getter can't show one check a value and the next another.
  const { tier: tierId, root_l2_block: rootBlock } = choice;
  const groups = Array.isArray(choice.groups)
    ? choice.groups.map((g) => ({ group_id: g.group_id, region: g.region }))
    : choice.groups;
  if (typeof rootBlock !== "bigint" || rootBlock < 0n || rootBlock > MAX_U64)
    throw new RangeError("choice.root_l2_block: expected a u64");
  if (!Array.isArray(groups)) throw new RangeError("tier.groups: expected at least one group");
  // Within what a definition can state: at most MAX_TIER_GROUPS groups and
  // regions, so neither the count nor the regions' list can grow unbounded.
  if (groups.length > MAX_TIER_GROUPS)
    throw new RangeError(`tier.groups: expected at most ${MAX_TIER_GROUPS} groups`);
  if (groups.some((g) => !Number.isSafeInteger(g.region) || g.region >= MAX_TIER_GROUPS))
    throw new RangeError(`tier.groups: expected each region below ${MAX_TIER_GROUPS}`);
  // Regions are numbered from 0; one no group names is counted 0 and refused as `empty`.
  const regionCount = groups.reduce((n, g) => Math.max(n, Number(g.region) + 1), 0);
  checkGroups(groups, regionCount);
  if (tierId !== 0) throw new TierMembershipError("tier-unsupported");
  const raw = listedGroupLeaves(records, tierId, rootBlock, groups, pins);
  const derived = deriveTierCells(
    { groups, regions: Array.from({ length: regionCount }, () => 0n) },
    new Map(groups.map((g, i) => [g.group_id, (raw[i] as ListedGroup).leaves])),
    new Map(
      groups.flatMap((g, i) => {
        const order = (raw[i] as ListedGroup).chainOrder;
        return order === undefined ? [] : [[g.group_id, order] as const];
      }),
    ),
  );
  if (derived.regions.some((n) => n === 0n)) throw new TierMembershipError("empty");
  return {
    tier: tierId,
    root_l2_block: rootBlock,
    groups,
    regions: [...derived.regions],
    cells: derived.cells.map((c) => ({ root: c.root, members: c.members })),
  };
}

/** A rolling tier as its definition lists it: which groups, and the block its opening state is read at. */
export interface RollingTierChoice {
  readonly tier: number;
  readonly root_l2_block: bigint;
  /** The tier's groups, in strictly ascending `group_id`. */
  readonly groups: readonly bigint[];
}

/**
 * A rolling Tier 0 tier's events ([[membership]], Rolling tier tree and
 * Rolling checks; verifier 2.4; P2-17 part 4c), as `rollingTierSteps` and
 * `rollingBallotElection` read them, from the group registry's own records
 * (`records`, any order, other contracts' ignored): every listed group's
 * `MembersAdded`, `MembersRemoved` and `SelfPaidMemberAdded` in L2 blocks
 * whose timestamp is at or before `closesAt`, in log order, each after its
 * group's strict replay, with its block and timestamp. The replay is the
 * fixed recount's (`statedTierElectorate`) under the same pins, taken
 * through close rather than to `root_l2_block`, since every accepted step
 * and every reported count reads events up to then (and never short of
 * `root_l2_block`); a record after both is never replayed, so one that
 * breaks a group's history there fails nothing. Each listed group must
 * be created, once, by `root_l2_block`, for Tier 0. Records whose timestamps
 * decrease along `n`, or differ within one block, aren't the registry's (the
 * event accumulator binds both), and are refused (T-71, T-08, T-13). There
 * is no first-occurrence rule: a repeat keeps a leaf per occurrence.
 *
 * Only Tier 0, as `statedTierElectorate`: a Tier 1 group's leaves are the
 * additions the deployment's count takes, which this doesn't decide, and
 * Tier 2 has no addition path yet (`tier-unsupported`). Throws
 * `TierMembershipError`; malformed arguments throw `TypeError` or
 * `RangeError`.
 */
export function rollingTierEvents(
  records: readonly ContractEventRecord[],
  choice: RollingTierChoice,
  closesAt: bigint,
  pins: GroupRegistryPins,
): RollingTierEvent[] {
  if (!Array.isArray(records)) throw new TypeError("records: expected an array");
  if (choice === null || typeof choice !== "object")
    throw new TypeError("choice: expected an object");
  if (pins === null || typeof pins !== "object") throw new TypeError("pins: expected an object");
  // Each field read once, so a getter can't show one check a value and the next another.
  const { tier: tierId, root_l2_block: rootBlock } = choice;
  const groups = Array.isArray(choice.groups) ? choice.groups.slice() : choice.groups;
  if (typeof rootBlock !== "bigint" || rootBlock < 0n || rootBlock > MAX_U64)
    throw new RangeError("choice.root_l2_block: expected a u64");
  if (typeof closesAt !== "bigint" || closesAt < 0n || closesAt > MAX_U64)
    throw new RangeError("closesAt: expected a u64");
  if (!Array.isArray(groups) || groups.length === 0 || groups.length > MAX_TIER_GROUPS)
    throw new RangeError(`choice.groups: expected 1 to ${MAX_TIER_GROUPS} groups`);
  for (const [i, g] of groups.entries())
    if (typeof g !== "bigint" || g < 0n || g > MAX_U64 || (i > 0 && (groups[i - 1] as bigint) >= g))
      throw new RangeError("choice.groups: expected strictly ascending u64 group ids");
  if (tierId !== 0) throw new TierMembershipError("tier-unsupported");

  const read = readRegistry(records, pins);
  const { events, timestamps } = read;
  // T-71: the accumulator binds each record's block and timestamp, and an L2
  // timestamp never decreases along the chain, so a board showing otherwise
  // isn't the registry's, and the scans' steps would be read out of order.
  for (let i = 1; i < events.length; i++) {
    const sameBlock = events[i - 1]?.block === events[i]?.block;
    const [before, now] = [timestamps[i - 1] as bigint, timestamps[i] as bigint];
    if (now < before || (sameBlock && now !== before)) throw new TierMembershipError("board-event");
  }
  // Each listed group's creations and records through close, bucketed in
  // one pass (T-52).
  const listed = new Map(
    groups.map((id) => [
      id,
      {
        created: [] as { at: number; block: bigint; tier: number; selfPaid: boolean }[],
        naming: [] as { at: number; e: GroupRegistryEvent }[],
      },
    ]),
  );
  for (const [at, e] of events.entries()) {
    // Through close, and never short of root_l2_block, so the opening state is
    // the tree up to that block whatever the two bounds' order. Both blocks
    // and timestamps never decrease (checked above), so this is a prefix.
    if ((timestamps[at] as bigint) > closesAt && e.block > rootBlock) break;
    if (e.kind === "tier1-addition") continue;
    const bucket = listed.get(e.groupId);
    if (bucket === undefined) continue;
    if (e.kind === "group-created" || e.kind === "self-paid-group-created")
      bucket.created.push({
        at,
        block: e.block,
        tier: e.kind === "group-created" ? e.tier : 0,
        selfPaid: e.kind !== "group-created",
      });
    else bucket.naming.push({ at, e });
  }

  // What each listed group's records did, at their positions in log order.
  const applied: {
    at: number;
    groupId: bigint;
    change:
      | { readonly kind: "add"; readonly commitments: readonly bigint[] }
      | { readonly kind: "remove"; readonly indices: readonly bigint[] };
  }[] = [];
  for (const id of groups) {
    const { created, naming } = listed.get(id) as NonNullable<ReturnType<typeof listed.get>>;
    const only = created[0];
    // The opening state is read at `root_l2_block`, so a group created only
    // later can't be in it, as the fixed recount refuses one.
    if (only === undefined || created.length !== 1 || only.block > rootBlock)
      throw new TierMembershipError("group-created", id);
    if (only.tier !== tierId) throw new TierMembershipError("group-tier", id);
    if (naming.some((r) => r.at < only.at)) throw new TierMembershipError("group-history", id);
    if (only.selfPaid) {
      const log: SelfPaidLogRecord[] = [];
      for (const { e } of naming) {
        if (e.kind !== "self-paid-addition") throw new TierMembershipError("group-history", id);
        log.push({ index: e.index, record: e.record });
      }
      const replay = applySelfPaidRecords(log, { groupId: id });
      if (!replay.ok) throw new TierMembershipError("group-history", id);
      // Each record appended exactly its own leaf, at its logged index.
      for (const [k, { at }] of naming.entries())
        applied.push({
          at,
          groupId: id,
          change: { kind: "add", commitments: [replay.leaves[k] as bigint] },
        });
      continue;
    }
    const replay = new GroupRecordReplay({
      groupId: id,
      domainSeparator: read.domainSeparator,
      tier: tierId,
      registrars: read.registrars,
      threshold: read.threshold,
    });
    for (const { at, e } of naming) {
      let r: ReturnType<GroupRecordReplay["apply"]>;
      if (e.kind === "members-added") {
        // The event's `firstIndex` topic must be the record's own, as the fixed recount checks it.
        if (e.record.length >= 16 && e.firstIndex !== u64At(e.record, 8))
          throw new TierMembershipError("group-history", id);
        r = replay.apply({ kind: "add", record: e.record });
      } else if (e.kind === "members-removed")
        r = replay.apply({ kind: "remove", record: e.record });
      else throw new TierMembershipError("group-history", id);
      if (!r.ok) throw new TierMembershipError("group-history", id);
      applied.push({
        at,
        groupId: id,
        change:
          r.kind === "add"
            ? { kind: "add", commitments: r.commitments }
            : { kind: "remove", indices: r.indices },
      });
    }
  }
  return applied
    .sort((a, b) => a.at - b.at)
    .map(({ at, groupId, change }) => ({
      blockNumber: (events[at] as GroupRegistryEvent).block,
      timestamp: timestamps[at] as bigint,
      groupId,
      ...change,
    }));
}

/** Where a Tier 0 registrant's commitment stands (docs/spec/registration.md, Outcome). */
export type Tier0Registration =
  /** Counted in a published group of the region it asked for, signed or self-paid. */
  | { readonly kind: "registered"; readonly group: bigint }
  /**
   * Counted in a group of another region: a copy someone else added first
   * moved it there. An alarm: the client registers again only under a new
   * secret, since the commitment's place can't be taken back (T-16).
   */
  | { readonly kind: "moved"; readonly group: bigint }
  /** In no group, or only as a removed leaf: the client may send its request again. */
  | { readonly kind: "not-yet" };

/** The deployment's published Tier 0 groups, read at one block (docs/spec/registration.md, Groups). */
export interface Tier0Groups {
  /** The L2 block the registry is read at: finalized for the outcome, the latest for the direct path's check. */
  readonly block: bigint;
  /**
   * Every published Tier 0 group, signed and self-paid, in strictly
   * ascending `group_id`, each with its region code (a u32), from the
   * signed release, never a list an API or an indexer names.
   */
  readonly groups: readonly { readonly group_id: bigint; readonly region: number }[];
}

const MAX_U32 = 0xffff_ffff;

/**
 * Where `commitment` stands among the published Tier 0 groups at
 * `groups.block`, for a registrant who asked for region `region`, from the
 * group registry's own records (`records`, as `statedTierElectorate` takes
 * them; other contracts' are ignored). Each group is replayed strictly, as
 * `tierMembership` and the verifier's 2.4 replay it, under the release's
 * registrars, and the first-occurrence rule (signed groups first, then
 * self-paid additions in chain order) picks the one occurrence that counts.
 * The client reads the whole registry, never asking a server about its own
 * commitment (T-11, T-13). Throws `TierMembershipError` for a history the
 * release's registry can't log; malformed arguments throw `TypeError` or
 * `RangeError`, as does a region no published group serves.
 */
export function tier0Registration(
  records: readonly ContractEventRecord[],
  groups: Tier0Groups,
  commitment: bigint,
  region: number,
  pins: GroupRegistryPins,
): Tier0Registration {
  if (!Array.isArray(records)) throw new TypeError("records: expected an array");
  if (groups === null || typeof groups !== "object")
    throw new TypeError("groups: expected an object");
  if (pins === null || typeof pins !== "object") throw new TypeError("pins: expected an object");
  if (typeof commitment !== "bigint" || isForbiddenCommitment(commitment))
    throw new RangeError("commitment: expected one that isn't forbidden");
  // Each field read once, so a getter can't show one check a value and the next another.
  const { block } = groups;
  const listed = Array.isArray(groups.groups)
    ? groups.groups.map((g) => ({ group_id: g.group_id, region: g.region }))
    : groups.groups;
  if (typeof block !== "bigint" || block < 0n || block > MAX_U64)
    throw new RangeError("groups.block: expected a u64");
  if (!Array.isArray(listed) || listed.length === 0 || listed.length > MAX_TIER_GROUPS)
    throw new RangeError(`groups.groups: expected 1 to ${MAX_TIER_GROUPS} groups`);
  for (const [i, g] of listed.entries()) {
    if (typeof g.group_id !== "bigint" || g.group_id < 0n || g.group_id > MAX_U64)
      throw new RangeError("groups.groups: expected u64 group_ids");
    if (i > 0 && (listed[i - 1]?.group_id as bigint) >= g.group_id)
      throw new RangeError("groups.groups: expected strictly ascending group_id");
    if (!Number.isSafeInteger(g.region) || g.region < 0 || g.region > MAX_U32)
      throw new RangeError("groups.groups: expected u32 region codes");
  }
  if (!listed.some((g) => g.region === region))
    throw new RangeError("region: expected one a published group serves");

  const raw = listedGroupLeaves(records, 0, block, listed, pins);
  const counted = firstOccurrence(
    raw.map((g) => g.leaves),
    raw.map((g) => g.chainOrder),
  );
  const home = counted.findIndex((leaves) => leaves.includes(commitment));
  const found = listed[home];
  if (found === undefined) return { kind: "not-yet" };
  return found.region === region
    ? { kind: "registered", group: found.group_id }
    : { kind: "moved", group: found.group_id };
}
