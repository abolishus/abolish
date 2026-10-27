// The tally opening (docs/spec/tally.md, Opening record; record type 0x0006):
// one cell's published opening, signed by the trustee that combined it with
// its per-election signing key, and the verifier's checks over every opening
// on the board (verifier 7.2 to 7.4). A passing opening counts whoever signed
// it; a signature only decides whom a failure is attributed to (T-29, T-54,
// T-31, ADR 0015). Version 3 carries one panel's partial opening of a cell
// under an author panel, and a cell's count is the sum of both panels'
// (docs/spec/tally.md, Author panel; ADR 0027).

import { type CommittedVote, type CommittedVoteV4, type Share, SHARES } from "./ballot-validity.ts";
import {
  bytesFixed,
  type CodecValue,
  DecodeError,
  type DecodeErrorCode,
  encode,
  list,
  struct,
  u16,
  u8,
  Writer,
} from "./codec.ts";
import { ds } from "./domain-separation.ts";
import {
  type Element,
  elementOrIdentity,
  G,
  GENERATOR_H,
  GROUP_ORDER,
  H,
  IDENTITY,
} from "./group.ts";
import { PARAMETERS } from "./parameters.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
import {
  aggregateCell,
  type CellAggregate,
  checkRules,
  firstQuestionOutside,
  type TallyRules,
} from "./tally.ts";
import { p256Sig, signStatement, verifyStatement } from "./trustee.ts";

const TAG = "abolish/v1/sig/tally-opening";

/** Version 3's own tag: its message has a header and a panel, so it is never read as version 1's (T-29, T-31). */
const PARTIAL_TAG = "abolish/v1/sig/partial-opening";

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

// Version 1's fields with `panel` after `cell` (docs/spec/tally.md, Opening
// record (version 3)). `panel` is a plain u8, compared with the election only
// when the opening is sorted, as `cell` is.
const partialFields = [
  ["definition_hash", bytesFixed(32)],
  ["cell", u8],
  ["panel", u8],
  ["aggregate_hash", bytesFixed(32)],
  ["signer", u8],
  ["opening", SHARES],
] as const;

const statementV3 = struct(partialFields);

const tallyOpeningV3 = struct([...partialFields, ["signature", p256Sig]] as const);

/** What a seat signs of its panel's partial opening: every field but the signature. */
export type PartialOpeningStatement = CodecValue<typeof statementV3>;

/** Tally opening, version 3: one panel's partial opening of a cell (docs/spec/tally.md, Opening record (version 3)). */
export type PartialOpening = CodecValue<typeof tallyOpeningV3>;

/**
 * Record type `0x0006`: one cell's opening of the tally, on the board.
 * Version 2, which every live poll pins, is version 1's layout byte for byte
 * apart from the header's version (docs/spec/tally.md, Tally-opening version
 * 2): it also fixes the running opening, so a sealed poll's board can never
 * carry one (T-16, T-31).
 */
export const TALLY_OPENING = recordType(RECORD_TYPES.tallyOpening, {
  1: tallyOpeningV1,
  2: tallyOpeningV1,
  3: tallyOpeningV3,
});

/** The tally-opening versions whose record is one cell's whole opening: 1, and a live poll's 2. */
export type WholeOpeningVersion = 1 | 2;

const SCHEMA = new RecordSchema([TALLY_OPENING]);

/** Encodes a tally opening under version 1, or 2 for a live poll. */
export function encodeTallyOpening(
  opening: TallyOpening,
  version: WholeOpeningVersion = 1,
): Uint8Array {
  // An untyped caller could name version 3, a partial opening's layout.
  if (version !== 1 && version !== 2) throw new RangeError("encodeTallyOpening: version 1 or 2");
  return SCHEMA.encode(TALLY_OPENING, version, opening);
}

/** Strictly decodes a tally opening against the version the election's profile pins. */
export function decodeTallyOpening(bytes: Uint8Array, pinned: WholeOpeningVersion): TallyOpening {
  // An untyped caller could pin version 3, whose record is a partial opening.
  if (pinned !== 1 && pinned !== 2) throw new RangeError("decodeTallyOpening: pin 1 or 2");
  const r = SCHEMA.decode(TALLY_OPENING, bytes, pinned);
  // Unreachable: the pin refused every other version.
  if (r.version !== pinned) throw new RangeError(`tally opening: not version ${pinned}`);
  return r.value as TallyOpening;
}

/** Encodes a panel's partial opening under version 3. */
export function encodePartialOpening(opening: PartialOpening): Uint8Array {
  return SCHEMA.encode(TALLY_OPENING, 3, opening);
}

/** Strictly decodes a tally opening under version 3, which a definition with an author panel pins. */
export function decodePartialOpening(bytes: Uint8Array, pinned: 3): PartialOpening {
  const r = SCHEMA.decode(TALLY_OPENING, bytes, pinned);
  // Unreachable: the pin refused every other version.
  if (r.version !== 3) throw new RangeError("tally opening: not version 3");
  return r.value;
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

/**
 * `u16(0x0006) ‖ u8(3) ‖ definition_hash ‖ u8(cell) ‖ u8(panel) ‖
 * aggregate_hash ‖ u8(signer) ‖ encode(opening)`: the record without its
 * signature, header included (docs/spec/tally.md, Opening record (version
 * 3), Signature).
 */
export function partialOpeningMessage(statement: PartialOpeningStatement): Uint8Array {
  const w = new Writer();
  u16.write(w, RECORD_TYPES.tallyOpening);
  u8.write(w, 3);
  // Through the struct, so only these fields are read even from a whole record.
  statementV3.write(w, {
    definition_hash: statement.definition_hash,
    cell: statement.cell,
    panel: statement.panel,
    aggregate_hash: statement.aggregate_hash,
    signer: statement.signer,
    opening: statement.opening,
  });
  return w.finish();
}

/**
 * Signs a panel's partial opening of a cell with the signer's per-election
 * signing key. A seat signs only a partial opening its own checks passed
 * (`openPartialCell`), at most one per cell, and a default seat only once the
 * author panel's partial opening of every cell is anchored (docs/spec/tally.md,
 * Partial openings, Order; T-54).
 */
export function signPartialOpening(
  signingSecret: Uint8Array,
  statement: PartialOpeningStatement,
): PartialOpening {
  if (statement.panel !== 1 && statement.panel !== 2)
    throw new RangeError("signPartialOpening: panel is 1 or 2");
  return {
    definition_hash: Uint8Array.from(statement.definition_hash),
    cell: statement.cell,
    panel: statement.panel,
    aggregate_hash: Uint8Array.from(statement.aggregate_hash),
    signer: statement.signer,
    opening: statement.opening.map(({ v, r }) => ({ v, r })),
    signature: signStatement(signingSecret, PARTIAL_TAG, partialOpeningMessage(statement)),
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

export type CellCode =
  | "tally-missing"
  | "tally-opening"
  | "tally-conflict"
  | "tally-range"
  | "tally-question-range";

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
      /** For `tally-question-range`: the first question outside its limits. */
      readonly question?: number;
      readonly passing: readonly OpeningReport[];
      readonly failing: readonly FailingOpening[];
    };

export interface TallyCheck {
  /** True only if every cell passes: the election's result is then every cell's counts. */
  readonly ok: boolean;
  /** The first failing cell, in cell order (verifier 7.2). */
  readonly failure?: {
    readonly cell: number;
    readonly code: CellCode;
    readonly option?: number;
    readonly question?: number;
  };
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

/**
 * The registered seat whose signature attributes `payload`, a tally opening
 * under version 1 or 2, or `null` when none does or it doesn't decode under
 * `pinned` (docs/spec/tally.md, Opening record). For a board
 * operator deciding whether an opening may start the costly read of the
 * counted set (T-52): it judges attribution alone, never whether the opening
 * is boarded, which is `tallyOpeningBoarding`'s.
 */
export function tallyOpeningSigner(
  registered: TallyElection["registered"],
  payload: Uint8Array,
  pinned: WholeOpeningVersion,
): number | null {
  let opening: TallyOpening;
  try {
    opening = decodeTallyOpening(payload, pinned);
  } catch (e) {
    if (e instanceof DecodeError) return null;
    throw e;
  }
  return attribution({ registered }, opening);
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
  { aggregate, counted }: CountedCell,
  openings: readonly SortedTallyOpening[],
): CellCheck {
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
  const bound = BigInt(counted);
  const over = first.opening.findIndex((s) => s.v > bound);
  if (over !== -1) return { ok: false, code: "tally-range", option: over, ...reports };
  // 5. tally-question-range under definition version 5: every question's
  // total within its limits, since each question's result is its slice.
  const counts = first.opening.map((s) => s.v);
  const question = firstQuestionOutside(election.rules, counted, counts);
  if (question !== null) return { ok: false, code: "tally-question-range", question, ...reports };
  return { ok: true, counts, ...reports };
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
  pinned: WholeOpeningVersion,
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
  pinned: WholeOpeningVersion,
): TallyCheck {
  if (!(election.definitionHash instanceof Uint8Array) || election.definitionHash.length !== 32)
    throw new RangeError("checkTally: definitionHash must be 32 bytes");
  if (cells.length < 1 || cells.length > MAX_CELLS)
    throw new RangeError("checkTally: from 1 to 256 cells");
  return checkCells(
    election,
    cells.map((ballots) => ({
      aggregate: aggregateCell(election.rules, ballots),
      counted: ballots.length,
    })),
    payloads,
    pinned,
  );
}

/**
 * One cell of the counted set, summed: its aggregate over the counted
 * ballots (`aggregateCell`) and how many ballots it counts, which is all the
 * opening checks read of them (docs/spec/tally.md, Opening checks).
 */
export interface CountedCell {
  readonly aggregate: CellAggregate;
  readonly counted: number;
}

/**
 * `checkTally` over each cell's aggregate and count rather than its ballots,
 * for a party that keeps the counted set summed, as the board operator does
 * once it has judged openings against it (docs/spec/verifier.md, Results
 * from the counted tally): the same checks in the same order, so it gives
 * exactly what `checkTally` gives over the ballots summed into `cells`
 * (T-29). The cells must be summed from the counted set (`aggregateCell`),
 * never read back from storage: nothing here ties an aggregate or a count to
 * the ballots, and an overcount loosens `tally-range`. Every aggregate must
 * have the election's shape, one row of `k`
 * elements per option, and every count be a whole number of ballots; a cell
 * that doesn't is the caller's error, never an opening's failure.
 */
export function checkCountedTally(
  election: TallyElection,
  cells: readonly CountedCell[],
  payloads: readonly Uint8Array[],
  pinned: WholeOpeningVersion,
): TallyCheck {
  if (!(election.definitionHash instanceof Uint8Array) || election.definitionHash.length !== 32)
    throw new RangeError("checkCountedTally: definitionHash must be 32 bytes");
  if (cells.length < 1 || cells.length > MAX_CELLS)
    throw new RangeError("checkCountedTally: from 1 to 256 cells");
  checkRules(election.rules);
  const { optionCount: m, threshold: k } = election.rules;
  for (const { aggregate, counted } of cells) {
    if (!Number.isSafeInteger(counted) || counted < 0)
      throw new RangeError("checkCountedTally: a cell's count must be a whole number");
    if (aggregate.length !== m || aggregate.some((row) => row.length !== k))
      throw new RangeError("checkCountedTally: an aggregate doesn't match the election's shape");
  }
  return checkCells(election, cells, payloads, pinned);
}

function checkCells(
  election: TallyElection,
  cells: readonly CountedCell[],
  payloads: readonly Uint8Array[],
  pinned: WholeOpeningVersion,
): TallyCheck {
  const byCell = cells.map(() => [] as SortedTallyOpening[]);
  const stray: OpeningReport[] = [];
  const rejected: { at: number; error: DecodeErrorCode }[] = [];
  for (const o of sortTallyOpenings(election, cells.length, payloads, pinned)) {
    if ("error" in o) rejected.push(o);
    else if (o.cell === null) stray.push({ at: o.at, signer: o.signer });
    else byCell[o.cell]?.push(o);
  }
  const checked = cells.map((cell, c) => checkCell(election, cell, byCell[c] ?? []));
  const at = checked.findIndex((c) => !c.ok);
  if (at === -1) return { ok: true, cells: checked, stray, rejected };
  const bad = checked[at] as Extract<CellCheck, { ok: false }>;
  const failure = {
    cell: at,
    code: bad.code,
    ...(bad.option === undefined ? {} : { option: bad.option }),
    ...(bad.question === undefined ? {} : { question: bad.question }),
  };
  return { ok: false, failure, cells: checked, stray, rejected };
}

/**
 * Why the board operator refuses a tally opening (docs/spec/tally.md,
 * Opening record, Boarding), in that rule's order, with Opening record's
 * codes: `decode` for a payload that doesn't decode under the pinned version,
 * `tally-stray` for another definition or a cell the partition doesn't have,
 * `tally-missing` for another number of entries than options,
 * `tally-aggregate` for an opening over another counted set,
 * `tally-opening` for one not opening `option`, `tally-unattributed`, and
 * `tally-second` or `tally-repeat` for a second opening of the cell by the
 * same seat (over another signed message, or the same one) found at `of`.
 */
export type TallyBoarding =
  | { readonly ok: true; readonly cell: number; readonly signer: number }
  | { readonly ok: false; readonly code: "decode"; readonly error: DecodeErrorCode }
  | {
      readonly ok: false;
      readonly code: "tally-stray" | "tally-missing" | "tally-aggregate" | "tally-unattributed";
    }
  | { readonly ok: false; readonly code: "tally-opening"; readonly option: number }
  | { readonly ok: false; readonly code: "tally-second" | "tally-repeat"; readonly of: number };

/**
 * The board operator's Boarding rule for one tally opening under version 1 or
 * 2 (docs/spec/tally.md, Opening record, Boarding): `payload` is boarded only
 * if it names this election's definition and a cell of the registered
 * partition, its `aggregate_hash` is that cell's over the anchored counted
 * set, it opens every option of that aggregate, its signature attributes it
 * to a registered seat, and no opening of that cell by that seat is among
 * `boarded`, the tally-opening payloads already on the board in board order
 * (`of` is a position in it). `aggregates` holds each cell's aggregate over
 * the anchored counted set (`aggregateCell`), one per cell of the registered
 * partition in partition order, so a caller judging many openings sums each
 * cell's ballots once; its length is taken as the partition's size, so a
 * caller passing fewer would refuse a real cell's openings as stray.
 *
 * A seat's node resends an opening until the seal, so its caller should
 * answer `tally-repeat` with the entry at `of` rather than an error.
 *
 * Every opening it passes is fixed by its cell's aggregate (binding), so the
 * board carries no chosen bytes beyond a registered seat's signature nonce,
 * at most one per seat and cell, and no summed shares disguised as a failing
 * opening (T-15, T-17). It judges the opening alone, never the cell: a
 * passing opening still fails `tally-range` if the counted set is wrong,
 * which only the verifier's checks over the sealed board decide.
 */
export function tallyOpeningBoarding(
  election: TallyElection,
  aggregates: readonly CellAggregate[],
  boarded: readonly Uint8Array[],
  payload: Uint8Array,
  pinned: WholeOpeningVersion,
): TallyBoarding {
  if (!(election.definitionHash instanceof Uint8Array) || election.definitionHash.length !== 32)
    throw new RangeError("tallyOpeningBoarding: definitionHash must be 32 bytes");
  if (aggregates.length < 1 || aggregates.length > MAX_CELLS)
    throw new RangeError("tallyOpeningBoarding: from 1 to 256 cells");
  const m = election.rules.optionCount;
  if (aggregates.some((a) => a.length !== m))
    throw new RangeError("tallyOpeningBoarding: an aggregate doesn't match the election's shape");
  const [sorted] = sortTallyOpenings(election, aggregates.length, [payload], pinned);
  if (sorted === undefined) throw new Error("tallyOpeningBoarding: sorted no opening");
  if ("error" in sorted) return { ok: false, code: "decode", error: sorted.error };
  const { cell, signer, opening } = sorted;
  if (cell === null) return { ok: false, code: "tally-stray" };
  if (opening.opening.length !== m) return { ok: false, code: "tally-missing" };
  const aggregate = aggregates[cell] as CellAggregate;
  if (!sameBytes(opening.aggregate_hash, aggregateHash(aggregate)))
    return { ok: false, code: "tally-aggregate" };
  const option = firstUnopened(aggregate, opening.opening);
  if (option !== null) return { ok: false, code: "tally-opening", option };
  if (signer === null) return { ok: false, code: "tally-unattributed" };
  // An earlier opening is the seat's only when its signature attributes it
  // there: anyone can write an unattributed one naming the seat, which must
  // never keep the seat's own off the board (T-29, T-54).
  const signed = tallyOpeningStatement(opening);
  for (const [at, payload] of boarded.entries()) {
    let earlier: TallyOpening;
    try {
      earlier = decodeTallyOpening(payload, pinned);
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      continue;
    }
    // Only an opening of this cell naming this seat can be the seat's, so
    // only those cost a signature check: a board of others' openings is
    // judged without verifying each (T-52).
    if (
      earlier.cell !== cell ||
      earlier.signer !== signer ||
      !sameBytes(earlier.definition_hash, election.definitionHash) ||
      attribution(election, earlier) !== signer
    )
      continue;
    // Anyone can replay a signed record, so a repeat is refused like a
    // second, though only a second is evidence against the seat (T-29).
    const code = sameBytes(tallyOpeningStatement(earlier), signed)
      ? "tally-repeat"
      : "tally-second";
    return { ok: false, code, of: at };
  }
  return { ok: true, cell, signer };
}

// --- Version 3: partial openings under an author panel -------------------------

type Registered = readonly { readonly index: number; readonly signingKey: Uint8Array }[];

/** What a version-3 tally is checked against, all from data the verifier has already checked. */
export interface PartialTallyElection {
  readonly definitionHash: Uint8Array;
  /** `panelTallyRules(definition, 1)`: the default panel's half. */
  readonly defaultRules: TallyRules;
  /** `panelTallyRules(definition, 2)`: the author panel's half. */
  readonly authorRules: TallyRules;
  /**
   * Each panel's registered key set: the default panel's from the transcript
   * check of `ceremony_transcript_hash`, the author panel's from that of
   * `author_transcript_hash` once the author approvals approve it
   * (docs/spec/tally.md, Panels and counted set). Only a seat of the panel an
   * opening names attributes it (T-37).
   */
  readonly registered: { readonly default: Registered; readonly author: Registered };
}

/** A version-3 tally-opening payload in the board's sealed extent, with its entry's segment. */
export interface PartialTallyEntry {
  readonly segment: number;
  readonly payload: Uint8Array;
}

/** A counted ballot's two halves: the default panel's commitments and the author panel's. */
export type BallotHalves = Pick<CommittedVoteV4, "vss" | "author_vss">;

/**
 * One panel's openings of a cell: those that open its aggregate, with each
 * one's segment (the first gives the destruction timing's `firstPassing`),
 * and the rest.
 */
export interface PanelOpenings {
  readonly passing: readonly (OpeningReport & { readonly segment: number })[];
  readonly failing: readonly FailingOpening[];
}

export type PartialCellCode = CellCode | "tally-author-late";

/**
 * One cell's verdict under version 3 (docs/spec/tally.md, Opening checks
 * (version 3)). `panel` names the panel a failure is of, where it names one;
 * `tally-author-late` names none: it is the author panel's or the board
 * operator's, never the default panel's.
 */
export type PartialCellCheck =
  | {
      readonly ok: true;
      /** `V_{c,j} = V^D_{c,j} + V^A_{c,j} mod ℓ`: the cell's counts. */
      readonly counts: readonly bigint[];
      readonly default: PanelOpenings;
      readonly author: PanelOpenings;
    }
  | {
      readonly ok: false;
      readonly code: PartialCellCode;
      readonly panel?: 1 | 2;
      readonly option?: number;
      readonly question?: number;
      readonly default: PanelOpenings;
      readonly author: PanelOpenings;
    };

export interface PartialTallyCheck {
  /** True only if every cell passes: the election's result is then every cell's counts. */
  readonly ok: boolean;
  /** The first failing cell, in cell order (verifier 7.2). */
  readonly failure?: {
    readonly cell: number;
    readonly code: PartialCellCode;
    readonly panel?: 1 | 2;
    readonly option?: number;
    readonly question?: number;
  };
  readonly cells: readonly PartialCellCheck[];
  /**
   * Openings naming another definition, a cell the partition doesn't have or
   * a panel other than 1 and 2, with their panel byte and the seat of that
   * panel their signature attributes them to, if any (verifier 7.4).
   */
  readonly stray: readonly (OpeningReport & { readonly panel: number })[];
  /**
   * Default partial openings boarded before every cell had a passing author
   * partial opening: breaches of the boarding rule, the operator's, which
   * still count if they pass (`tally-early`; Boarding (version 3)).
   */
  readonly early: readonly OpeningReport[];
  /** Payloads that don't decode under version 3: rejected entries, never an election failure. */
  readonly rejected: readonly { readonly at: number; readonly error: DecodeErrorCode }[];
}

/** A decoded version-3 tally opening, sorted and attributed (docs/spec/tally.md, Which openings are a cell's). */
export interface SortedPartialOpening extends OpeningReport {
  readonly segment: number;
  /** The cell it is an opening of, or `null` for a stray opening. */
  readonly cell: number | null;
  readonly opening: PartialOpening;
}

const isSegment = (s: number) => Number.isInteger(s) && s >= 0 && s <= 0xffffffff;

/**
 * The seat of panel `panel` an opening's signature attributes it to: its
 * `signer`, if `panel` is 1 or 2, `signer` is a seat of that panel's
 * registered key set and the signature verifies under its key; otherwise
 * `null`. The message binds the panel, so an author seat's partial opening is
 * never attributed to the default seat with its index (T-29, T-37).
 */
function partialAttribution(
  registered: PartialTallyElection["registered"],
  o: PartialOpening,
): number | null {
  const set = o.panel === 1 ? registered.default : o.panel === 2 ? registered.author : undefined;
  const seat = set?.find((k) => k.index === o.signer);
  if (seat === undefined) return null;
  return verifyStatement(seat.signingKey, PARTIAL_TAG, partialOpeningMessage(o), o.signature)
    ? o.signer
    : null;
}

function checkPartialElection(election: PartialTallyElection, what: string): void {
  if (!(election.definitionHash instanceof Uint8Array) || election.definitionHash.length !== 32)
    throw new RangeError(`${what}: definitionHash must be 32 bytes`);
  const { defaultRules: d, authorRules: a } = election;
  if (d.panel !== 1 || a.panel !== 2)
    throw new RangeError(`${what}: the rules must be panelTallyRules' for panels 1 and 2`);
  const sameQuestions =
    d.questions?.length === a.questions?.length &&
    (d.questions ?? []).every((q, i) => {
      const o = a.questions?.[i];
      return (
        o !== undefined &&
        q.optionCount === o.optionCount &&
        q.minSelections === o.minSelections &&
        q.maxSelections === o.maxSelections
      );
    });
  if (d.optionCount !== a.optionCount || !sameQuestions)
    throw new RangeError(`${what}: both panels' rules must be one definition's`);
}

/**
 * Every version-3 tally-opening entry, in the order given, decoded and either
 * sorted into an opening of a cell for its panel (this election's definition
 * hash, a cell below `cellCount` and panel 1 or 2) or a stray opening, with
 * the seat of its panel its signature attributes it to; or, if it doesn't
 * decode under version 3, its decoding code: a rejected entry
 * (docs/spec/tally.md, Opening record (version 3), Which openings are a
 * cell's). `at` is a position in `entries`. Needs no counted set.
 */
export function sortPartialOpenings(
  election: Pick<PartialTallyElection, "definitionHash" | "registered">,
  cellCount: number,
  entries: readonly PartialTallyEntry[],
): (SortedPartialOpening | { readonly at: number; readonly error: DecodeErrorCode })[] {
  if (!(election.definitionHash instanceof Uint8Array) || election.definitionHash.length !== 32)
    throw new RangeError("sortPartialOpenings: definitionHash must be 32 bytes");
  if (!Number.isInteger(cellCount) || cellCount < 1 || cellCount > MAX_CELLS)
    throw new RangeError("sortPartialOpenings: from 1 to 256 cells");
  return entries.map(({ segment, payload }, at) => {
    if (!isSegment(segment)) throw new RangeError("sortPartialOpenings: segments must be u32");
    let opening: PartialOpening;
    try {
      opening = decodePartialOpening(payload, 3);
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      return { at, error: e.code };
    }
    const mine =
      sameBytes(opening.definition_hash, election.definitionHash) &&
      opening.cell < cellCount &&
      (opening.panel === 1 || opening.panel === 2);
    return {
      at,
      segment,
      signer: partialAttribution(election.registered, opening),
      cell: mine ? opening.cell : null,
      opening,
    };
  });
}

/** One panel's openings of a cell against the panel's aggregate, as Opening checks, steps 1 and 2, sort them. */
function panelOpenings(
  rules: TallyRules,
  halves: readonly CommittedVote["vss"][],
  openings: readonly SortedPartialOpening[],
) {
  const aggregate = aggregateCell(rules, halves);
  const expected = aggregateHash(aggregate);
  const m = rules.optionCount;
  const passing: (OpeningReport & {
    readonly segment: number;
    readonly opening: readonly Share[];
  })[] = [];
  const failing: FailingOpening[] = [];
  for (const { at, signer, segment, opening: o } of openings) {
    if (o.opening.length !== m) failing.push({ at, signer, code: "tally-missing" });
    else if (!sameBytes(o.aggregate_hash, expected))
      failing.push({ at, signer, code: "tally-aggregate" });
    else {
      const option = firstUnopened(aggregate, o.opening);
      if (option === null) passing.push({ at, signer, segment, opening: o.opening });
      else failing.push({ at, signer, code: "tally-opening", option });
    }
  }
  return { passing, failing };
}

type Evaluated = ReturnType<typeof panelOpenings>;

const reportOf = (e: Evaluated): PanelOpenings => ({
  passing: e.passing.map(({ at, signer, segment }) => ({ at, signer, segment })),
  failing: e.failing,
});

function partialVerdict(
  rules: TallyRules,
  ballotCount: number,
  author: Evaluated,
  dflt: Evaluated,
  authorLate: boolean,
): PartialCellCheck {
  const reports = { default: reportOf(dflt), author: reportOf(author) };
  const panels = [
    [2, author],
    [1, dflt],
  ] as const;
  // 1. tally-missing, the author panel first: no opening of the cell for the
  // panel has m entries. A default one missing while an author opening of
  // some cell was late is the author panel's or the operator's, never the
  // default panel's (Whose failure).
  for (const [panel, e] of panels)
    if (e.passing.length === 0 && e.failing.every((f) => f.code === "tally-missing")) {
      if (panel === 1 && authorLate) return { ok: false, code: "tally-author-late", ...reports };
      return { ok: false, code: "tally-missing", panel, ...reports };
    }
  // 2. tally-opening: none of a panel's full-length openings passes; the first
  // of them in board order names its first failing option, unless it is over
  // another counted set.
  for (const [panel, e] of panels)
    if (e.passing.length === 0) {
      const f = e.failing.find((x) => x.code !== "tally-missing");
      return f?.option === undefined
        ? { ok: false, code: "tally-opening", panel, ...reports }
        : { ok: false, code: "tally-opening", panel, option: f.option, ...reports };
    }
  // 3. tally-conflict: two passing openings of one panel differ, which only a
  // break of binding allows.
  for (const [panel, e] of panels) {
    const first = e.passing[0];
    if (first !== undefined && e.passing.some((p) => differ(p.opening, first.opening)))
      return { ok: false, code: "tally-conflict", panel, ...reports };
  }
  // 4. tally-range on the cell's count, the sum of both partial openings
  // mod ℓ; a partial opening's own V is uniform and never range-checked.
  const a = (author.passing[0] as Evaluated["passing"][number]).opening;
  const d = (dflt.passing[0] as Evaluated["passing"][number]).opening;
  const counts = d.map((s, j) => (s.v + (a[j] as Share).v) % GROUP_ORDER);
  const bound = BigInt(ballotCount);
  const over = counts.findIndex((v) => v > bound);
  if (over !== -1) return { ok: false, code: "tally-range", option: over, ...reports };
  // 5. tally-question-range on the cell's counts.
  const question = firstQuestionOutside(rules, ballotCount, counts);
  if (question !== null) return { ok: false, code: "tally-question-range", question, ...reports };
  return { ok: true, counts, ...reports };
}

/**
 * The verifier's tally check under tally-opening version 3
 * (docs/spec/tally.md, Author panel: Opening checks (version 3) and Boarding
 * (version 3); verifier 7.2 to 7.4). `cells` holds each cell's counted
 * ballots' two halves, in partition order, over the one counted set both
 * panels sum over; `entries` every tally-opening payload (record type
 * `0x0006`) in the board's sealed extent, in board order, with its segment,
 * and `at` in every report is a position in it. `authorDeadline` is `s_A`,
 * the anchoring period containing `t_S + AUTHOR_OPENING_WINDOW`: a cell with
 * no default partial opening while some cell had no passing author one at or
 * before it fails `tally-author-late`. Each cell's count is the sum of both
 * panels' passing partial openings, range-checked only as a sum.
 */
export function checkPartialTally(
  election: PartialTallyElection,
  cells: readonly (readonly BallotHalves[])[],
  entries: readonly PartialTallyEntry[],
  authorDeadline: number,
): PartialTallyCheck {
  checkPartialElection(election, "checkPartialTally");
  if (cells.length < 1 || cells.length > MAX_CELLS)
    throw new RangeError("checkPartialTally: from 1 to 256 cells");
  if (!isSegment(authorDeadline))
    throw new RangeError("checkPartialTally: authorDeadline must be a u32");
  const byCell = cells.map(() => ({
    1: [] as SortedPartialOpening[],
    2: [] as SortedPartialOpening[],
  }));
  const stray: (OpeningReport & { panel: number })[] = [];
  const rejected: { at: number; error: DecodeErrorCode }[] = [];
  for (const o of sortPartialOpenings(election, cells.length, entries)) {
    if ("error" in o) rejected.push(o);
    else if (o.cell === null) stray.push({ at: o.at, signer: o.signer, panel: o.opening.panel });
    else byCell[o.cell]?.[o.opening.panel as 1 | 2].push(o);
  }
  const evaluated = cells.map((ballots, c) => ({
    author: panelOpenings(
      election.authorRules,
      ballots.map((b) => b.author_vss),
      byCell[c]?.[2] ?? [],
    ),
    dflt: panelOpenings(
      election.defaultRules,
      ballots.map((b) => b.vss),
      byCell[c]?.[1] ?? [],
    ),
  }));
  // Some cell has no passing author partial opening in a segment at or
  // before s_A (Whose failure).
  const authorLate = evaluated.some(
    ({ author }) => !author.passing.some((p) => p.segment <= authorDeadline),
  );
  // tally-early: a default partial opening boarded before the board held a
  // passing author partial opening of every cell (Boarding (version 3)).
  const allAuthor = evaluated.reduce(
    (latest, { author }) => Math.max(latest, author.passing[0]?.at ?? Number.POSITIVE_INFINITY),
    -1,
  );
  const early = byCell
    .flatMap((c) => c[1])
    .filter((o) => o.at < allAuthor)
    .sort((x, y) => x.at - y.at)
    .map(({ at, signer }) => ({ at, signer }));
  const checked = evaluated.map(({ author, dflt }, c) =>
    partialVerdict(
      election.defaultRules,
      (cells[c] as readonly BallotHalves[]).length,
      author,
      dflt,
      authorLate,
    ),
  );
  const at = checked.findIndex((c) => !c.ok);
  if (at === -1) return { ok: true, cells: checked, stray, early, rejected };
  const bad = checked[at] as Extract<PartialCellCheck, { ok: false }>;
  const failure = {
    cell: at,
    code: bad.code,
    ...(bad.panel === undefined ? {} : { panel: bad.panel }),
    ...(bad.option === undefined ? {} : { option: bad.option }),
    ...(bad.question === undefined ? {} : { question: bad.question }),
  };
  return { ok: false, failure, cells: checked, stray, early, rejected };
}
