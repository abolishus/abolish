// The close rule (docs/spec/close.md; ADR 0030, option E): each ballot path's
// window (verifier 5.5), L_δ in L1 headers, the close statement (record type
// 0x0015) a trustee seat signs with the L2 head it derived from L1 through
// L_δ, the close head over every statement on the board, and the close check
// (verifier 6.3). The head only checks the contract's rule and never decides
// which ballots count, so no one holding k seats can drop a ballot with it,
// only fail the election loudly (T-35, T-45, T-50, T-53, T-54).

import {
  bytesFixed,
  type CodecValue,
  DecodeError,
  type DecodeErrorCode,
  struct,
  u64,
  u8,
  u16,
  Writer,
} from "./codec.ts";
import type { PeriodClock } from "./delivery.ts";
import { PARAMETERS } from "./parameters.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
import { type AdmittedBallot, type FinalizedL1, selectBallots } from "./revoting.ts";
import { p256Sig, signStatement, verifyStatement } from "./trustee.ts";

const TAG = "abolish/v1/sig/close-statement";

const VERSION = 1;

const U64_MAX = (1n << 64n) - 1n;

/** Seconds after `closes_at + l1_inclusion_bound`; the close window of version 1. */
export const CLOSE_WINDOW = BigInt(PARAMETERS.CLOSE_WINDOW);

const statementFields = [
  ["definition_hash", bytesFixed(32)],
  ["signer", u8],
  ["l1_number", u64],
  ["l1_hash", bytesFixed(32)],
  ["l2_number", u64],
  ["l2_hash", bytesFixed(32)],
] as const;

const statementV1 = struct(statementFields);

const closeV1 = struct([...statementFields, ["signature", p256Sig]] as const);

/** What the signer states: the election, its seat, `L_δ` and the head it derived through it. */
export type CloseStatementFields = CodecValue<typeof statementV1>;

/** Close statement, version 1 (docs/spec/close.md, Close statement). */
export type CloseStatement = CodecValue<typeof closeV1>;

/**
 * Record type `0x0015`. No profile pins it: the board-entry version that
 * allows it fixes its version (P1-18 part 4c-2b).
 */
export const CLOSE_STATEMENT = recordType(RECORD_TYPES.closeStatement, { 1: closeV1 });

const SCHEMA = new RecordSchema([CLOSE_STATEMENT]);

export function encodeCloseStatement(statement: CloseStatement): Uint8Array {
  return SCHEMA.encode(CLOSE_STATEMENT, 1, statement);
}

/** Strictly decodes a close statement under version 1. */
export function decodeCloseStatement(bytes: Uint8Array, pinned: 1): CloseStatement {
  return SCHEMA.decode(CLOSE_STATEMENT, bytes, pinned).value;
}

/**
 * `u16(0x0015) ‖ u8(1) ‖ definition_hash ‖ u8(signer) ‖ u64(l1_number) ‖
 * l1_hash ‖ u64(l2_number) ‖ l2_hash`: the record without its signature,
 * header included, so a later version can't reuse a version 1 signature (T-31).
 */
export function closeStatementMessage(fields: CloseStatementFields): Uint8Array {
  const w = new Writer();
  u16.write(w, RECORD_TYPES.closeStatement);
  u8.write(w, VERSION);
  // Through the struct, so only these fields are read even from a whole record.
  statementV1.write(w, {
    definition_hash: fields.definition_hash,
    signer: fields.signer,
    l1_number: fields.l1_number,
    l1_hash: fields.l1_hash,
    l2_number: fields.l2_number,
    l2_hash: fields.l2_hash,
  });
  return w.finish();
}

/**
 * Signs a seat's close statement with its per-election signing key. A node
 * signs once per election, from `L_δ` it found in headers it read itself and
 * the head its own L2 node derived through it, stores the result before
 * sending it, and resends those bytes: a second statement with another claim
 * is equivocation, and none of its statements then counts.
 */
export function signCloseStatement(
  signingSecret: Uint8Array,
  fields: CloseStatementFields,
): CloseStatement {
  const m = closeStatementMessage(fields);
  return {
    definition_hash: Uint8Array.from(fields.definition_hash),
    signer: fields.signer,
    l1_number: fields.l1_number,
    l1_hash: Uint8Array.from(fields.l1_hash),
    l2_number: fields.l2_number,
    l2_hash: Uint8Array.from(fields.l2_hash),
    signature: signStatement(signingSecret, TAG, m),
  };
}

function checkU64(x: unknown, what: string): asserts x is bigint {
  if (typeof x !== "bigint" || x < 0n || x > U64_MAX) throw new RangeError(`${what}: not a u64`);
}

function bytes32(x: unknown, what: string): Uint8Array {
  if (!(x instanceof Uint8Array) || !ArrayBuffer.isView(x))
    throw new TypeError(`${what}: expected 32 bytes`);
  const copy = new Uint8Array(x);
  if (copy.length !== 32) throw new TypeError(`${what}: expected 32 bytes`);
  return copy;
}

// Public data, so a constant-time comparison isn't needed.
const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Which path brought a ballot entry to the board (docs/spec/close.md, Window). */
export type BallotPath = "ordinary" | "relayed" | "board";

export type WindowVerdict =
  | "admitted"
  | "window-before-open"
  | "window-after-close"
  | "window-boarded-late";

/**
 * Verifier 5.5 for one ballot entry. `value` is an ordinary ballot's L2 block
 * timestamp, a relayed ballot's L1 stamp from its matched relay call, or a
 * board-path entry's segment, which has only the upper bound `s_A =
 * period(closes_at) + 1`: nothing public shows when within a period the
 * operator received it (ADR 0029). Each copy of a ballot is judged by its
 * own entry, before repeats.
 */
export function ballotWindow(
  path: BallotPath,
  value: bigint,
  window: { readonly opensAt: bigint; readonly closesAt: bigint; readonly boardSegment: bigint },
): WindowVerdict {
  if (typeof value !== "bigint") throw new TypeError("ballotWindow: value must be a bigint");
  if (path === "board") return value <= window.boardSegment ? "admitted" : "window-boarded-late";
  if (path !== "ordinary" && path !== "relayed") throw new RangeError("ballotWindow: unknown path");
  if (value < window.opensAt) return "window-before-open";
  if (value > window.closesAt) return "window-after-close";
  return "admitted";
}

/** `s_A = period(closes_at) + 1`: the last segment a board-path ballot may be in. */
export function boardBallotSegment(clock: PeriodClock, closesAt: bigint): bigint {
  checkClock(clock);
  if (typeof closesAt !== "bigint" || closesAt < clock.epoch)
    throw new RangeError("boardBallotSegment: closesAt must be a bigint at or after the epoch");
  return (closesAt - clock.epoch) / clock.period + 1n;
}

function checkClock(clock: PeriodClock): void {
  if (typeof clock.epoch !== "bigint" || clock.epoch < 0n)
    throw new RangeError("epoch must be a bigint ≥ 0");
  if (typeof clock.period !== "bigint" || clock.period < 1n)
    throw new RangeError("period must be a bigint ≥ 1");
}

/** `t_C` and `s_C`: by when a contract-path statement must be submitted, and in which segment a board-path one must be. */
export interface CloseDeadline {
  readonly time: bigint;
  readonly segment: bigint;
}

/**
 * `t_C = closes_at + l1_inclusion_bound + CLOSE_WINDOW` and `s_C = period(t_C)`
 * (docs/spec/close.md, Close statement, Window).
 */
export function closeDeadline(
  clock: PeriodClock,
  closesAt: bigint,
  l1InclusionBound: bigint,
): CloseDeadline {
  checkClock(clock);
  checkU64(closesAt, "closeDeadline: closesAt");
  if (
    typeof l1InclusionBound !== "bigint" ||
    l1InclusionBound < 0n ||
    l1InclusionBound >= 1n << 32n
  )
    throw new RangeError("closeDeadline: l1InclusionBound must be a u32");
  const time = closesAt + l1InclusionBound + CLOSE_WINDOW;
  if (time - CLOSE_WINDOW < clock.epoch)
    throw new RangeError("closeDeadline: the close is before the anchoring clock's epoch");
  return { time, segment: (time - clock.epoch) / clock.period };
}

/**
 * `L_δ`: the last finalized L1 block whose timestamp is at or before
 * `closesAt + l1InclusionBound`, searched between `low` and `l1.head`.
 * Returns `undefined` while no finalized block is after that time, since a
 * later block could still be at or before it. `low` must be a finalized block
 * at or before that time. Binary search relies on Ethereum's timestamps
 * strictly increasing with the block number.
 */
export function lDelta(
  l1: FinalizedL1,
  low: bigint,
  closesAt: bigint,
  l1InclusionBound: bigint,
): { readonly number: bigint; readonly hash: Uint8Array } | undefined {
  checkU64(l1.head, "lDelta: head");
  checkU64(low, "lDelta: low");
  checkU64(closesAt, "lDelta: closesAt");
  checkU64(l1InclusionBound, "lDelta: l1InclusionBound");
  if (low > l1.head) throw new RangeError("lDelta: low is above the finalized head");
  const bound = closesAt + l1InclusionBound;
  const at = (n: bigint) => {
    const t = l1.block(n).timestamp;
    checkU64(t, "lDelta: block timestamp");
    return t;
  };
  if (at(low) > bound) throw new RangeError("lDelta: low is after closes_at + δ");
  if (at(l1.head) <= bound) return undefined;
  // Invariant: at(lo) ≤ bound < at(hi).
  let lo = low;
  let hi = l1.head;
  while (hi - lo > 1n) {
    const mid = lo + (hi - lo) / 2n;
    if (at(mid) <= bound) lo = mid;
    else hi = mid;
  }
  return { number: lo, hash: bytes32(l1.block(lo).hash, "lDelta: block hash") };
}

/** What the statements are checked against, all from data the verifier has already checked. */
export interface CloseElection {
  readonly definitionHash: Uint8Array;
  /**
   * The default panel's registered key set ([[ceremony]], Transcript check):
   * each qualified seat and its per-election signing key. Only these attribute.
   */
  readonly registered: readonly { readonly index: number; readonly signingKey: Uint8Array }[];
  /** `k`, the default panel's threshold. */
  readonly threshold: number;
  /** `L_δ`, from the verifier's own finalized L1 headers (`lDelta`). */
  readonly lDelta: { readonly number: bigint; readonly hash: Uint8Array };
  readonly deadline: CloseDeadline;
  /**
   * `g`: the highest L2 block a pinned permissionless dispute game claims,
   * with its L1 head at or before `L_δ`, valid and resolved in its claim's
   * favour at `t_S`; or `null` if there is none (docs/spec/close.md, The
   * floor). It only reports: a claim below it still counts, so one false game
   * can never raise the head or leave the close unchecked (T-71, T-35).
   */
  readonly floor: bigint | null;
}

/** A close-statement payload in the board's sealed extent, with how it got there. */
export type CloseStatementEntry =
  | { readonly path: "board"; readonly segment: bigint; readonly payload: Uint8Array }
  | { readonly path: "contract"; readonly submittedAt: bigint; readonly payload: Uint8Array };

export interface CloseClaim {
  readonly number: bigint;
  readonly hash: Uint8Array;
}

export type StatementVerdict =
  | { readonly at: number; readonly code: "decode"; readonly error: DecodeErrorCode }
  | { readonly at: number; readonly code: "close-stray"; readonly signer: number | null }
  | { readonly at: number; readonly code: "close-unattributed" }
  | { readonly at: number; readonly code: "close-l1"; readonly seat: number }
  /** `seat` is `null` through the board path, where the operator may have held it back. */
  | { readonly at: number; readonly code: "close-late"; readonly seat: number | null }
  | { readonly at: number; readonly code: "valid"; readonly seat: number };

export type SeatClose =
  | { readonly seat: number; readonly code: "close-counted"; readonly claim: CloseClaim }
  | { readonly seat: number; readonly code: "close-missing" | "close-equivocation" };

export interface CloseHeadReport {
  /** `B`, the `k`-th largest counted claim, or `null` with fewer than `k` counted seats. */
  readonly head: bigint | null;
  /** One verdict per entry, in board order; `at` is a position in the entries. */
  readonly statements: readonly StatementVerdict[];
  /** One line per registered seat, in the key set's order. */
  readonly seats: readonly SeatClose[];
  /** Every distinct claim among the valid statements, by number then hash: more than one proves a false statement. */
  readonly claims: readonly CloseClaim[];
  /** Counted seats whose claim is below the floor, in key-set order: reported against them, still counted. */
  readonly belowFloor: readonly number[];
}

/** The seat a statement's signature attributes it to, or `null` (T-29). */
function attribution(election: CloseElection, s: CloseStatement): number | null {
  const seat = election.registered.find((k) => k.index === s.signer);
  if (seat === undefined) return null;
  return verifyStatement(seat.signingKey, TAG, closeStatementMessage(s), s.signature)
    ? s.signer
    : null;
}

function inTime(entry: CloseStatementEntry, deadline: CloseDeadline): boolean {
  if (entry.path === "board") return entry.segment <= deadline.segment;
  if (entry.path === "contract") return entry.submittedAt <= deadline.time;
  throw new RangeError("closeHead: unknown path");
}

function compareClaims(a: CloseClaim, b: CloseClaim): number {
  if (a.number !== b.number) return a.number < b.number ? -1 : 1;
  for (let i = 0; i < 32; i++) {
    const x = a.hash[i] ?? 0;
    const y = b.hash[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The close head over every close-statement payload in the board's sealed
 * extent, in board order (docs/spec/close.md, Close head). Statements are
 * judged by their own window, wherever they are, so the head is the same over
 * the counted extent and the whole sealed one.
 */
export function closeHead(
  election: CloseElection,
  entries: readonly CloseStatementEntry[],
  pinned: 1,
): CloseHeadReport {
  const definitionHash = bytes32(election.definitionHash, "closeHead: definitionHash");
  const l1Hash = bytes32(election.lDelta.hash, "closeHead: lDelta.hash");
  checkU64(election.lDelta.number, "closeHead: lDelta.number");
  // `t_C` may pass 2^64 − 1 when `closes_at + δ` is near it: a deadline, never encoded.
  if (typeof election.deadline.time !== "bigint")
    throw new TypeError("closeHead: deadline.time must be a bigint");
  if (typeof election.deadline.segment !== "bigint")
    throw new TypeError("closeHead: deadline.segment must be a bigint");
  if (election.floor !== null) checkU64(election.floor, "closeHead: floor");
  const k = election.threshold;
  if (!Number.isInteger(k) || k < 1 || k > PARAMETERS.MAX_TRUSTEES)
    throw new RangeError("closeHead: threshold must be an integer from 1 to MAX_TRUSTEES");
  const statements: StatementVerdict[] = [];
  const valid = new Map<number, Map<string, CloseClaim>>();
  entries.forEach((entry, at) => {
    let s: CloseStatement;
    try {
      s = decodeCloseStatement(entry.payload, pinned);
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      statements.push({ at, code: "decode", error: e.code });
      return;
    }
    const seat = attribution(election, s);
    if (!sameBytes(s.definition_hash, definitionHash)) {
      statements.push({ at, code: "close-stray", signer: seat });
    } else if (seat === null) {
      statements.push({ at, code: "close-unattributed" });
    } else if (s.l1_number !== election.lDelta.number || !sameBytes(s.l1_hash, l1Hash)) {
      statements.push({ at, code: "close-l1", seat });
    } else if (!inTime(entry, election.deadline)) {
      statements.push({ at, code: "close-late", seat: entry.path === "contract" ? seat : null });
    } else {
      statements.push({ at, code: "valid", seat });
      const claims = valid.get(seat) ?? new Map<string, CloseClaim>();
      claims.set(`${s.l2_number}:${toHex(s.l2_hash)}`, { number: s.l2_number, hash: s.l2_hash });
      valid.set(seat, claims);
    }
  });
  const counted: bigint[] = [];
  const belowFloor: number[] = [];
  const seats = election.registered.map(({ index }): SeatClose => {
    const claims = valid.get(index);
    if (claims === undefined) return { seat: index, code: "close-missing" };
    // Statements that agree are one, whatever their signatures (ECDSA lets the
    // signer make many); two claims prove the seat signed a false one.
    if (claims.size > 1) return { seat: index, code: "close-equivocation" };
    const [claim] = claims.values();
    if (claim === undefined) throw new Error("unreachable: a seat with no claim is missing");
    counted.push(claim.number);
    if (election.floor !== null && claim.number < election.floor) belowFloor.push(index);
    return { seat: index, code: "close-counted", claim };
  });
  // With fewer than k false claims and at least k honest ones counted, the
  // k-th largest is the honest head: false claims above it take at most k − 1
  // places, and those below it never reach the k-th.
  counted.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const head = counted.length >= k ? (counted[k - 1] ?? null) : null;
  const all = new Map<string, CloseClaim>();
  for (const claims of valid.values()) for (const [key, c] of claims) all.set(key, c);
  return { head, statements, seats, claims: [...all.values()].sort(compareClaims), belowFloor };
}

/**
 * One ballot entry in the counted extent that the admission checks admit
 * (5.1 to 5.5 and 5.8), before repeats, with the path that brought it and,
 * for an ordinary contract-path ballot, the L2 block that emitted it.
 */
export type CloseBallot = AdmittedBallot & {
  /** Its cell in the partition: the tier under definition version 1, the cell it names otherwise. */
  readonly cell: number;
  /** The ballot hash delivery records name, which leaves out the L1 reference. */
  readonly ballotHash: Uint8Array;
} & (
    | { readonly path: "ordinary"; readonly l2Block: bigint }
    | { readonly path: "relayed" | "board" }
  );

export type CloseCheckResult =
  /** Every cell's counted set is the same without the late ordinary ballots, listed by index. */
  | { readonly status: "pass"; readonly late: readonly bigint[] }
  /** `cell` is the first cell, in partition order, whose counted set differs. */
  | {
      readonly status: "fail";
      readonly code: "close-contested";
      readonly cell: number;
      readonly late: readonly bigint[];
    }
  /** No close head: the counted ballots with only ordinary copies, each by its smallest index. */
  | { readonly status: "unchecked"; readonly unchecked: readonly bigint[] };

const isLate = (b: CloseBallot, head: bigint) => b.path === "ordinary" && b.l2Block > head;

const contentKey = (b: AdmittedBallot) => `${b.tier}:${b.nullifier}:${toHex(b.message)}`;

/**
 * Each cell's counted set: the ballots selection keeps (repeats, then the
 * single newest block per tier and nullifier) that delivery keeps, as sets of
 * (tier, ν, M). Delivery is by ballot hash, never by entry, so it doesn't
 * change with which copies are present.
 */
function countedSets(
  ballots: readonly CloseBallot[],
  delivered: (ballotHash: Uint8Array) => boolean,
): Map<number, Set<string>> {
  const byIndex = new Map(ballots.map((b) => [b.index, b]));
  const cells = new Map<number, Set<string>>();
  for (const s of selectBallots(ballots).selected) {
    const b = byIndex.get(s.index);
    if (b === undefined) throw new Error("unreachable: selection returns its input");
    if (!delivered(Uint8Array.from(b.ballotHash))) continue;
    const set = cells.get(b.cell) ?? new Set<string>();
    set.add(contentKey(b));
    cells.set(b.cell, set);
  }
  return cells;
}

/**
 * The close check, verifier 6.3 (docs/spec/close.md, Close check). `ballots`
 * is every ballot entry in the counted extent that admission admits, before
 * repeats; `head` the close head, or `null`; `delivered` whether the delivery
 * check delivers a ballot hash and no proven complaint excludes it. Late
 * ordinary copies are removed before repeats are resolved, so a ballot that
 * also has a timely copy keeps it. The head never decides what counts: the
 * tally opens the counted sets of every admitted ballot, and a difference
 * fails the election rather than pick one (T-35, T-45).
 */
export function closeCheck(
  ballots: readonly CloseBallot[],
  head: bigint | null,
  delivered: (ballotHash: Uint8Array) => boolean,
): CloseCheckResult {
  const input = ballots.map((b): CloseBallot => {
    if (!Number.isInteger(b.cell) || b.cell < 0 || b.cell > 255)
      throw new RangeError("closeCheck: cell must be an integer from 0 to 255");
    const base = { ...b, ballotHash: bytes32(b.ballotHash, "closeCheck: ballotHash") };
    if (b.path === "ordinary") {
      checkU64(b.l2Block, "closeCheck: l2Block");
      return { ...base, path: "ordinary", l2Block: b.l2Block };
    }
    if (b.path !== "relayed" && b.path !== "board")
      throw new RangeError("closeCheck: unknown path");
    return { ...base, path: b.path };
  });
  if (head === null) {
    const counted = new Set<string>();
    for (const set of countedSets(input, delivered).values()) for (const k of set) counted.add(k);
    const first = new Map<string, { index: bigint; ordinaryOnly: boolean }>();
    for (const b of input) {
      const key = contentKey(b);
      if (!counted.has(key)) continue;
      const seen = first.get(key);
      const ordinaryOnly = (seen?.ordinaryOnly ?? true) && b.path === "ordinary";
      const index = seen === undefined || b.index < seen.index ? b.index : seen.index;
      first.set(key, { index, ordinaryOnly });
    }
    const unchecked = [...first.values()].filter((f) => f.ordinaryOnly).map((f) => f.index);
    return {
      status: "unchecked",
      unchecked: unchecked.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    };
  }
  checkU64(head, "closeCheck: head");
  const late = input
    .filter((b) => isLate(b, head))
    .map((b) => b.index)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const before = countedSets(input, delivered);
  const after = countedSets(
    input.filter((b) => !isLate(b, head)),
    delivered,
  );
  const cells = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b);
  for (const cell of cells) {
    const x = before.get(cell) ?? new Set<string>();
    const y = after.get(cell) ?? new Set<string>();
    if (x.size !== y.size || [...x].some((key) => !y.has(key)))
      return { status: "fail", code: "close-contested", cell, late };
  }
  return { status: "pass", late };
}
