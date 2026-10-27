// The counted set from the counted extent (docs/spec/verifier.md, Counted
// set from the counted extent): each cell's counted ballots, for a party that
// holds the board through `C_S`, the counted checkpoint with the largest
// segment at or before `s_S`, and nothing past it, as a trustee node does
// before it sums (docs/spec/tally.md, Summed shares; [[P2-13]]). It is the
// verifier's own computation, not a second one: the same definition and
// transcript checks as admission's, ballot admission (5.1 to 5.5, 5.7, 5.8),
// selection's rule (6.1) and delivery (5.9), with `s_S` itself where the
// sealed copy's checks have only its floors, so a trustee sums over exactly
// the set the verifier later recomputes (T-14, T-16, T-29).
//
// Wherever those checks can't decide a ballot, the result is undecided,
// never a set: a trustee summing over a set that differs from the anchored
// one by a ballot lets `k − 1` others open that ballot beside the published
// opening (T-14, T-16).

import {
  aggregateCell,
  type AnchorClock,
  type CellAggregate,
  countedExtent,
  DecodeError,
  decodeBoardEntry,
  type Panel,
  pinnedVersion,
  RECORD_TYPES,
  type TallyElection,
  tallyRules,
  type WholeOpeningVersion,
} from "@abolishus/crypto";
import { type ElectionAdmissionCode, readElection } from "./admission.ts";
import { ALL_ROWS, ballotChecks, type BallotOutcome, type BallotTally } from "./ballots.ts";
import { type CountedOutcome, deliverSelected } from "./counted.ts";
import { isPanelled, type VerifiedDefinition } from "./definition.ts";
import type { L1Header } from "./l1.ts";
import { PINNED_PANELS, type PinnedPanel } from "./panels.ts";
import { selectAdmitted, type SelectionOutcome } from "./selection.ts";
import { partitionSize } from "./tallies.ts";

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export interface CountedExtentInputs {
  /** The registered definition's bytes. */
  readonly definition: Uint8Array;
  /** The panel the release pins for the election, which 2.5 checks the definition against. */
  readonly panel: Panel;
  /**
   * Every board entry through `C_S`, encoded, in board order, as the board
   * checks passed them through that checkpoint: the counted extent, with
   * nothing past it (docs/spec/availability.md, The counted extent).
   */
  readonly entries: readonly Uint8Array[];
  /** The anchoring clock the board anchor fixes. */
  readonly clock: AnchorClock;
  /**
   * A run of finalized L1 headers, each the parent of the next, from the
   * last block before `opens_at − L1_REF_MARGIN` (or block 0) to the first
   * after `closes_at`: what 5.8 judges every ballot's reference against.
   */
  readonly blocks: readonly L1Header[];
  /**
   * Whether every contract-event record in `entries` is authenticated as
   * its contract's own log, with its L2 block's timestamp: by 4.4's
   * accumulator replay, or by a trustee node against its own L2 node's
   * finalized history. Until then an ordinary ballot or a contract-path
   * delivery record leaves the set undecided, since its window rests on
   * that timestamp (T-35, T-71).
   */
  readonly eventsAuthenticated: boolean;
  /** The panels the release pins, as `verifyBundle` reads them. */
  readonly pins?: readonly PinnedPanel[];
}

/** Each cell's counted set, or why it isn't decided. */
export type CountedSetResult =
  | {
      readonly ok: true;
      readonly definitionHash: Uint8Array;
      /**
       * For each cell of the registered partition, in partition order, the
       * ballot records of its counted ballots, in copy order: the entry's
       * payload, or the record its contract event frames.
       */
      readonly cells: readonly (readonly Uint8Array[])[];
    }
  /** No ballot of the election can be admitted: the check that stops them all, as `electionAdmission`'s. */
  | { readonly ok: false; readonly code: ElectionAdmissionCode }
  /** The row that can't decide, with its outcome: a later input may, never another set from these. */
  | {
      readonly ok: false;
      readonly row: string;
      readonly outcome: BallotOutcome | SelectionOutcome | CountedOutcome;
    };

/**
 * The counted set over the counted extent. Throws a `RangeError` for an
 * entry that doesn't decode under the pinned board-entry version, names
 * another election or lies in a segment past `s_S`: then `entries` isn't the
 * counted extent the board checks passed, and no set over it is the
 * anchored one.
 */
export function countedSet(inputs: CountedExtentInputs): CountedSetResult {
  const counted = countedCells(inputs);
  if (!counted.ok) return counted;
  return {
    ok: true,
    definitionHash: counted.definitionHash,
    cells: counted.cells.map((cell) => cell.map((b) => b.record)),
  };
}

/**
 * What the board operator judges a tally opening against (docs/spec/
 * tally.md, Opening record, Boarding): the election as crypto's
 * `tallyOpeningBoarding` reads it (the definition hash, the tally rules and
 * the registered key set), each cell's aggregate over the counted set
 * `countedSet` gives, and the tally-opening version the definition pins.
 */
export type CountedTallyResult =
  | {
      readonly ok: true;
      readonly election: TallyElection;
      /** Each cell's aggregate, in partition order. */
      readonly aggregates: readonly CellAggregate[];
      readonly pinned: WholeOpeningVersion;
    }
  | Exclude<CountedSetResult, { readonly ok: true }>;

/**
 * `countedSet`'s cells summed into their aggregates, for a party that boards
 * or checks whole tally openings (version 1 or 2) over the counted extent:
 * the same set, so an opening the operator boards is over the aggregate the
 * verifier recomputes (T-29, T-17). A definition with an author panel, whose
 * openings are version 3's partial openings with their own boarding rule, or
 * one pinning no whole-opening version, is `unsupported-version`, decided
 * before any ballot is admitted. Throws as `countedSet` does.
 */
export function countedTally(inputs: CountedExtentInputs): CountedTallyResult {
  let pinned: WholeOpeningVersion | undefined;
  const counted = countedCells(
    inputs,
    (record) => (pinned = wholeOpeningPin(record)) !== undefined,
  );
  if (!counted.ok) return counted;
  if (pinned === undefined) throw new Error("countedTally: no pin past its guard");
  const rules = tallyRules(counted.record);
  return {
    ok: true,
    election: {
      definitionHash: counted.definitionHash,
      rules,
      registered: counted.registered.map((k) => ({ index: k.index, signingKey: k.signingKey })),
    },
    aggregates: counted.cells.map((cell) =>
      aggregateCell(
        rules,
        cell.map((b) => b.vss),
      ),
    ),
    pinned,
  };
}

/**
 * The whole-opening version (1, or a live poll's 2) a definition's openings
 * are read under, or `undefined` beside an author panel, whose profile pins
 * version 3's partial openings, and for any other pin (docs/spec/tally.md,
 * Tally-opening version 2, Author panel; T-36, T-37).
 */
export function wholeOpeningPin(record: VerifiedDefinition): WholeOpeningVersion | undefined {
  if (isPanelled(record) && record.value.author_keys.length !== 0) return undefined;
  const v = pinnedVersion(record.value, RECORD_TYPES.tallyOpening);
  return v === 1 || v === 2 ? v : undefined;
}

/**
 * The counted set's ballots by cell, each with its record and its
 * commitments, after `accept` has passed the definition (else
 * `unsupported-version`, before any ballot is read).
 */
function countedCells(
  inputs: CountedExtentInputs,
  accept: (record: VerifiedDefinition) => boolean = () => true,
):
  | {
      readonly ok: true;
      readonly definitionHash: Uint8Array;
      readonly record: VerifiedDefinition;
      readonly registered: readonly { readonly index: number; readonly signingKey: Uint8Array }[];
      readonly cells: readonly (readonly {
        readonly record: Uint8Array;
        readonly vss: BallotTally["vss"];
      }[])[];
    }
  | Exclude<CountedSetResult, { readonly ok: true }> {
  const { entries, clock, blocks } = inputs;
  const election = readElection(
    inputs.definition,
    inputs.panel,
    entries,
    inputs.pins ?? PINNED_PANELS,
  );
  if (!election.ok) return election;
  const { record, hash, boardEntryVersion, registered, authorRegistered } = election;
  if (!accept(record)) return { ok: false, code: "unsupported-version" };
  const d = record.value;
  // 2.6 fails a definition opening before the clock's epoch: the counted
  // extent can't be placed on the clock.
  if (d.closes_at < clock.epoch)
    return {
      ok: false,
      row: "5.9",
      outcome: { status: "unverifiable", code: "not-reached", at: {} },
    };
  const sS = countedExtent(clock, d.closes_at, BigInt(d.l1_inclusion_bound)).segment;
  let previous = 0;
  for (const [at, encoded] of entries.entries()) {
    let entry;
    try {
      entry = decodeBoardEntry(encoded, boardEntryVersion);
    } catch (e) {
      if (e instanceof DecodeError)
        throw new RangeError("countedSet: an entry that doesn't decode");
      throw e;
    }
    if (!equal(entry.election_id, d.election_id))
      throw new RangeError("countedSet: an entry of another election");
    if (BigInt(entry.segment) > sS) throw new RangeError("countedSet: an entry past s_S");
    // A board is indexed from 0 in order, its segments never decreasing
    // (docs/spec/board.md, Board checks): selection reads each ballot's
    // position as its index, so a copy out of order isn't the board's.
    if (entry.index !== BigInt(at) || entry.segment < previous)
      throw new RangeError("countedSet: entries out of the board's order");
    previous = entry.segment;
  }
  // Every admission row settled (Selection, condition 1): one that can't be
  // evaluated may yet admit or reject a ballot.
  const admission = ballotChecks(
    record,
    registered,
    authorRegistered,
    entries,
    boardEntryVersion,
    clock,
    blocks,
  );
  for (const id of ALL_ROWS) {
    const outcome = admission.rows.get(id);
    if (outcome === undefined || outcome.status === "unverifiable")
      return {
        ok: false,
        row: id,
        outcome: outcome ?? { status: "unverifiable", code: "not-reached", at: {} },
      };
  }
  const { candidates } = admission;
  // Settled rows mean 5.5 ran, and with it the candidates.
  if (candidates === undefined) throw new Error("countedSet: settled admission without candidates");
  // An ordinary ballot's window rests on its record's `l2_timestamp`
  // (Selection, condition 4; T-35, T-71). The board through `C_S` fixes the
  // counted extent, so the seal (condition 3) and the floor of `s_S`
  // (condition 5) are met: no entry here is past `s_S`, and none later joins.
  const unproven = admission.ordinary?.[0];
  if (!inputs.eventsAuthenticated && unproven !== undefined)
    return {
      ok: false,
      row: "6.1",
      outcome: { status: "unverifiable", code: "not-reached", at: { entry: unproven } },
    };
  const byEntry = new Map(candidates.map((c) => [c.entry, c]));
  const chosen = selectAdmitted(candidates).selected.map(({ entry }) => {
    const c = byEntry.get(entry);
    if (c?.tally === undefined) throw new Error("countedSet: a selected ballot wasn't admitted");
    return { entry, tally: c.tally, record: c.record };
  });
  // Delivery with every entry in the counted extent: each record is judged
  // by its own window, and none is past `s_S` (Counted set and tally, step 2).
  const delivered = deliverSelected(
    {
      definition: record,
      definitionHash: hash,
      registered,
      ...(authorRegistered !== undefined && { authorRegistered }),
      selected: chosen,
      entries,
      boardEntryVersion,
      extent: entries.length,
      eventsPass: inputs.eventsAuthenticated,
      clock,
    },
    sS,
  );
  if ("stop" in delivered) return { ok: false, row: "5.9", outcome: delivered.stop };
  const cells: { record: Uint8Array; vss: BallotTally["vss"] }[][] = Array.from(
    { length: partitionSize(record) },
    () => [],
  );
  delivered.ballots.forEach((b, i) => {
    if (!b.counted) return;
    const { tally, record: ballot } = chosen[i] as (typeof chosen)[number];
    const into = cells[tally.cell];
    if (into === undefined) throw new Error("countedSet: a selected ballot outside the partition");
    into.push({ record: ballot, vss: tally.vss });
  });
  return { ok: true, definitionHash: hash, record, registered, cells };
}
