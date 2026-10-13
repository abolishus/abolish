// Runs a simulated election in memory through @abolishus/crypto's own code:
// a well-formed definition and its signed key ceremony (./election.ts), each
// voter's sharing and share encryption, the tracking code shown before the
// cast-or-challenge choice, a challenged attempt's opening and its checker's
// verdict (./challenge.ts), the cast attempt's validity proof, the share
// intake of each trustee up at its cast (proof checks, decryption,
// share checks, receipt) and the receipt's check under the seat's registered
// signing key, each ballot's L1 reference on a simulated L1 (./l1.ts), the
// ballot record on the board (./board.ts) with the operator's receipt and
// the client's check of it at cast, each such seat's share receipt on the
// board and a posting voter's postings of the seats down at its cast, the verifier's
// board check, and from the boarded records: each ballot's admission check,
// the re-vote rule's selection of each voter's counted ballot, the delivery
// check that keeps only delivered ones, the summed shares of those, sent
// between seats in summed-share messages, each honest seat's combination of
// each cell from the k lowest passing seats, the cell's signed opening on
// the board and the verifier's tally check over the board's openings, the
// challenged attempts' openings their voters ask to publish, which the
// operator boards after the counted extent (./publication.ts), then
// each online seat's destruction statement and the verifier's destruction
// report. An anchoring authority anchors the board's checkpoints
// (./anchor.ts), and three reads of the board run the board checks over
// them: the trustees' read of the counted extent, a node's of the tally
// openings before it destroys, and the verifier's of the whole board once
// the seal's window has closed. Nothing
// here reimplements a check the verifier makes (AGENTS.md, Architecture): it
// only calls them and compares the result with the plan (T-29, T-54, T-25,
// T-14).

import {
  type AdmittedBallot,
  aggregateCell,
  aggregateHash,
  type BallotRecord,
  ballotCore,
  ballotElection,
  ballotHash,
  type CellOpening,
  checkBoard,
  checkDelivery,
  checkpointHash,
  checkDestruction,
  checkL1Reference,
  checkReceiptAtCast,
  checkShareReceipt,
  checkSummedShares,
  checkTally,
  type CommittedVote,
  coreHash,
  decode,
  decodeBallot,
  decodeMembershipProof,
  type DeliveryBallot,
  type DeliveryEntry,
  deliveryDeadlines,
  deliverySegments,
  deriveTotal,
  encodeBallot,
  encodeDestructionStatement,
  encodeOpening,
  decodeOpening,
  openingCoreHash,
  encodeReceipt,
  encodeSharePosting,
  encodeShareReceipt,
  encodeTallyOpening,
  encryptShares,
  GROUP_ORDER,
  type IntakeKeys,
  l1RefMin,
  membershipMessage,
  membershipVkEncoding,
  openCell,
  openChallenge,
  openSummedShares,
  openedCommitments,
  opensBallotCommitment,
  proveValidity,
  RECORD_TYPES,
  sealSummedShares,
  type SeatDestruction,
  type SeatSecrets,
  selectBallots,
  type Share,
  SHARE_CIPHERTEXT,
  shareReceiptRecord,
  shareVote,
  signDestructionStatement,
  signTallyOpening,
  type SpoiledBallotOpening,
  sumShares,
  type TallyCode,
  type TallyRules,
  trackingCode,
  type ValidityContext,
  verifyBoard,
} from "@abolishus/crypto";
import { parseBundle, type Verdict, verifyBundle } from "@abolishus/verifier";
import { SimulatedAnchor } from "./anchor.ts";
import { type VerifierBundle, verifierBundle } from "./bundle.ts";
import {
  afterAnchored,
  endOf,
  postClose,
  SIMULATED_ANCHOR_DEADLINE,
  SIMULATED_ANCHOR_PERIOD,
  SimulatedBoard,
  segmentAt,
} from "./board.ts";
import { checkChallenge } from "./challenge.ts";
import {
  type Intake,
  intakeInThread,
  intakeInWorkers,
  MAX_INTAKE_WORKERS,
  type SeatCiphertext,
  type SeatIntake,
} from "./intake.ts";
import { admitOpening } from "./publication.ts";
import { SIMULATED_BOARD_ENTRY_VERSION, simulateElection } from "./election.ts";
import { nameBlock, SimulatedL1 } from "./l1.ts";
import {
  deliveredAt,
  downAt,
  type Plan,
  type PlannedBallot,
  type PlannedVoter,
  planElection,
  secondsAt,
  selectionRange,
} from "./plan.ts";
import type { Scenario, SimulatedTier } from "./scenario.ts";
import { judgeVerifierReport } from "./verify.ts";

/**
 * What this run models only in outline, until the items that build each
 * piece land (docs/status/P1-21.md). Every report carries the list, so no
 * result is mistaken for a run of the whole protocol.
 */
export const SIMULATION_STUBS = Object.freeze([
  "definition: a well-formed version-1 definition, but its contracts, chain IDs, election counter, clock and tier roots are placeholders and nothing registers it on L2 (P1-18, P3-2)",
  "ceremony: every seat takes part in the four signed rounds, and the operator boards the transcript as the board's first entry; no release pins the panel, whose identity keys are fresh per run, so the verifier's bundle gives it as a local input (P1-7)",
  "membership: no membership proofs; each voter's nullifier is its index plus one, and each ballot record carries a placeholder proof, the verification key's own alpha, beta and alpha points, which decodes but proves nothing; the run never checks it, and each ballot's M for the re-vote rule is computed from its record here rather than taken from crypto's checkBallot, while the verifier's admission rejects every ballot for it (5.1 to 5.3, membership-proof), so it never verifies their validity proofs (5.4 covers only their shape and qualified share hashes) and its checks over admitted ballots (5.7, and 6.2's opening-cast) judge none (P1-17b, P3-2)",
  "board: the operator boards each server ballot as it arrives and signs a receipt the voter's client checks at cast, under one receipt key fresh per run that no definition lists or registry holds; the anchoring clock (hourly from the Unix epoch, with a half-hour deadline) is a placeholder, the post-close windows other than the tally, openings' and destruction windows are taken as zero for the counted extent, though the delivery check applies the real delivery deadline (every delivery record is boarded or sent long before it), so the counted extent ends one period after close and the seal is the destruction window's end (P1-13b, P1-18)",
  "anchoring: an anchoring authority anchors the checkpoint of every period that added entries, and the seal's, in the first block after the period ends, and every reader judges them with crypto's verifyBoard; but the anchor contract, its clock and the authority's key are simulated, readers during the election take the anchors from memory, and only the verifier's final read proves them from L1 state, a simulated one (the anchor's account alone, with placeholder code, under a header whose other fields are zero and whose hash isn't the simulated chain's block hash), every period's entries are boarded before its end, and the CIDs name segment objects that nothing publishes or pins; readers check the operator's copy, the tally and destruction checks read it before the final board check authenticates it, a node checks the whole board before destroying rather than each first passing opening's inclusion, and the trustees' moments come from the clock rather than from the blocks they saw (P4-1, P4-3)",
  "delivery: ciphertexts reach trustees in memory, and no contract records anything; a direct ballot is boarded by the operator when the servers return, with no operator receipt, never as a contract event; each online seat's node boards its share receipt right after the ballot, and the operator boards it unchecked rather than under the delivery boarding rules; a posting voter's client posts each seat down at that ballot's cast once, right after cast, as a contract-path record the delivery check reads with its cast time as its submission time, though no contract records it and nothing puts it on the board or the archive; a departing seat's receipts for ballots it took before going down are boarded with them, even a direct ballot's after the seat is down; offline and departed seats never come back, so no seat catches up on postings or complains, and nothing is resent (P1-12c, P1-18, P4-2)",
  "trustees: offline seats go down after the ceremony, for the whole voting period, tally and destruction, and departing seats at their scenario time, for the rest of it, and take no part in the tally or destruction, though they hold shares of every ballot cast before; nothing models a departing seat's node or disk afterwards; faulty seats lie only in their summed shares, which their own node's check refuses to seal, so no lie reaches another seat as a summed-share message, no recipient's refusal is shown, and a cell's excluded seats are those that sent nothing (openCell never sees a failing sum); summed-share messages travel in memory, never over a channel, every honest seat combines, and the lowest seat combined signs each cell's opening",
  "challenges: the checker records each tracking code and checks the opening in memory, with the election the run built rather than one fetched from chain and IPFS; a voter who publishes asks once, in the first period after the counted extent, and the operator's boarding rules are applied here; the verifier's 6.2 reports every published opening without a break but leaves its row unverifiable until it knows s_S, as 7.4 does the tally openings (P1-19, P1-21 part 2)",
  "re-voting: L1 is simulated, a block every 12 seconds with random hashes, all finalized; a reorganised ballot's block is replaced before it is finalized, which the client sees two epochs after the block and then casts the same committed vote again at once, with no light client or header range modelled; every other reference is admitted, so no ballot is replayed, ties, or names a block before opening or after close (P1-21 part 2)",
  "destruction: every online seat signs its statement at the moment the tally rule sets, and the operator boards each one; nothing destroys the run's key material, which lives until the report is returned",
  "verifier: packages/verifier reads the closed election once, at the first block after the seal's window, from a bundle whose definition, clock and panel are local inputs, so its verdict is never better than unverifiable; the checks it doesn't implement yet, and 1.2's and 2.1's comparisons with pinned deployments, aren't exercised (P1-19)",
  "not yet simulated: wipe-and-rebuild (P1-21 part 2)",
] as const);

export type CellOutcome = "opened" | TallyCode;

export interface CellReport {
  readonly tier: SimulatedTier;
  readonly ballots: number;
  /** The plan's counts, per option. */
  readonly expected: readonly number[];
  readonly expectedOutcome: CellOutcome;
  readonly outcome: CellOutcome;
  /** The opened counts, when `outcome` is `opened`. */
  readonly counts?: readonly number[];
  /** The seats combined, the `k` lowest whose summed shares passed. */
  readonly combined?: readonly number[];
  /** Seats whose summed shares failed the check. */
  readonly excluded: readonly number[];
  /**
   * Whether the verifier's tally check over the board's openings (7.2)
   * passed the cell, on the opened counts, with the combiner's signature.
   */
  readonly verified: boolean;
  /** The outcome is the expected one and, when opened, the counts are the plan's. */
  readonly matches: boolean;
}

export interface SimulationReport {
  /** Every cell matched the plan. */
  readonly ok: boolean;
  readonly scenario: Scenario;
  /** The definition's hash, which every ballot, receipt and opening binds, in hex. */
  readonly definition: { readonly hash: string };
  /** The ceremony transcript's hash, which the definition names, and the seats it registered. */
  readonly ceremony: { readonly transcriptHash: string; readonly registered: readonly number[] };
  readonly ballots: {
    /** Every ballot cast, re-votes' earlier ballots and recasts included. */
    readonly cast: number;
    readonly server: number;
    readonly direct: number;
    /** Earlier ballots the re-vote rule didn't select: cast, but not counted. */
    readonly superseded: number;
    /**
     * Last ballots naming an L1 block reorganised away, which admission
     * rejects (`l1-ref-unknown`): each recast, or lost when its block is
     * finalized too late to cast again before close.
     */
    readonly reorged: number;
    /** Reorganised ballots cast again, the same committed vote under a new L1 reference. */
    readonly recast: number;
    /** Attempts challenged before a fresh one was cast, each opening checked by the voter's checker. */
    readonly challenged: number;
    /** Challenged attempts whose openings their voters asked to publish, each boarded after the counted extent. */
    readonly published: number;
    /** Shares posted through the contract path: one per seat down at its cast for each ballot of a posting voter. */
    readonly postings: number;
    /**
     * Ballots the re-vote rule selected that the delivery check kept out of
     * the counted set: a ballot that has a seat down at its cast its voter
     * didn't post.
     */
    readonly undelivered: number;
  };
  /**
   * The board the operator wrote, which passed the verifier's board checks
   * (4.1, 4.2) against every anchor once the seal's window had closed.
   */
  readonly board: {
    readonly entries: number;
    /** Entries in the counted extent: the ceremony transcript, then ballots and share receipts. */
    readonly counted: number;
    /** Share receipts, one from each seat up at its cast per ballot cast. */
    readonly shareReceipts: number;
    /** Tally openings, one per opened cell. */
    readonly openings: number;
    /** Spoiled-ballot openings, one per published challenge. */
    readonly spoiled: number;
    /** The chain head after its last entry, in hex. */
    readonly head: string;
    /** The key that signed every receipt, which the voters' clients pinned, in hex. */
    readonly receiptKey: string;
    /** The seal: the last period the board may use, whose checkpoint fixes its extent. */
    readonly seal: number;
    /**
     * Every checkpoint anchored, in L1 order: one per period that added
     * entries, and the seal's. Each with its size, its checkpoint hash in
     * hex and the L1 time of its block.
     */
    readonly anchors: readonly {
      readonly segment: number;
      readonly size: number;
      readonly hash: string;
      readonly anchoredAt: number;
    }[];
  };
  /**
   * packages/verifier's report over the closed election's format-4 bundle,
   * its anchors and `now` proven from the anchor's simulated L1 state at
   * `block`: the rows it passed and failed, which must be exactly those
   * ./verify.ts expects, and how many ballots admission rejected (each for
   * its placeholder membership proof). Its verdict is unverifiable while
   * any check it runs isn't implemented or the bundle's inputs are local.
   */
  readonly verifier: {
    readonly verdict: Verdict;
    readonly verdictAgainstInputs: Verdict;
    /**
     * The simulated block the proofs are against: its number, and the hash
     * of the bundle's simulated header, which isn't the hash the simulated
     * chain gives that block (SIMULATION_STUBS).
     */
    readonly block: { readonly number: number; readonly headerHash: string };
    readonly passed: readonly string[];
    readonly failed: readonly { readonly id: string; readonly code: string }[];
    readonly rejectedBallots: number;
  };
  readonly trustees: {
    /** Every seat up from the ceremony through destruction, faulty ones included. */
    readonly online: readonly number[];
    readonly offline: readonly number[];
    /** Seats that took ballots, then went down before the tally. */
    readonly departed: readonly number[];
    readonly faulty: readonly number[];
    /**
     * Summed-share messages sealed, one per cell from each honest online
     * seat to each other online seat, every one opened by its recipient and
     * passing.
     */
    readonly summedShareMessages: number;
  };
  readonly cells: readonly CellReport[];
  /**
   * The verifier's destruction report (8.5) over the board's statements: the
   * destruction segment and each registered seat's line, every online seat
   * `destroyed` and every offline or departed one `destruction-missing`.
   */
  readonly destruction: { readonly from: number; readonly seats: readonly SeatDestruction[] };
  /** The election's total, derived from the opened cells, when every cell opened. */
  readonly total?: readonly number[];
  readonly stubs: readonly string[];
}

export interface SimulationProgress {
  readonly stage: "cast" | "tally";
  readonly done: number;
  readonly total: number;
}

export interface SimulationOptions {
  /** Called after each ballot and each cell. */
  readonly onProgress?: (progress: SimulationProgress) => void;
  /**
   * Worker threads for the trustee seats' intake, most of a run's cost: 0
   * (the default) runs it in the calling thread, one ballot at a time. The
   * report doesn't depend on it.
   */
  readonly workers?: number;
  /**
   * Called with the closed election's verifier bundle (docs/spec/verifier.md,
   * Bundle, format 4) before the verifier judges it, so a caller can keep its
   * two files even when the verifier disagrees.
   */
  readonly onBundle?: (bundle: VerifierBundle) => void;
}

// A faulty seat's lie: option 0's summed vote share plus one, which the
// summed-share check refuses before the seat's node seals it.
function corrupt(summed: readonly Share[]): Share[] {
  return summed.map((s, j) => (j === 0 ? { v: (s.v + 1n) % GROUP_ORDER, r: s.r } : s));
}

/** What every cell must show: the outcome and, for each, which seats are excluded and combined. */
export interface CellExpectation {
  readonly outcome: CellOutcome;
  /** The faulty seats, ascending: the summed-share check must catch each. */
  readonly excluded: readonly number[];
  /** When opened, the `k` lowest honest online seats. */
  readonly combined: readonly number[];
}

/** Every seat up through the tally: neither offline nor departing. */
const onlineSeats = (scenario: Scenario): number[] => {
  const { panel, offline, departures } = scenario.trustees;
  return Array.from({ length: panel }, (_, i) => i + 1).filter(
    (s) => !offline.includes(s) && !departures.some((d) => d.seat === s),
  );
};

export function expectCells(scenario: Scenario): CellExpectation {
  const { threshold, faulty } = scenario.trustees;
  const honest = onlineSeats(scenario).filter((s) => !faulty.includes(s));
  return {
    outcome: honest.length >= threshold ? "opened" : "tally-quorum",
    excluded: faulty,
    combined: honest.slice(0, threshold),
  };
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// A record's type, the u16 at the head of its encoding (docs/spec/notation.md):
// which records on the board each check reads.
const recordTypeOf = (record: Uint8Array) => ((record[0] ?? 0) << 8) | (record[1] ?? 0);

// What the delivery check reads (docs/spec/delivery.md, Delivery check).
const DELIVERY_RECORD_TYPES: ReadonlySet<number> = new Set([
  RECORD_TYPES.shareReceipt,
  RECORD_TYPES.sharePosting,
  RECORD_TYPES.shareComplaint,
]);

const same32 = (a: Uint8Array, b: Uint8Array) =>
  a.length === 32 && b.length === 32 && a.every((x, i) => x === b[i]);

const same = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Judges one cell's tally against the plan: the outcome, the excluded and
 * combined seats, and, when opened, the verifier's check and the counts.
 * Any difference is a `matches: false` the report carries.
 */
export function judgeCell(
  cell: {
    readonly tier: SimulatedTier;
    readonly ballots: number;
    readonly expected: readonly number[];
  },
  want: CellExpectation,
  opened: CellOpening,
  verified: boolean,
): CellReport {
  const base = {
    ...cell,
    expectedOutcome: want.outcome,
    excluded: opened.excluded,
  };
  if (!opened.ok)
    return {
      ...base,
      outcome: opened.code,
      verified: false,
      matches: opened.code === want.outcome && same(opened.excluded, want.excluded),
    };
  const counts = opened.counts.map(Number);
  return {
    ...base,
    outcome: "opened",
    counts,
    combined: opened.combined,
    verified,
    matches:
      want.outcome === "opened" &&
      verified &&
      same(counts, cell.expected) &&
      same(opened.excluded, want.excluded) &&
      same(opened.combined, want.combined),
  };
}

/**
 * Runs `scenario` and reports each cell's result against the plan. Rejects
 * only on a bug, or a `workers` that isn't an integer from 0 to
 * `MAX_INTAKE_WORKERS`.
 */
export async function runSimulation(
  scenario: Scenario,
  options: SimulationOptions = {},
): Promise<SimulationReport> {
  const workers = options.workers ?? 0;
  if (!Number.isSafeInteger(workers) || workers < 0 || workers > MAX_INTAKE_WORKERS)
    throw new RangeError(`simulation: workers must be an integer from 0 to ${MAX_INTAKE_WORKERS}`);
  const plan: Plan = planElection(scenario);
  const { panel: n, threshold: k, offline, faulty } = scenario.trustees;
  const { min, max } = selectionRange(scenario);
  const rules = {
    optionCount: scenario.options,
    minSelections: min,
    maxSelections: max,
    threshold: k,
    panelSize: n,
  };
  const election = simulateElection(scenario, plan);
  const { definitionHash, seats, registered } = election;
  // Ballots go only to the keys the ceremony check registered, by seat (T-37).
  const keys = registered.map((r) => r.kemKey);
  // The checker's election and the casting device's: one definition and the
  // key set its ceremony check registered.
  const ballots = ballotElection(election.definition, registered);
  // The seats that sum, combine and destroy: a departed seat's shares go down with it.
  const online = onlineSeats(scenario);
  const departed = scenario.trustees.departures.map((d) => d.seat);

  const tallyRules: TallyRules = { optionCount: scenario.options, threshold: k, panelSize: n };
  // The L1 window the re-vote rule reads (docs/spec/revoting.md, Admission):
  // a verifier of the closed election takes the first block after close as
  // its head.
  const { opens_at: opensAt, closes_at: closesAt } = election.definition;
  const l1 = new SimulatedL1();
  const finalized = l1.finalized(l1.firstAfter(closesAt));
  const refMin = l1RefMin(finalized, 0n, opensAt);
  if (refMin === undefined) throw new Error("simulation: L1 hasn't reached the election's window");
  const window = { l1RefMin: refMin, closesAt };

  // Every ballot cast, in time order: a re-voting voter's earlier ballot,
  // then each voter's last, then its recast if the last named a block
  // reorganised away and the client could cast again before close.
  const order = { earlier: 0, last: 1, recast: 2 } as const;
  type Cast = {
    readonly voter: PlannedVoter;
    readonly ballot: PlannedBallot;
    readonly kind: keyof typeof order;
    readonly seconds: bigint;
  };
  const casts = plan.voters
    .flatMap((voter): Cast[] => {
      const { earlier, reorg } = voter;
      return [
        ...(earlier === null
          ? []
          : [{ voter, ballot: earlier, kind: "earlier" as const, seconds: secondsAt(earlier.at) }]),
        { voter, ballot: voter, kind: "last", seconds: secondsAt(voter.at) },
        // A recast posts and challenges nothing: only its time and path are its own.
        ...(reorg?.recast == null
          ? []
          : [
              {
                voter,
                ballot: {
                  votes: voter.votes,
                  at: reorg.recast.at,
                  path: reorg.recast.path,
                  posts: false,
                },
                kind: "recast" as const,
                seconds: reorg.recast.seconds,
              },
            ]),
      ];
    })
    .sort((a, b) =>
      a.seconds !== b.seconds
        ? Number(a.seconds - b.seconds)
        : a.ballot.at - b.ballot.at ||
          a.voter.index - b.voter.index ||
          order[a.kind] - order[b.kind],
    );
  // The board and its operator. The client accepts a receipt's segment
  // within one period of its cast's, from the election's first segment to
  // its seal (board client rule 1).
  const operator = new SimulatedBoard(
    election.definition.election_id,
    SIMULATED_BOARD_ENTRY_VERSION,
  );
  const firstSegment = segmentAt(opensAt);
  // The ceremony's transcript, which the definition's hash of it names, is
  // the board's first entry, in the election's first segment, so the
  // verifier's 3.1 and 3.2 find it on the board alone (T-37).
  operator.board(firstSegment, election.transcript);
  const after = postClose(closesAt);
  const { seal } = after;
  const anchor = new SimulatedAnchor(election.definition.election_id, firstSegment, seal, l1);
  // A reader's board check at `moment`, as the verifier's 4.1 and 4.2 make
  // it: once the first L1 block at or after `moment` is finalized, it reads
  // every anchor and takes that block's time as `now`, so only anchors in
  // blocks up to it count. The check authenticates the board up to the
  // largest anchored size, and an honest board must be all of it (T-23, T-24).
  const anchoredBoard = (moment: bigint) => {
    const now = l1.block(l1.firstAfter(moment - 1n)).timestamp;
    const verified = verifyBoard(
      election.definition.election_id,
      operator.entries,
      SIMULATED_BOARD_ENTRY_VERSION,
      anchor.anchors,
      anchor.clock,
      now,
    );
    if (verified.unauthenticated > 0)
      throw new Error("simulation: an entry no timely anchor covers");
    return verified.board;
  };
  // A ballot record's placeholder membership proof (SIMULATION_STUBS): the
  // verification key's alpha (G1) and beta (G2) points, which decode.
  const vk = membershipVkEncoding();
  const placeholderProof = decodeMembershipProof(
    Uint8Array.from([...vk.subarray(0, 192), ...vk.subarray(0, 64)]),
  );
  // Per board position, each online seat's shares of the ballot there, which
  // the trustees keep until the re-vote rule has selected, and whether the
  // plan has the rule select it.
  interface Kept {
    readonly shares: ReadonlyMap<number, readonly Share[]>;
    readonly selects: boolean;
    /** Whether it names a block reorganised away, so admission rejects it (`l1-ref-unknown`). */
    readonly reorged: boolean;
    /** Whether the plan expects the ballot delivered to every qualified seat. */
    readonly delivered: boolean;
    /** The seats down at the ballot's cast, which took no share of it. */
    readonly down: readonly number[];
  }
  const kept: Kept[] = [];
  // Ballots submitted directly while our servers are down, which the
  // operator boards when they return (SIMULATION_STUBS), each with its
  // share receipts from the seats up at its cast.
  let pending: (Kept & { readonly payload: Uint8Array; readonly receipts: Uint8Array[] })[] = [];
  const returnsAt = segmentAt(secondsAt(scenario.outage?.to ?? 1));
  // Each seat's node boards its share receipt once the ballot is on
  // the board (docs/spec/delivery.md, Boarding rule 2): a receipted seat is
  // delivered even when the client goes away (Client rules).
  let shareReceipts = 0;
  const boardReceipts = (segment: number, receipts: readonly Uint8Array[]) => {
    for (const r of receipts) operator.board(segment, r);
    shareReceipts += receipts.length;
  };
  const boardPending = () => {
    for (const { payload, receipts, ...k } of pending) {
      kept[operator.board(returnsAt, payload)] = k;
      boardReceipts(returnsAt, receipts);
    }
    pending = [];
  };
  // Shares posted through the contract path, which the delivery check reads
  // by their submission time (SIMULATION_STUBS).
  const postings: DeliveryEntry[] = [];
  // Per voter, the newest block it named (Client rule 3's own records).
  const named = new Map<number, bigint>();
  // Per voter whose last ballot named a block reorganised away, what its
  // client keeps of it to cast again (Client rule 4): the committed vote and
  // the shares and receipts that cover its ballot hash.
  const toRecast = new Map<
    number,
    { readonly vote: CommittedVote; readonly shares: Kept["shares"]; readonly down: number[] }
  >();
  let server = 0;
  let reorged = 0;
  let challenged = 0;
  // The openings voters will ask to publish after close, each with the
  // tracking code their checker recorded before the choice.
  const publications: {
    readonly voter: PlannedVoter;
    readonly recorded: Uint8Array;
    readonly payload: Uint8Array;
  }[] = [];
  // Boards a ballot by its path, the client checking the operator's receipt
  // when it goes through our servers.
  const submit = (
    ballot: PlannedBallot,
    seconds: bigint,
    payload: Uint8Array,
    k: Kept,
    receipts: Uint8Array[],
  ) => {
    if (ballot.path === "direct") {
      pending.push({ payload, receipts, ...k });
      return;
    }
    // The servers are back: what was submitted directly is boarded first.
    boardPending();
    const segment = segmentAt(seconds);
    const receipt = operator.submit(segment, payload);
    kept[Number(receipt.index)] = k;
    boardReceipts(segment, receipts);
    // The client's checks at cast, before it tells the voter the ballot
    // was received ([[receipts]], Checks at cast; T-25, T-26).
    const check = checkReceiptAtCast(encodeReceipt(receipt), {
      electionId: election.definition.election_id,
      payload,
      boardEntryVersion: SIMULATED_BOARD_ENTRY_VERSION,
      receiptKeys: [operator.receiptKey],
      segments: { min: Math.max(firstSegment, segment - 1), max: Math.min(seal, segment + 1) },
    });
    if (!check.ok)
      throw new Error(`simulation: an honest operator's receipt failed its check (${check.code})`);
    server++;
  };
  // Each cast in two steps: the client's, up to the ballot's intake, then,
  // with each seat's intake back, the receipts' checks and the boarding.
  // The first step runs in cast order, and so does the second, which waits
  // for each ballot's intake in turn while later ones' run in the workers.
  interface Casting {
    readonly intake: Promise<readonly SeatIntake[]>;
    readonly finish: (results: readonly SeatIntake[]) => void;
  }
  const castOne = (
    intake: Intake,
    { voter, ballot, kind, seconds }: Cast,
    done: number,
  ): Casting => {
    const progress = () =>
      options.onProgress?.({ stage: "cast", done: done + 1, total: casts.length });
    const ctx: ValidityContext = {
      ...rules,
      definitionHash,
      tier: voter.tier,
      nullifier: BigInt(voter.index + 1),
    };
    // The client's record of the newest block it named; the L1 reference is
    // made after the cast choice (Client rule 6).
    const l1RefNumber = nameBlock(seconds, named.get(voter.index));
    named.set(voter.index, l1RefNumber);
    const recordOf = (vote: CommittedVote, l1RefHash: Uint8Array): BallotRecord => ({
      definition_hash: definitionHash,
      tier: voter.tier,
      nullifier: ctx.nullifier,
      l1_ref_number: l1RefNumber,
      l1_ref_hash: l1RefHash,
      membership_proof: placeholderProof,
      committed_vote: vote,
    });
    if (kind === "recast")
      return {
        intake: Promise.resolve([]),
        finish: () => {
          // Client rule 4: the client, finding the block it named reorganised
          // away once it is finalized, casts the same committed vote under a new
          // reference. Its ballot hash is the first cast's, so the trustees'
          // receipts and the voter's postings already cover it, and nothing is
          // sent to them again ([[share-encryption]], Intake and receipts).
          const first = toRecast.get(voter.index);
          if (first === undefined) throw new Error("simulation: a recast with no first cast");
          const payload = encodeBallot(recordOf(first.vote, l1.block(l1RefNumber).hash));
          const { shares, down } = first;
          const k = { shares, down, selects: true, reorged: false, delivered: voter.delivered };
          submit(ballot, seconds, payload, k, []);
          progress();
        },
      };
    const last = kind === "last";
    // A challenged attempt: the checker records the code shown before the
    // choice, then checks the opening the device hands over (T-42).
    let opening: SpoiledBallotOpening | undefined;
    if (last && voter.challenged) {
      const attempt = encryptShares({ definitionHash }, shareVote(rules, ballot.votes), keys);
      const recorded = trackingCode(ballots, voter.tier, attempt);
      const handed = encodeOpening(openChallenge(ballots, voter.tier, attempt).opening);
      const verdict = checkChallenge(ballots, recorded, voter, handed);
      if (!verdict.ok)
        throw new Error(`simulation: an honest challenge failed its check (${verdict.code})`);
      opening = verdict.opening;
      challenged++;
      if (voter.published) publications.push({ voter, recorded, payload: handed });
    }
    // The cast attempt is a fresh sharing: crypto refuses to prove an opened one.
    const sharing = shareVote(rules, ballot.votes);
    const encrypted = encryptShares({ definitionHash }, sharing, keys);
    const core = ballotCore(ballots, voter.tier, encrypted);
    // The code shown before the cast choice, which the checker records.
    const shown = trackingCode(ballots, voter.tier, encrypted);
    const vote = proveValidity(ctx, sharing, core.shareHashes);
    // Client rule 3: the core cast, as the ballot carries it, is the one whose code was shown.
    const cast = coreHash({
      definitionHash: ctx.definitionHash,
      tier: voter.tier,
      vss: vote.vss,
      shareHashes: vote.share_hashes,
    });
    if (!same32(cast, shown)) throw new Error("simulation: the cast core isn't the one shown");
    // Checker rule 4: no challenged attempt opens a commitment of the cast ballot.
    if (
      opening !== undefined &&
      opensBallotCommitment(openedCommitments(opening), { definitionHash, vss: vote.vss })
    )
      throw new Error("simulation: a challenged attempt opens the cast ballot");
    const down = downAt(scenario, ballot.at);
    // Every seat up at the cast takes the ballot's intake.
    const up: SeatCiphertext[] = seats
      .filter(({ index: seat }) => !down.includes(seat))
      .map(({ index: seat }) => ({
        seat,
        ciphertext: encrypted.ciphertexts[seat - 1] as Uint8Array,
      }));
    return {
      intake: intake.run(ctx, vote, up),
      finish: (results) => {
        const shares = new Map<number, readonly Share[]>();
        const receipts: Uint8Array[] = [];
        up.forEach(({ seat }, i) => {
          const result = results[i];
          // An honest client's ballot that intake refuses is a bug in the protocol code.
          if (result === undefined || !result.ok)
            throw new Error(`simulation: intake refused an honest ballot (${result?.code})`);
          // The voter's client checks each receipt at cast against the seat's
          // registered signing key ([[share-encryption]], Intake and receipts).
          if (!checkShareReceipt(registered, ctx, vote, seat, result.receipt))
            throw new Error("simulation: an honest seat's receipt failed its check");
          if (online.includes(seat)) shares.set(seat, result.shares);
          receipts.push(encodeShareReceipt(shareReceiptRecord(definitionHash, seat, result)));
        });
        // A last ballot the plan reorganises names the hash of a block that L1
        // then replaced, which the client saw 2 deep (Client rule 2).
        const lost = last && voter.reorg !== null;
        const payload = encodeBallot(
          recordOf(vote, lost ? l1.orphan(l1RefNumber) : l1.block(l1RefNumber).hash),
        );
        if (lost) {
          toRecast.set(voter.index, { vote, shares, down });
          reorged++;
        }
        // Client rule 4 (docs/spec/delivery.md): a down seat's intake fails by
        // every route, so a voter who chooses to posts that seat's ciphertext
        // and ML-KEM message through the contract path, which our outage doesn't
        // touch; any other voter's ballot stays undelivered (T-15, T-25).
        if (ballot.posts)
          for (const seat of down) {
            const at = seat - 1;
            postings.push({
              path: "contract",
              submittedAt: seconds,
              payload: encodeSharePosting({
                definition_hash: definitionHash,
                ballot_hash: ballotHash(ctx, vote),
                seat,
                m: (encrypted.randomness[at] as (typeof encrypted.randomness)[number]).m,
                ciphertext: decode(SHARE_CIPHERTEXT, encrypted.ciphertexts[at] as Uint8Array),
              }),
            });
          }
        const k: Kept = {
          shares,
          selects: last ? !lost : voter.selected === "earlier",
          reorged: lost,
          delivered: last ? voter.delivered : deliveredAt(scenario, ballot),
          down,
        };
        submit(ballot, seconds, payload, k, receipts);
        progress();
      },
    };
  };
  // Each seat's keys for intake, which the workers hold for the run.
  const intakeKeys: IntakeKeys[] = seats.map((s) => ({
    seat: s.index,
    kemSecret: s.kem.secretKey,
    signingSecret: s.signingSecret,
  }));
  const intake = workers > 0 ? intakeInWorkers(intakeKeys, workers) : intakeInThread(intakeKeys);
  try {
    const queue: Casting[] = [];
    const finishNext = async () => {
      const next = queue.shift() as Casting;
      next.finish(await next.intake);
    };
    for (const [done, c] of casts.entries()) {
      const casting = castOne(intake, c, done);
      // Awaited in order by finishNext; a failure there ends the run, and
      // ballots still waiting are dropped with it.
      casting.intake.catch(() => {});
      queue.push(casting);
      while (queue.length > intake.ahead) await finishNext();
    }
    while (queue.length > 0) await finishNext();
  } finally {
    await intake.close();
  }
  boardPending();

  // The counted extent, as the trustees read it at t_S, once the checkpoint
  // for s_S is due: the authority has anchored every period through s_S,
  // and the board checks pass over the anchors finalized by then (verifier
  // 4.1 and 4.2), so every entry is anchored, decodes under the pinned
  // version and names the election and its index; the first is the
  // ceremony transcript and every other a ballot or a share receipt, each
  // boarded by s_S.
  anchor.anchorThrough(operator.entries, after.counted);
  const checked = anchoredBoard(after.tallyFrom);
  if (
    checked.entries.some(
      (e, i) =>
        e.segment > after.counted ||
        (recordTypeOf(e.payload) === RECORD_TYPES.ceremonyTranscript) !== (i === 0) ||
        (i > 0 &&
          recordTypeOf(e.payload) !== RECORD_TYPES.ballot &&
          recordTypeOf(e.payload) !== RECORD_TYPES.shareReceipt),
    )
  )
    throw new Error(
      "simulation: the counted extent isn't the transcript, then ballots and share receipts",
    );

  // From each boarded ballot record: its L1 reference's admission (5.8) and
  // M as the verifier recomputes it from the ballot and the definition (5.7).
  // Ballots are keyed by board index, which receipts interleave. Every
  // ballot naming a block reorganised away is rejected `l1-ref-unknown` and
  // never selected, and every other is admitted (T-45).
  const admitted: AdmittedBallot[] = [];
  const boarded = new Map<number, BallotRecord>();
  checked.entries.forEach((entry, index) => {
    if (recordTypeOf(entry.payload) !== RECORD_TYPES.ballot) return;
    const b = decodeBallot(entry.payload, 1);
    boarded.set(index, b);
    const ref = { l1RefNumber: b.l1_ref_number, l1RefHash: b.l1_ref_hash };
    const verdict = checkL1Reference(ref, finalized, window);
    const want = (kept[index] as Kept).reorged ? "l1-ref-unknown" : "admitted";
    if (verdict !== want)
      throw new Error(`simulation: an honest ballot's L1 reference was ${verdict}, not ${want}`);
    if (verdict !== "admitted") return;
    const context = { definitionHash, tier: b.tier, nullifier: b.nullifier };
    admitted.push({
      tier: b.tier,
      nullifier: b.nullifier,
      message: membershipMessage({
        ...ref,
        definitionHash,
        tier: b.tier,
        ballotHash: ballotHash(context, b.committed_vote),
      }),
      l1RefNumber: b.l1_ref_number,
      index: BigInt(index),
    });
  });

  // Verifier 5.7 and 6.1: one counted ballot per tier and nullifier. Honest
  // voters re-vote on strictly newer blocks and nothing replays a ballot, so
  // anything but each voter's ballot the plan selects (its last or recast,
  // or its earlier one when the last was lost) is a bug.
  const selection = selectBallots(admitted);
  if (
    selection.repeats.length > 0 ||
    selection.ties.length > 0 ||
    selection.selected.length !== plan.voters.filter((v) => v.selected !== null).length ||
    selection.selected.some((b) => kept[Number(b.index)]?.selects !== true)
  )
    throw new Error("simulation: the re-vote rule didn't select each voter's planned ballot");

  // Verifier 5.9 (docs/spec/delivery.md, Delivery check): a selected ballot
  // stays in the counted set only if every qualified seat has a share
  // receipt or a passing contract-path posting in time. Every seat up at a
  // ballot's cast receipted it, so a ballot is delivered exactly when its
  // voter posted each seat down then; anything else is a bug, as is any
  // record the check reports (T-25, T-41).
  const ballotOf = (index: bigint): BallotRecord => {
    const b = boarded.get(Number(index));
    if (b === undefined) throw new Error("simulation: a selected entry isn't a boarded ballot");
    return b;
  };
  const { l1_inclusion_bound: bound } = election.definition;
  const delivery = checkDelivery(
    {
      definitionHash,
      panelSize: n,
      registered,
      segments: deliverySegments(
        { epoch: 0n, period: SIMULATED_ANCHOR_PERIOD },
        closesAt,
        BigInt(bound),
      ),
      deadlines: deliveryDeadlines(closesAt, BigInt(bound)),
    },
    selection.selected.map((s): DeliveryBallot => {
      const b = ballotOf(s.index);
      return { tier: b.tier, nullifier: b.nullifier, vote: b.committed_vote };
    }),
    // Every delivery record of the counted extent (share receipts, postings
    // and complaints, whichever the operator boarded), so crypto, not this
    // file, decides what each says.
    [
      ...checked.entries
        .filter((e) => DELIVERY_RECORD_TYPES.has(recordTypeOf(e.payload)))
        .map((e): DeliveryEntry => ({ path: "board", segment: e.segment, payload: e.payload })),
      ...postings,
    ],
    1,
  );
  if (
    delivery.records.length > 0 ||
    delivery.rejected.length > 0 ||
    delivery.ballots.some((d, i) => {
      const { delivered, down } = kept[Number(selection.selected[i]?.index)] as Kept;
      return (
        d.counted !== delivered ||
        d.excludedBy.length > 0 ||
        !same(
          d.missing,
          delivered ? [] : registered.map((r) => r.index).filter((s) => down.includes(s)),
        )
      );
    })
  )
    throw new Error("simulation: the delivery check didn't keep exactly the delivered ballots");
  const counted = selection.selected.filter((_, i) => delivery.ballots[i]?.counted === true);

  // Per tier: the counted ballots' VSS commitments, and each online seat's
  // sum of its shares of them.
  const zero = () => Array.from({ length: scenario.options }, () => ({ v: 0n, r: 0n }));
  const cells = new Map(
    plan.tiers.map((t) => [
      t,
      {
        vss: [] as CommittedVote["vss"][],
        sums: new Map<number, readonly Share[]>(online.map((i) => [i, zero()])),
      },
    ]),
  );
  type Cell = NonNullable<ReturnType<typeof cells.get>>;
  // A missing entry is a bug in this file, never a scenario's doing.
  const cellOf = (tier: SimulatedTier): Cell => {
    const cell = cells.get(tier);
    if (cell === undefined) throw new Error("simulation: a voter outside the electorate");
    return cell;
  };
  const sumOf = (cell: Cell, seat: number): readonly Share[] => {
    const sum = cell.sums.get(seat);
    if (sum === undefined) throw new Error("simulation: no running sum for an online seat");
    return sum;
  };
  for (const b of counted) {
    const { shares } = kept[Number(b.index)] as Kept;
    const { tier, committed_vote: vote } = ballotOf(b.index);
    const cell = cellOf(tier as SimulatedTier);
    for (const [seat, share] of shares)
      cell.sums.set(seat, sumShares(tallyRules, [sumOf(cell, seat), share]));
    cell.vss.push(vote.vss);
  }

  // Each cell, in partition order (the definition's electorate order), from
  // t_S: every online seat seals its summed shares to every other online
  // seat in a summed-share message (docs/spec/tally.md, Summed-share
  // message), under the KEM key the ceremony check registered for the
  // recipient and signed with its own key (T-37, T-39). A faulty seat's sums
  // fail its own check, so its node refuses to seal them and its lie never
  // leaves it. Each honest seat opens every message sent to it against its
  // own aggregate (T-29) and, with the k lowest passing seats among its own
  // and the senders', combines; the lowest of them signs the opening, which
  // the operator boards (Combination, Opening record).
  let messages = 0;
  const openingSegment = segmentAt(after.tallyFrom);
  const aggregates = plan.tiers.map((tier) => aggregateCell(tallyRules, cellOf(tier).vss));
  const summedElection = { definition: election.definition, aggregates, registered };
  const honest = online.filter((s) => !faulty.includes(s));
  const opens = plan.tiers.map((tier, c) => {
    const cell = cellOf(tier);
    const aggregate = aggregates[c] as (typeof aggregates)[number];
    const where = { definition: election.definition, cell: c, aggregate };
    const outbox: { readonly from: number; readonly to: number; readonly bytes: Uint8Array }[] = [];
    for (const seat of online) {
      const sum = sumOf(cell, seat);
      const sender = { index: seat, signingSecret: (seats[seat - 1] as SeatSecrets).signingSecret };
      for (const to of online) {
        if (to === seat) continue;
        if (!faulty.includes(seat)) {
          outbox.push({
            from: seat,
            to,
            bytes: sealSummedShares(where, registered, sender, to, sum),
          });
          continue;
        }
        // The sender's own summed-share check refuses the lie: crypto's check
        // fails it, and so the seal is refused.
        if (checkSummedShares(aggregate, seat, corrupt(sum)))
          throw new Error("simulation: a faulty seat's sums pass the summed-share check");
        let sealed = false;
        try {
          sealSummedShares(where, registered, sender, to, corrupt(sum));
          sealed = true;
        } catch (e) {
          if (!(e instanceof RangeError)) throw e;
        }
        if (sealed) throw new Error("simulation: a faulty seat's node sealed failing sums");
      }
    }
    // Each online seat opens every message sent to it, and an honest
    // sender's message failing any check, or naming another sender or cell,
    // is a bug. Each honest seat's view: its own sums, then the senders'.
    const received = new Map<number, Map<number, readonly Share[]>>();
    for (const m of outbox) {
      const secretKey = (seats[m.to - 1] as SeatSecrets).kem.secretKey;
      const got = openSummedShares(summedElection, { index: m.to, secretKey }, m.bytes);
      if (!got.ok || got.cell !== c || got.sender !== m.from)
        throw new Error("simulation: an honest seat's summed-share message didn't pass");
      const inbox = received.get(m.to) ?? new Map<number, readonly Share[]>();
      inbox.set(got.sender, got.summed);
      received.set(m.to, inbox);
    }
    const views = honest.map((seat) => {
      const held = new Map<number, readonly Share[]>([[seat, sumOf(cell, seat)]]);
      for (const [from, summed] of received.get(seat) ?? []) held.set(from, summed);
      const opened = openCell(tallyRules, cell.vss, held);
      if (opened.excluded.length > 0)
        throw new Error("simulation: sums that passed a summed-share message failed openCell");
      return { held, opened };
    });
    // Seats whose passing summed shares the honest seats don't hold: each
    // faulty one, if its node's check stopped its lie.
    const first = views[0];
    const holds = (s: number) => first?.held.has(s) === true;
    const excluded = online.filter((s) => !holds(s));
    // Every honest seat holds the same passing sums, so each combines the
    // same seats to the same opening, or none can.
    const result: CellOpening = first?.opened ?? { ok: false, code: "tally-quorum", excluded };
    for (const { held, opened: v } of views)
      if (
        !same(
          [...held.keys()].sort((a, b) => a - b),
          online.filter(holds),
        ) ||
        v.ok !== result.ok ||
        (v.ok &&
          result.ok &&
          (!same(v.combined, result.combined) ||
            v.counts.some((x, j) => x !== result.counts[j]) ||
            v.randomness.some((x, j) => x !== result.randomness[j])))
      )
        throw new Error("simulation: two honest seats combined a cell differently");
    const opened: CellOpening = { ...result, excluded };
    if (opened.ok) {
      const signer = opened.combined[0] as number;
      const record = signTallyOpening((seats[signer - 1] as SeatSecrets).signingSecret, {
        definition_hash: definitionHash,
        cell: c,
        aggregate_hash: aggregateHash(aggregate),
        signer,
        opening: opened.counts.map((v, j) => ({ v, r: opened.randomness[j] as bigint })),
      });
      operator.board(openingSegment, encodeTallyOpening(record));
    }
    messages += outbox.length;
    return { tier, cell, opened };
  });

  // Verifier 7.2 over every tally opening in the board's sealed extent, in
  // board order, each with its segment for the destruction rule. The board
  // is read through its entry checks (4.1) every time.
  const onBoard = (type: number) =>
    checkBoard(election.definition.election_id, operator.entries, SIMULATED_BOARD_ENTRY_VERSION)
      .entries.filter((e) => e.segment <= seal && recordTypeOf(e.payload) === type)
      .map((e) => ({ segment: e.segment, payload: e.payload }));
  const tallyEntries = onBoard(RECORD_TYPES.tallyOpening);
  const tally = checkTally(
    { definitionHash, rules: tallyRules, registered },
    opens.map((o) => o.cell.vss),
    tallyEntries.map((e) => e.payload),
    1,
  );
  if (tally.stray.length > 0 || tally.rejected.length > 0)
    throw new Error("simulation: a stray or rejected tally opening");

  const want = expectCells(scenario);
  const reports: CellReport[] = opens.map(({ tier, cell, opened }, c) => {
    const check = tally.cells[c];
    // Only an opened cell has an opening on the board; any other is tally-missing.
    if (!opened.ok && (check === undefined || check.ok || check.code !== "tally-missing"))
      throw new Error("simulation: an unopened cell's tally check found an opening");
    const verified =
      opened.ok &&
      check?.ok === true &&
      same(check.counts.map(Number), opened.counts.map(Number)) &&
      check.passing.length === 1 &&
      check.failing.length === 0 &&
      check.passing[0]?.signer === opened.combined[0];
    options.onProgress?.({ stage: "tally", done: c + 1, total: plan.tiers.length });
    const expected = plan.expected.get(tier) as readonly number[];
    return judgeCell({ tier, ballots: cell.vss.length, expected }, want, opened, verified);
  });

  // The openings voters asked to publish (docs/spec/challenge.md, Client
  // rule 4 and Publication): each asks once, after s_S has ended, and the
  // operator, holding the counted extent, applies the boarding rules to
  // each, then appends them sorted when the period ends, after the cells'
  // tally openings of that period. An honest voter's opening refused, or
  // admitted as another core or vote than its checker recorded, is a bug.
  const publishedIn = after.counted + 1;
  const desk = {
    election: ballots,
    counted: [...boarded.values()].map((b) => ({ definitionHash, vss: b.committed_vote.vss })),
    countedUntil: after.counted,
    openingsUntil: after.openingsUntil,
  };
  // Every ballot cast is boarded by s_S, superseded ones included, and each
  // is one an opening may not open (opening-cast).
  if (desk.counted.length !== casts.length)
    throw new Error("simulation: the operator's counted extent isn't every ballot cast");
  const held = new Set<string>();
  for (const { voter, recorded, payload } of publications) {
    const admitted = admitOpening(desk, held, publishedIn, payload);
    if (!admitted.ok)
      throw new Error(`simulation: the operator refused an honest opening (${admitted.code})`);
    if (!same32(admitted.coreHash, recorded) || !same(admitted.votes.map(Number), voter.votes))
      throw new Error("simulation: an opening admitted as another core or vote than recorded");
  }
  operator.boardOpenings(
    publishedIn,
    publications.map((p) => p.payload),
  );

  // Destruction (docs/spec/tally.md, When): with every cell's first passing
  // opening seen anchored, a node destroys once that checkpoint is due;
  // otherwise at t_D. Each online seat then signs its statement, the signing
  // key's last use, and the operator boards it (T-14, T-40, T-69).
  anchor.anchorThrough(operator.entries, publishedIn);
  const firstPassing = tally.cells.map((cell) => {
    const first = cell.passing[0];
    return first === undefined ? null : (tallyEntries[first.at] as { segment: number }).segment;
  });
  // A node sees every first passing opening anchored from the board checks
  // once that checkpoint is due: they authenticate the whole board through
  // the openings' period, or throw.
  if (firstPassing.every((s) => s !== null))
    anchoredBoard(endOf(Math.max(...firstPassing)) + SIMULATED_ANCHOR_DEADLINE);
  // The earlier of the two moments (docs/spec/tally.md, When).
  const destroyedIn = Math.min(
    firstPassing.every((s) => s !== null)
      ? afterAnchored(Math.max(...firstPassing))
      : Number.POSITIVE_INFINITY,
    segmentAt(after.destroyBy),
  );
  for (const seat of online)
    operator.board(
      destroyedIn,
      encodeDestructionStatement(
        signDestructionStatement((seats[seat - 1] as SeatSecrets).signingSecret, {
          definition_hash: definitionHash,
          signer: seat,
        }),
      ),
    );
  // Verifier 8.5: every online seat destroyed in the destruction segment,
  // every offline or departed one missing, and nothing else on the board.
  const destruction = checkDestruction(
    { definitionHash, registered },
    onBoard(RECORD_TYPES.destructionStatement),
    { firstPassing, windowSegment: after.windowSegment },
    1,
  );
  if (
    destruction.duplicates.length + destruction.unattributed.length > 0 ||
    destruction.stray.length + destruction.rejected.length > 0 ||
    destruction.seats.some(
      (d) => d.code !== (online.includes(d.seat) ? "destroyed" : "destruction-missing"),
    )
  )
    throw new Error("simulation: the destruction report isn't every online seat's statement");

  // Verifier 4.1 and 4.2 over the whole board at the first L1 block after
  // the seal's window has closed, so a segment with entries but no timely
  // checkpoint fails `unanchored` and a missing seal `unsealed`: the seal's
  // checkpoint fixes the board's extent, and its chain ends at the
  // operator's head (T-23, T-24, T-54).
  anchor.anchorThrough(operator.entries, seal);
  const sealed = anchoredBoard(endOf(seal) + SIMULATED_ANCHOR_DEADLINE + 1n);
  if (!same32(sealed.links.at(-1) ?? new Uint8Array(32), operator.head))
    throw new Error("simulation: the anchored board's chain doesn't end at the operator's head");

  // The sealed board carries exactly the published openings, by the codes
  // their checkers recorded, and its entry checks held them in order.
  const spoiled = onBoard(RECORD_TYPES.spoiledBallotOpening).map((e) =>
    hex(openingCoreHash(decodeOpening(e.payload, 1))),
  );
  if (
    spoiled.length !== publications.length ||
    [...spoiled].sort().join() !==
      publications
        .map((p) => hex(p.recorded))
        .sort()
        .join()
  )
    throw new Error("simulation: the board's openings aren't the published ones");

  // The verifier over the output: the closed election as a format-4
  // bundle, read by packages/verifier from its own two files at the same
  // block as the read above, the anchors and `now` proven from the board
  // anchor's simulated L1 state. Its report must agree with the run but for
  // the stubs (./verify.ts): the caller gets the bundle first, so a
  // disagreement can be inspected (T-23, T-24, T-37, T-54).
  const verifierBlock = l1.firstAfter(endOf(seal) + SIMULATED_ANCHOR_DEADLINE);
  const bundle = verifierBundle({
    definition: election.definition,
    panel: election.panel,
    clock: anchor.clock,
    entries: operator.entries,
    anchors: anchor.anchors,
    firstSegment,
    block: { number: verifierBlock, timestamp: l1.block(verifierBlock).timestamp },
  });
  options.onBundle?.(bundle);
  const verifier = verifyBundle(parseBundle(bundle.json, bundle.board));
  const disagreements = judgeVerifierReport(verifier, {
    entries: operator.entries.length,
    ballots: onBoard(RECORD_TYPES.ballot).length,
    openings: spoiled.length,
    tallies: tallyEntries.length,
    registered: registered.length,
    anchors: anchor.anchors.map((a) => ({
      segment: a.checkpoint.segment,
      hash: hex(checkpointHash(a.checkpoint)),
    })),
  });
  if (disagreements.length > 0)
    throw new Error(`simulation: the verifier disagrees: ${disagreements.join("; ")}`);

  const allOpened = reports.every((c) => c.counts !== undefined);
  return {
    ok: reports.every((c) => c.matches),
    scenario,
    definition: { hash: hex(definitionHash) },
    ceremony: {
      transcriptHash: hex(election.transcriptHash),
      registered: registered.map((r) => r.index),
    },
    ballots: {
      cast: casts.length,
      server,
      direct: casts.length - server,
      superseded: casts.length - reorged - selection.selected.length,
      reorged,
      recast: casts.filter((c) => c.kind === "recast").length,
      challenged,
      published: publications.length,
      postings: postings.length,
      undelivered: selection.selected.length - counted.length,
    },
    board: {
      entries: sealed.entries.length,
      counted: checked.entries.length,
      shareReceipts,
      openings: tallyEntries.length,
      spoiled: spoiled.length,
      head: hex(operator.head),
      receiptKey: hex(operator.receiptKey),
      seal,
      anchors: anchor.anchors.map((a) => ({
        segment: a.checkpoint.segment,
        size: Number(a.checkpoint.size),
        hash: hex(checkpointHash(a.checkpoint)),
        anchoredAt: Number(a.anchoredAt),
      })),
    },
    verifier: {
      verdict: verifier.verdict,
      verdictAgainstInputs: verifier.verdictAgainstInputs,
      block: { number: Number(verifierBlock), headerHash: verifier.l1?.blockHash ?? "" },
      passed: verifier.checks.filter((c) => c.status === "pass").map((c) => c.id),
      failed: verifier.checks
        .filter((c) => c.status === "fail")
        .map((c) => ({ id: c.id, code: c.code ?? "" })),
      rejectedBallots: verifier.ballots?.rejected.length ?? 0,
    },
    trustees: { online, offline, departed, faulty, summedShareMessages: messages },
    cells: reports,
    destruction: { from: destruction.from, seats: destruction.seats },
    ...(allOpened
      ? {
          total: deriveTotal(reports.map((c) => (c.counts as readonly number[]).map(BigInt))).map(
            Number,
          ),
        }
      : {}),
    stubs: SIMULATION_STUBS,
  };
}
