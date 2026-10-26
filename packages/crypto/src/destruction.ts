// The destruction statement (docs/spec/tally.md, Destruction; record type
// 0x000f): a trustee's signed claim, on the board, that it destroyed its
// per-election key material after the tally, and the verifier's report over
// every statement on the board (verifier 8.5). Destruction can't be proven, so
// the report never fails an election: a rule that did would give every
// trustee a veto over the result (T-14, T-40, T-69, T-54). Version 2, which
// tally-opening version 3 fixes, names the seat's panel, and the report holds
// per seat of both panels (docs/spec/tally.md, Windows and destruction
// (version 2)).

import {
  bytesFixed,
  type CodecValue,
  DecodeError,
  type DecodeErrorCode,
  enum8,
  struct,
  u8,
  u16,
  Writer,
} from "./codec.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
import { p256Sig, signStatement, verifyStatement } from "./trustee.ts";

const TAG = "abolish/v1/sig/destruction";

const statementFields = [
  ["definition_hash", bytesFixed(32)],
  ["signer", u8],
] as const;

const statementV1 = struct(statementFields);

const destructionV1 = struct([...statementFields, ["signature", p256Sig]] as const);

// Version 1's fields with `panel` after `definition_hash`.
const statementV2 = struct([
  ["definition_hash", bytesFixed(32)],
  ["panel", enum8([1, 2])],
  ["signer", u8],
] as const);

const destructionV2 = struct([
  ["definition_hash", bytesFixed(32)],
  ["panel", enum8([1, 2])],
  ["signer", u8],
  ["signature", p256Sig],
] as const);

/** What the signer states: the election and its seat. */
export type DestructionStatementFields = CodecValue<typeof statementV1>;

/** Destruction statement, version 1 (docs/spec/tally.md, Destruction). */
export type DestructionStatement = CodecValue<typeof destructionV1>;

/** What a seat of either panel states under version 2: the election, its panel and its seat. */
export type PanelDestructionStatementFields = CodecValue<typeof statementV2>;

/** Destruction statement, version 2 (docs/spec/tally.md, Windows and destruction (version 2)). */
export type PanelDestructionStatement = CodecValue<typeof destructionV2>;

/**
 * Record type `0x000f`. No profile pins it: the pinned tally-opening version
 * fixes it, version 1 under tally-opening version 1 and version 2 under
 * version 3.
 */
export const DESTRUCTION_STATEMENT = recordType(RECORD_TYPES.destructionStatement, {
  1: destructionV1,
  2: destructionV2,
});

const SCHEMA = new RecordSchema([DESTRUCTION_STATEMENT]);

export function encodeDestructionStatement(statement: DestructionStatement): Uint8Array {
  return SCHEMA.encode(DESTRUCTION_STATEMENT, 1, statement);
}

/** Strictly decodes a destruction statement under version 1, the version tally opening 1 fixes. */
export function decodeDestructionStatement(bytes: Uint8Array, pinned: 1): DestructionStatement {
  const r = SCHEMA.decode(DESTRUCTION_STATEMENT, bytes, pinned);
  // Unreachable: the pin refused every other version.
  if (r.version !== 1) throw new RangeError("destruction statement: not version 1");
  return r.value;
}

export function encodePanelDestructionStatement(statement: PanelDestructionStatement): Uint8Array {
  return SCHEMA.encode(DESTRUCTION_STATEMENT, 2, statement);
}

/** Strictly decodes a destruction statement under version 2, the version tally opening 3 fixes. */
export function decodePanelDestructionStatement(
  bytes: Uint8Array,
  pinned: 2,
): PanelDestructionStatement {
  const r = SCHEMA.decode(DESTRUCTION_STATEMENT, bytes, pinned);
  // Unreachable: the pin refused every other version.
  if (r.version !== 2) throw new RangeError("destruction statement: not version 2");
  return r.value;
}

/**
 * `u16(0x000f) ‖ u8(1) ‖ definition_hash ‖ u8(signer)`: the record without its
 * signature, header included, so a later version can't reuse a version 1
 * signature (T-31).
 */
export function destructionStatementMessage(fields: DestructionStatementFields): Uint8Array {
  const w = new Writer();
  u16.write(w, RECORD_TYPES.destructionStatement);
  u8.write(w, 1);
  // Through the struct, so only these fields are read even from a whole record.
  statementV1.write(w, { definition_hash: fields.definition_hash, signer: fields.signer });
  return w.finish();
}

/**
 * `u16(0x000f) ‖ u8(2) ‖ definition_hash ‖ u8(panel) ‖ u8(signer)`: version
 * 2's record without its signature, header included, so no statement of one
 * version serves as the other's, and a default seat's never as the author
 * seat's with its index (T-31, T-37).
 */
export function panelDestructionStatementMessage(
  fields: PanelDestructionStatementFields,
): Uint8Array {
  const w = new Writer();
  u16.write(w, RECORD_TYPES.destructionStatement);
  u8.write(w, 2);
  statementV2.write(w, {
    definition_hash: fields.definition_hash,
    panel: fields.panel,
    signer: fields.signer,
  });
  return w.finish();
}

/**
 * Signs seat `(panel, signer)`'s version-2 destruction statement: as
 * `signDestructionStatement`, for its own half's material, once every cell
 * has a passing opening for each panel or at `t_D`.
 */
export function signPanelDestructionStatement(
  signingSecret: Uint8Array,
  fields: PanelDestructionStatementFields,
): PanelDestructionStatement {
  return {
    definition_hash: Uint8Array.from(fields.definition_hash),
    panel: fields.panel,
    signer: fields.signer,
    signature: signStatement(signingSecret, TAG, panelDestructionStatementMessage(fields)),
  };
}

/**
 * Signs a seat's destruction statement with its per-election signing key. A
 * node signs only once it has destroyed everything docs/spec/tally.md
 * (Destruction, What) lists, and destroys the signing key once it holds the
 * result: this is the key's last use.
 */
export function signDestructionStatement(
  signingSecret: Uint8Array,
  fields: DestructionStatementFields,
): DestructionStatement {
  return {
    definition_hash: Uint8Array.from(fields.definition_hash),
    signer: fields.signer,
    signature: signStatement(signingSecret, TAG, destructionStatementMessage(fields)),
  };
}

/** What the statements are checked against, all from data the verifier has already checked. */
export interface DestructionElection {
  readonly definitionHash: Uint8Array;
  /**
   * The election's registered key set ([[ceremony]], Transcript check): each
   * qualified seat and its per-election signing key. Only these attribute.
   */
  readonly registered: readonly { readonly index: number; readonly signingKey: Uint8Array }[];
}

/** A destruction-statement payload in the board's sealed extent, with its entry's segment. */
export interface DestructionEntry {
  readonly segment: number;
  readonly payload: Uint8Array;
}

/** Where the tally stood, from the tally check and the anchoring clock. */
export interface DestructionTiming {
  /**
   * For each cell of the partition, the segment of its first passing opening
   * in board order (`checkTally`'s first `passing` entry), or `null` if it has
   * none.
   */
  readonly firstPassing: readonly (number | null)[];
  /** `s_T`: the anchoring period containing `t_S + TALLY_WINDOW`. */
  readonly windowSegment: number;
}

export type SeatDestruction =
  | { readonly seat: number; readonly code: "destroyed" | "destruction-early"; readonly at: number }
  | { readonly seat: number; readonly code: "destruction-missing" };

export interface DestructionReport {
  /** The destruction segment: `min(s_O + 1, s_T)`, or `s_T` if some cell has no passing opening. */
  readonly from: number;
  /** One line per registered seat, in the key set's order. */
  readonly seats: readonly SeatDestruction[];
  /** A registered seat's later attributed statements: breaches of the boarding rule. */
  readonly duplicates: readonly { readonly at: number; readonly seat: number }[];
  /** Statements naming this definition that no registered seat's signature attributes. */
  readonly unattributed: readonly { readonly at: number }[];
  /** Statements naming another definition, with the seat this election's keys attribute them to, if any. */
  readonly stray: readonly { readonly at: number; readonly signer: number | null }[];
  /** Payloads that don't decode under version 1: rejected entries. */
  readonly rejected: readonly { readonly at: number; readonly error: DecodeErrorCode }[];
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const isSegment = (s: number) => Number.isInteger(s) && s >= 0 && s <= 0xffffffff;

/** The seat a statement's signature attributes it to, or `null` (T-29). */
function attribution(election: DestructionElection, s: DestructionStatement): number | null {
  const seat = election.registered.find((k) => k.index === s.signer);
  if (seat === undefined) return null;
  return verifyStatement(seat.signingKey, TAG, destructionStatementMessage(s), s.signature)
    ? s.signer
    : null;
}

/** The destruction segment (docs/spec/tally.md, Destruction checks). */
export function destructionSegment(timing: DestructionTiming): number {
  const { firstPassing, windowSegment } = timing;
  if (!isSegment(windowSegment))
    throw new RangeError("destructionSegment: windowSegment must be a u32");
  if (firstPassing.length < 1 || firstPassing.length > 256)
    throw new RangeError("destructionSegment: from 1 to 256 cells");
  let latest = -1;
  for (const s of firstPassing) {
    if (s === null) return windowSegment;
    if (!isSegment(s)) throw new RangeError("destructionSegment: segments must be u32");
    latest = Math.max(latest, s);
  }
  return Math.min(latest + 1, windowSegment);
}

/**
 * The verifier's destruction report (docs/spec/tally.md, Destruction checks;
 * verifier 8.5). `entries` holds every destruction-statement payload (record
 * type `0x000f`) in the board's sealed extent, in board order, and `at` in
 * every report is a position in it. It reports signed claims only, and
 * nothing in it fails the election.
 */
export function checkDestruction(
  election: DestructionElection,
  entries: readonly DestructionEntry[],
  timing: DestructionTiming,
  pinned: 1,
): DestructionReport {
  if (!(election.definitionHash instanceof Uint8Array) || election.definitionHash.length !== 32)
    throw new RangeError("checkDestruction: definitionHash must be 32 bytes");
  const from = destructionSegment(timing);
  const first = new Map<number, { at: number; segment: number }>();
  const duplicates: { at: number; seat: number }[] = [];
  const unattributed: { at: number }[] = [];
  const stray: { at: number; signer: number | null }[] = [];
  const rejected: { at: number; error: DecodeErrorCode }[] = [];
  entries.forEach(({ segment, payload }, at) => {
    if (!isSegment(segment)) throw new RangeError("checkDestruction: segments must be u32");
    let statement: DestructionStatement;
    try {
      statement = decodeDestructionStatement(payload, pinned);
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      rejected.push({ at, error: e.code });
      return;
    }
    const seat = attribution(election, statement);
    if (!sameBytes(statement.definition_hash, election.definitionHash)) {
      stray.push({ at, signer: seat });
    } else if (seat === null) {
      unattributed.push({ at });
    } else if (first.has(seat)) {
      duplicates.push({ at, seat });
    } else {
      first.set(seat, { at, segment });
    }
  });
  const seats = election.registered.map(({ index }): SeatDestruction => {
    const s = first.get(index);
    if (s === undefined) return { seat: index, code: "destruction-missing" };
    return { seat: index, code: s.segment >= from ? "destroyed" : "destruction-early", at: s.at };
  });
  return { from, seats, duplicates, unattributed, stray, rejected };
}

/**
 * The Boarding rule's verdict on one destruction statement: the seat its
 * signature attributes it to, or why it is refused: `decode` for a payload
 * that doesn't decode strictly, `destruction-stray` for one naming another
 * definition, `destruction-unattributed` for one no registered seat's
 * signature attributes, and `destruction-repeat` when a statement attributed
 * to the same seat is already boarded, found at `of`.
 */
export type DestructionBoarding =
  | { readonly ok: true; readonly signer: number }
  | { readonly ok: false; readonly code: "decode"; readonly error: DecodeErrorCode }
  | { readonly ok: false; readonly code: "destruction-stray" | "destruction-unattributed" }
  | { readonly ok: false; readonly code: "destruction-repeat"; readonly of: number };

/**
 * The board operator's Boarding rule for one destruction statement under
 * version 1 (docs/spec/tally.md, Destruction, Boarding): `payload` is boarded
 * only if it decodes strictly, names this election's definition, its
 * signature attributes it to a registered seat, and no statement attributed
 * to that seat is among `boarded`, the destruction-statement payloads already
 * on the board in board order (`of` is a position in it). Timing is never
 * judged: a statement boarded early is the seat's to explain, and 8.5 reports
 * it.
 *
 * Every statement it passes is fixed but for the seat's ECDSA nonce, at most
 * one per seat, so the board carries no other chosen bytes (T-17); any
 * statement this refuses, 8.5 would list as rejected, stray, unattributed or
 * a duplicate against the operator. A seat signs one message per election,
 * so a second attributed statement is always the same signed message: its
 * caller should answer `destruction-repeat` with the entry at `of`, since a
 * node resends its statement until it is boarded.
 */
export function destructionBoarding(
  election: DestructionElection,
  boarded: readonly Uint8Array[],
  payload: Uint8Array,
  pinned: 1,
): DestructionBoarding {
  if (!(election.definitionHash instanceof Uint8Array) || election.definitionHash.length !== 32)
    throw new RangeError("destructionBoarding: definitionHash must be 32 bytes");
  let statement: DestructionStatement;
  try {
    statement = decodeDestructionStatement(payload, pinned);
  } catch (e) {
    if (!(e instanceof DecodeError)) throw e;
    return { ok: false, code: "decode", error: e.code };
  }
  if (!sameBytes(statement.definition_hash, election.definitionHash))
    return { ok: false, code: "destruction-stray" };
  const signer = attribution(election, statement);
  if (signer === null) return { ok: false, code: "destruction-unattributed" };
  for (const [at, earlier] of boarded.entries()) {
    let s: DestructionStatement;
    try {
      s = decodeDestructionStatement(earlier, pinned);
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      continue;
    }
    // Only a statement naming this definition and seat can be the seat's, so
    // only those cost a signature check; one anyone wrote naming the seat
    // without its signature never keeps the seat's own off the board (T-29,
    // T-52, T-54).
    if (
      s.signer === signer &&
      sameBytes(s.definition_hash, election.definitionHash) &&
      attribution(election, s) === signer
    )
      return { ok: false, code: "destruction-repeat", of: at };
  }
  return { ok: true, signer };
}

// --- Version 2: both panels' seats ----------------------------------------------

type Registered = DestructionElection["registered"];

/** What version-2 statements are checked against: each panel's registered key set. */
export interface PanelDestructionElection {
  readonly definitionHash: Uint8Array;
  readonly registered: { readonly default: Registered; readonly author: Registered };
}

/** Where the tally stood for both panels. */
export interface PanelDestructionTiming {
  /**
   * For each cell, the segment of its first passing opening for the default
   * panel and for the author panel (`checkPartialTally`'s first `passing`
   * entry of each), or `null` where it has none.
   */
  readonly firstPassing: readonly {
    readonly default: number | null;
    readonly author: number | null;
  }[];
  /** `s_T`: the anchoring period containing `t_S + TALLY_WINDOW`. */
  readonly windowSegment: number;
}

export type PanelSeatDestruction = SeatDestruction & { readonly panel: 1 | 2 };

export interface PanelDestructionReport {
  /** `min(s_O + 1, s_T)` over cells and both panels, or `s_T` if some cell lacks either panel's passing opening. */
  readonly from: number;
  /** One line per registered seat: the default panel's in key-set order, then the author panel's. */
  readonly seats: readonly PanelSeatDestruction[];
  readonly duplicates: readonly {
    readonly at: number;
    readonly panel: 1 | 2;
    readonly seat: number;
  }[];
  readonly unattributed: readonly { readonly at: number }[];
  readonly stray: readonly {
    readonly at: number;
    readonly panel: 1 | 2;
    readonly signer: number | null;
  }[];
  /** Payloads that don't decode under version 2, a version-1 statement included: rejected entries. */
  readonly rejected: readonly { readonly at: number; readonly error: DecodeErrorCode }[];
}

/** Seat `(panel, signer)`, if the statement's signature verifies under that seat's registered key, or `null`. */
function panelAttribution(
  election: PanelDestructionElection,
  s: PanelDestructionStatement,
): number | null {
  const set = s.panel === 1 ? election.registered.default : election.registered.author;
  const seat = set.find((k) => k.index === s.signer);
  if (seat === undefined) return null;
  return verifyStatement(seat.signingKey, TAG, panelDestructionStatementMessage(s), s.signature)
    ? s.signer
    : null;
}

/**
 * The destruction segment under version 2 (docs/spec/tally.md, Windows and
 * destruction (version 2), Checks): `s_O` is the latest, over cells and both
 * panels, of the segment of the first passing opening, since a seat of one
 * panel waits for the other panel's partial openings too.
 */
export function panelDestructionSegment(timing: PanelDestructionTiming): number {
  const { firstPassing, windowSegment } = timing;
  if (firstPassing.length < 1 || firstPassing.length > 256)
    throw new RangeError("panelDestructionSegment: from 1 to 256 cells");
  return destructionSegment({
    firstPassing: firstPassing.flatMap((c) => [c.default, c.author]),
    windowSegment,
  });
}

/**
 * The verifier's destruction report under version 2 (verifier 8.5): as
 * `checkDestruction`, per seat of each panel, with every statement attributed
 * only to a seat of the panel it names. Nothing in it fails the election.
 */
export function checkPanelDestruction(
  election: PanelDestructionElection,
  entries: readonly DestructionEntry[],
  timing: PanelDestructionTiming,
  pinned: 2,
): PanelDestructionReport {
  if (!(election.definitionHash instanceof Uint8Array) || election.definitionHash.length !== 32)
    throw new RangeError("checkPanelDestruction: definitionHash must be 32 bytes");
  const from = panelDestructionSegment(timing);
  const first = new Map<string, { at: number; segment: number }>();
  const duplicates: { at: number; panel: 1 | 2; seat: number }[] = [];
  const unattributed: { at: number }[] = [];
  const stray: { at: number; panel: 1 | 2; signer: number | null }[] = [];
  const rejected: { at: number; error: DecodeErrorCode }[] = [];
  entries.forEach(({ segment, payload }, at) => {
    if (!isSegment(segment)) throw new RangeError("checkPanelDestruction: segments must be u32");
    let statement: PanelDestructionStatement;
    try {
      statement = decodePanelDestructionStatement(payload, pinned);
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      rejected.push({ at, error: e.code });
      return;
    }
    const seat = panelAttribution(election, statement);
    const key = `${statement.panel}:${seat}`;
    if (!sameBytes(statement.definition_hash, election.definitionHash)) {
      stray.push({ at, panel: statement.panel, signer: seat });
    } else if (seat === null) {
      unattributed.push({ at });
    } else if (first.has(key)) {
      duplicates.push({ at, panel: statement.panel, seat });
    } else {
      first.set(key, { at, segment });
    }
  });
  const report = (panel: 1 | 2, set: Registered) =>
    set.map(({ index }): PanelSeatDestruction => {
      const s = first.get(`${panel}:${index}`);
      if (s === undefined) return { panel, seat: index, code: "destruction-missing" };
      return {
        panel,
        seat: index,
        code: s.segment >= from ? "destroyed" : "destruction-early",
        at: s.at,
      };
    });
  const seats = [
    ...report(1, election.registered.default),
    ...report(2, election.registered.author),
  ];
  return { from, seats, duplicates, unattributed, stray, rejected };
}
