// The counted set and the tally (docs/spec/verifier.md, Counted set and
// tally): once selection (6.1) has passed, delivery (5.9) over the selected
// ballots by @abolishus/crypto's `checkDelivery`, each cell's counted set
// from the ballots it keeps, the tally checks (7.1 to 7.3) by `checkTally`,
// the two breaks of 7.4 that need the counted set, and 8.5's destruction
// report by `checkDestruction`. The verifier gathers the records and maps the
// results; every check is crypto's (T-29, T-54, T-14).
//
// The counted set comes from the counted extent (`segment ≤ s_S`), and `s_S`
// isn't known yet (P1-18's contract-event window), only floors of it: `s_F =
// period(closes_at) + 1` and `s_K`, the complaint window's last segment
// (docs/spec/tally.md, Tally window; docs/spec/delivery.md, Windows). Each
// step runs only where those floors decide it, and is unverifiable
// otherwise, never a pass over a set a later entry could still change:
//
// - a board-path ballot above `s_F` is already rejected (5.5), and selection
//   reached no admitted ballot above it;
// - a board-path delivery record above `max(s_F, s_K)` is outside its own
//   window whatever `s_S` is, so it delivers and excludes nothing, in the
//   counted extent or not, and isn't read;
// - a contract-path delivery record is in time by its `l2_timestamp`, which
//   only 4.4's accumulator replay authenticates, so until 4.4 passes one in
//   the anchored extent leaves everything here unverifiable (T-35, T-71);
//   after that, one above the floor may or may not be in the counted extent.
//
// So the counted set over the counted extent equals the one over the whole
// sealed extent, and 7.1's `tally-late` can't fail here: a later release that
// knows `s_S` may report more records, never another counted set.

import {
  type AnchorClock,
  type BoardEntryVersion,
  type CellCode,
  checkContractEvent,
  checkDelivery,
  checkDestruction,
  checkTally,
  type ContractEventVersion,
  DecodeError,
  type DecodeErrorCode,
  decodeBoardEntry,
  decodeContractEvent,
  deriveTotal,
  type DeliveryEntry,
  type DeliveryRecordCode,
  deliveryDeadlines,
  deliverySegments,
  PARAMETERS,
  pinnedVersion,
  RECORD_TYPES,
  type RegisteredKeys,
  tallyRules,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { BallotTally } from "./ballots.ts";
import type { VerifiedDefinition } from "./definition.ts";
import { type CloseCandidate, closeChecks, type CloseReport } from "./close.ts";
import type { L1Header } from "./l1.ts";
import { countedFloor } from "./openings.ts";
import { partitionSize, type TallyBreak } from "./tallies.ts";

/** A selected ballot (6.1), by its entry, with what the tally reads of it. */
export interface CountedBallot {
  readonly entry: number;
  readonly tally: BallotTally;
}

export interface CountedInputs {
  readonly definition: VerifiedDefinition;
  readonly definitionHash: Uint8Array;
  /** The registered key set the transcript check returned (3.2 passed). */
  readonly registered: readonly RegisteredKeys[];
  /** 6.1's selected ballots, in copy order. */
  readonly selected: readonly CountedBallot[];
  readonly entries: readonly Uint8Array[];
  readonly boardEntryVersion: BoardEntryVersion;
  /** The anchored extent, which 6.1's pass makes the sealed board. */
  readonly extent: number;
  /** Whether 4.4 passed: only its accumulator replay authenticates `l2_timestamp`. */
  readonly eventsPass: boolean;
  readonly clock: AnchorClock;
  /** Whether the pinned board-entry version allows destruction statements (8.5 applies). */
  readonly destruction: boolean;
  /** Every ballot the admission checks admitted in the anchored extent, in copy order (6.3). */
  readonly admitted: readonly CloseCandidate[];
  /** A format-5 bundle's run of finalized L1 headers, where `L_δ` is found (6.3). */
  readonly blocks: readonly L1Header[] | undefined;
}

export type CountedCode =
  | CellCode
  | "close-contested"
  | "l1-blocks-short"
  | "destruction-early"
  | "destruction-missing"
  | "unsupported-version"
  | "not-reached"
  | "not-implemented";

export type CountedAt =
  | { readonly entry: number }
  | { readonly cell: number; readonly option?: number; readonly question?: number }
  | { readonly seat: number }
  | Record<string, never>;

export interface CountedOutcome {
  readonly status: "pass" | "fail" | "unverifiable";
  readonly code?: CountedCode;
  readonly at?: CountedAt;
}

/** The report's `delivery`, once 5.9 passed. */
export interface DeliveryReport {
  /** Each selected ballot the delivery check doesn't keep, in copy order. */
  readonly excluded: readonly {
    readonly entry: number;
    /** Qualified seats with no receipt or passing posting in time, ascending. */
    readonly missing: readonly number[];
    /** Each proven complaint about it, with the seat its signature attributes it to, or `null`. */
    readonly complaints: readonly {
      readonly entry: number;
      readonly seat: number;
      readonly signer: number | null;
    }[];
  }[];
  /** Each record the check ignored or attributed, in copy order. */
  readonly records: readonly {
    readonly entry: number;
    /** For a share-receipt batch's pair, its index in the batch from 0. */
    readonly pair?: number;
    readonly code: DeliveryRecordCode;
    readonly signer?: number | null;
  }[];
  /** Each record that doesn't decode under version 1: a rejected entry (8.3). */
  readonly rejected: readonly { readonly entry: number; readonly decodeError: DecodeErrorCode }[];
}

/** One cell of the partition, in partition order, once 7.1 passed. */
export interface CellReport {
  readonly cell: number;
  /** The tier the cell belongs to (definition version 1: the cell is the tier). */
  readonly tier: number;
  /** Its counted ballots. */
  readonly counted: number;
  /** For a cell that passes 7.2, its count per option, as decimal strings. */
  readonly counts?: readonly string[];
  readonly code?: CellCode;
  readonly option?: number;
  readonly question?: number;
  /** The seats a passing opening of the cell is attributed to, ascending; empty if none is (8.4). */
  readonly signers: readonly number[];
}

/** One tier's result, derived from its cells (tally.md, Coarser totals), once 7.1 passed. */
export interface TierReport {
  readonly tier: number;
  readonly counted: number;
  /** Per option, the sum of its cells' counts, as decimal strings; only where every cell passes 7.2. */
  readonly counts?: readonly string[];
}

/** One registered seat's destruction, by its first attributed statement (8.5). */
export interface SeatReport {
  readonly seat: number;
  /** Absent while `s_T` decides it (the statement lies between `earliest` and `latest`). */
  readonly code?: "destroyed" | "destruction-early" | "destruction-missing";
  readonly entry?: number;
}

/** The report's `destruction`, once 8.5 ran. */
export interface DestructionReport {
  /** The lowest the destruction segment can be, with `s_T` at its floor. */
  readonly earliest: number;
  /** The highest it can be, `s_O + 1`; absent while some cell has no passing opening. */
  readonly latest?: number;
  readonly seats: readonly SeatReport[];
  readonly duplicates: readonly { readonly entry: number; readonly seat: number }[];
  readonly unattributed: readonly { readonly entry: number }[];
  readonly stray: readonly { readonly entry: number; readonly signer: number | null }[];
  readonly rejected: readonly { readonly entry: number; readonly decodeError: DecodeErrorCode }[];
}

export interface CountedResult {
  /** 5.9, 6.3, 7.1, 7.2, 7.3 and, where the destruction statement applies, 8.5. */
  readonly rows: ReadonlyMap<string, CountedOutcome>;
  readonly delivery?: DeliveryReport;
  readonly cells?: readonly CellReport[];
  readonly tiers?: readonly TierReport[];
  readonly destruction?: DestructionReport;
  /** 7.4's breaks that need the counted set, by entry (tally.md, Boarding). */
  readonly tallyBreaks?: ReadonlyMap<number, TallyBreak>;
  /** The close check's statements, seats, head and late ballots, once 6.3 found `L_δ`. */
  readonly close?: CloseReport;
}

const TALLY_ROWS = ["7.1", "7.2", "7.3"] as const;

/** Every row this module decides, with one outcome. */
export function countedRows(outcome: CountedOutcome, destruction: boolean): CountedResult {
  return {
    rows: new Map(
      ["5.9", "6.3", ...TALLY_ROWS, ...(destruction ? ["8.5"] : [])].map((id) => [id, outcome]),
    ),
  };
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const typeOf = (payload: Uint8Array) => ((payload[0] as number) << 8) | (payload[1] as number);

const DELIVERY_TYPES: ReadonlySet<number> = new Set([
  RECORD_TYPES.shareReceipt,
  RECORD_TYPES.sharePosting,
  RECORD_TYPES.shareComplaint,
]);
// A share-receipt batch reaches the board only as a contract event: no
// board-entry version allows it, so 4.1 refuses one boarded directly.
const DELIVERY_EVENTS: ReadonlySet<string> = new Set([
  "ShareReceiptSubmitted",
  "SharePosted",
  "ShareComplaintSubmitted",
  "ShareReceiptBatchSubmitted",
]);

const readsEvents = (v: number | undefined): v is ContractEventVersion =>
  v === 1 || v === 2 || v === 3 || v === 4;

const U32_MAX = 0xffffffff;

/** The election's entries in the anchored extent, by position, with their segment and payload. */
function anchored(inputs: CountedInputs) {
  const d = inputs.definition.value;
  const out: { readonly at: number; readonly segment: number; readonly payload: Uint8Array }[] = [];
  for (const [at, encoded] of inputs.entries.entries()) {
    if (at >= inputs.extent) break;
    try {
      const e = decodeBoardEntry(encoded, inputs.boardEntryVersion);
      // 4.1 passed over the anchored extent, so every entry decodes; another
      // election's is 4.1's too.
      if (equal(e.election_id, d.election_id))
        out.push({ at, segment: e.segment, payload: e.payload });
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
    }
  }
  return out;
}

/**
 * 5.9, 7.1 to 7.3, 7.4's counted-set breaks and 8.5, over 6.1's selected
 * ballots (docs/spec/verifier.md, Counted set and tally). Call it only once
 * 6.1 passed; `countedRows` gives the rows otherwise.
 */
export function countedChecks(inputs: CountedInputs): CountedResult {
  const { definition, definitionHash, registered, clock } = inputs;
  const d = definition.value;
  // This release's delivery check reads ballot versions 1 and 2, whose
  // delivery records are version 1; definition version 5's ballots are
  // version 3, which `checkDelivery` doesn't read yet.
  if (definition.version === 5)
    return countedRows(
      { status: "unverifiable", code: "not-implemented", at: {} },
      inputs.destruction,
    );
  // Ordinary ballots can't be found under a contract-event version this
  // release doesn't read, so 5.5 is unsupported, admission never settles and
  // 6.1 never passes there, whatever the copy holds; a caller that gets here
  // anyway reports it unsupported, never a counted set (T-36).
  const eventVersion = pinnedVersion(d, RECORD_TYPES.contractEvent);
  if (!readsEvents(eventVersion))
    return countedRows(
      { status: "unverifiable", code: "unsupported-version", at: {} },
      inputs.destruction,
    );
  const closesAt = d.closes_at;
  const bound = BigInt(d.l1_inclusion_bound);
  // 2.6 fails a definition opening before the clock's epoch; a close plus
  // the inclusion bound before it leaves the windows nowhere on the clock.
  if (closesAt + bound < clock.epoch)
    return countedRows({ status: "unverifiable", code: "not-reached", at: {} }, inputs.destruction);
  const segments = deliverySegments(clock, closesAt, bound);
  const deadlines = deliveryDeadlines(closesAt, bound);
  // `s_S` is at least `s_F` and at least `s_K` (tally.md, Tally window;
  // delivery.md, Windows), so every entry at or below this floor is in the
  // counted extent.
  const sF = countedFloor(closesAt, clock);
  const floor = sF > segments.complaint ? sF : segments.complaint;

  const own = anchored(inputs);
  const contracts = {
    electionRegistry: d.election_registry,
    trusteeRegistry: d.trustee_registry,
    groupRegistry: d.group_registry,
    board: d.board,
  };
  const records: DeliveryEntry[] = [];
  const recordAt: number[] = [];
  for (const { at, segment, payload } of own) {
    const type = typeOf(payload);
    if (DELIVERY_TYPES.has(type)) {
      // Above the floor a board-path record is outside its own window
      // (segment > s_K ≥ s_D), so it delivers and excludes nothing.
      if (BigInt(segment) > floor) continue;
      records.push({ path: "board", segment, payload });
      recordAt.push(at);
    } else if (type === RECORD_TYPES.contractEvent) {
      let record;
      try {
        record = decodeContractEvent(payload, eventVersion);
      } catch (e) {
        // 4.4's to report: it carries no record.
        if (e instanceof DecodeError) continue;
        throw e;
      }
      const checked = checkContractEvent(record, contracts, eventVersion);
      if (!checked.ok || checked.role !== "board" || !DELIVERY_EVENTS.has(checked.event.event))
        continue;
      // In time by its `l2_timestamp`, which only 4.4's replay
      // authenticates: until then the operator could move it into or out of
      // its window (T-35, T-71).
      if (!inputs.eventsPass)
        return countedRows(
          { status: "unverifiable", code: "not-reached", at: { entry: at } },
          inputs.destruction,
        );
      // Boarded above the floor, it may or may not be in the counted extent,
      // unless it was sent after the complaint window's end (`t_K ≥ t_D`):
      // then it is late whatever `s_S` is, as a board-path record above the
      // floor is, so a record submitted after the windows never holds the
      // rows open.
      if (BigInt(segment) > floor && record.l2_timestamp > deadlines.complaint) continue;
      if (BigInt(segment) > floor)
        return countedRows(
          { status: "unverifiable", code: "not-implemented", at: { entry: at } },
          inputs.destruction,
        );
      if (!("record" in checked.event)) continue;
      records.push({
        path: "contract",
        submittedAt: record.l2_timestamp,
        payload: checked.event.record,
      });
      recordAt.push(at);
    }
  }

  const ballots = inputs.selected.map((b) => {
    if (b.tally.delivery === undefined)
      throw new Error("countedChecks: a selected ballot without its delivery fields");
    return b.tally.delivery;
  });
  const delivered = checkDelivery(
    {
      definitionHash,
      panelSize: d.panel_size,
      registered,
      segments,
      deadlines,
    },
    ballots,
    records,
    1,
  );
  const entryOf = (i: number) => recordAt[i] as number;
  const delivery: DeliveryReport = {
    excluded: delivered.ballots.flatMap((b, i) =>
      b.counted
        ? []
        : [
            {
              entry: (inputs.selected[i] as CountedBallot).entry,
              missing: b.missing,
              complaints: b.excludedBy.map((c) => ({
                entry: entryOf(c.at),
                seat: c.seat,
                signer: c.signer,
              })),
            },
          ],
    ),
    records: delivered.records.map((r) => ({
      entry: entryOf(r.at),
      ...(r.pair !== undefined && { pair: r.pair }),
      code: r.code,
      ...(r.signer !== undefined && { signer: r.signer }),
    })),
    rejected: delivered.rejected.map((r) => ({ entry: entryOf(r.at), decodeError: r.error })),
  };
  // An exclusion is the rule's outcome, never a breach, and a failing record
  // is ignored: 5.9 has no failure of its own.
  const rows = new Map<string, CountedOutcome>([["5.9", { status: "pass" }]]);

  // The close check recomputes the counted sets with the same delivery,
  // which is by ballot hash (close.md, Close check, step 3).
  const kept = new Map(
    delivered.ballots.map((b) => [bytesToHex(b.ballotHash), b.counted] as const),
  );
  const closed = closeChecks({
    definition,
    definitionHash,
    registered,
    clock,
    eventVersion,
    eventsPass: inputs.eventsPass,
    own,
    blocks: inputs.blocks,
    ballots: inputs.admitted,
    delivered: kept,
  });
  rows.set("6.3", closed.row);
  const close = closed.report === undefined ? {} : { close: closed.report };

  // The destruction statement's version is the tally opening's (tally.md,
  // Destruction), so neither is read under another tally-opening pin (T-36).
  if (pinnedVersion(d, RECORD_TYPES.tallyOpening) !== 1) {
    const unsupported: CountedOutcome = {
      status: "unverifiable",
      code: "unsupported-version",
      at: {},
    };
    for (const id of [...TALLY_ROWS, ...(inputs.destruction ? ["8.5"] : [])])
      rows.set(id, unsupported);
    return { rows, delivery, ...close };
  }

  const size = partitionSize(definition);
  const cells: CommittedVss[][] = Array.from({ length: size }, () => []);
  delivered.ballots.forEach((b, i) => {
    if (!b.counted) return;
    const { cell, vss } = (inputs.selected[i] as CountedBallot).tally;
    const into = cells[cell];
    if (into === undefined)
      throw new Error("countedChecks: a selected ballot outside the partition");
    into.push(vss);
  });
  const openings = own.filter((e) => typeOf(e.payload) === RECORD_TYPES.tallyOpening);
  const tally = checkTally(
    { definitionHash, rules: tallyRules(definition), registered },
    cells,
    openings.map((o) => o.payload),
    1,
  );
  const tiers = cellTiers(definition);
  const cellReports: CellReport[] = tally.cells.map((c, cell) => {
    const counted = (cells[cell] as CommittedVss[]).length;
    const tier = tiers[cell] as number;
    // The seats whose passing opening of the cell is attributed to them; an
    // unattributed one counts as well, so the list may be empty (8.4).
    const signers = [
      ...new Set(c.passing.flatMap((p) => (p.signer === null ? [] : [p.signer]))),
    ].sort((a, b) => a - b);
    if (c.ok) return { cell, tier, counted, counts: c.counts.map((v) => v.toString()), signers };
    return {
      cell,
      tier,
      counted,
      code: c.code,
      ...(c.option !== undefined && { option: c.option }),
      ...(c.question !== undefined && { question: c.question }),
      signers,
    };
  });
  // Each tier's result is derived from its cells' counts, never opened
  // (tally.md, Coarser totals): only where every cell of the tier passed.
  const tierReports: TierReport[] = [...new Set(tiers)].map((tier) => {
    const members = cellReports.filter((c) => c.tier === tier);
    const counted = members.reduce((n, c) => n + c.counted, 0);
    const counts = members.map((c) => c.counts);
    return counts.every((x) => x !== undefined)
      ? {
          tier,
          counted,
          counts: deriveTotal(counts.map((x) => x.map(BigInt))).map((v) => v.toString()),
        }
      : { tier, counted };
  });
  // Every board-path entry past `s_S` is outside its own window, and none
  // carried by a contract event is left, so no late entry changes a counted
  // set: `tally-late` can't fail (tally.md, Tally window).
  rows.set("7.1", { status: "pass" });
  const failure = tally.failure;
  rows.set(
    "7.2",
    failure === undefined
      ? { status: "pass" }
      : {
          status: "fail",
          code: failure.code,
          at: {
            cell: failure.cell,
            ...(failure.option !== undefined && { option: failure.option }),
            ...(failure.question !== undefined && { question: failure.question }),
          },
        },
  );
  // An opening that doesn't decode is a rejected entry and opens no cell,
  // and sorting and attribution only report: 7.3 decides nothing by itself,
  // and its findings are 7.2's and 7.4's.
  rows.set("7.3", { status: "pass" });
  const tallyBreaks = new Map<number, TallyBreak>();
  for (const c of tally.cells)
    for (const f of c.failing) {
      const entry = (openings[f.at] as (typeof openings)[number]).at;
      if (f.code === "tally-aggregate") tallyBreaks.set(entry, { code: "tally-aggregate" });
      else if (f.code === "tally-opening")
        tallyBreaks.set(entry, { code: "tally-opening", option: f.option as number });
    }

  if (!inputs.destruction)
    return { rows, delivery, ...close, cells: cellReports, tiers: tierReports, tallyBreaks };
  // The destruction segment is `min(s_O + 1, s_T)`, or `s_T` while a cell
  // has no passing opening (tally.md, Destruction checks). `s_T`, the period
  // holding `t_S + TALLY_WINDOW` with `t_S` the end of `s_S` plus the
  // deadline, isn't known, but it grows with `s_S`, so the floor above
  // bounds it from below.
  const windowFloor =
    floor + 1n + (clock.deadline + BigInt(PARAMETERS.TALLY_WINDOW)) / clock.period;
  const firstPassing = tally.cells.map((c) => {
    const p = c.passing[0];
    return p === undefined ? null : (openings[p.at] as (typeof openings)[number]).segment;
  });
  const statements = own.filter((e) => typeOf(e.payload) === RECORD_TYPES.destructionStatement);
  const lowest = checkDestruction(
    { definitionHash, registered },
    statements.map(({ segment, payload }) => ({ segment, payload })),
    {
      firstPassing,
      windowSegment: windowFloor > BigInt(U32_MAX) ? U32_MAX : Number(windowFloor),
    },
    1,
  );
  const latest = firstPassing.every((s) => s !== null)
    ? Math.max(...(firstPassing as number[])) + 1
    : undefined;
  const statementAt = (i: number) => statements[i] as (typeof statements)[number];
  // With `s_T` at its floor a statement is early only if it is early
  // whatever `s_T` is; one the floor finds destroyed is destroyed only at or
  // after the highest the destruction segment can be.
  // Ascending by seat, as the report and the row's first seat are, whatever
  // order the key set lists them in.
  const seats: SeatReport[] = [...lowest.seats]
    .sort((a, b) => a.seat - b.seat)
    .map((s) => {
      if (s.code === "destruction-missing") return { seat: s.seat, code: s.code };
      const { at, segment } = statementAt(s.at);
      if (s.code === "destruction-early") return { seat: s.seat, code: s.code, entry: at };
      return latest !== undefined && segment >= latest
        ? { seat: s.seat, code: "destroyed", entry: at }
        : { seat: s.seat, entry: at };
    });
  const destruction: DestructionReport = {
    earliest: lowest.from,
    ...(latest !== undefined && { latest }),
    seats,
    duplicates: lowest.duplicates.map((x) => ({ entry: statementAt(x.at).at, seat: x.seat })),
    unattributed: lowest.unattributed.map((x) => ({ entry: statementAt(x.at).at })),
    stray: lowest.stray.map((x) => ({ entry: statementAt(x.at).at, signer: x.signer })),
    rejected: lowest.rejected.map((x) => ({
      entry: statementAt(x.at).at,
      decodeError: x.error,
    })),
  };
  const open = seats.find((s) => s.code === undefined);
  const missed = seats.find((s) => s.code !== undefined && s.code !== "destroyed");
  rows.set(
    "8.5",
    open !== undefined
      ? { status: "unverifiable", code: "not-implemented", at: { seat: open.seat } }
      : missed !== undefined
        ? {
            status: "fail",
            code: missed.code as "destruction-early" | "destruction-missing",
            at: { seat: missed.seat },
          }
        : { status: "pass" },
  );
  return {
    rows,
    delivery,
    ...close,
    cells: cellReports,
    tiers: tierReports,
    destruction,
    tallyBreaks,
  };
}

type CommittedVss = BallotTally["vss"];

/**
 * Each cell's tier, in partition order: under definition version 1 the
 * cells are the tiers, under versions 3 and 4 every tier's cells in
 * `electorate` order (election-definition.md, Notes, Tally partition).
 */
function cellTiers(definition: VerifiedDefinition): readonly number[] {
  switch (definition.version) {
    case 1:
      return definition.value.electorate.map((g) => g.tier);
    case 3:
    case 4:
    case 5:
      return definition.value.electorate.flatMap((t) => t.cells.map(() => t.tier));
    default: {
      const unread: never = definition;
      throw new Error(`unread definition version ${String(unread)}`);
    }
  }
}
