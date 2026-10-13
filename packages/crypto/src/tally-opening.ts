// The tally opening (docs/spec/tally.md, Opening record; record type 0x0006):
// one cell's published opening, signed by the trustee that combined it with
// its per-election signing key, and the verifier's checks over every opening
// on the board (verifier 7.2 to 7.4). A passing opening counts whoever signed
// it; a signature only decides whom a failure is attributed to (T-29, T-54,
// T-31, ADR 0015).

import { type CommittedVote, type Share, SHARES } from "./ballot-validity.ts";
import {
  bytesFixed,
  type CodecValue,
  DecodeError,
  type DecodeErrorCode,
  encode,
  list,
  struct,
  u8,
} from "./codec.ts";
import { ds } from "./domain-separation.ts";
import { type Element, elementOrIdentity, G, GENERATOR_H, H, IDENTITY } from "./group.ts";
import { PARAMETERS } from "./parameters.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
import { aggregateCell, type CellAggregate, type TallyRules } from "./tally.ts";
import { p256Sig, signStatement, verifyStatement } from "./trustee.ts";

const TAG = "abolish/v1/sig/tally-opening";

/** Cells are named by a `u8`; version 1 of the definition has at most three. */
const MAX_CELLS = 256;

const COMMITMENTS = list(elementOrIdentity, PARAMETERS.MAX_OPTIONS);

const statementFields = [
  ["definition_hash", bytesFixed(32)],
  ["cell", u8],
  ["aggregate_hash", bytesFixed(32)],
  ["signer", u8],
  ["opening", SHARES],
] as const;

const statementV1 = struct(statementFields);

const tallyOpeningV1 = struct([...statementFields, ["signature", p256Sig]] as const);

/** What the signer signs: every field but the signature. */
export type TallyOpeningStatement = CodecValue<typeof statementV1>;

/** Tally opening, version 1 (docs/spec/tally.md, Opening record). */
export type TallyOpening = CodecValue<typeof tallyOpeningV1>;

/** Record type `0x0006`: one cell's opening of the tally, on the board. */
export const TALLY_OPENING = recordType(RECORD_TYPES.tallyOpening, { 1: tallyOpeningV1 });

const SCHEMA = new RecordSchema([TALLY_OPENING]);

/** Encodes a tally opening under version 1, the only version. */
export function encodeTallyOpening(opening: TallyOpening): Uint8Array {
  return SCHEMA.encode(TALLY_OPENING, 1, opening);
}

/** Strictly decodes a tally opening against the version the election's profile pins. */
export function decodeTallyOpening(bytes: Uint8Array, pinned: 1): TallyOpening {
  return SCHEMA.decode(TALLY_OPENING, bytes, pinned).value;
}

/**
 * `H(DS("abolish/v1/tally-aggregate", encode(Ĉ_0, …, Ĉ_{m−1})))`: which
 * counted set an opening is over, so a trustee whose view of the counted set
 * differs from the verifier's is told apart from one whose opening is wrong
 * (docs/spec/tally.md, Opening record; T-29).
 */
export function aggregateHash(aggregate: CellAggregate): Uint8Array {
  return H(
    ds(
      "abolish/v1/tally-aggregate",
      encode(
        COMMITMENTS,
        aggregate.map((row) => row[0] as Element),
      ),
    ),
  );
}

/** `m = definition_hash ‖ u8(cell) ‖ aggregate_hash ‖ u8(signer) ‖ encode(opening)`: the record's fields without header or signature. */
export function tallyOpeningStatement(statement: TallyOpeningStatement): Uint8Array {
  // Through the struct, so only these fields are read even from a whole record.
  return encode(statementV1, {
    definition_hash: statement.definition_hash,
    cell: statement.cell,
    aggregate_hash: statement.aggregate_hash,
    signer: statement.signer,
    opening: statement.opening,
  });
}

/**
 * Signs a cell's opening with the signer's per-election signing key
 * (docs/spec/tally.md, Signature). A node signs only an opening its own
 * checks passed (`openCell`), and at most one per cell.
 */
export function signTallyOpening(
  signingSecret: Uint8Array,
  statement: TallyOpeningStatement,
): TallyOpening {
  const m = tallyOpeningStatement(statement);
  return {
    definition_hash: Uint8Array.from(statement.definition_hash),
    cell: statement.cell,
    aggregate_hash: Uint8Array.from(statement.aggregate_hash),
    signer: statement.signer,
    opening: statement.opening.map(({ v, r }) => ({ v, r })),
    signature: signStatement(signingSecret, TAG, m),
  };
}

/** What a tally is checked against, all from data the verifier has already checked. */
export interface TallyElection {
  readonly definitionHash: Uint8Array;
  readonly rules: TallyRules;
  /**
   * The election's registered key set ([[ceremony]], Transcript check): each
   * qualified seat and its per-election signing key. Only these attribute.
   */
  readonly registered: readonly { readonly index: number; readonly signingKey: Uint8Array }[];
}

/** An opening found on the board, by its position in the list checked (board order). */
export interface OpeningReport {
  readonly at: number;
  /** The seat its signature attributes it to, or `null` if it is unattributed. */
  readonly signer: number | null;
}

/**
 * An opening of a cell that fails: with another number of entries
 * (`tally-missing`), over another counted set (`tally-aggregate`), or not
 * opening an option (`tally-opening`).
 */
export interface FailingOpening extends OpeningReport {
  readonly code: "tally-missing" | "tally-aggregate" | "tally-opening";
  readonly option?: number;
}

export type CellCode = "tally-missing" | "tally-opening" | "tally-conflict" | "tally-range";

/**
 * One cell's verdict (docs/spec/tally.md, Opening checks). `passing` lists
 * the openings that open every option, `failing` the cell's other openings;
 * both are reported whatever the verdict.
 */
export type CellCheck =
  | {
      readonly ok: true;
      readonly counts: readonly bigint[];
      readonly passing: readonly OpeningReport[];
      readonly failing: readonly FailingOpening[];
    }
  | {
      readonly ok: false;
      readonly code: CellCode;
      readonly option?: number;
      readonly passing: readonly OpeningReport[];
      readonly failing: readonly FailingOpening[];
    };

export interface TallyCheck {
  /** True only if every cell passes: the election's result is then every cell's counts. */
  readonly ok: boolean;
  /** The first failing cell, in cell order (verifier 7.2). */
  readonly failure?: { readonly cell: number; readonly code: CellCode; readonly option?: number };
  readonly cells: readonly CellCheck[];
  /** Openings naming another definition or a cell the partition doesn't have (verifier 7.4). */
  readonly stray: readonly OpeningReport[];
  /** Payloads that don't decode under the pinned version: rejected entries, never an election failure. */
  readonly rejected: readonly { readonly at: number; readonly error: DecodeErrorCode }[];
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// @noble rejects a multiplier of 0, which openings of empty cells use. Every
// value here was decoded, so none is at or above ℓ.
function mul(p: Element, s: bigint): Element {
  return s === 0n ? IDENTITY : p.multiply(s);
}

/**
 * The seat an opening's signature attributes it to: its `signer`, if that is
 * a registered seat and the signature verifies under the seat's registered
 * signing key over this record's own fields; otherwise `null` (T-29).
 */
function attribution(election: Pick<TallyElection, "registered">, o: TallyOpening): number | null {
  const seat = election.registered.find((k) => k.index === o.signer);
  if (seat === undefined) return null;
  return verifyStatement(seat.signingKey, TAG, tallyOpeningStatement(o), o.signature)
    ? o.signer
    : null;
}

/** The first option whose `(V_j, R_j)` doesn't open `Ĉ_j`, or `null` if every one does. */
function firstUnopened(aggregate: CellAggregate, opening: readonly Share[]): number | null {
  for (let j = 0; j < aggregate.length; j++) {
    const { v, r } = opening[j] as Share;
    const c = (aggregate[j] as readonly Element[])[0] as Element;
    if (!mul(G, v).add(mul(GENERATOR_H, r)).equals(c)) return j;
  }
  return null;
}

/** Whether two openings differ in any `V_j` or `R_j`. Exported for tests: no vector can reach it. */
export function differ(a: readonly Share[], b: readonly Share[]): boolean {
  return a.length !== b.length || a.some((s, j) => s.v !== b[j]?.v || s.r !== b[j]?.r);
}

function checkCell(
  election: TallyElection,
  ballots: readonly CommittedVote["vss"][],
  openings: readonly SortedTallyOpening[],
): CellCheck {
  const aggregate = aggregateCell(election.rules, ballots);
  const expected = aggregateHash(aggregate);
  const m = election.rules.optionCount;
  const passing: (OpeningReport & { readonly opening: readonly Share[] })[] = [];
  const failing: FailingOpening[] = [];
  for (const { at, signer, opening: o } of openings) {
    if (o.opening.length !== m) {
      failing.push({ at, signer, code: "tally-missing" });
      continue;
    }
    if (!sameBytes(o.aggregate_hash, expected)) {
      failing.push({ at, signer, code: "tally-aggregate" });
      continue;
    }
    const option = firstUnopened(aggregate, o.opening);
    if (option === null) passing.push({ at, signer, opening: o.opening });
    else failing.push({ at, signer, code: "tally-opening", option });
  }
  const reports = {
    passing: passing.map(({ at, signer }) => ({ at, signer })),
    failing,
  };
  const first = passing[0];
  if (first === undefined) {
    // 1. tally-missing: no opening of the cell has exactly m entries. 2.
    // tally-opening: none of those passes; the first of them in board order
    // names its first failing option, unless it is over another counted set.
    const f = failing.find((x) => x.code !== "tally-missing");
    if (f === undefined) return { ok: false, code: "tally-missing", ...reports };
    return f.option === undefined
      ? { ok: false, code: "tally-opening", ...reports }
      : { ok: false, code: "tally-opening", option: f.option, ...reports };
  }
  // 3. tally-conflict: two passing openings differ, which only a break of binding allows.
  if (passing.some((p) => differ(p.opening, first.opening)))
    return { ok: false, code: "tally-conflict", ...reports };
  // 4. tally-range on the passing opening: no count above the cell's ballots.
  const bound = BigInt(ballots.length);
  const over = first.opening.findIndex((s) => s.v > bound);
  if (over !== -1) return { ok: false, code: "tally-range", option: over, ...reports };
  return { ok: true, counts: first.opening.map((s) => s.v), ...reports };
}

/** A decoded tally opening, sorted and attributed (docs/spec/tally.md, Which openings are a cell's). */
export interface SortedTallyOpening extends OpeningReport {
  /** The cell it is an opening of, or `null` for a stray opening. */
  readonly cell: number | null;
  readonly opening: TallyOpening;
}

/**
 * Every tally-opening payload, in the order given, decoded under the pinned
 * version and either sorted into an opening of a cell (this election's
 * definition hash and a cell below `cellCount`) or a stray opening, with the
 * seat its signature attributes it to; or, if it doesn't decode, its decoding
 * code: a rejected entry, which opens no cell (docs/spec/tally.md, Which
 * openings are a cell's). `at` is a position in `payloads`. Needs only the
 * definition hash and the registered signing keys, never the counted set, so
 * a verifier can sort and attribute before it knows the set (verifier 7.3,
 * 7.4).
 */
export function sortTallyOpenings(
  election: Pick<TallyElection, "definitionHash" | "registered">,
  cellCount: number,
  payloads: readonly Uint8Array[],
  pinned: 1,
): (SortedTallyOpening | { readonly at: number; readonly error: DecodeErrorCode })[] {
  if (!(election.definitionHash instanceof Uint8Array) || election.definitionHash.length !== 32)
    throw new RangeError("sortTallyOpenings: definitionHash must be 32 bytes");
  if (!Number.isInteger(cellCount) || cellCount < 1 || cellCount > MAX_CELLS)
    throw new RangeError("sortTallyOpenings: from 1 to 256 cells");
  return payloads.map((payload, at) => {
    let opening: TallyOpening;
    try {
      opening = decodeTallyOpening(payload, pinned);
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      return { at, error: e.code };
    }
    const mine =
      sameBytes(opening.definition_hash, election.definitionHash) && opening.cell < cellCount;
    return {
      at,
      signer: attribution(election, opening),
      cell: mine ? opening.cell : null,
      opening,
    };
  });
}

/**
 * The verifier's tally check (docs/spec/tally.md, Opening record and Opening
 * checks; verifier 7.2 to 7.4). `cells` holds each cell's counted ballots, in
 * partition order; `payloads` every tally-opening payload (record type
 * `0x0006`) in the board's sealed extent, in board order, and `at` in every
 * report is a position in it. Anyone can post one, so a payload that doesn't
 * decode under the pinned version is a rejected entry, never a failure. Each
 * opening is an opening of the cell it names, or stray; every failing or
 * stray one is reported with the seat its signature attributes it to, if any.
 */
export function checkTally(
  election: TallyElection,
  cells: readonly (readonly CommittedVote["vss"][])[],
  payloads: readonly Uint8Array[],
  pinned: 1,
): TallyCheck {
  if (!(election.definitionHash instanceof Uint8Array) || election.definitionHash.length !== 32)
    throw new RangeError("checkTally: definitionHash must be 32 bytes");
  if (cells.length < 1 || cells.length > MAX_CELLS)
    throw new RangeError("checkTally: from 1 to 256 cells");
  const byCell = cells.map(() => [] as SortedTallyOpening[]);
  const stray: OpeningReport[] = [];
  const rejected: { at: number; error: DecodeErrorCode }[] = [];
  for (const o of sortTallyOpenings(election, cells.length, payloads, pinned)) {
    if ("error" in o) rejected.push(o);
    else if (o.cell === null) stray.push({ at: o.at, signer: o.signer });
    else byCell[o.cell]?.push(o);
  }
  const checked = cells.map((ballots, c) => checkCell(election, ballots, byCell[c] ?? []));
  const at = checked.findIndex((c) => !c.ok);
  if (at === -1) return { ok: true, cells: checked, stray, rejected };
  const bad = checked[at] as Extract<CellCheck, { ok: false }>;
  const failure =
    bad.option === undefined
      ? { cell: at, code: bad.code }
      : { cell: at, code: bad.code, option: bad.option };
  return { ok: false, failure, cells: checked, stray, rejected };
}
