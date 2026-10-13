// Spoiled-ballot openings (docs/spec/verifier.md, Spoiled-ballot openings;
// 6.2): every opening record (0x0003) of this election on the board copy is
// decoded under the pinned version and checked by @abolishus/crypto's
// `checkChallengeOpening` against the definition and the registered key set,
// never against a board entry, then judged against challenge.md's
// Publication rules. None of it ever counts, displaces or fails anything: an
// opening is a report, attributed to the board operator (T-42, T-47, T-53).
//
// The counted extent's last segment `s_S` needs the contract-event window
// (P1-18), so it isn't known yet. What is known is its floor,
// `period(closes_at) + 1` (docs/spec/tally.md, Tally window): an opening in a
// segment at or below it is early, and one that opens a commitment of a
// ballot admitted at or below it is cast, whatever `s_S` turns out to be.
// Anything above the floor stays undecided, so 6.2 can't pass while an
// opening that breaks no decided rule is on the copy.

import {
  type AnchorClock,
  type BoardEntryVersion,
  type ChallengeOpeningCode,
  checkChallengeOpening,
  DecodeError,
  type DecodeErrorCode,
  decodeBoardEntry,
  decodeOpening,
  type ElectionDefinition,
  type BallotElection,
  openedCommitments,
  openingCoreHash,
  opensBallotCommitment,
  pinnedVersion,
  RECORD_TYPES,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { AdmittedCore } from "./ballots.ts";

/** A publication rule an opening is known to break (docs/spec/challenge.md, Publication). */
export type OpeningBreak =
  | { readonly code: "opening-early" }
  /** `ballot`: the first admitted ballot at or below the floor it opens a commitment of. */
  | { readonly code: "opening-cast"; readonly ballot: number }
  /** `of`: the first earlier entry carrying an opening with the same core hash. */
  | { readonly code: "opening-repeat"; readonly of: number };

/** One opening entry of the copy, by its position from 0. */
export interface OpeningReport {
  readonly entry: number;
  /** A failed check, or `decode`: the opening opens nothing. */
  readonly code?: ChallengeOpeningCode | "decode";
  /** `decode`'s strict-decoding code (docs/spec/notation.md). */
  readonly decodeError?: DecodeErrorCode;
  /** `opening-vss`'s first failing option. */
  readonly option?: number;
  /** `opening-ciphertext`'s first failing seat. */
  readonly seat?: number;
  /** A passing opening's tracking code, as hex. */
  readonly coreHash?: string;
  /** A passing opening's vote, `v_j` for each option, as decimal strings. */
  readonly votes?: readonly string[];
  /** `opening-vote-outside`: no valid ballot could carry the vote; the client's evidence, no one's on the board. */
  readonly voteOutside?: true;
  /** The publication rules it is known to break, in Publication's order. */
  readonly breaks: readonly OpeningBreak[];
}

export type OpeningCode = ChallengeOpeningCode | OpeningBreak["code"];

export interface OpeningOutcome {
  readonly status: "pass" | "fail" | "unverifiable";
  readonly code?:
    | OpeningCode
    | "decode"
    | "unsupported-version"
    | "not-reached"
    | "not-implemented";
  readonly at?:
    | { readonly entry: number; readonly decodeError?: DecodeErrorCode }
    | Record<string, never>;
}

const NOT_REACHED: OpeningOutcome = { status: "unverifiable", code: "not-reached" };

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// ⌊a / b⌋ for b > 0: BigInt division truncates towards zero.
const floorDiv = (a: bigint, b: bigint) => {
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
};

/**
 * `period(closes_at) + 1`, the floor of `s_S` (docs/spec/tally.md, Tally
 * window). A close before the clock's epoch gives a floor below 0, which no
 * segment is at or below.
 */
export function countedFloor(closesAt: bigint, clock: AnchorClock): bigint {
  return floorDiv(closesAt - clock.epoch, clock.period) + 1n;
}

/**
 * The row 6.2 and the report's `openings`. `election` is the ballot context
 * of the definition and the key set the transcript check registered, or
 * `undefined` when ballot admission didn't run, which leaves every opening
 * unchecked: an opening of shares made to an unregistered panel can't be
 * judged (T-37), and `opening-cast` compares with admitted ballots only.
 */
export function openingChecks(
  d: ElectionDefinition,
  election: BallotElection | undefined,
  admitted: readonly AdmittedCore[] | undefined,
  entries: readonly Uint8Array[],
  boardEntryVersion: BoardEntryVersion,
  clock: AnchorClock,
): { readonly row: OpeningOutcome; readonly report?: readonly OpeningReport[] } {
  // An opening version this verifier doesn't read may be one a later release
  // reads, and so may a ballot version, whose cores a later opening version
  // may open: unverifiable, never failed, so releases agree (2.3; T-36).
  // Every version-1 profile pins both (`profile-types`).
  if (
    pinnedVersion(d, RECORD_TYPES.spoiledBallotOpening) !== 1 ||
    pinnedVersion(d, RECORD_TYPES.ballot) !== 1
  )
    return { row: { status: "unverifiable", code: "unsupported-version", at: {} } };
  if (election === undefined || admitted === undefined) return { row: NOT_REACHED };
  const floor = countedFloor(d.closes_at, clock);
  const counted = admitted.filter((b) => BigInt(b.segment) <= floor);
  const report: OpeningReport[] = [];
  // Each decoded opening's core hash by the first entry carrying it.
  const seen = new Map<string, number>();
  for (const [at, encoded] of entries.entries()) {
    let payload: Uint8Array;
    let segment: number;
    try {
      const e = decodeBoardEntry(encoded, boardEntryVersion);
      // 4.1 reports an entry that doesn't decode or names another election.
      if (!equal(e.election_id, d.election_id)) continue;
      payload = e.payload;
      segment = e.segment;
    } catch (e) {
      if (e instanceof DecodeError) continue;
      throw e;
    }
    if (
      (((payload[0] as number) << 8) | (payload[1] as number)) !==
      RECORD_TYPES.spoiledBallotOpening
    )
      continue;
    // The segment is the envelope's, so even an opening that doesn't decode
    // was boarded early (docs/spec/challenge.md, Publication).
    const early: OpeningBreak[] = BigInt(segment) <= floor ? [{ code: "opening-early" }] : [];
    let opening;
    try {
      opening = decodeOpening(payload, 1);
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      report.push({ entry: at, code: "decode", decodeError: e.code, breaks: early });
      continue;
    }
    // Any earlier opening with this core makes it a repeat, whether or not
    // that one passes: the operator boards only one per core.
    const hash = bytesToHex(openingCoreHash(opening));
    const first = seen.get(hash);
    if (first === undefined) seen.set(hash, at);
    const repeat: OpeningBreak[] =
      first === undefined ? [] : [{ code: "opening-repeat", of: first }];
    const checked = checkChallengeOpening(election, opening);
    if (!checked.ok) {
      report.push({
        entry: at,
        code: checked.code,
        ...(checked.option !== undefined && { option: checked.option }),
        ...(checked.seat !== undefined && { seat: checked.seat }),
        breaks: [...early, ...repeat],
      });
      continue;
    }
    // Only a passing opening opens anything; `openedCommitments` needs one
    // (T-45, T-47). A ballot above the floor may or may not be counted.
    const opened = openedCommitments(opening);
    const cast = counted.find((b) => opensBallotCommitment(opened, b.core));
    report.push({
      entry: at,
      coreHash: bytesToHex(checked.coreHash),
      votes: checked.votes.map(String),
      ...(!checked.withinRules && { voteOutside: true as const }),
      breaks: [
        ...early,
        ...(cast === undefined ? [] : [{ code: "opening-cast" as const, ballot: cast.entry }]),
        ...repeat,
      ],
    });
  }
  return { row: rowOf(report), report };
}

// An opening is settled when it failed a check or broke a decided rule; one
// that passed and broke none may still be early, late or cast once `s_S` is
// known, so it leaves 6.2 unverifiable, which also keeps a settled failure
// from passing the row for the others (Verdicts).
function rowOf(report: readonly OpeningReport[]): OpeningOutcome {
  const settled = (o: OpeningReport) => o.code !== undefined || o.breaks.length > 0;
  if (report.some((o) => !settled(o))) return { status: "unverifiable", code: "not-implemented" };
  const first = report[0];
  if (first === undefined) return { status: "pass" };
  const code = first.code ?? (first.breaks[0] as OpeningBreak).code;
  return {
    status: "fail",
    code,
    at: {
      entry: first.entry,
      ...(first.decodeError !== undefined && { decodeError: first.decodeError }),
    },
  };
}
