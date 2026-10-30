// Tally openings (docs/spec/verifier.md, Tally openings; 7.3, 7.4): every
// tally opening (0x0006) of this election on the board copy is decoded under
// the pinned version, sorted into an opening of a cell of the registered
// partition or a stray opening, and attributed by the registered signing keys
// through @abolishus/crypto's `sortTallyOpenings`, then judged against
// tally.md's Boarding rule as far as the bundle decides it. None of it counts
// or fails anything: 7.4 reports and attributes (T-29, T-15, T-17).
//
// The partition is the definition's (2.8): under version 1 its tiers, under
// versions 3 to 6 and a fixed version 7 every tier's stated cells, numbered
// across the tiers, so an opening's `cell` is a position among those, never a
// tier (T-16); under a rolling version 7 one cell per rolling tier, in
// `rolling_electorate` order (tally.md, Rolling tiers).
//
// What is decided without the counted set: a stray opening, an opening of a
// cell with another number of entries than options (`tally-missing`), an
// unattributed one, and a second one by the same seat for the same cell
// (`tally-second` when the seat signed another message, `tally-repeat` for a
// replay of the same one, which is the operator's alone).
// Whether an opening is over the counted set (`tally-aggregate`) or opens it
// (`tally-opening`) needs the counted set (counted.ts), which needs selection
// (6.1) and delivery (5.9): until it is known, an opening that breaks none of
// the decided rules stays unsettled and 7.4 can't pass while one is on the
// copy. Once it is, the board is sealed and authenticated, so only the
// anchored extent is read, every opening is settled, and 7.4 passes or fails.
//
// Beside an author panel the profile pins tally-opening version 3, whose
// openings are partial openings of a cell for a panel: each is sorted by its
// panel byte as well and attributed only by that panel's registered key set,
// a second or a repeat is by the same seat of the same panel, and a default
// partial opening boarded before every cell had a passing author one breaks
// `tally-early`, which needs the counted set too (tally.md, Boarding
// (version 3); T-29, T-37, T-54).

import {
  DecodeError,
  type DecodeErrorCode,
  decodeBoardEntry,
  type BoardEntryVersion,
  panelTallyRules,
  partialOpeningMessage,
  pinnedVersion,
  RECORD_TYPES,
  type RegisteredKeys,
  sortPartialOpenings,
  sortTallyOpenings,
  tallyOpeningStatement,
  tallyRules,
  ELECTORATE_MODES,
} from "@abolishus/crypto";
import {
  isPanelled,
  isRolling,
  type PanelledRecord,
  type VerifiedDefinition,
} from "./definition.ts";

/** A boarding rule an opening is known to break (docs/spec/tally.md, Opening record, Boarding), in that rule's order. */
export type TallyBreak =
  | { readonly code: "tally-stray" }
  | { readonly code: "tally-missing" }
  /** Over another counted set than the verifier's: decided once the counted set is (counted.ts). */
  | { readonly code: "tally-aggregate" }
  /** Over the counted set, but not opening `option`'s aggregate commitment. */
  | { readonly code: "tally-opening"; readonly option: number }
  | { readonly code: "tally-unattributed" }
  /**
   * `of`: the first earlier entry carrying an opening of the same cell
   * attributed to the same seat, over another signed message: evidence
   * against that seat as well as the operator.
   */
  | { readonly code: "tally-second"; readonly of: number }
  /**
   * `of`: the same, over the same signed message. Anyone can replay a signed
   * record, so it is the operator's breach alone, never its signer's (T-29).
   */
  | { readonly code: "tally-repeat"; readonly of: number }
  /**
   * Under tally-opening version 3, a default partial opening boarded before
   * the board held a passing author partial opening of every cell: the
   * operator's breach, which still counts if it passes. Decided once the
   * counted set is (counted.ts).
   */
  | { readonly code: "tally-early" };

/** One tally-opening entry of the copy, by its position from 0. */
export interface TallyReport {
  readonly entry: number;
  /** `decode`: a rejected entry, which opens no cell. */
  readonly code?: "decode";
  readonly decodeError?: DecodeErrorCode;
  /** The cell it is an opening of; absent for a stray opening or one that doesn't decode. */
  readonly cell?: number;
  /** Under tally-opening version 3, the panel byte it names (1 default, 2 author, any other stray). */
  readonly panel?: number;
  /** The seat its signature attributes it to, or `null`; absent when it doesn't decode. */
  readonly signer?: number | null;
  readonly breaks: readonly TallyBreak[];
}

export type TallyCode = "decode" | TallyBreak["code"];

export interface TallyOutcome {
  readonly status: "pass" | "fail" | "unverifiable";
  readonly code?: TallyCode | "unsupported-version" | "not-reached" | "not-implemented";
  readonly at?:
    | { readonly entry: number; readonly decodeError?: DecodeErrorCode }
    | Record<string, never>;
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The number of cells in a definition's partition (docs/spec/
 * election-definition.md, Notes, Tally partition): version 1's tiers, or
 * versions 3 to 6's and a fixed version 7's cells of every tier, as the
 * definition states them, or a rolling version 7's rolling tiers, one cell
 * each (tally.md, Rolling tiers). 2.1's rules keep it from 1 to 256, as
 * `sortTallyOpenings` requires: a non-empty electorate, and under versions 3
 * to 7 the `cells` rule, which caps the total and gives every tier at least
 * one cell.
 */
export function partitionSize(definition: VerifiedDefinition): number {
  switch (definition.version) {
    case 1:
      return definition.value.electorate.length;
    case 3:
    case 4:
    case 5:
    case 6:
      return definition.value.electorate.reduce((n, t) => n + t.cells.length, 0);
    case 7:
      // One cell per rolling tier (tally.md, Rolling tiers).
      if (definition.value.electorate_mode === ELECTORATE_MODES.rolling)
        return definition.value.rolling_electorate.length;
      return definition.value.electorate.reduce((n, t) => n + t.cells.length, 0);
    default: {
      const unread: never = definition;
      throw new Error(`unread definition version ${String(unread)}`);
    }
  }
}

/** What the counted set decides of the openings (counted.ts), once it is known. */
export interface CountedOpenings {
  /** The anchored extent: past it no entry is on the board. */
  readonly extent: number;
  /** `tally-aggregate` or `tally-opening`, by entry, for each opening of a cell with `m` entries that breaks one. */
  readonly breaks: ReadonlyMap<number, TallyBreak>;
  /** Under tally-opening version 3, the entries of the default partial openings that break `tally-early`. */
  readonly early?: ReadonlySet<number>;
}

/**
 * The row 7.4 and the report's `tallies`. `registered` is the key set the
 * transcript check registered, or `undefined` when 3.2 didn't pass: with no
 * registered key set no opening can be attributed, so nothing is judged.
 * Beside an author panel `authorRegistered` is its registered key set, once
 * 3.2 passed for its run, 2.5 didn't fail and its approvals approved it, and
 * `undefined` leaves 7.4 not reached as well. `counted`, once the counted set
 * is known, settles every opening of a cell.
 */
export function tallyChecks(
  definition: VerifiedDefinition,
  definitionHash: Uint8Array,
  registered: readonly RegisteredKeys[] | undefined,
  authorRegistered: readonly RegisteredKeys[] | undefined,
  entries: readonly Uint8Array[],
  boardEntryVersion: BoardEntryVersion,
  counted?: CountedOpenings,
): { readonly row: TallyOutcome; readonly report?: readonly TallyReport[] } {
  const d = definition.value;
  // A rolling poll's partition is one cell per rolling tier, its openings
  // version 1's (or a live one's version 2) over ballot version 5's default
  // half, the whole sharing (tally.md, Rolling tiers). Beside an author panel
  // its partial openings aren't read yet (P2-17 part 4d-2b-2b-2b-2): never
  // judged here, whatever a caller passes (T-37).
  if (
    definition.version === 7 &&
    isRolling(definition) &&
    definition.value.author_keys.length !== 0
  )
    return { row: { status: "unverifiable", code: "not-reached", at: {} } };
  // Under definition version 6 and a fixed version 7 tally-opening version 1
  // opens ballot version 4's default half, which without an author panel is
  // the whole sharing (tally.md, Context); beside one the profile pins
  // version 3, whose partial openings are per panel, and a version-1 opening
  // there would be judged against the default panel's rules alone (T-37).
  const author = isPanelled(definition) && definition.value.author_keys.length !== 0;
  // A tally-opening version this verifier doesn't read here, or none pinned
  // (a later tally scheme's record), may be one a later release reads:
  // unverifiable, never failed, so releases agree (2.3; T-36). Version 2, a
  // live poll's, is version 1's record under another header (tally.md,
  // Tally-opening version 2), read whatever 2.3 finds of the pins beside it.
  const pinned = pinnedVersion(d, RECORD_TYPES.tallyOpening);
  const version = author
    ? pinned === 3
      ? 3
      : undefined
    : pinned === 1 || pinned === 2
      ? pinned
      : undefined;
  if (version === undefined)
    return { row: { status: "unverifiable", code: "unsupported-version", at: {} } };
  if (registered === undefined || (author && authorRegistered === undefined))
    return { row: { status: "unverifiable", code: "not-reached" } };
  const positions: number[] = [];
  const found: { readonly segment: number; readonly payload: Uint8Array }[] = [];
  for (const [at, encoded] of entries.entries()) {
    // Only the sealed board counts once it is known; before that, every
    // opening on the copy is read, and one past the extent stays unsettled.
    if (counted !== undefined && at >= counted.extent) break;
    try {
      const e = decodeBoardEntry(encoded, boardEntryVersion);
      // 4.1 reports an entry that doesn't decode or names another election.
      if (!equal(e.election_id, d.election_id)) continue;
      if (
        (((e.payload[0] as number) << 8) | (e.payload[1] as number)) !==
        RECORD_TYPES.tallyOpening
      )
        continue;
      positions.push(at);
      found.push({ segment: e.segment, payload: e.payload });
    } catch (e) {
      if (e instanceof DecodeError) continue;
      throw e;
    }
  }
  const cells = partitionSize(definition);
  // The guard above returned without the author key set, so an empty one
  // never stands in for it (T-37).
  const authorSet = author ? authorRegistered : [];
  if (authorSet === undefined) throw new Error("tallyChecks: no author key set past its guard");
  // Each sorted opening as one shape: its cell, the panel it names under
  // version 3, its signer, its entries and the message its signature is over.
  // Version 3 is pinned exactly when there is an author panel.
  const sorted =
    version === 3
      ? sortPartialOpenings(
          { definitionHash, registered: { default: registered, author: authorSet } },
          cells,
          found,
        ).map((o) =>
          "error" in o
            ? o
            : {
                at: o.at,
                cell: o.cell,
                panel: o.opening.panel as number | undefined,
                signer: o.signer,
                length: o.opening.opening.length,
                signed: partialOpeningMessage(o.opening),
              },
        )
      : sortTallyOpenings(
          { definitionHash, registered },
          cells,
          found.map((f) => f.payload),
          version,
        ).map((o) =>
          "error" in o
            ? o
            : {
                at: o.at,
                cell: o.cell,
                panel: undefined,
                signer: o.signer,
                length: o.opening.opening.length,
                signed: tallyOpeningStatement(o.opening),
              },
        );
  // `m`, the options an opening of a cell opens: under definition versions 5
  // to 7 the total over the questions, for each panel's partial opening as
  // for a whole one (tally.md, Context). 2.1 passed, so the definition is
  // well formed.
  const m = (author ? panelTallyRules(definition as PanelledRecord, 1) : tallyRules(definition))
    .optionCount;
  const report: TallyReport[] = [];
  // Each (cell, panel, seat)'s first attributed opening: its entry and signed message.
  const first = new Map<string, { readonly entry: number; readonly signed: Uint8Array }>();
  for (const o of sorted) {
    const entry = positions[o.at] as number;
    if ("error" in o) {
      report.push({ entry, code: "decode", decodeError: o.error, breaks: [] });
      continue;
    }
    const panel = o.panel === undefined ? {} : { panel: o.panel };
    if (o.cell === null) {
      report.push({
        entry,
        ...panel,
        signer: o.signer,
        breaks: [
          { code: "tally-stray" },
          ...(o.signer === null ? [{ code: "tally-unattributed" as const }] : []),
        ],
      });
      continue;
    }
    const breaks: TallyBreak[] = [];
    if (o.length !== m) breaks.push({ code: "tally-missing" });
    // Tally.md's Opening checks order: after `tally-missing`, which an
    // opening of another number of entries breaks instead, and before
    // `tally-unattributed`.
    else {
      const against = counted?.breaks.get(entry);
      if (against !== undefined) breaks.push(against);
    }
    if (o.signer === null) breaks.push({ code: "tally-unattributed" });
    else {
      // Any earlier opening of this cell by this seat of this panel, whatever
      // its checks find: the operator boards at most one per seat and cell.
      // Only a different signed message shows the seat signed two openings;
      // the same message again, under any signature, opens nothing new, and
      // a byte-identical copy is anyone's replay. A version-3 message binds
      // its panel, so an author seat's opening is never a default seat's
      // second (T-37).
      const key = `${o.cell}/${o.panel ?? 1}/${o.signer}`;
      const earlier = first.get(key);
      if (earlier === undefined) first.set(key, { entry, signed: o.signed });
      else
        breaks.push({
          code: equal(earlier.signed, o.signed) ? "tally-repeat" : "tally-second",
          of: earlier.entry,
        });
    }
    // Boarding (version 3)'s last condition, after the others.
    if (counted?.early?.has(entry) === true) breaks.push({ code: "tally-early" });
    report.push({ entry, cell: o.cell, ...panel, signer: o.signer, breaks });
  }
  return { row: rowOf(report, counted !== undefined), report };
}

// An opening is settled when it doesn't decode or broke a decided rule; one
// that broke none may still be over another set or fail to open its cell's
// aggregate, so it leaves 7.4 unverifiable, which also keeps a settled break
// from passing the row for the others. Once the counted set is known, one
// that broke none passes, and the row fails at the first that broke one.
function rowOf(report: readonly TallyReport[], counted: boolean): TallyOutcome {
  // With the counted set known, an opening of a cell that breaks nothing
  // passes every opening check and the boarding rule: settled.
  const settled = (o: TallyReport) => counted || o.code !== undefined || o.breaks.length > 0;
  if (report.some((o) => !settled(o))) return { status: "unverifiable", code: "not-implemented" };
  const head = report.find((o) => o.code !== undefined || o.breaks.length > 0);
  if (head === undefined) return { status: "pass" };
  return {
    status: "fail",
    code: head.code ?? (head.breaks[0] as TallyBreak).code,
    at: {
      entry: head.entry,
      ...(head.decodeError !== undefined && { decodeError: head.decodeError }),
    },
  };
}
