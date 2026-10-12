// The destruction statement (docs/spec/tally.md, Destruction; record type
// 0x000f): a trustee's signed claim, on the board, that it destroyed its
// per-election key material after the tally, and the verifier's report over
// every statement on the board (verifier 8.5). Destruction can't be proven, so
// the report never fails an election: a rule that did would give every
// trustee a veto over the result (T-14, T-40, T-69, T-54).

import {
  bytesFixed,
  type CodecValue,
  DecodeError,
  type DecodeErrorCode,
  struct,
  u8,
  u16,
  Writer,
} from "./codec.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
import { p256Sig, signStatement, verifyStatement } from "./trustee.ts";

const TAG = "abolish/v1/sig/destruction";

const VERSION = 1;

const statementFields = [
  ["definition_hash", bytesFixed(32)],
  ["signer", u8],
] as const;

const statementV1 = struct(statementFields);

const destructionV1 = struct([...statementFields, ["signature", p256Sig]] as const);

/** What the signer states: the election and its seat. */
export type DestructionStatementFields = CodecValue<typeof statementV1>;

/** Destruction statement, version 1 (docs/spec/tally.md, Destruction). */
export type DestructionStatement = CodecValue<typeof destructionV1>;

/**
 * Record type `0x000f`. No profile pins it: version 1 of the tally opening,
 * the version a profile pins, uses version 1 of this statement.
 */
export const DESTRUCTION_STATEMENT = recordType(RECORD_TYPES.destructionStatement, {
  1: destructionV1,
});

const SCHEMA = new RecordSchema([DESTRUCTION_STATEMENT]);

export function encodeDestructionStatement(statement: DestructionStatement): Uint8Array {
  return SCHEMA.encode(DESTRUCTION_STATEMENT, 1, statement);
}

/** Strictly decodes a destruction statement under version 1, the version tally opening 1 fixes. */
export function decodeDestructionStatement(bytes: Uint8Array, pinned: 1): DestructionStatement {
  return SCHEMA.decode(DESTRUCTION_STATEMENT, bytes, pinned).value;
}

/**
 * `u16(0x000f) ‖ u8(1) ‖ definition_hash ‖ u8(signer)`: the record without its
 * signature, header included, so a later version can't reuse a version 1
 * signature (T-31).
 */
export function destructionStatementMessage(fields: DestructionStatementFields): Uint8Array {
  const w = new Writer();
  u16.write(w, RECORD_TYPES.destructionStatement);
  u8.write(w, VERSION);
  // Through the struct, so only these fields are read even from a whole record.
  statementV1.write(w, { definition_hash: fields.definition_hash, signer: fields.signer });
  return w.finish();
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
