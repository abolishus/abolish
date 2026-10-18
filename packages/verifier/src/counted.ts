// The counted set and the tally (docs/spec/verifier.md, Counted set and
// tally): once selection (6.1) has passed, delivery (5.9) over the selected
// ballots by @abolishus/crypto's `checkDelivery` (`checkDeliveryV2` under
// ballot version 4, over both panels' seats), each cell's counted set
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
  type BallotHalves,
  type BoardEntryVersion,
  checkContractEvent,
  checkDelivery,
  checkDeliveryV2,
  checkDestruction,
  checkPanelDestruction,
  checkPartialTally,
  checkTally,
  type ContractEventVersion,
  DecodeError,
  type DecodeErrorCode,
  decodeBoardEntry,
  decodeContractEvent,
  deriveTotal,
  type DeliveryCheck,
  type DeliveryCheckV2,
  type DeliveryDeadlines,
  type DeliveryEntry,
  type DeliveryRecordCode,
  type DestructionReport as DestructionCheck,
  type OpeningReport,
  type PanelDestructionReport,
  panelTallyRules,
  type PartialCellCode,
  type PartialTallyCheck,
  deliveryDeadlines,
  type DeliverySegments,
  deliverySegments,
  PARAMETERS,
  pinnedVersion,
  questionResults,
  RECORD_TYPES,
  type RegisteredKeys,
  type SeatPanel,
  type TallyRules,
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
  /**
   * Beside an author panel, its registered key set, once 3.2 passed for its
   * run, 2.5 didn't fail and its approvals approved it; `undefined` leaves
   * every row here not reached.
   */
  readonly authorRegistered?: readonly RegisteredKeys[];
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
  | PartialCellCode
  | "close-contested"
  | "l1-blocks-short"
  | "destruction-early"
  | "destruction-missing"
  | "unsupported-version"
  | "not-reached"
  | "not-implemented";

export type CountedAt =
  | { readonly entry: number }
  | {
      readonly cell: number;
      readonly panel?: SeatPanel;
      readonly option?: number;
      readonly question?: number;
    }
  | { readonly panel?: SeatPanel; readonly seat: number }
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
      /** For a share-complaint batch's entry, its index in the batch from 0. */
      readonly pair?: number;
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

/**
 * The report's `delivery` under ballot version 4, whose delivery records are
 * version 2: version 1's, with each seat named by its panel (1 default, 2
 * author) as well as its index.
 */
export interface DeliveryReportV2 {
  readonly excluded: readonly {
    readonly entry: number;
    /** Qualified seats of either panel with no receipt or passing posting in time: default seats first, each panel ascending. */
    readonly missing: readonly { readonly panel: SeatPanel; readonly seat: number }[];
    readonly complaints: readonly {
      readonly entry: number;
      readonly panel: SeatPanel;
      readonly seat: number;
      readonly signer: number | null;
    }[];
  }[];
  /** Each record the check ignored or attributed, in copy order, with the panel and seat it names. */
  readonly records: readonly {
    readonly entry: number;
    readonly code: DeliveryRecordCode;
    readonly panel: SeatPanel;
    readonly seat: number;
    readonly signer?: number | null;
  }[];
  /** Each record that doesn't decode under version 2 (every batch and root among them): a rejected entry (8.3). */
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
  /** Under definition versions 5 and 6, beside `counts`, each question's slice of them, in question order. */
  readonly byQuestion?: readonly (readonly string[])[];
  /**
   * For a cell that fails 7.2, its code; beside an author panel, neither this
   * nor `counts` while `s_A` decides between `tally-author-late` and the
   * default panel's `tally-missing`.
   */
  readonly code?: PartialCellCode;
  /** Beside an author panel, the panel a failure names, where it names one. */
  readonly panel?: SeatPanel;
  readonly option?: number;
  readonly question?: number;
  /**
   * The seats a passing opening of the cell is attributed to, ascending;
   * empty if none is (8.4). Beside an author panel, the default panel's
   * seats, by their passing partial openings.
   */
  readonly signers: readonly number[];
  /** Beside an author panel, the author panel's seats its passing partial openings are attributed to, ascending. */
  readonly authorSigners?: readonly number[];
}

/** One tier's result, derived from its cells (tally.md, Coarser totals), once 7.1 passed. */
export interface TierReport {
  readonly tier: number;
  readonly counted: number;
  /** Per option, the sum of its cells' counts, as decimal strings; only where every cell passes 7.2. */
  readonly counts?: readonly string[];
  /** Under definition versions 5 and 6, beside `counts`, each question's slice of them, in question order. */
  readonly byQuestion?: readonly (readonly string[])[];
}

/** One question of a definition version 5 or 6, as its results are read (8.1). */
export interface QuestionReport {
  readonly question: number;
  /** `m_q`, its option count. */
  readonly options: number;
  readonly minSelections: number;
  readonly maxSelections: number;
  /** The method its limits give, rendered from them; never a label the definition carries. */
  readonly method: string;
}

/** One registered seat's destruction, by its first attributed statement (8.5). */
export interface SeatReport {
  /** Under destruction-statement version 2, the seat's panel (1 default, 2 author). */
  readonly panel?: SeatPanel;
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
  /** Under version 2 each duplicate and stray statement also gives the panel it names. */
  readonly duplicates: readonly {
    readonly entry: number;
    readonly panel?: SeatPanel;
    readonly seat: number;
  }[];
  readonly unattributed: readonly { readonly entry: number }[];
  readonly stray: readonly {
    readonly entry: number;
    readonly panel?: SeatPanel;
    readonly signer: number | null;
  }[];
  readonly rejected: readonly { readonly entry: number; readonly decodeError: DecodeErrorCode }[];
}

export interface CountedResult {
  /** 5.9, 6.3, 7.1, 7.2, 7.3 and, where the destruction statement applies, 8.5. */
  readonly rows: ReadonlyMap<string, CountedOutcome>;
  readonly delivery?: DeliveryReport | DeliveryReportV2;
  readonly cells?: readonly CellReport[];
  readonly tiers?: readonly TierReport[];
  /** Under definition versions 5 and 6, beside `cells`, each question's limits and method. */
  readonly questions?: readonly QuestionReport[];
  readonly destruction?: DestructionReport;
  /** 7.4's breaks that need the counted set, by entry (tally.md, Boarding). */
  readonly tallyBreaks?: ReadonlyMap<number, TallyBreak>;
  /**
   * Under tally-opening version 3, the entries of the default partial
   * openings boarded before every cell had a passing author one (7.4's
   * `tally-early`, tally.md, Boarding (version 3)).
   */
  readonly tallyEarly?: ReadonlySet<number>;
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
// Share-receipt and share-complaint batches and obligation roots reach the
// board only as contract events: no board-entry version allows them, so 4.1
// refuses one boarded directly.
const DELIVERY_EVENTS: ReadonlySet<string> = new Set([
  "ShareReceiptSubmitted",
  "SharePosted",
  "ShareComplaintSubmitted",
  "ShareReceiptBatchSubmitted",
  "ShareComplaintBatchSubmitted",
  "ObligationRootSubmitted",
]);

const readsEvents = (v: number | undefined): v is ContractEventVersion =>
  v === 1 || v === 2 || v === 3 || v === 4 || v === 5 || v === 6 || v === 7 || v === 8;

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
  // Beside an author panel delivery (5.9) reads the author seats' key set,
  // their own run's, approved on the board: without it nothing is decided,
  // never with a key set taken on trust or the default panel's alone (T-37).
  const author = definition.version === 6 && definition.value.author_keys.length !== 0;
  if (author && inputs.authorRegistered === undefined)
    return countedRows({ status: "unverifiable", code: "not-reached", at: {} }, inputs.destruction);
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
  // Obligation roots naming another definition, by entry.
  const strays: number[] = [];
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
      // Under ballot version 4 no contract-path record delivers or excludes:
      // the board's events carry delivery records of version 1, batches and
      // roots only, none of which that version fixes. So one above the floor
      // isn't read either, as a board-path one isn't, and can't hold the rows
      // open; one at or below it is listed as the rejected entry it is.
      if (BigInt(segment) > floor && definition.version === 6) continue;
      if (BigInt(segment) > floor)
        return countedRows(
          { status: "unverifiable", code: "not-implemented", at: { entry: at } },
          inputs.destruction,
        );
      // Ballot version 4 fixes no obligation-root version, so there a root
      // is a rejected entry the delivery check lists, whatever it names.
      if (checked.event.event === "ObligationRootSubmitted" && definition.version !== 6) {
        // A root for this election may deliver for every ballot by its leaves,
        // which only the counted-extent attestations make available and
        // `checkDelivery` doesn't read yet (P1-12f parts 2 and 3; P4-3 part
        // 2c), so the counted set can't be decided while one is in the
        // extent: unverifiable, never a guess either way (T-25, T-53). One
        // naming another definition is stray, its first code, whatever its
        // leaves (delivery.md, Delivery check).
        if (equal(checked.event.definitionHash, definitionHash))
          return countedRows(
            { status: "unverifiable", code: "not-implemented", at: { entry: at } },
            inputs.destruction,
          );
        strays.push(at);
        continue;
      }
      if (!("record" in checked.event)) continue;
      records.push({
        path: "contract",
        submittedAt: record.l2_timestamp,
        payload: checked.event.record,
      });
      recordAt.push(at);
    }
  }

  const against: DeliveryWindow = { definitionHash, registered, segments, deadlines };
  const delivered =
    definition.version === 6
      ? deliveryV2(inputs, against, records, recordAt)
      : deliveryV1(inputs, against, records, recordAt, strays);
  const { delivery } = delivered;
  // An exclusion is the rule's outcome, never a breach, and a failing record
  // is ignored: 5.9 has no failure of its own.
  const rows = new Map<string, CountedOutcome>([["5.9", { status: "pass" }]]);

  // The close check recomputes the counted sets with the same delivery,
  // which is by ballot hash (close.md, Close check, step 3). Only the default
  // panel's seats make close statements, so beside an author panel it runs
  // as without one, over the counted set delivery over both panels gave.
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
  // Beside an author panel the pin is version 3, whose partial openings are
  // per panel; a version-1 opening opens one sharing, never two halves.
  // Version 2, a live poll's, is version 1's opening under another header
  // and fixes the same destruction statement, version 1 (tally.md,
  // Tally-opening version 2).
  const pinned = pinnedVersion(d, RECORD_TYPES.tallyOpening);
  const whole = pinned === 1 || pinned === 2 ? pinned : undefined;
  if (author ? pinned !== 3 : whole === undefined) {
    const unsupported: CountedOutcome = {
      status: "unverifiable",
      code: "unsupported-version",
      at: {},
    };
    for (const id of [...TALLY_ROWS, ...(inputs.destruction ? ["8.5"] : [])])
      rows.set(id, unsupported);
    return { rows, delivery, ...close };
  }

  const openings = own.filter((e) => typeOf(e.payload) === RECORD_TYPES.tallyOpening);
  if (author) {
    const rules = panelTallyRules(definition as Extract<VerifiedDefinition, { version: 6 }>, 1);
    const tally = panelTally(inputs, delivered.ballots, openings, floor, rules);
    for (const [id, outcome] of tally.rows) rows.set(id, outcome);
    const result = {
      rows,
      delivery,
      ...close,
      cells: tally.cells,
      tiers: tierResults(definition, rules, tally.cells),
      ...questionReports(rules),
      tallyBreaks: tally.breaks,
      tallyEarly: tally.early,
    };
    if (!inputs.destruction) return result;
    // Destruction statement version 2, which tally-opening version 3 fixes:
    // every registered seat of both panels, each statement attributed only
    // by the key set of the panel it names, and the destruction segment from
    // the latest first passing opening over cells and both panels, since a
    // seat of one panel waits for the other's (tally.md, Windows and
    // destruction (version 2); T-14, T-37, T-54).
    const statements = own.filter((e) => typeOf(e.payload) === RECORD_TYPES.destructionStatement);
    // The guard at the top returned without the author key set, so an empty
    // one never stands in for it here (T-37).
    const authorSet = inputs.authorRegistered;
    if (authorSet === undefined) throw new Error("countedChecks: no author key set past its guard");
    const lowest = checkPanelDestruction(
      { definitionHash, registered: { default: registered, author: authorSet } },
      statements.map(({ segment, payload }) => ({ segment, payload })),
      { firstPassing: tally.firstPassing, windowSegment: windowFloor(inputs, floor) },
      2,
    );
    const destroyed = destructionOf(
      lowest,
      statements,
      tally.firstPassing.flatMap((c) => [c.default, c.author]),
    );
    rows.set("8.5", destroyed.row);
    return { ...result, destruction: destroyed.report };
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
  // Past the guard above, without an author panel the pin is version 1 or 2.
  if (whole === undefined) throw new Error("countedChecks: no whole-opening pin past its guard");
  const rules = tallyRules(definition);
  const tally = checkTally(
    { definitionHash, rules, registered },
    cells,
    openings.map((o) => o.payload),
    whole,
  );
  const tiers = cellTiers(definition);
  const cellReports: CellReport[] = tally.cells.map((c, cell) => {
    const counted = (cells[cell] as CommittedVss[]).length;
    const tier = tiers[cell] as number;
    const signers = signersOf(c.passing);
    if (c.ok) return { cell, tier, counted, ...countsOf(rules, c.counts), signers };
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
  const tierReports = tierResults(definition, rules, cellReports);
  const questions = questionReports(rules);
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
    return {
      rows,
      delivery,
      ...close,
      cells: cellReports,
      tiers: tierReports,
      ...questions,
      tallyBreaks,
    };
  const firstPassing = tally.cells.map((c) => {
    const p = c.passing[0];
    return p === undefined ? null : (openings[p.at] as (typeof openings)[number]).segment;
  });
  const statements = own.filter((e) => typeOf(e.payload) === RECORD_TYPES.destructionStatement);
  const lowest = checkDestruction(
    { definitionHash, registered },
    statements.map(({ segment, payload }) => ({ segment, payload })),
    { firstPassing, windowSegment: windowFloor(inputs, floor) },
    1,
  );
  const destroyed = destructionOf(lowest, statements, firstPassing);
  rows.set("8.5", destroyed.row);
  return {
    rows,
    delivery,
    ...close,
    cells: cellReports,
    tiers: tierReports,
    ...questions,
    destruction: destroyed.report,
    tallyBreaks,
  };
}

/**
 * `s_T`'s floor. The destruction segment is `min(s_O + 1, s_T)`, or `s_T`
 * while a cell has no passing opening (tally.md, Destruction checks; under
 * tally-opening version 3, for either panel, Windows and destruction (version
 * 2)). `s_T`, the period holding `t_S + TALLY_WINDOW` with `t_S` the end of
 * `s_S` plus the deadline, isn't known, but it grows with `s_S`, so the
 * counted extent's floor bounds it from below.
 */
function windowFloor(inputs: CountedInputs, floor: bigint): number {
  const { clock } = inputs;
  const s = floor + 1n + (clock.deadline + BigInt(PARAMETERS.TALLY_WINDOW)) / clock.period;
  return s > BigInt(U32_MAX) ? U32_MAX : Number(s);
}

/**
 * 8.5's row and the report's `destruction` from crypto's report with `s_T`
 * at its floor (version 1's, or version 2's with each seat's panel), and the
 * segments of each cell's first passing openings (null where there is none).
 */
function destructionOf(
  lowest: DestructionCheck | PanelDestructionReport,
  statements: readonly { readonly at: number; readonly segment: number }[],
  firstPassing: readonly (number | null)[],
): { readonly row: CountedOutcome; readonly report: DestructionReport } {
  const latest = firstPassing.every((s) => s !== null)
    ? Math.max(...(firstPassing as number[])) + 1
    : undefined;
  const statementAt = (i: number) => statements[i] as (typeof statements)[number];
  const panelOf = (x: object) =>
    "panel" in x ? { panel: (x as { readonly panel: SeatPanel }).panel } : {};
  // With `s_T` at its floor a statement is early only if it is early
  // whatever `s_T` is; one the floor finds destroyed is destroyed only at or
  // after the highest the destruction segment can be.
  // Ascending by seat, as the report and the row's first seat are, whatever
  // order the key set lists them in; under version 2 the default panel's
  // seats, then the author panel's.
  const order = (s: object) => ("panel" in s ? (s as { readonly panel: SeatPanel }).panel : 1);
  const seats: SeatReport[] = [...lowest.seats]
    .sort((a, b) => order(a) - order(b) || a.seat - b.seat)
    .map((s) => {
      const seat = { ...panelOf(s), seat: s.seat };
      if (s.code === "destruction-missing") return { ...seat, code: s.code };
      const { at, segment } = statementAt(s.at as number);
      if (s.code === "destruction-early") return { ...seat, code: s.code, entry: at };
      return latest !== undefined && segment >= latest
        ? { ...seat, code: "destroyed", entry: at }
        : { ...seat, entry: at };
    });
  const report: DestructionReport = {
    earliest: lowest.from,
    ...(latest !== undefined && { latest }),
    seats,
    duplicates: lowest.duplicates.map((x) => ({
      entry: statementAt(x.at).at,
      ...panelOf(x),
      seat: x.seat,
    })),
    unattributed: lowest.unattributed.map((x) => ({ entry: statementAt(x.at).at })),
    stray: lowest.stray.map((x) => ({
      entry: statementAt(x.at).at,
      ...panelOf(x),
      signer: x.signer,
    })),
    rejected: lowest.rejected.map((x) => ({
      entry: statementAt(x.at).at,
      decodeError: x.error,
    })),
  };
  const where = (s: SeatReport) => ({
    ...(s.panel !== undefined && { panel: s.panel }),
    seat: s.seat,
  });
  const open = seats.find((s) => s.code === undefined);
  const missed = seats.find((s) => s.code !== undefined && s.code !== "destroyed");
  const row: CountedOutcome =
    open !== undefined
      ? { status: "unverifiable", code: "not-implemented", at: where(open) }
      : missed !== undefined
        ? {
            status: "fail",
            code: missed.code as "destruction-early" | "destruction-missing",
            at: where(missed),
          }
        : { status: "pass" };
  return { row, report };
}

/** What delivery runs against beside the definition and the records. */
interface DeliveryWindow {
  readonly definitionHash: Uint8Array;
  readonly registered: readonly RegisteredKeys[];
  readonly segments: DeliverySegments;
  readonly deadlines: DeliveryDeadlines;
}

/** The selected ballots' delivery fields, of the version the definition's ballots have. */
function deliveryFields<K extends "delivery" | "deliveryV4">(
  selected: readonly CountedBallot[],
  key: K,
): NonNullable<BallotTally[K]>[] {
  return selected.map((b) => {
    const fields = b.tally[key];
    if (fields === undefined)
      throw new Error("countedChecks: a selected ballot without its delivery fields");
    return fields as NonNullable<BallotTally[K]>;
  });
}

/** 5.9 under ballot versions 1 and 2: delivery records version 1, over the default panel. */
function deliveryV1(
  inputs: CountedInputs,
  window: DeliveryWindow,
  records: readonly DeliveryEntry[],
  recordAt: readonly number[],
  strays: readonly number[],
): { readonly ballots: DeliveryCheck["ballots"]; readonly delivery: DeliveryReport } {
  const delivered = checkDelivery(
    { ...window, panelSize: inputs.definition.value.panel_size },
    deliveryFields(inputs.selected, "delivery"),
    records,
    1,
  );
  const entryOf = (i: number) => recordAt[i] as number;
  return {
    ballots: delivered.ballots,
    delivery: {
      excluded: delivered.ballots.flatMap((b, i) =>
        b.counted
          ? []
          : [
              {
                entry: (inputs.selected[i] as CountedBallot).entry,
                missing: b.missing,
                complaints: b.excludedBy.map((c) => ({
                  entry: entryOf(c.at),
                  ...(c.pair !== undefined && { pair: c.pair }),
                  seat: c.seat,
                  signer: c.signer,
                })),
              },
            ],
      ),
      // In copy order, the stray roots among the check's records.
      records: [
        ...delivered.records.map((r) => ({
          entry: entryOf(r.at),
          ...(r.pair !== undefined && { pair: r.pair }),
          code: r.code,
          ...(r.signer !== undefined && { signer: r.signer }),
        })),
        ...strays.map((entry) => ({ entry, code: "delivery-stray" as const })),
      ].sort((a, b) => a.entry - b.entry),
      rejected: delivered.rejected.map((r) => ({ entry: entryOf(r.at), decodeError: r.error })),
    },
  };
}

/**
 * 5.9 under ballot version 4: delivery records version 2, over every
 * qualified seat of both panels, each record against its own panel's share
 * hashes and key set (docs/spec/delivery.md, Delivery check (version 2);
 * T-37). Beside an author panel its seats are the key set its own run
 * registered and its approvals approved; without one that set is empty, so a
 * record naming an author seat is `delivery-seat` and delivers nothing.
 */
function deliveryV2(
  inputs: CountedInputs,
  window: DeliveryWindow,
  records: readonly DeliveryEntry[],
  recordAt: readonly number[],
): { readonly ballots: DeliveryCheckV2["ballots"]; readonly delivery: DeliveryReportV2 } {
  const d = inputs.definition.value as Extract<VerifiedDefinition, { version: 6 }>["value"];
  const delivered = checkDeliveryV2(
    {
      definitionHash: window.definitionHash,
      panelSize: d.panel_size,
      authorPanelSize: d.author_keys.length,
      registered: { default: window.registered, author: inputs.authorRegistered ?? [] },
      segments: window.segments,
      deadlines: window.deadlines,
    },
    deliveryFields(inputs.selected, "deliveryV4"),
    records,
    // Beside an author panel crypto takes both key sets only as this
    // definition's runs registered them, the author set approved, so neither
    // a copy nor another run's passes (T-37). Without one the default set is
    // the transcript check's, as it is for ballot versions 1 and 2.
    ...(d.author_keys.length !== 0 ? [d] : []),
  );
  const entryOf = (i: number) => recordAt[i] as number;
  return {
    ballots: delivered.ballots,
    delivery: {
      excluded: delivered.ballots.flatMap((b, i) =>
        b.counted
          ? []
          : [
              {
                entry: (inputs.selected[i] as CountedBallot).entry,
                missing: b.missing.map(({ panel, seat }) => ({ panel, seat })),
                // Ballot version 4 fixes no batch version, so no complaint
                // here is a batch's entry.
                complaints: b.excludedBy.map((c) => ({
                  entry: entryOf(c.at),
                  panel: c.panel,
                  seat: c.seat,
                  signer: c.signer,
                })),
              },
            ],
      ),
      records: delivered.records.map((r) => ({
        entry: entryOf(r.at),
        code: r.code,
        panel: r.panel,
        seat: r.seat,
        ...(r.signer !== undefined && { signer: r.signer }),
      })),
      rejected: delivered.rejected.map((r) => ({ entry: entryOf(r.at), decodeError: r.error })),
    },
  };
}

type CommittedVss = BallotTally["vss"];

/** The seats the openings in `passing` are attributed to, ascending; an unattributed one counts as well (8.4). */
const signersOf = (passing: readonly OpeningReport[]) =>
  [...new Set(passing.flatMap((p) => (p.signer === null ? [] : [p.signer])))].sort((a, b) => a - b);

/**
 * Each tier's result, derived from its cells' counts, never opened (tally.md,
 * Coarser totals): only where every cell of the tier passed.
 */
function tierResults(
  definition: VerifiedDefinition,
  rules: TallyRules,
  cells: readonly CellReport[],
): readonly TierReport[] {
  return [...new Set(cellTiers(definition))].map((tier) => {
    const members = cells.filter((c) => c.tier === tier);
    const counted = members.reduce((n, c) => n + c.counted, 0);
    const counts = members.map((c) => c.counts);
    return counts.every((x) => x !== undefined)
      ? { tier, counted, ...countsOf(rules, deriveTotal(counts.map((x) => x.map(BigInt)))) }
      : { tier, counted };
  });
}

/**
 * A passing cell's or tier's counts, and under definition versions 5 and 6
 * each question's slice of them by crypto's `questionResults`: each question
 * on its own, never a figure joining two, since none is opened (8.1;
 * ADR 0026, No cross-tabulation; T-29, T-16).
 */
function countsOf(
  rules: TallyRules,
  counts: readonly bigint[],
): { readonly counts: readonly string[]; readonly byQuestion?: readonly (readonly string[])[] } {
  const text = (xs: readonly bigint[]) => xs.map((v) => v.toString());
  return rules.questions === undefined
    ? { counts: text(counts) }
    : { counts: text(counts), byQuestion: questionResults(rules, counts).map(text) };
}

/** Under definition versions 5 and 6, each question's limits and its method (8.1). */
function questionReports(rules: TallyRules): { readonly questions?: readonly QuestionReport[] } {
  if (rules.questions === undefined) return {};
  return {
    questions: rules.questions.map((q, question) => ({
      question,
      options: q.optionCount,
      minSelections: q.minSelections,
      maxSelections: q.maxSelections,
      method: questionMethod(q.minSelections, q.maxSelections, q.optionCount),
    })),
  };
}

/**
 * The method a question's limits give (election-definition.md, Questions,
 * Methods are limits): the owner's four are pick one `(0, 1)`, pick any
 * `(0, m)`, pick up to N `(0, N)` and pick exactly N `(N, N)`; any other
 * range the rules allow is said as at least N or N to M. Rendered from the
 * limits the validity proof enforces, so it can't disagree with what was
 * counted (T-34, T-41).
 */
export function questionMethod(min: number, max: number, options: number): string {
  if (min === 0) {
    if (max === 1) return "pick one";
    return max === options ? "pick any" : `pick up to ${max}`;
  }
  if (min === max) return `pick exactly ${min}`;
  return max === options ? `pick at least ${min}` : `pick ${min} to ${max}`;
}

const failureAt = (f: NonNullable<PartialTallyCheck["failure"]>) => ({
  cell: f.cell,
  ...(f.panel !== undefined && { panel: f.panel }),
  ...(f.option !== undefined && { option: f.option }),
  ...(f.question !== undefined && { question: f.question }),
});

/**
 * 7.1 to 7.3 beside an author panel, under tally-opening version 3
 * (docs/spec/tally.md, Author panel, Opening checks (version 3)): one counted
 * set per cell, which both panels sum over, each panel's partial openings
 * checked against its own half's aggregate and attributed only by its own
 * registered key set, and each cell's count the sum of the two (T-29, T-37,
 * T-54). Whose failure a missing default partial opening is turns on `s_A`,
 * the period holding `t_S + AUTHOR_OPENING_WINDOW`, which grows with `s_S`
 * as `s_T` does: an author partial opening at or below its floor is in time
 * whatever `s_S` is, and one boarded nowhere is late whatever it is. Where
 * the two readings give a cell different codes, the cell isn't decided, and
 * nor is 7.2 if it is the first failing one: a later release that knows
 * `s_S` reports `tally-author-late` or the default panel's `tally-missing`,
 * never another status, and never names the default panel for the author's
 * delay meanwhile.
 */
function panelTally(
  inputs: CountedInputs,
  /** Delivery's verdict on each selected ballot, in the same order. */
  ballots: readonly { readonly counted: boolean }[],
  openings: readonly {
    readonly at: number;
    readonly segment: number;
    readonly payload: Uint8Array;
  }[],
  floor: bigint,
  /** The default panel's rules, whose questions a cell's counts are read by. */
  rules: TallyRules,
): {
  readonly rows: ReadonlyMap<string, CountedOutcome>;
  readonly cells: readonly CellReport[];
  readonly breaks: ReadonlyMap<number, TallyBreak>;
  readonly early: ReadonlySet<number>;
  readonly firstPassing: readonly {
    readonly default: number | null;
    readonly author: number | null;
  }[];
} {
  const definition = inputs.definition as Extract<VerifiedDefinition, { version: 6 }>;
  const { definitionHash, registered, clock } = inputs;
  const halves: BallotHalves[][] = Array.from({ length: partitionSize(definition) }, () => []);
  ballots.forEach((b, i) => {
    if (!b.counted) return;
    const { cell, deliveryV4 } = (inputs.selected[i] as CountedBallot).tally;
    const into = halves[cell];
    if (into === undefined || deliveryV4 === undefined)
      throw new Error(
        "countedChecks: a selected ballot outside the partition or without both halves",
      );
    into.push(deliveryV4.vote);
  });
  const election = {
    definitionHash,
    defaultRules: rules,
    authorRules: panelTallyRules(definition, 2),
    registered: { default: registered, author: inputs.authorRegistered ?? [] },
  };
  const entries = openings.map(({ segment, payload }) => ({ segment, payload }));
  const sA =
    floor + 1n + (clock.deadline + BigInt(PARAMETERS.AUTHOR_OPENING_WINDOW)) / clock.period;
  // `s_A` at its floor, and unbounded: every other code is the same under both.
  const atFloor = checkPartialTally(
    election,
    halves,
    entries,
    sA > BigInt(U32_MAX) ? U32_MAX : Number(sA),
  );
  const unbounded = checkPartialTally(election, halves, entries, U32_MAX);
  const tiers = cellTiers(definition);
  const cells = atFloor.cells.map((c, cell): CellReport => {
    const base = {
      cell,
      tier: tiers[cell] as number,
      counted: (halves[cell] as BallotHalves[]).length,
    };
    const signers = {
      signers: signersOf(c.default.passing),
      authorSigners: signersOf(c.author.passing),
    };
    if (c.ok) return { ...base, ...countsOf(rules, c.counts), ...signers };
    const other = unbounded.cells[cell] as (typeof unbounded.cells)[number];
    if (other.ok || other.code !== c.code) return { ...base, ...signers };
    return {
      ...base,
      code: c.code,
      ...(c.panel !== undefined && { panel: c.panel }),
      ...(c.option !== undefined && { option: c.option }),
      ...(c.question !== undefined && { question: c.question }),
      ...signers,
    };
  });
  const failure = atFloor.failure;
  const decided = unbounded.failure;
  const row: CountedOutcome =
    failure === undefined
      ? { status: "pass" }
      : decided?.code === failure.code
        ? { status: "fail", code: failure.code, at: failureAt(failure) }
        : { status: "unverifiable", code: "not-implemented", at: { cell: failure.cell } };
  // 7.4's breaks against each panel's aggregate, and `tally-early`, by entry:
  // neither turns on `s_A`, so the floor's reading gives them.
  const entryOf = (i: number) => (openings[i] as (typeof openings)[number]).at;
  const breaks = new Map<number, TallyBreak>();
  for (const c of atFloor.cells)
    for (const f of [...c.default.failing, ...c.author.failing])
      if (f.code === "tally-aggregate") breaks.set(entryOf(f.at), { code: "tally-aggregate" });
      else if (f.code === "tally-opening")
        breaks.set(entryOf(f.at), { code: "tally-opening", option: f.option as number });
  const first = (p: { readonly passing: readonly { readonly segment: number }[] }) =>
    p.passing[0]?.segment ?? null;
  // 7.1 and 7.3 pass for the reasons they do without an author panel: no late
  // entry changes a counted set, and an opening that doesn't decode under
  // version 3 is a rejected entry that opens no cell.
  return {
    rows: new Map<string, CountedOutcome>([
      ["7.1", { status: "pass" }],
      ["7.2", row],
      ["7.3", { status: "pass" }],
    ]),
    cells,
    breaks,
    early: new Set(atFloor.early.map((o) => entryOf(o.at))),
    firstPassing: atFloor.cells.map((c) => ({
      default: first(c.default),
      author: first(c.author),
    })),
  };
}

/**
 * Each cell's tier, in partition order: under definition version 1 the
 * cells are the tiers, under versions 3 to 6 every tier's cells in
 * `electorate` order (election-definition.md, Notes, Tally partition).
 */
export function cellTiers(definition: VerifiedDefinition): readonly number[] {
  switch (definition.version) {
    case 1:
      return definition.value.electorate.map((g) => g.tier);
    case 3:
    case 4:
    case 5:
    case 6:
      return definition.value.electorate.flatMap((t) => t.cells.map(() => t.tier));
    default: {
      const unread: never = definition;
      throw new Error(`unread definition version ${String(unread)}`);
    }
  }
}
