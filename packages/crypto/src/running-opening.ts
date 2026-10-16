// The running opening (docs/spec/tally.md, Running opening record; record
// type 0x0018): one cell's opening of one chosen release of a live poll, over
// the cell's running set at the released snapshot, signed by the seat that
// combined it. Which running openings are a release's, whether one passes,
// each release's totals and the operator's boarding rule. A passing opening
// counts whoever signed it; a signature only decides whom a breach is
// attributed to (T-16, T-29, T-31).

import { type CommittedVote, type Share, SHARES } from "./ballot-validity.ts";
import {
  bytesFixed,
  type CodecValue,
  DecodeError,
  type DecodeErrorCode,
  encode,
  struct,
  u8,
  u16,
  u32,
} from "./codec.ts";
import { type Element, G, GENERATOR_H, IDENTITY } from "./group.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
import { aggregateCell, type CellAggregate } from "./tally.ts";
import { aggregateHash, type TallyElection } from "./tally-opening.ts";
import { p256Sig, signStatement, verifyStatement } from "./trustee.ts";

const TAG = "abolish/v1/sig/running-opening";

/** Cells are named by a `u8`. */
const MAX_CELLS = 256;

const statementFields = [
  ["definition_hash", bytesFixed(32)],
  ["cell", u8],
  ["snapshot", u32],
  ["aggregate_hash", bytesFixed(32)],
  ["signer", u8],
  ["opening", SHARES],
] as const;

const statementV1 = struct(statementFields);

const runningOpeningV1 = struct([...statementFields, ["signature", p256Sig]] as const);

// m begins with the record's own header, unlike the tally opening's, so a
// later version giving these bytes another meaning can't reuse a version-1
// signature (T-31).
const signedV1 = struct([["record_type", u16], ["version", u8], ...statementFields] as const);

/** What the signer signs, besides the header: every field but the signature. */
export type RunningOpeningStatement = CodecValue<typeof statementV1>;

/** Running opening, version 1 (docs/spec/tally.md, Running opening record). */
export type RunningOpening = CodecValue<typeof runningOpeningV1>;

/** Record type `0x0018`: one cell's opening of one release of a live poll, on the board. */
export const RUNNING_OPENING = recordType(RECORD_TYPES.runningOpening, { 1: runningOpeningV1 });

const SCHEMA = new RecordSchema([RUNNING_OPENING]);

/** Encodes a running opening under version 1, the only version. */
export function encodeRunningOpening(opening: RunningOpening): Uint8Array {
  return SCHEMA.encode(RUNNING_OPENING, 1, opening);
}

/**
 * Strictly decodes a running opening against the version tally-opening
 * version 2 fixes, 1 (docs/spec/tally.md, Tally-opening version 2).
 */
export function decodeRunningOpening(bytes: Uint8Array, pinned: 1): RunningOpening {
  return SCHEMA.decode(RUNNING_OPENING, bytes, pinned).value;
}

/**
 * `m = u16(0x0018) ‖ u8(1) ‖ definition_hash ‖ u8(cell) ‖ u32(snapshot) ‖
 * aggregate_hash ‖ u8(signer) ‖ encode(opening)`: the record's encoding
 * without its signature.
 */
export function runningOpeningStatement(statement: RunningOpeningStatement): Uint8Array {
  // Through the struct, so only these fields are read even from a whole record.
  return encode(signedV1, {
    record_type: RECORD_TYPES.runningOpening,
    version: 1,
    definition_hash: statement.definition_hash,
    cell: statement.cell,
    snapshot: statement.snapshot,
    aggregate_hash: statement.aggregate_hash,
    signer: statement.signer,
    opening: statement.opening,
  });
}

/**
 * Signs a cell's opening of a release with the signer's per-election signing
 * key (docs/spec/tally.md, Running opening record, Signature). A node signs
 * only a chosen release's opening its own checks passed, within the release's
 * window (What a node does).
 */
export function signRunningOpening(
  signingSecret: Uint8Array,
  statement: RunningOpeningStatement,
): RunningOpening {
  const m = runningOpeningStatement(statement);
  return {
    definition_hash: Uint8Array.from(statement.definition_hash),
    cell: statement.cell,
    snapshot: statement.snapshot,
    aggregate_hash: Uint8Array.from(statement.aggregate_hash),
    signer: statement.signer,
    opening: statement.opening.map(({ v, r }) => ({ v, r })),
    signature: signStatement(signingSecret, TAG, m),
  };
}

/** A live poll's releases, as the release choice fixed them (docs/spec/tally.md, Release choice). */
export interface ReleaseSchedule {
  /** Each cell's tier, by its position in the registered partition. */
  readonly cellTiers: readonly number[];
  /** For each tier, the snapshots chosen as its releases; a tier with none may be absent. */
  readonly chosen: ReadonlyMap<number, readonly number[]>;
  /**
   * The ballots each nullifier of `R_{q,c}` entered with (Running set), for
   * a chosen release `q` of cell `c`'s tier. Asked only for chosen releases,
   * at most once each.
   */
  readonly runningSet: (cell: number, snapshot: number) => readonly CommittedVote["vss"][];
}

/** Why an opening of a release fails (docs/spec/tally.md, Which running openings are a release's). */
export type RunningOpeningFailure =
  | { readonly reason: "entries" }
  | { readonly reason: "aggregate" }
  | { readonly reason: "opening"; readonly option: number };

/** A running-opening payload, by its position in the list read (board order). */
export type RunningOpeningEntry =
  | ({
      readonly at: number;
      readonly kind: "release";
      readonly snapshot: number;
      readonly cell: number;
      /** The seat its signature attributes it to, or `null` if it is unattributed. */
      readonly signer: number | null;
    } & ({ readonly passes: true } | ({ readonly passes: false } & RunningOpeningFailure)))
  | { readonly at: number; readonly kind: "outside-schedule"; readonly signer: number | null }
  | { readonly at: number; readonly kind: "rejected"; readonly error: DecodeErrorCode };

/** One chosen release of one cell: its totals, from its first passing opening, or `null` if none passed. */
export interface ReleaseTotals {
  readonly snapshot: number;
  readonly cell: number;
  readonly counts: readonly bigint[] | null;
}

export interface RunningOpeningsRead {
  readonly entries: readonly RunningOpeningEntry[];
  /** Every chosen release of every cell, in cell order, then snapshot order. */
  readonly releases: readonly ReleaseTotals[];
}

type LiveElection = Pick<TallyElection, "definitionHash" | "rules" | "registered">;

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// @noble rejects a multiplier of 0, which openings of empty sets use. Every
// value here was decoded, so none is at or above ℓ.
function mul(p: Element, s: bigint): Element {
  return s === 0n ? IDENTITY : p.multiply(s);
}

/**
 * The seat a running opening's signature attributes it to: its `signer`, if
 * that is a registered seat and the signature verifies under the seat's
 * registered signing key over this record's own header and fields; otherwise
 * `null`. So a signed release moved to another election, cell or snapshot
 * never frames its signer (T-29).
 */
function attribution(election: Pick<LiveElection, "registered">, o: RunningOpening): number | null {
  const seat = election.registered.find((k) => k.index === o.signer);
  if (seat === undefined) return null;
  return verifyStatement(seat.signingKey, TAG, runningOpeningStatement(o), o.signature)
    ? o.signer
    : null;
}

function checkElection(election: LiveElection, schedule: ReleaseSchedule, caller: string): void {
  if (!(election.definitionHash instanceof Uint8Array) || election.definitionHash.length !== 32)
    throw new RangeError(`${caller}: definitionHash must be 32 bytes`);
  const cells = schedule.cellTiers.length;
  if (cells < 1 || cells > MAX_CELLS) throw new RangeError(`${caller}: from 1 to 256 cells`);
  for (const [tier, snapshots] of schedule.chosen)
    if (snapshots.some((q) => !Number.isInteger(q) || q < 1 || q > 0xffff_ffff))
      throw new RangeError(`${caller}: tier ${tier} has a snapshot outside 1 to 2^32 − 1`);
}

/** Judges decoded running openings against one election's releases, with each release's aggregate computed once. */
function judge(election: LiveElection, schedule: ReleaseSchedule) {
  const aggregates = new Map<string, { aggregate: CellAggregate; hash: Uint8Array }>();
  const aggregateOf = (cell: number, snapshot: number) => {
    const key = `${cell}/${snapshot}`;
    let a = aggregates.get(key);
    if (a === undefined) {
      const aggregate = aggregateCell(election.rules, schedule.runningSet(cell, snapshot));
      a = { aggregate, hash: aggregateHash(aggregate) };
      aggregates.set(key, a);
    }
    return a;
  };
  return (at: number, o: RunningOpening): RunningOpeningEntry => {
    const signer = attribution(election, o);
    const tier = schedule.cellTiers[o.cell];
    if (
      !sameBytes(o.definition_hash, election.definitionHash) ||
      tier === undefined ||
      !(schedule.chosen.get(tier) ?? []).includes(o.snapshot)
    )
      return { at, kind: "outside-schedule", signer };
    const release = { at, kind: "release", snapshot: o.snapshot, cell: o.cell, signer } as const;
    if (o.opening.length !== election.rules.optionCount)
      return { ...release, passes: false, reason: "entries" };
    const { aggregate, hash } = aggregateOf(o.cell, o.snapshot);
    if (!sameBytes(o.aggregate_hash, hash))
      return { ...release, passes: false, reason: "aggregate" };
    const option = firstUnopened(aggregate, o.opening);
    return option === null
      ? { ...release, passes: true }
      : { ...release, passes: false, reason: "opening", option };
  };
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

function decodeOrCode(payload: Uint8Array): RunningOpening | DecodeErrorCode {
  try {
    return decodeRunningOpening(payload, 1);
  } catch (e) {
    if (!(e instanceof DecodeError)) throw e;
    return e.code;
  }
}

/**
 * Every running-opening payload of the board's sealed extent, in board
 * order, decoded under version 1 and judged (docs/spec/tally.md, Which
 * running openings are a release's): a rejected entry if it doesn't decode,
 * outside the schedule if it names another definition, a cell the partition
 * doesn't have or a snapshot that isn't a chosen release of its cell's tier,
 * and otherwise an opening of that release that passes or fails, with the
 * seat its signature attributes it to. Each chosen release's totals in each
 * cell are its first passing opening's counts; under binding every passing
 * one is the same, and telling otherwise is the verifier's (7.5). `at` is a
 * position in `payloads`.
 */
export function readRunningOpenings(
  election: LiveElection,
  schedule: ReleaseSchedule,
  payloads: readonly Uint8Array[],
): RunningOpeningsRead {
  checkElection(election, schedule, "readRunningOpenings");
  const verdict = judge(election, schedule);
  const totals = new Map<string, readonly bigint[]>();
  const entries = payloads.map((payload, at): RunningOpeningEntry => {
    const o = decodeOrCode(payload);
    if (typeof o === "string") return { at, kind: "rejected", error: o };
    const e = verdict(at, o);
    const key = `${o.cell}/${o.snapshot}`;
    if (e.kind === "release" && e.passes && !totals.has(key))
      totals.set(
        key,
        o.opening.map((s) => s.v),
      );
    return e;
  });
  const releases = schedule.cellTiers.flatMap((tier, cell) =>
    [...new Set(schedule.chosen.get(tier) ?? [])]
      .sort((a, b) => a - b)
      .map((snapshot) => ({
        snapshot,
        cell,
        counts: totals.get(`${cell}/${snapshot}`) ?? null,
      })),
  );
  return { entries, releases };
}

/**
 * The board operator's rule (docs/spec/tally.md, Running opening record,
 * Boarding), over running openings offered in this order to a board whose
 * sealed extent already holds `onBoard`, the running openings boarded so far:
 * one is boarded only if it decodes, is an opening of a chosen release in a
 * cell, passes against that release's aggregate, is attributed to a
 * registered seat, and that seat has no running opening of that release and
 * cell on the board yet. Anything else is refused: a passing opening over a
 * set the release choice never chose discloses totals the batch rule never
 * bounded (T-16), and a second one per seat, or an unattributed one, would
 * carry chosen bytes the bound on result-critical fields doesn't allow
 * (T-17). Returns, per offered payload, whether it is boarded.
 */
export function boardRunningOpenings(
  election: LiveElection,
  schedule: ReleaseSchedule,
  onBoard: readonly Uint8Array[],
  offered: readonly Uint8Array[],
): boolean[] {
  checkElection(election, schedule, "boardRunningOpenings");
  const verdict = judge(election, schedule);
  const boarded = new Set<string>();
  const boards = (payload: Uint8Array, at: number) => {
    const o = decodeOrCode(payload);
    if (typeof o === "string") return false;
    const e = verdict(at, o);
    if (e.kind !== "release" || !e.passes || e.signer === null) return false;
    const key = `${e.cell}/${e.snapshot}/${e.signer}`;
    if (boarded.has(key)) return false;
    boarded.add(key);
    return true;
  };
  onBoard.forEach(boards);
  return offered.map(boards);
}
