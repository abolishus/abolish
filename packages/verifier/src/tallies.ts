// Tally openings (docs/spec/verifier.md, Tally openings; 7.3, 7.4): every
// tally opening (0x0006) of this election on the board copy is decoded under
// the pinned version, sorted into an opening of a cell of the registered
// partition or a stray opening, and attributed by the registered signing keys
// through @abolishus/crypto's `sortTallyOpenings`, then judged against
// tally.md's Boarding rule as far as the bundle decides it. None of it counts
// or fails anything: 7.4 reports and attributes (T-29, T-15, T-17).
//
// The partition is the definition's (2.8): under version 1 its tiers, under
// versions 3 and 4 every tier's stated cells, numbered across the tiers, so
// an opening's `cell` is a position among those, never a tier (T-16).
//
// What is decided without the counted set: a stray opening, an opening of a
// cell with another number of entries than options (`tally-missing`), an
// unattributed one, and a second one by the same seat for the same cell
// (`tally-second` when the seat signed another message, `tally-repeat` for a
// replay of the same one, which is the operator's alone).
// Whether an opening is over the counted set (`tally-aggregate`) or opens it
// (`tally-opening`) needs selection (6.1), which needs the close rule (5.5),
// so an opening that breaks none of the decided rules stays unsettled and 7.4
// can't pass while one is on the copy.

import {
  DecodeError,
  type DecodeErrorCode,
  decodeBoardEntry,
  type BoardEntryVersion,
  type ElectionDefinitionRecord,
  pinnedVersion,
  RECORD_TYPES,
  type RegisteredKeys,
  sortTallyOpenings,
  tallyOpeningStatement,
} from "@abolishus/crypto";

/** A boarding rule an opening is known to break (docs/spec/tally.md, Opening record, Boarding), in that rule's order. */
export type TallyBreak =
  | { readonly code: "tally-stray" }
  | { readonly code: "tally-missing" }
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
  | { readonly code: "tally-repeat"; readonly of: number };

/** One tally-opening entry of the copy, by its position from 0. */
export interface TallyReport {
  readonly entry: number;
  /** `decode`: a rejected entry, which opens no cell. */
  readonly code?: "decode";
  readonly decodeError?: DecodeErrorCode;
  /** The cell it is an opening of; absent for a stray opening or one that doesn't decode. */
  readonly cell?: number;
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
 * versions 3 and 4's cells of every tier, as the definition states them.
 */
const partitionSize = (definition: ElectionDefinitionRecord): number =>
  definition.version === 1
    ? definition.value.electorate.length
    : definition.value.electorate.reduce((n, t) => n + t.cells.length, 0);

/**
 * The row 7.4 and the report's `tallies`. `registered` is the key set the
 * transcript check registered, or `undefined` when 3.2 didn't pass: with no
 * registered key set no opening can be attributed, so nothing is judged.
 */
export function tallyChecks(
  definition: ElectionDefinitionRecord,
  definitionHash: Uint8Array,
  registered: readonly RegisteredKeys[] | undefined,
  entries: readonly Uint8Array[],
  boardEntryVersion: BoardEntryVersion,
): { readonly row: TallyOutcome; readonly report?: readonly TallyReport[] } {
  const d = definition.value;
  // A tally-opening version this verifier doesn't read, or none pinned (a
  // later tally scheme's record), may be one a later release reads:
  // unverifiable, never failed, so releases agree (2.3; T-36).
  if (pinnedVersion(d, RECORD_TYPES.tallyOpening) !== 1)
    return { row: { status: "unverifiable", code: "unsupported-version", at: {} } };
  if (registered === undefined) return { row: { status: "unverifiable", code: "not-reached" } };
  const positions: number[] = [];
  const payloads: Uint8Array[] = [];
  for (const [at, encoded] of entries.entries()) {
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
      payloads.push(e.payload);
    } catch (e) {
      if (e instanceof DecodeError) continue;
      throw e;
    }
  }
  const sorted = sortTallyOpenings(
    { definitionHash, registered },
    partitionSize(definition),
    payloads,
    1,
  );
  const report: TallyReport[] = [];
  // Each (cell, seat)'s first attributed opening: its entry and signed message.
  const first = new Map<string, { readonly entry: number; readonly signed: Uint8Array }>();
  for (const o of sorted) {
    const entry = positions[o.at] as number;
    if ("error" in o) {
      report.push({ entry, code: "decode", decodeError: o.error, breaks: [] });
      continue;
    }
    if (o.cell === null) {
      report.push({
        entry,
        signer: o.signer,
        breaks: [
          { code: "tally-stray" },
          ...(o.signer === null ? [{ code: "tally-unattributed" as const }] : []),
        ],
      });
      continue;
    }
    const breaks: TallyBreak[] = [];
    if (o.opening.opening.length !== d.option_count) breaks.push({ code: "tally-missing" });
    if (o.signer === null) breaks.push({ code: "tally-unattributed" });
    else {
      // Any earlier opening of this cell by this seat, whatever its checks
      // find: the operator boards at most one per seat and cell. Only a
      // different signed message shows the seat signed two openings; the
      // same message again, under any signature, opens nothing new, and a
      // byte-identical copy is anyone's replay.
      const key = `${o.cell}/${o.signer}`;
      const signed = tallyOpeningStatement(o.opening);
      const earlier = first.get(key);
      if (earlier === undefined) first.set(key, { entry, signed });
      else
        breaks.push({
          code: equal(earlier.signed, signed) ? "tally-repeat" : "tally-second",
          of: earlier.entry,
        });
    }
    report.push({ entry, cell: o.cell, signer: o.signer, breaks });
  }
  return { row: rowOf(report), report };
}

// An opening is settled when it doesn't decode or broke a decided rule; one
// that broke none may still be over another set or fail to open its cell's
// aggregate, so it leaves 7.4 unverifiable, which also keeps a settled break
// from passing the row for the others.
function rowOf(report: readonly TallyReport[]): TallyOutcome {
  const settled = (o: TallyReport) => o.code !== undefined || o.breaks.length > 0;
  if (report.some((o) => !settled(o))) return { status: "unverifiable", code: "not-implemented" };
  const head = report[0];
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
