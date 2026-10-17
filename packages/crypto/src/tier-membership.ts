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
  groupRegistryDomainSeparator,
  isForbiddenCommitment,
  type SelfPaidLogRecord,
} from "./group-registry.ts";
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
  /** A listed group has no `GroupCreated` on the board by the tier's `root_l2_block`, or more than one. */
  | "group-created"
  /** A listed group was created for another tier. */
  | "group-tier"
  /**
   * A listed Tier 0 group's records break its replayed history
   * (`applyGroupRecords`), or a listed Tier 1 group's boarded additions hold
   * one no count takes: one before the group's creation, a forbidden
   * commitment, or one already its leaf.
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
   * The voter's commitment is counted in an earlier group of another region,
   * so the first-occurrence rule moved it out of the region it registered in
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
  // Each field read once, so a getter can't show one check a value and the next another.
  const { version, chainId, registry, registrars, threshold } = pins;
  if (!(registry instanceof Uint8Array) || registry.length !== 20)
    throw new RangeError("pins.registry: expected 20 bytes");
  const pinned = { version, chainId, registry: new Uint8Array(registry), registrars, threshold };

  const read = groupRegistryEvents(registryRecords(records, pinned), pinned.registry, version);
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

  const domainSeparator = groupRegistryDomainSeparator(chainId, pinned.registry);
  // Events up to the tier's block, at their positions in the registry's log order.
  const upTo: GroupRegistryEvent[] = [];
  for (const e of read.events) {
    if (e.block > rootBlock) break; // blocks never decrease along the sequence
    upTo.push(e);
  }
  return groups.map(({ group_id: id }): ListedGroup => {
    const created = upTo.flatMap((e, at) =>
      (e.kind === "group-created" || e.kind === "self-paid-group-created") && e.groupId === id
        ? [
            {
              at,
              tier: e.kind === "group-created" ? e.tier : 0,
              selfPaid: e.kind !== "group-created",
            },
          ]
        : [],
    );
    const only = created[0];
    if (only === undefined || created.length !== 1)
      throw new TierMembershipError("group-created", id);
    if (only.tier !== tierId) throw new TierMembershipError("group-tier", id);
    if (only.tier === 1) return { leaves: tier1GroupLeaves(upTo, only.at, id, rootBlock) };
    if (only.tier !== 0) throw new TierMembershipError("tier-unsupported", id);
    const naming = upTo.flatMap((e, at) =>
      (e.kind === "members-added" ||
        e.kind === "members-removed" ||
        e.kind === "self-paid-addition") &&
      e.groupId === id
        ? [{ at, e }]
        : [],
    );
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
