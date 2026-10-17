// Tier 1 counting across the deployment (docs/spec/vouching.md, Counting
// across the deployment; ADR 0014): which Tier 1 additions of a group
// registry count, and so which leaves each Tier 1 group's tier tree holds.
// Slots are deployment-wide, so every Tier 1 addition of the registry is
// decided in one replay, in log order, with each vouch's Tier 2 root rebuilt
// here from the registry's own Tier 2 records (T-06, T-02, T-13, T-22, T-52,
// T-71). The order is walked first and the proofs last, in batches, only for
// the additions the walk would count.

import {
  type ContractEventError,
  type ContractEventRecord,
  type ContractEventVersion,
  checkContractEvent,
} from "./contract-event.ts";
import {
  decodeGroupAddition,
  type GroupHistoryReason,
  GroupRecordReplay,
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
      readonly kind: "members-added";
      readonly block: bigint;
      readonly groupId: bigint;
      readonly record: Uint8Array;
      /**
       * The event's `firstIndex` topic, where the event is read from its log
       * (`groupRegistryEvents`): an addition whose own `first_index` differs
       * breaks its group's history as `position`.
       */
      readonly firstIndex?: bigint;
    }
  | {
      readonly kind: "members-removed";
      readonly block: bigint;
      readonly groupId: bigint;
      readonly record: Uint8Array;
    }
  | {
      /** A self-paid Tier 0 group, as `SelfPaidGroupCreated` logs it (contract-event versions 7 and 8). */
      readonly kind: "self-paid-group-created";
      readonly block: bigint;
      readonly groupId: bigint;
    }
  | {
      /** A self-paid addition, as `SelfPaidMemberAdded` logs it, with its `index` topic. */
      readonly kind: "self-paid-addition";
      readonly block: bigint;
      readonly groupId: bigint;
      readonly index: bigint;
      readonly record: Uint8Array;
    }
  | {
      /** A Tier 1 addition record, as the registry's `Tier1MemberAdded` logs it (contract-event versions 6 to 8). */
      readonly kind: "tier1-addition";
      readonly block: bigint;
      readonly record: Uint8Array;
    };

export type GroupRegistryEventsResult =
  | {
      readonly ok: true;
      readonly events: readonly GroupRegistryEvent[];
      /**
       * Each `RegistrarsPinned`, by position: the caller requires it to name
       * exactly the registrars and threshold its release pins, the ones
       * counting is judged under (docs/spec/contracts.md, Group registry,
       * Verification).
       */
      readonly pinned: readonly {
        readonly at: number;
        readonly threshold: number;
        readonly registrars: readonly Uint8Array[];
      }[];
    }
  | {
      readonly ok: false;
      /** The first record that fails, by its position in the records given. */
      readonly at: number;
      readonly error: ContractEventError;
    };

/**
 * Reads the group registry's archived sequence as `countTier1Additions`
 * takes it: each contract-event record, under the pinned contract-event
 * version, through the event check against the group registry
 * (docs/spec/contracts.md, Event check), then `GroupCreated`, `MembersAdded`
 * (with its `firstIndex` topic), `MembersRemoved`, `Tier1MemberAdded`,
 * `SelfPaidGroupCreated` and `SelfPaidMemberAdded` (with its `index` topic)
 * as events at the record's L2 block, and `RegistrarsPinned` returned apart,
 * for the caller to compare with its pins. The first record that fails the
 * check is reported, as 4.4 reports it: the release's registry logs none, so
 * one is a rewritten chain or other bytecode, never a submitter's (T-53,
 * T-71). `records` is the registry's own sequence in order of `n`, with L2
 * blocks never decreasing,
 * as the event accumulator's replay authenticates it (P4-3), so a record out
 * of that order throws, as the caller's mistake; whether it is the registry's
 * whole sequence is that replay's, not this function's.
 */
export function groupRegistryEvents(
  records: readonly ContractEventRecord[],
  groupRegistry: Uint8Array,
  version: ContractEventVersion,
): GroupRegistryEventsResult {
  if (!Array.isArray(records)) throw new TypeError("records: expected an array");
  const registry = bytesArg(groupRegistry, "groupRegistry");
  if (registry.length !== 20) throw new RangeError("groupRegistry: expected 20 bytes");
  // Only the group registry's address is given; the other roles match nothing
  // a decoded record carries, since its contract is 20 bytes.
  const none = new Uint8Array(0);
  const contracts = {
    electionRegistry: none,
    trusteeRegistry: none,
    groupRegistry: registry,
    board: none,
  };
  const events: GroupRegistryEvent[] = [];
  const pinned: { at: number; threshold: number; registrars: readonly Uint8Array[] }[] = [];
  let lastN = -1n;
  let lastBlock = 0n;
  for (const [at, record] of records.slice().entries()) {
    if (record === null || typeof record !== "object")
      throw new TypeError(`records[${at}]: expected an object`);
    // Log order is the order of `n`, which the accumulator binds; anything
    // else is the caller's mistake.
    if (typeof record.n !== "bigint" || record.n <= lastN)
      throw new RangeError(`records[${at}]: n must increase`);
    lastN = record.n;
    if (typeof record.l2_block !== "bigint" || record.l2_block < lastBlock)
      throw new RangeError(`records[${at}]: l2_block must not decrease`);
    lastBlock = record.l2_block;
    const checked = checkContractEvent(record, contracts, version);
    if (!checked.ok) return { ok: false, at, error: checked.error };
    // A hand-built record whose contract matches no 20-byte address could
    // match an empty role: only the group registry's events are read.
    if (checked.role !== "group-registry") return { ok: false, at, error: "unknown-contract" };
    const block = record.l2_block;
    const { event } = checked;
    if (event.event === "GroupCreated")
      events.push({ kind: "group-created", block, groupId: event.groupId, tier: event.tier });
    else if (event.event === "MembersAdded")
      events.push({
        kind: "members-added",
        block,
        groupId: event.groupId,
        record: event.record,
        firstIndex: event.firstIndex,
      });
    else if (event.event === "MembersRemoved")
      events.push({ kind: "members-removed", block, groupId: event.groupId, record: event.record });
    else if (event.event === "Tier1MemberAdded")
      events.push({ kind: "tier1-addition", block, record: event.record });
    else if (event.event === "SelfPaidGroupCreated")
      events.push({ kind: "self-paid-group-created", block, groupId: event.groupId });
    else if (event.event === "SelfPaidMemberAdded")
      events.push({
        kind: "self-paid-addition",
        block,
        groupId: event.groupId,
        index: event.index,
        record: event.record,
      });
    else if (event.event === "RegistrarsPinned")
      pinned.push({ at, threshold: event.threshold, registrars: event.registrars });
    else throw new Error(`records[${at}]: unread group-registry event ${event.event}`);
  }
  return { ok: true, events, pinned };
}

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
    if (kind === "members-added") {
      const { groupId, record, firstIndex } = e;
      return {
        kind,
        block,
        groupId: u64Arg(groupId, `events[${at}].groupId`),
        record: bytesArg(record, `events[${at}].record`),
        ...(firstIndex === undefined
          ? {}
          : { firstIndex: u64Arg(firstIndex, `events[${at}].firstIndex`) }),
      };
    }
    if (kind === "members-removed") {
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
    if (kind === "self-paid-group-created")
      return { kind, block, groupId: u64Arg(e.groupId, `events[${at}].groupId`) };
    if (kind === "self-paid-addition") {
      const { groupId, index, record } = e;
      return {
        kind,
        block,
        groupId: u64Arg(groupId, `events[${at}].groupId`),
        index: u64Arg(index, `events[${at}].index`),
        record: bytesArg(record, `events[${at}].record`),
      };
    }
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
 * Each Tier 2 group is replayed strictly, as verifier 2.4 replays it
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
 * Each Tier 2 group's tree is built once, its root kept at every root-grid
 * block. The proofs are checked last (docs/spec/vouching.md, Batched
 * verification, Proofs last): only those of additions a walk of the order
 * would count, in batches with coefficients from the CSPRNG
 * (`verifyDecodedMembershipProofs`), each proof at most once, with the walk
 * redone once when one fails. So copies of counted additions, which anyone can
 * log, cost no pairing, and each proof's verdict is the one checking it alone
 * gives (T-52). This is one extension of a fresh `Tier1CountingState`, so the
 * relay's state and a verifier's replay are the same code.
 */
export function countTier1Additions(
  events: readonly GroupRegistryEvent[],
  ctx: Tier1CountContext,
): Tier1Count {
  const state = new Tier1CountingState(ctx);
  const { additions, broken } = state.extend(events);
  return { additions, broken, groups: state.groups() };
}

/** What one extension of a counting state decided. */
export interface Tier1Extension {
  /** The verdicts of the extension's Tier 1 additions in blocks before any break, in log order. */
  readonly additions: Tier1Count["additions"];
  /** The state's break, from this extension or an earlier one. */
  readonly broken: Tier1Break | null;
}

/** Why the relay drops a record that would count: too little of a vouch's window is left to send it. */
export interface Tier1SendMarginFailure {
  readonly ok: false;
  readonly error: "send-margin";
  readonly vouch: number;
}

/** One candidate's outcome at a boundary (docs/spec/tier1-relay.md, The batch, step 4). */
export type Tier1Judged =
  | {
      readonly status: "chosen";
      readonly value: Tier1Addition;
      /** The leaf index it would take, after the counted additions and the candidates chosen before it. */
      readonly index: number;
    }
  | {
      readonly status: "dropped";
      readonly verdict: Exclude<Tier1CountVerdict, { ok: true }> | Tier1SendMarginFailure;
    }
  /** Not judged: the walk had chosen its limit first. */
  | { readonly status: "unreached" };

export type Tier1Judgement =
  | {
      readonly ok: true;
      /** `b + 1`: the block every candidate was judged as if logged in. */
      readonly block: bigint;
      readonly candidates: readonly Tier1Judged[];
    }
  | { readonly ok: false; readonly error: "group-history"; readonly broken: Tier1Break };

interface Group {
  readonly at: number;
  readonly block: bigint;
  readonly tier: number;
}

// A Tier 2 group's strict replay and its tier tree, with the roots the tree
// had before later records changed it (T-52).
interface Tier2Group {
  readonly replay: GroupRecordReplay;
  readonly tree: TierTreeBuilder;
  /** The block of the last record applied; 0 before any. */
  last: bigint;
  /**
   * `root` is the tree over the records in blocks before the next record's,
   * from block `from` on. Kept only where a root-grid block falls in that span,
   * since a vouch names no other block, and only back to the oldest grid block
   * a later addition can still name.
   */
  roots: { readonly from: bigint; readonly root: bigint }[];
}

// The counted additions: every slot nullifier they spent, and each Tier 1
// group's members and leaves in order.
interface Counted {
  readonly spent: Set<bigint>;
  readonly members: Map<bigint, Set<bigint>>;
  readonly leaves: Map<bigint, { commitment: bigint; block: bigint }[]>;
}

// An addition after the checks that need no slots or members: its verdict, or
// (`verdict: null`) its decoded value and proofs, still to be walked.
type Pre =
  | { readonly at: number; readonly block: bigint; readonly verdict: Tier1CountVerdict }
  | {
      readonly at: number;
      readonly block: bigint;
      readonly verdict: null;
      readonly value: Tier1Addition;
      readonly proofs: readonly MembershipProofCheck[];
    };

let emptyRoot: bigint | undefined;

/**
 * The relay's counting state (docs/spec/tier1-relay.md, The counting state):
 * the replay of [[vouching]]'s counting rule up to a block, extended by the
 * registry's later events as they are logged, against which candidate
 * records are judged without a full replay each (T-52). It holds every
 * group's creation and tier, each Tier 2 group's strict replay and tier tree
 * with its roots at the grid blocks still inside the window, the slot
 * nullifiers spent, each Tier 1 group's counted members, and the break, if
 * any. Extending it by a sequence in pieces gives exactly the verdicts and
 * the break that `countTier1Additions` gives over the whole sequence, which
 * is one extension of a fresh state.
 *
 * Positions (`at`, a break's `at`) count every event the state was extended
 * by. The state can't be rolled back: when a reorganisation removes a block
 * it was extended past, the caller builds a new one.
 */
export class Tier1CountingState {
  readonly #vouchCtx: VouchContext;
  readonly #domainSeparator: Uint8Array;
  readonly #registrars: readonly Uint8Array[];
  readonly #threshold: number;
  readonly #groups = new Map<bigint, Group>();
  readonly #tier2 = new Map<bigint, Tier2Group>();
  readonly #counted: Counted = { spent: new Set(), members: new Map(), leaves: new Map() };
  #broken: Tier1Break | null = null;
  // Set when an extension throws partway: its events are part applied, so
  // the state no longer matches any replay and refuses everything after.
  #failed = false;
  #through: bigint | null = null;
  #position = 0;

  constructor(ctx: Tier1CountContext) {
    if (ctx === null || typeof ctx !== "object") throw new TypeError("ctx: expected an object");
    // Each field read once, so a getter can't show one check one value and the next another.
    const { chainId, registry, registrars, threshold } = ctx;
    this.#vouchCtx = {
      chainId: u64Arg(chainId, "chainId"),
      registry: bytesArg(registry, "registry"),
    };
    this.#domainSeparator = groupRegistryDomainSeparator(
      this.#vouchCtx.chainId,
      this.#vouchCtx.registry,
    );
    // Checked now, by a replay of no group's records, and copied, so every
    // Tier 2 group is judged under the same set whatever the caller does later.
    new GroupRecordReplay({
      groupId: 0n,
      domainSeparator: this.#domainSeparator,
      tier: 2,
      registrars,
      threshold,
    });
    this.#registrars = registrars.map((r) => new Uint8Array(r));
    this.#threshold = threshold;
  }

  /** `b`: the block the state has every event of, or null before any extension that names one. */
  get block(): bigint | null {
    return this.#through;
  }

  get broken(): Tier1Break | null {
    return this.#broken;
  }

  /** Each Tier 1 group's counted additions in order: the leaves of its tier tree. */
  groups(): Tier1Count["groups"] {
    return new Map(
      [...this.#counted.leaves].map(([id, leaves]) => [id, leaves.map((l) => ({ ...l }))]),
    );
  }

  /**
   * Extends the state by the registry's events after its block, in log order,
   * through block `through` (by default the last event's): the caller asserts
   * that these are all of the registry's events in blocks up to it, so the
   * next extension starts in a later block. Returns the verdicts of the
   * additions it decided. Once a Tier 2 history is broken, nothing more is
   * decided (docs/spec/vouching.md, A broken Tier 2 history), and the state
   * only advances its block.
   */
  extend(events: readonly GroupRegistryEvent[], through?: bigint): Tier1Extension {
    this.#usable();
    const list = readEvents(events);
    const firstBlock = list[0]?.block;
    const lastBlock = list.at(-1)?.block;
    if (this.#through !== null && firstBlock !== undefined && firstBlock <= this.#through)
      throw new RangeError("events: blocks must be after the state's block");
    let end = this.#through;
    if (through !== undefined) {
      end = u64Arg(through, "through");
      if ((lastBlock !== undefined && end < lastBlock) || (this.#through ?? 0n) > end)
        throw new RangeError("through: must be at or after every event's block and the state's");
    } else if (lastBlock !== undefined) end = lastBlock;
    const base = this.#position;
    if (this.#broken !== null) {
      this.#position += list.length;
      this.#through = end;
      return { additions: [], broken: this.#broken };
    }
    try {
      const additions = this.#decide(list, base);
      this.#position += list.length;
      this.#through = end;
      this.#prune();
      return { additions, broken: this.#broken };
    } catch (e) {
      this.#failed = true;
      throw e;
    }
  }

  // Applies the events and decides their Tier 1 additions, `base` being the
  // first one's position.
  #decide(list: readonly GroupRegistryEvent[], base: number): Tier1Extension["additions"] {
    // Groups, Tier 2 records and breaks in log order; the Tier 1 additions are
    // decided after, once every root they can name is known.
    const pending: { at: number; block: bigint; record: Uint8Array }[] = [];
    for (const [i, e] of list.entries()) {
      const at = base + i;
      if (e.kind === "tier1-addition") pending.push({ at, block: e.block, record: e.record });
      else if (!this.#apply(at, e)) break;
    }
    const stop = this.#broken?.block ?? null;
    const pres = pending
      .filter((p) => stop === null || p.block < stop)
      .map((p) => this.#pre(p.at, p.block, p.record));

    // Proofs last (docs/spec/vouching.md, Batched verification): walk the order
    // taking each addition that passes checks 1 to 8 as counted, then batch the
    // proofs of the additions it counted. If every one passes, the walk stands.
    // Otherwise the walk is redone once, now checking each addition's proofs
    // when it reaches them (those already checked from the batch's verdicts):
    // an addition that fails consumes nothing, so a later one may now pass
    // `slot-spent` or `member` and need its own proofs. So there are at most
    // two walks, whatever a rewritten history logs, each proof is checked at
    // most once, and pairings go only to additions that reach `proof` in some
    // walk, never to copies of counted ones (T-52). On an honest chain no
    // logged proof fails, so one walk and one batch decide everything.
    const proofs = new Map<number, readonly boolean[]>();
    let walked = walkOrder(pres, this.#counted, (i) => proofs.get(i));
    const batch = walked.unchecked.flatMap((u) => u.proofs);
    const verdicts = batch.length === 0 ? [] : verifyDecodedMembershipProofs(batch);
    let next = 0;
    for (const u of walked.unchecked) {
      proofs.set(u.pre, verdicts.slice(next, next + u.proofs.length));
      next += u.proofs.length;
    }
    if (verdicts.includes(false))
      walked = walkOrder(pres, this.#counted, (i, own) => {
        let known = proofs.get(i);
        if (known === undefined) {
          known = verifyDecodedMembershipProofs(own);
          proofs.set(i, known);
        }
        return known;
      });
    walked.walk.commit();
    return walked.additions;
  }

  #usable(): void {
    if (this.#failed) throw new Error("the state failed partway through an extension: rebuild it");
  }

  /**
   * Judges candidate records, in the order given (the relay's shuffle), as if
   * logged in block `b + 1` after the state's events and the candidates chosen
   * before them, with every check of the counting rule, proofs last and each
   * candidate's own (docs/spec/tier1-relay.md, The batch, step 4). A candidate
   * that would count is chosen only if every vouch's window still has
   * `sendMargin` blocks past `b` (`b + sendMargin ≤ root_block + W`), checked
   * before its slots and proofs; any other is dropped and consumes nothing.
   * Once `limit` are chosen, the rest are unreached. The state is unchanged:
   * what lands is read from the chain at the next extension.
   */
  judge(
    records: readonly Uint8Array[],
    options: { readonly limit: number; readonly sendMargin: bigint },
  ): Tier1Judgement {
    this.#usable();
    if (!Array.isArray(records)) throw new TypeError("records: expected an array");
    if (options === null || typeof options !== "object")
      throw new TypeError("options: expected an object");
    const { limit, sendMargin } = options;
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new RangeError("limit: expected a non-negative integer");
    const margin = u64Arg(sendMargin, "sendMargin");
    const b = this.#through;
    if (b === null) throw new RangeError("judge: the state has no block yet");
    if (this.#broken !== null) return { ok: false, error: "group-history", broken: this.#broken };
    const block = b + 1n;
    const walk = new Walk(this.#counted);
    const prove = (_: number, own: readonly MembershipProofCheck[]) =>
      verifyDecodedMembershipProofs(own);
    let chosen = 0;
    const candidates = records.slice().map((r, i): Tier1Judged => {
      const record = bytesArg(r, `records[${i}]`);
      if (chosen >= limit) return { status: "unreached" };
      // Every group the state knows was created before any candidate.
      const p = this.#pre(this.#position, block, record);
      if (p.verdict !== null) return { status: "dropped", verdict: drop(p.verdict) };
      const late = p.value.vouches.findIndex((v) => b + margin > v.rootBlock + VOUCH_ROOT_WINDOW);
      if (late >= 0)
        return { status: "dropped", verdict: { ok: false, error: "send-margin", vouch: late } };
      const { verdict } = walk.consider(i, p, prove);
      if (!verdict.ok) return { status: "dropped", verdict };
      chosen++;
      return { status: "chosen", value: verdict.value, index: verdict.index };
    });
    return { ok: true, block, candidates };
  }

  // Applies one event that isn't a Tier 1 addition; false once it breaks the
  // count. A members record of a group with no earlier creation, of any tier,
  // breaks at its own block, so no later event can move a break earlier (T-71).
  #apply(at: number, e: Exclude<GroupRegistryEvent, { kind: "tier1-addition" }>): boolean {
    const breakAt = (reason: Tier1Break["reason"]) => {
      this.#broken = { at, block: e.block, groupId: e.groupId, reason };
      return false;
    };
    // A self-paid group is a Tier 0 group of its own kind: it takes no Tier 1
    // addition and no vouch names it, but its creation numbers a group, so a
    // second creation of an identifier breaks the count whichever kinds they are.
    if (e.kind === "group-created" || e.kind === "self-paid-group-created") {
      if (this.#groups.has(e.groupId)) return breakAt("duplicate-group");
      this.#groups.set(e.groupId, {
        at,
        block: e.block,
        tier: e.kind === "group-created" ? e.tier : 0,
      });
      return true;
    }
    const group = this.#groups.get(e.groupId);
    if (group === undefined) return breakAt("created");
    if (group.tier !== 2) return true;
    // A self-paid addition naming a signed group fails that group's replay at
    // `group` (2.4). Events read by `groupRegistryEvents` have passed the event
    // check, which decodes the record strictly, so no decoding code comes
    // first; hand-built events are the caller's to have decoded.
    if (e.kind === "self-paid-addition") return breakAt("group");
    // The event's `firstIndex` topic is the one an accumulator and an indexer
    // read; an addition whose own `first_index` differs fails its group
    // (docs/spec/contracts.md, Group registry, Verification, which checks the
    // topics before replaying the record).
    if (e.kind === "members-added" && e.firstIndex !== undefined) {
      const d = decodeGroupAddition(e.record);
      if (d.ok && d.value.firstIndex !== e.firstIndex) return breakAt("position");
    }
    let t = this.#tier2.get(e.groupId);
    if (t === undefined) {
      t = {
        replay: new GroupRecordReplay({
          groupId: e.groupId,
          domainSeparator: this.#domainSeparator,
          tier: 2,
          registrars: this.#registrars,
          threshold: this.#threshold,
        }),
        tree: new TierTreeBuilder(),
        last: 0n,
        roots: [],
      };
      this.#tier2.set(e.groupId, t);
    }
    // The tree as it stands holds from `last` until this record's block: keep
    // its root if a grid block falls in between.
    const grid = ((t.last + VOUCH_ROOT_INTERVAL - 1n) / VOUCH_ROOT_INTERVAL) * VOUCH_ROOT_INTERVAL;
    if (grid < e.block) t.roots.push({ from: t.last, root: t.tree.root() });
    const applied = t.replay.apply({
      kind: e.kind === "members-added" ? "add" : "remove",
      record: e.record,
    });
    if (!applied.ok) return breakAt(applied.reason);
    if (applied.kind === "add") for (const c of applied.commitments) t.tree.append(c);
    else for (const i of applied.indices) t.tree.remove(Number(i));
    t.last = e.block;
    return true;
  }

  // The root a Tier 2 group's tree had over its records in blocks up to grid
  // block `g`: every record the state holds is in a block up to `g` when
  // `g ≥ last`, `b + 1` included.
  #rootAt(groupId: bigint, g: bigint): bigint | undefined {
    const t = this.#tier2.get(groupId);
    if (t === undefined) return (emptyRoot ??= new TierTreeBuilder().root());
    if (g >= t.last) return t.tree.root();
    let lo = 0;
    let hi = t.roots.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((t.roots[mid] as Tier2Group["roots"][number]).from <= g) lo = mid + 1;
      else hi = mid;
    }
    return t.roots[lo - 1]?.root;
  }

  // Drops the roots no later addition or candidate can name: every one is in
  // a block after the state's, so names no grid block before `b + 1 - W`.
  #prune(): void {
    if (this.#through === null || this.#through + 1n <= VOUCH_ROOT_WINDOW) return;
    const oldest = this.#through + 1n - VOUCH_ROOT_WINDOW;
    for (const t of this.#tier2.values()) {
      const keep = t.roots.findLastIndex((r) => r.from <= oldest);
      if (keep > 0) t.roots = t.roots.slice(keep);
    }
  }

  // The checks that need no slots or members, up to `root-mismatch`, of an
  // addition at position `at` in block `block`.
  #pre(at: number, block: bigint, record: Uint8Array): Pre {
    const pre = precheckTier1Addition(record, this.#vouchCtx);
    if (!pre.ok) return { at, block, verdict: pre.failure };
    const { groupId, vouches } = pre.value;
    const fail = (verdict: Tier1CountVerdict): Pre => ({ at, block, verdict });
    const group = this.#groups.get(groupId);
    if (group?.tier !== 1 || group.at > at) return fail({ ok: false, error: "group" });
    for (const [i, v] of vouches.entries())
      if (v.rootBlock % VOUCH_ROOT_INTERVAL !== 0n)
        return fail({ ok: false, error: "root-grid", vouch: i });
    for (const [i, v] of vouches.entries())
      if (v.rootBlock > block || block - v.rootBlock > VOUCH_ROOT_WINDOW)
        return fail({ ok: false, error: "root-window", vouch: i });
    for (const [i, v] of vouches.entries()) {
      const t2 = this.#groups.get(v.tier2GroupId);
      if (t2?.tier !== 2 || t2.block > v.rootBlock)
        return fail({ ok: false, error: "tier2-group", vouch: i });
    }
    for (const [i, v] of vouches.entries())
      if (v.root !== this.#rootAt(v.tier2GroupId, v.rootBlock))
        return fail({ ok: false, error: "root-mismatch", vouch: i });
    return { at, block, verdict: null, value: pre.value, proofs: pre.proofs };
  }
}

const drop = (v: Tier1CountVerdict): Exclude<Tier1CountVerdict, { ok: true }> => {
  if (v.ok) throw new Error("unreachable: a verdict before the walk counts nothing");
  return v;
};

/**
 * Slots and leaves taken by a walk over `base`, the counted additions, which
 * it reads but changes only on `commit`.
 */
class Walk {
  readonly #base: Counted;
  readonly #spent = new Set<bigint>();
  readonly #members = new Map<bigint, Set<bigint>>();
  readonly #leaves = new Map<bigint, { commitment: bigint; block: bigint }[]>();

  constructor(base: Counted) {
    this.#base = base;
  }

  /**
   * `slot-spent`, `member`, then the proofs, whose verdicts are asked of
   * `verdictsOf` only once the others pass and taken as passing where it
   * gives none (`unchecked`). A counted addition takes its slots and its
   * group's next leaf.
   */
  consider(
    i: number,
    p: Extract<Pre, { verdict: null }>,
    verdictsOf: (
      pre: number,
      proofs: readonly MembershipProofCheck[],
    ) => readonly boolean[] | undefined,
  ): { readonly verdict: Tier1CountVerdict; readonly unchecked: boolean } {
    const { groupId, commitment, vouches } = p.value;
    const reused = vouches.findIndex(
      (v) => this.#base.spent.has(v.slotNullifier) || this.#spent.has(v.slotNullifier),
    );
    if (reused >= 0)
      return { verdict: { ok: false, error: "slot-spent", vouch: reused }, unchecked: false };
    // The registry has no Tier 1 removals ([[contracts]], Group registry, Tier
    // 1 additions), so every counted leaf is unremoved.
    const members = this.#members.get(groupId) ?? new Set<bigint>();
    if (this.#base.members.get(groupId)?.has(commitment) === true || members.has(commitment))
      return { verdict: { ok: false, error: "member" }, unchecked: false };
    const own = verdictsOf(i, p.proofs);
    const failure = own === undefined ? null : proofFailure(own);
    if (failure !== null) return { verdict: failure, unchecked: false };
    for (const v of vouches) this.#spent.add(v.slotNullifier);
    members.add(commitment);
    this.#members.set(groupId, members);
    const leaves = this.#leaves.get(groupId) ?? [];
    const index = (this.#base.leaves.get(groupId)?.length ?? 0) + leaves.length;
    leaves.push({ commitment, block: p.block });
    this.#leaves.set(groupId, leaves);
    return { verdict: { ok: true, value: p.value, index }, unchecked: own === undefined };
  }

  /** Makes the walk's slots and leaves the base's. */
  commit(): void {
    const base = this.#base;
    for (const n of this.#spent) base.spent.add(n);
    for (const [id, members] of this.#members) {
      const into = base.members.get(id) ?? new Set<bigint>();
      for (const c of members) into.add(c);
      base.members.set(id, into);
    }
    for (const [id, leaves] of this.#leaves) {
      const into = base.leaves.get(id) ?? [];
      into.push(...leaves);
      base.leaves.set(id, into);
    }
  }
}

/**
 * One walk of the order over the counted additions in `base`, with an
 * addition's proof verdicts asked of `verdictsOf` (by its position in `pres`)
 * only once it passes checks 1 to 8. `unchecked` lists the additions the walk
 * counted on proofs it had no verdicts for; when it is empty, the walk is the
 * count.
 */
function walkOrder(
  pres: readonly Pre[],
  base: Counted,
  verdictsOf: (
    pre: number,
    proofs: readonly MembershipProofCheck[],
  ) => readonly boolean[] | undefined,
): {
  readonly additions: Tier1Count["additions"];
  readonly walk: Walk;
  readonly unchecked: readonly {
    readonly pre: number;
    readonly proofs: readonly MembershipProofCheck[];
  }[];
} {
  const walk = new Walk(base);
  const additions: Tier1Count["additions"][number][] = [];
  const unchecked: { pre: number; proofs: readonly MembershipProofCheck[] }[] = [];
  for (const [i, p] of pres.entries()) {
    if (p.verdict !== null) {
      additions.push(p);
      continue;
    }
    const { verdict, unchecked: u } = walk.consider(i, p, verdictsOf);
    if (u) unchecked.push({ pre: i, proofs: p.proofs });
    additions.push({ at: p.at, block: p.block, verdict });
  }
  return { additions, walk, unchecked };
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
