// Ballot admission (docs/spec/verifier.md, Ballot admission): 5.1 to 5.4 over
// every ballot record of this election on the board copy, by
// @abolishus/crypto's `checkBallot` against the definition and the key set
// the transcript check registered, never against anything a ballot or the
// bundle chooses (T-37, T-04). A failure rejects that entry only: the rows
// report each check's first rejected entry and the report lists every one
// (8.3), so a bad ballot never fails the election (T-52, T-53). Repeats
// (5.7) are found among the admitted ballots by @abolishus/crypto's
// `selectBallots`, keyed by (tier, ν, M) with M recomputed, never by bytes
// (T-38); they are rejected only once the close rule (5.5) can say which
// copies are admitted. L1 references, the close rule and selection (5.5,
// 5.8, 6.1) are decided over the admitted ballots, later.

import {
  type AdmittedBallot,
  type BallotCode,
  ballotElection,
  type BoardEntryVersion,
  checkBallot,
  DecodeError,
  type DecodeErrorCode,
  decodeBallot,
  decodeBoardEntry,
  type ElectionDefinition,
  membershipVkHash,
  pinnedVersion,
  RECORD_TYPES,
  type RegisteredKeys,
  selectBallots,
} from "@abolishus/crypto";

/** One rejected ballot entry: its position in the copy, from 0, and why. */
export interface RejectedBallot {
  readonly entry: number;
  readonly code: BallotCode | "decode";
  /** `option-proof`'s first failing option. */
  readonly option?: number;
  /** `decode`'s strict-decoding code (docs/spec/notation.md). */
  readonly decodeError?: DecodeErrorCode;
}

/**
 * An admitted ballot with the same tier, nullifier and message as one at an
 * earlier position: a repeat once the close rule (5.5) admits that one (5.7).
 */
export interface RepeatedBallot {
  readonly entry: number;
}

/** The report's `ballots`, once the admission checks ran. */
export interface BallotsReport {
  /** Ballot entries 5.1 to 5.4 admit, repeats among them included. */
  readonly admitted: number;
  readonly rejected: readonly RejectedBallot[];
  readonly repeats: readonly RepeatedBallot[];
}

export interface BallotOutcome {
  readonly status: "pass" | "fail" | "unverifiable";
  readonly code?: BallotCode | "unsupported-version" | "not-reached";
  readonly at?: { readonly entry: number } | Record<string, never>;
}

const ROWS = ["5.1", "5.2", "5.3", "5.4"] as const;
const ALL_ROWS = [...ROWS, "5.7"] as const;

// The rows each admission code fails (docs/spec/verifier.md, Ballot
// admission). A membership proof is checked once against [ρ, ν, m̂, ŝ], so
// its failure can't say whether the root (5.1), the scope (5.2) or the
// message (5.3) was another; a decode failure is no row's. Exhaustive: a new
// code doesn't compile until it is placed.
const ROWS_OF: Readonly<Record<BallotCode, readonly (typeof ROWS)[number][]>> = {
  "ballot-stray": ["5.1"],
  "ballot-tier": ["5.1"],
  "membership-proof": ["5.1", "5.2", "5.3"],
  "validity-shape": ["5.4"],
  "share-hash-unqualified": ["5.4"],
  "option-proof": ["5.4"],
  "sum-proof": ["5.4"],
};

const all = (o: BallotOutcome) => new Map(ALL_ROWS.map((id) => [id, o]));
const NOT_REACHED: BallotOutcome = { status: "unverifiable", code: "not-reached" };

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The rows 5.1 to 5.4 and 5.7, and the report's `ballots`. `registered` is the key set
 * the transcript check returned once 3.2 passed, or `undefined`, which leaves
 * every ballot unchecked: shares made to an unregistered panel can't be
 * judged (T-37).
 */
export function ballotChecks(
  d: ElectionDefinition,
  registered: readonly RegisteredKeys[] | undefined,
  entries: readonly Uint8Array[],
  boardEntryVersion: BoardEntryVersion,
): { readonly rows: ReadonlyMap<string, BallotOutcome>; readonly report?: BallotsReport } {
  // A ballot version this verifier doesn't read may be one a later release
  // reads: unverifiable, never failed, so releases agree (2.3; T-36).
  if (pinnedVersion(d, RECORD_TYPES.ballot) !== 1)
    return { rows: all({ status: "unverifiable", code: "unsupported-version", at: {} }) };
  // Another membership key fails 1.3, and a tier root of 0 is one anyone
  // proves membership of (T-04, T-05): no ballot is judged under either.
  if (
    registered === undefined ||
    !equal(d.membership_vk_hash, membershipVkHash()) ||
    d.electorate.some((g) => g.root === 0n)
  )
    return { rows: all(NOT_REACHED) };
  const election = ballotElection(d, registered);
  const admitted: AdmittedBallot[] = [];
  const rejected: RejectedBallot[] = [];
  for (const [at, encoded] of entries.entries()) {
    let payload: Uint8Array;
    try {
      const e = decodeBoardEntry(encoded, boardEntryVersion);
      // 4.1 reports an entry that doesn't decode or names another election.
      if (!equal(e.election_id, d.election_id)) continue;
      payload = e.payload;
    } catch (e) {
      if (e instanceof DecodeError) continue;
      throw e;
    }
    if ((((payload[0] as number) << 8) | (payload[1] as number)) !== RECORD_TYPES.ballot) continue;
    let checked;
    try {
      checked = checkBallot(election, decodeBallot(payload, 1));
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      rejected.push({ entry: at, code: "decode", decodeError: e.code });
      continue;
    }
    if (checked.ok)
      admitted.push({
        tier: checked.tier,
        nullifier: checked.nullifier,
        message: checked.message,
        l1RefNumber: checked.l1RefNumber,
        index: BigInt(at),
      });
    else
      rejected.push({
        entry: at,
        code: checked.code,
        ...(checked.option !== undefined && { option: checked.option }),
      });
  }
  const judged = rejected.filter(
    (r): r is RejectedBallot & { readonly code: BallotCode } => r.code !== "decode",
  );
  const rows = new Map<string, BallotOutcome>();
  for (const id of ROWS) {
    const first = judged.find((r) => ROWS_OF[r.code].includes(id));
    rows.set(
      id,
      first === undefined
        ? { status: "pass" }
        : { status: "fail", code: first.code, at: { entry: first.entry } },
    );
  }
  // `message` is M recomputed from the record, so a re-randomised proof
  // doesn't hide a repeat (T-38).
  const repeats = selectBallots(admitted).repeats.map((b) => ({ entry: Number(b.index) }));
  const first = repeats[0];
  // The input to 5.7 is the ballots every other admission check admits. 5.8
  // depends on M alone, which copies share, but the close rule (5.5) judges
  // each entry by its own L2 block (ADR 0025), so an earlier copy may yet be
  // rejected, and a rejected entry never makes another a repeat (6.1, R4).
  // Until 5.5 runs, a candidate repeat can't be rejected, and 5.7 passes
  // only when there is none.
  rows.set(
    "5.7",
    first === undefined
      ? { status: "pass" }
      : { status: "unverifiable", code: "not-reached", at: { entry: first.entry } },
  );
  return { rows, report: { admitted: admitted.length, rejected, repeats } };
}
