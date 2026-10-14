// Ballot admission (docs/spec/verifier.md, Ballot admission): 5.1 to 5.4 over
// every ballot of this election on the board copy, by @abolishus/crypto's
// `checkBallot` (under definition versions 3 and 4, `checkBallotV2`, against
// the ballot's cell; under definition version 5, `checkBallotV3`, against its
// cell and the questions) with the definition and the key set the transcript
// check registered, never against anything a ballot or the bundle chooses
// (T-37, T-04). A ballot reaches the board by the board path, as a ballot
// record in a board entry, or by the ordinary contract path, as the board
// contract's `BallotSubmitted` event in a contract-event record; each copy is
// judged by its own path's window, the close rule (5.5, docs/spec/close.md,
// Window), so a late copy never stands in for a timely one (T-35, T-50). A
// failure rejects that entry only: the rows report each check's first
// rejected entry and the report lists every one (8.3), so a bad ballot never
// fails the election (T-52, T-53). Repeats (5.7) are found among the ballots
// 5.1 to 5.5 admit by @abolishus/crypto's `selectBallots`, keyed by
// (tier, ν, M) with M recomputed, never by bytes (T-38). Where the bundle
// gives a run of finalized L1 headers (format 5), each ballot's L1 reference
// (5.8) is judged against it before repeats, as docs/spec/revoting.md's
// Selection takes the ballots that passed every admission check; selection
// (6.1) is decided over the admitted ballots, later.

import {
  type AdmittedBallot,
  type AnchorClock,
  type BallotCheck,
  type BallotCheckV2,
  type BallotCode,
  type BallotCore,
  ballotElection,
  type BallotV2Code,
  type BoardEntryVersion,
  cellBallotElection,
  checkBallot,
  checkBallotV2,
  checkBallotV3,
  checkContractEvent,
  type ContractEventVersion,
  DecodeError,
  type DecodeErrorCode,
  decodeBallot,
  decodeBoardEntry,
  decodeContractEvent,
  membershipVkHash,
  pinnedVersion,
  questionBallotElection,
  RECORD_TYPES,
  type RegisteredKeys,
  selectBallots,
} from "@abolishus/crypto";
import type { VerifiedDefinition } from "./definition.ts";
import type { L1Header } from "./l1.ts";
import { countedFloor } from "./openings.ts";
import { type L1RefCode, referenceJudge } from "./references.ts";

/** One rejected ballot entry: its position in the copy, from 0, and why. */
export interface RejectedBallot {
  readonly entry: number;
  readonly code: AdmissionCode | WindowCode | L1RefCode | "repeat" | "decode";
  /** `option-proof`'s first failing option (ballot version 3: flat option). */
  readonly option?: number;
  /** Ballot version 3's `sum-proof`: the first failing question. */
  readonly question?: number;
  /** `decode`'s strict-decoding code (docs/spec/notation.md). */
  readonly decodeError?: DecodeErrorCode;
}

/**
 * An admitted ballot with the same tier, nullifier and message as one at an
 * earlier position, while the close rule (5.5) can't run: a repeat once it
 * admits that one (5.7).
 */
export interface RepeatedBallot {
  readonly entry: number;
}

/** The report's `ballots`, once the admission checks ran. */
export interface BallotsReport {
  /**
   * Ballot entries 5.1 to 5.5 and 5.7 admit; where 5.5 can't run, those 5.1
   * to 5.4 admit, candidate repeats included.
   */
  readonly admitted: number;
  readonly rejected: readonly RejectedBallot[];
  /** Candidate repeats, listed only where 5.5 can't run; otherwise rejected with `repeat`. */
  readonly repeats: readonly RepeatedBallot[];
  /**
   * Where 5.8 judged references: ballots naming a block beyond the finalized
   * head before L1 has finalized one after close, neither admitted nor rejected.
   */
  readonly pending?: readonly RepeatedBallot[];
}

/** An admitted ballot's core and segment, which 6.2's `opening-cast` compares openings with. */
export interface AdmittedCore {
  readonly entry: number;
  readonly segment: number;
  readonly core: Pick<BallotCore, "definitionHash" | "vss">;
}

/** Every admission code: versions 2 and 3 have `ballot-cell` where version 1 has `ballot-tier`. */
export type AdmissionCode = BallotCode | BallotV2Code;

/** The close rule's codes (docs/spec/close.md, Window), checked after 5.1 to 5.4. */
export type WindowCode = "window-before-open" | "window-after-close" | "window-boarded-late";

export interface BallotOutcome {
  readonly status: "pass" | "fail" | "unverifiable";
  readonly code?:
    | AdmissionCode
    | WindowCode
    | L1RefCode
    | "repeat"
    | "l1-ref-pending"
    | "l1-blocks-short"
    | "unsupported-version"
    | "not-reached";
  readonly at?: { readonly entry: number } | Record<string, never>;
}

const ROWS = ["5.1", "5.2", "5.3", "5.4"] as const;
const ALL_ROWS = [...ROWS, "5.5", "5.7", "5.8"] as const;

// The rows each admission code fails (docs/spec/verifier.md, Ballot
// admission). A membership proof is checked once against [ρ, ν, m̂, ŝ], so
// its failure can't say whether the root (5.1), the scope (5.2) or the
// message (5.3) was another; a decode failure is no row's. Exhaustive: a new
// code doesn't compile until it is placed.
const ROWS_OF: Readonly<Record<AdmissionCode, readonly (typeof ROWS)[number][]>> = {
  "ballot-stray": ["5.1"],
  "ballot-tier": ["5.1"],
  "ballot-cell": ["5.1"],
  "membership-proof": ["5.1", "5.2", "5.3"],
  "validity-shape": ["5.4"],
  "share-hash-unqualified": ["5.4"],
  "option-proof": ["5.4"],
  "sum-proof": ["5.4"],
};
const WINDOW_CODES: ReadonlySet<string> = new Set<WindowCode>([
  "window-before-open",
  "window-after-close",
  "window-boarded-late",
]);
const L1_REF_CODES: ReadonlySet<string> = new Set<L1RefCode>([
  "l1-ref-before-open",
  "l1-ref-after-close",
  "l1-ref-unknown",
]);

// 5.8 joins the other rows only where the bundle gives L1 blocks: without
// them it stays not implemented.
const all = (o: BallotOutcome, blocks: boolean) =>
  new Map((blocks ? ALL_ROWS : ALL_ROWS.slice(0, -1)).map((id) => [id, o]));
const NOT_REACHED: BallotOutcome = { status: "unverifiable", code: "not-reached" };

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// The contract-event versions this verifier reads; under version 1 the board
// emits no event, so every ballot is a board-path one.
const readsEvents = (v: number | undefined): v is ContractEventVersion => v === 1 || v === 2;

/** Where one ballot copy came from: its own path decides its window (5.5). */
type Path =
  | { readonly kind: "board"; readonly segment: number }
  | { readonly kind: "ordinary"; readonly segment: number; readonly l2Timestamp: bigint };

/**
 * The rows 5.1 to 5.5 and 5.7, and the report's `ballots`. `registered` is
 * the key set the transcript check returned once 3.2 passed, or `undefined`,
 * which leaves every ballot unchecked: shares made to an unregistered panel
 * can't be judged (T-37). `clock` is the anchoring clock, which gives the
 * board path's last segment, `s_A = period(closes_at) + 1`. `blocks`, a
 * format-5 bundle's run of finalized L1 headers, adds 5.8.
 */
export function ballotChecks(
  definition: VerifiedDefinition,
  registered: readonly RegisteredKeys[] | undefined,
  entries: readonly Uint8Array[],
  boardEntryVersion: BoardEntryVersion,
  clock: AnchorClock,
  blocks?: readonly L1Header[],
): {
  readonly rows: ReadonlyMap<string, BallotOutcome>;
  readonly report?: BallotsReport;
  readonly admitted?: readonly AdmittedCore[];
} {
  const judge = judgeFor(definition, registered);
  if (typeof judge !== "function") return { rows: all(judge, blocks !== undefined) };
  const d = definition.value;
  const eventVersion = pinnedVersion(d, RECORD_TYPES.contractEvent);
  // Under a contract-event version this verifier doesn't read, ordinary
  // ballots can't be found, so no row may say none was rejected: 5.1 to 5.4
  // report the board path's, and 5.5 and 5.7 are unverifiable, never passed
  // (T-36).
  const windows = readsEvents(eventVersion);
  const contracts = {
    electionRegistry: d.election_registry,
    trusteeRegistry: d.trustee_registry,
    groupRegistry: d.group_registry,
    board: d.board,
  };
  const lastBoardSegment = countedFloor(d.closes_at, clock);
  // References are judged only where every copy's window is: a row 5.5
  // can't decide can't let 5.8 pass either (T-36).
  const references =
    blocks !== undefined && windows ? referenceJudge(blocks, d.opens_at, d.closes_at) : undefined;
  const pending: RepeatedBallot[] = [];
  const passed: { readonly at: number; readonly path: Path; readonly ballot: AdmittedBallot }[] =
    [];
  const cores: AdmittedCore[] = [];
  const rejected: RejectedBallot[] = [];
  for (const [at, encoded] of entries.entries()) {
    let payload: Uint8Array;
    let path: Path;
    try {
      const e = decodeBoardEntry(encoded, boardEntryVersion);
      // 4.1 reports an entry that doesn't decode or names another election.
      if (!equal(e.election_id, d.election_id)) continue;
      const type = ((e.payload[0] as number) << 8) | (e.payload[1] as number);
      if (type === RECORD_TYPES.ballot) {
        payload = e.payload;
        path = { kind: "board", segment: e.segment };
      } else if (type === RECORD_TYPES.contractEvent && windows) {
        // A record that doesn't decode or fails the event check is 4.4's,
        // and carries no ballot: only the board's own `BallotSubmitted`, as
        // its contract framed it, is an ordinary ballot (T-71, T-17).
        const record = decodeContractEvent(e.payload, eventVersion);
        const checked = checkContractEvent(record, contracts, eventVersion);
        if (!checked.ok || checked.role !== "board" || checked.event.event !== "BallotSubmitted")
          continue;
        payload = checked.event.record;
        path = { kind: "ordinary", segment: e.segment, l2Timestamp: record.l2_timestamp };
      } else continue;
    } catch (e) {
      if (e instanceof DecodeError) continue;
      throw e;
    }
    let judged;
    try {
      judged = judge(payload);
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      rejected.push({ entry: at, code: "decode", decodeError: e.code });
      continue;
    }
    const { core, checked } = judged;
    if (!checked.ok) {
      rejected.push({
        entry: at,
        code: checked.code,
        ...(checked.option !== undefined && { option: checked.option }),
        ...(checked.question !== undefined && { question: checked.question }),
      });
      continue;
    }
    // The close rule (5.5) judges each copy by its own entry, after 5.1 to
    // 5.4: an ordinary ballot by its L2 block's timestamp, a board-path one
    // by its segment, at most `s_A`, the operator's word (docs/spec/close.md,
    // Window; T-35, T-50).
    const late = windows ? windowCode(path, d.opens_at, d.closes_at, lastBoardSegment) : undefined;
    if (late !== undefined) {
      rejected.push({ entry: at, code: late });
      continue;
    }
    // 5.8 reads only the reference M binds, so every copy of a ballot gets
    // the same verdict, and a pending one stays among the ballots 5.7
    // compares: whatever L1 later decides for it, it decides for its copies.
    if (typeof references === "function") {
      const verdict = references(checked);
      if (verdict === "pending") pending.push({ entry: at });
      else if (verdict !== "admitted") {
        rejected.push({ entry: at, code: verdict });
        continue;
      }
    }
    cores.push({ entry: at, segment: path.segment, core });
    passed.push({
      at,
      path,
      ballot: {
        tier: checked.tier,
        nullifier: checked.nullifier,
        message: checked.message,
        l1RefNumber: checked.l1RefNumber,
        index: BigInt(at),
      },
    });
  }
  // `message` is M recomputed from the record, so a re-randomised proof
  // doesn't hide a repeat (T-38).
  const repeated = new Set(selectBallots(passed.map((p) => p.ballot)).repeats.map((b) => b.index));
  let repeats: RepeatedBallot[] = [];
  if (windows) {
    // Every copy left has passed 5.1 to 5.5, so the first of each (tier, ν,
    // M) stands and the others are rejected (5.7). 5.8 can't tell them
    // apart: M binds the L1 reference, so it admits or rejects every copy
    // of a ballot alike.
    for (const b of repeated) rejected.push({ entry: Number(b), code: "repeat" });
    rejected.sort((a, b) => a.entry - b.entry);
  } else repeats = [...repeated].map((b) => ({ entry: Number(b) }));
  const waiting = pending.filter((p) => !repeated.has(BigInt(p.entry)));
  const rows = new Map<string, BallotOutcome>();
  const firstWith = (has: (r: RejectedBallot) => boolean): BallotOutcome => {
    const first = rejected.find(has);
    return first === undefined
      ? { status: "pass" }
      : {
          status: "fail",
          code: first.code as NonNullable<BallotOutcome["code"]>,
          at: { entry: first.entry },
        };
  };
  for (const id of ROWS)
    rows.set(
      id,
      firstWith(
        (r) => Object.hasOwn(ROWS_OF, r.code) && ROWS_OF[r.code as AdmissionCode].includes(id),
      ),
    );
  if (windows) {
    rows.set(
      "5.5",
      firstWith((r) => WINDOW_CODES.has(r.code)),
    );
    rows.set(
      "5.7",
      firstWith((r) => r.code === "repeat"),
    );
  } else {
    rows.set("5.5", UNSUPPORTED);
    rows.set("5.7", UNSUPPORTED);
  }
  if (blocks !== undefined)
    rows.set(
      "5.8",
      !windows
        ? UNSUPPORTED
        : references === "l1-blocks-short"
          ? { status: "unverifiable", code: "l1-blocks-short", at: {} }
          : // A pending ballot may yet be admitted or rejected, so the row
            // can neither pass nor fail while one waits (revoting.md,
            // Pending never lasts).
            waiting[0] !== undefined
            ? { status: "unverifiable", code: "l1-ref-pending", at: { entry: waiting[0].entry } }
            : firstWith((r) => L1_REF_CODES.has(r.code)),
    );
  const unsettled = new Set(waiting.map((p) => p.entry));
  const admitted = windows
    ? passed.filter((p) => !repeated.has(BigInt(p.at)) && !unsettled.has(p.at))
    : passed;
  return {
    rows,
    report: {
      admitted: admitted.length,
      rejected,
      repeats,
      ...(typeof references === "function" && { pending: waiting }),
    },
    admitted: cores,
  };
}

/** The close rule's code for an admitted copy, by its own path, or `undefined` inside the window. */
function windowCode(
  path: Path,
  opensAt: bigint,
  closesAt: bigint,
  lastBoardSegment: bigint,
): WindowCode | undefined {
  if (path.kind === "board")
    // No opening test: a segment bounds time only to a period, and 5.8
    // bounds an early ballot's reference anyway (docs/spec/close.md, Why
    // each path's test).
    return BigInt(path.segment) > lastBoardSegment ? "window-boarded-late" : undefined;
  if (path.l2Timestamp < opensAt) return "window-before-open";
  if (path.l2Timestamp > closesAt) return "window-after-close";
  return undefined;
}

/** One ballot payload's strict decoding and admission checks, with its core. */
export type Judge = (payload: Uint8Array) => {
  readonly core: AdmittedCore["core"];
  /** Versions 2 and 3 share `BallotCheckV2`. */
  readonly checked: BallotCheck | BallotCheckV2;
};

export const UNSUPPORTED: BallotOutcome = {
  status: "unverifiable",
  code: "unsupported-version",
  at: {},
};

/**
 * How this definition's ballots are judged, or the outcome every row takes
 * when none can be (docs/spec/verifier.md, Ballot admission, step 1).
 * Definition version 1's ballots (version 1) name a tier; versions 3 and 4
 * pin ballot version 2, which names a cell of the partition, so its root and
 * scope come from that cell, never from the ballot (2.8, T-16); version 5
 * pins ballot version 3, which names its cell too and carries one range
 * proof per question, judged against the definition's questions, never
 * against limits the ballot states (T-28).
 */
export function judgeFor(
  definition: VerifiedDefinition,
  registered: readonly RegisteredKeys[] | undefined,
): BallotOutcome | Judge {
  const d = definition.value;
  const pinned = pinnedVersion(d, RECORD_TYPES.ballot);
  const own = definition.version === 1 ? 1 : definition.version === 5 ? 3 : 2;
  // A ballot version this verifier doesn't read under this definition
  // version may be one a later release reads: unverifiable, never failed, so
  // releases agree (2.3; T-36).
  if (pinned !== own && pinned !== 1) return UNSUPPORTED;
  // Ballot version 1 names a tier, and a partition of cells can't be read
  // from one (2.3 fails that profile). Another membership key fails 1.3, and
  // a root of 0 is one anyone proves membership of (T-04, T-05): no ballot
  // is judged under any of them.
  if (
    pinned !== own ||
    registered === undefined ||
    !equal(d.membership_vk_hash, membershipVkHash())
  )
    return NOT_REACHED;
  if (definition.version === 1) {
    if (definition.value.electorate.some((g) => g.root === 0n)) return NOT_REACHED;
    const election = ballotElection(definition.value, registered);
    return (payload) => {
      const record = decodeBallot(payload, 1);
      return {
        core: { definitionHash: record.definition_hash, vss: record.committed_vote.vss },
        checked: checkBallot(election, record),
      };
    };
  }
  if (definition.value.electorate.some((t) => t.cells.some((c) => c.root === 0n)))
    return NOT_REACHED;
  if (definition.version === 5) {
    const election = questionBallotElection(definition.value, registered);
    return (payload) => {
      const record = decodeBallot(payload, 3);
      return {
        core: { definitionHash: record.definition_hash, vss: record.committed_vote.vss },
        checked: checkBallotV3(election, record),
      };
    };
  }
  const election = cellBallotElection(definition.value, registered);
  return (payload) => {
    const record = decodeBallot(payload, 2);
    return {
      core: { definitionHash: record.definition_hash, vss: record.committed_vote.vss },
      checked: checkBallotV2(election, record),
    };
  };
}
