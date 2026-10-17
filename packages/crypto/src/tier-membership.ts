// The ballot client's tier from the board (docs/spec/membership.md, Tier tree
// and Cell tree; docs/spec/contracts.md, Group registry, Verification;
// P2-21 part 3): the leaves of the voter's cell, rebuilt on the device from
// the group-registry events the election's board carries, never a path or a
// leaf index asked of a server (T-10, T-13). Each listed group is replayed
// strictly, as the verifier replays it (2.4), so a rewritten history is
// refused here too (T-71); the regions and cells are recounted under the
// first-occurrence rule and compared with the definition the client checked;
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
  type GroupLogRecord,
  groupRegistryDomainSeparator,
  isForbiddenCommitment,
} from "./group-registry.ts";
import { firstOccurrence, foldRegions } from "./regional-cells.ts";
import { groupRegistryEvents } from "./vouch-count.ts";

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
  /** A listed group's records break its replayed history (`applyGroupRecords`). */
  | "group-history"
  /** A Tier 1 or Tier 2 group: their leaves aren't the registrars' signed sequence (part 3b). */
  | "tier-unsupported"
  /** The recounted regions or cells differ from the definition's. */
  | "electorate"
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

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function u64At(b: Uint8Array, at: number): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(at, false);
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
 * The voter's cell in a fixed Tier 0 tier, from the election board's
 * contract-event records (`records`, any order, other contracts' included),
 * the tier's electorate from a definition the client checked (`tier`,
 * definition version 3 to 6), the voter's identity commitment
 * (`identityCommitment`) and the group it registered in (`group`).
 *
 * Every listed group is replayed strictly from its `GroupCreated`,
 * `MembersAdded` and `MembersRemoved` records in blocks up to the tier's
 * `root_l2_block`, under the release's registrars, as the verifier's 2.4
 * does; the regions and cells are recounted under the first-occurrence rule
 * and must equal the definition's; the voter's commitment must be a live
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
  // Each field read once, so a getter can't show one check a value and the next another.
  const { version, chainId, registry, registrars, threshold } = pins;
  if (!(registry instanceof Uint8Array) || registry.length !== 20)
    throw new RangeError("pins.registry: expected 20 bytes");
  const pinned = { version, chainId, registry: new Uint8Array(registry), registrars, threshold };
  const { tier: tierId, root_l2_block: rootBlock, groups, regions, cells } = tier;
  if (!Array.isArray(groups) || groups.length === 0)
    throw new RangeError("tier.groups: expected at least one group");
  for (let i = 1; i < groups.length; i++)
    if ((groups[i - 1]?.group_id as bigint) >= (groups[i]?.group_id as bigint))
      throw new RangeError("tier.groups: expected strictly ascending group_id");
  if (groups.some((g) => !Number.isSafeInteger(g.region) || g.region >= regions.length))
    throw new RangeError("tier.groups: a group names a region the tier doesn't have");

  const read = groupRegistryEvents(registryRecords(records, pinned), pinned.registry, version);
  if (!read.ok) throw new TierMembershipError("board-event");
  for (const p of read.pinned)
    if (
      p.threshold !== threshold ||
      p.registrars.length !== registrars.length ||
      p.registrars.some((r, i) => !equalBytes(r, registrars[i] as Uint8Array))
    )
      throw new TierMembershipError("registrars");

  const domainSeparator = groupRegistryDomainSeparator(chainId, pinned.registry);
  const raw = groups.map(({ group_id: id }) => {
    const created = read.events.filter(
      (e) => e.kind === "group-created" && e.groupId === id && e.block <= rootBlock,
    );
    const only = created[0];
    if (only === undefined || created.length !== 1 || only.kind !== "group-created")
      throw new TierMembershipError("group-created", id);
    if (only.tier !== tierId) throw new TierMembershipError("group-tier", id);
    if (only.tier !== 0) throw new TierMembershipError("tier-unsupported", id);
    const log: GroupLogRecord[] = [];
    for (const e of read.events) {
      if (e.block > rootBlock) break; // blocks never decrease along the sequence
      if (e.kind === "members-added" && e.groupId === id) {
        // The event's `firstIndex` topic must be the record's own, checked
        // before the replay, as the verifier does (`position`).
        if (e.record.length >= 16 && e.firstIndex !== u64At(e.record, 8))
          throw new TierMembershipError("group-history", id);
        log.push({ kind: "add", record: e.record });
      } else if (e.kind === "members-removed" && e.groupId === id)
        log.push({ kind: "remove", record: e.record });
    }
    const replay = applyGroupRecords(log, {
      groupId: id,
      domainSeparator,
      tier: tierId,
      registrars,
      threshold,
    });
    if (!replay.ok) throw new TierMembershipError("group-history", id);
    return replay.leaves;
  });

  const at = groups.findIndex((g) => g.group_id === group);
  if (at < 0 || !(raw[at] as readonly bigint[]).includes(commitment))
    throw new TierMembershipError("not-a-member", group);

  const counted = firstOccurrence(raw);
  const members = regions.map(() => 0n);
  for (const [i, g] of groups.entries())
    for (const leaf of counted[i] as bigint[])
      if (leaf !== 0n) members[g.region] = (members[g.region] as bigint) + 1n;
  if (members.some((n, r) => n !== regions[r])) throw new TierMembershipError("electorate");
  const fold = foldRegions(members);
  if (
    fold.length !== cells.length ||
    fold.some((rs, c) => cells[c]?.members !== rs.reduce((n, r) => n + (members[r] as bigint), 0n))
  )
    throw new TierMembershipError("electorate");

  // Earlier groups win a repeat, so the counted occurrence is the first group holding it.
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
