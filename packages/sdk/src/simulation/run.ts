// Runs a simulated election in memory through @abolishus/crypto's own code:
// a well-formed definition and its signed key ceremony (./election.ts), each
// voter's sharing and share encryption, the tracking code shown before the
// cast-or-challenge choice, a challenged attempt's opening and its checker's
// verdict (./challenge.ts), the cast attempt's validity proof, each online
// trustee's intake (proof checks, decryption,
// share checks, receipt) and the receipt's check under the seat's registered
// signing key, each ballot's L1 reference on a simulated L1 (./l1.ts), the
// ballot record on the board (./board.ts) with the operator's receipt and
// the client's check of it at cast, each online seat's share receipt on the
// board and a posting voter's postings of its offline seats, the verifier's
// board check, and from the boarded records: each ballot's admission check,
// the re-vote rule's selection of each voter's counted ballot, the delivery
// check that keeps only delivered ones, the summed shares of those, sent
// between seats in summed-share messages, each honest seat's combination of
// each cell from the k lowest passing seats, the cell's signed opening on
// the board and the verifier's tally check over the board's openings, the
// challenged attempts' openings their voters ask to publish, which the
// operator boards after the counted extent (./publication.ts), then
// each online seat's destruction statement and the verifier's destruction
// report, and the board check over the whole board. Nothing
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
  intake,
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
  type TallyRules,
  trackingCode,
  type ValidityContext,
} from "@abolishus/crypto";
import {
  afterAnchored,
  postClose,
  SIMULATED_ANCHOR_PERIOD,
  SimulatedBoard,
  segmentAt,
} from "./board.ts";
import { checkChallenge } from "./challenge.ts";
import { admitOpening } from "./publication.ts";
import { SIMULATED_BOARD_ENTRY_VERSION, simulateElection } from "./election.ts";
import { SimulatedL1 } from "./l1.ts";
import {
  type Plan,
  type PlannedBallot,
  type PlannedVoter,
  planElection,
  selectionRange,
} from "./plan.ts";
import type { Scenario, SimulatedTier } from "./scenario.ts";

/**
 * What this run models only in outline, until the items that build each
 * piece land (docs/status/P1-21.md). Every report carries the list, so no
 * result is mistaken for a run of the whole protocol.
 */
export const SIMULATION_STUBS = Object.freeze([
  "definition: a well-formed version-1 definition, but its contracts, chain IDs, election counter, clock and tier roots are placeholders and nothing registers it on L2 (P1-18, P3-2)",
  "ceremony: every seat takes part in the four signed rounds; no release pins the panel, whose identity keys are fresh per run (P1-7)",
  "membership: no membership proofs; each voter's nullifier is its index plus one, and each ballot record carries a placeholder proof, the verification key's own alpha, beta and alpha points, which decodes but proves nothing and is never checked, so admission (5.1 to 5.4) isn't run and each ballot's M for the re-vote rule is computed from its record here rather than taken from crypto's checkBallot (P1-17b, P3-2)",
  "board: the operator boards each server ballot as it arrives and signs a receipt the voter's client checks at cast, under one receipt key fresh per run that no definition lists or registry holds; the anchoring clock (hourly from the Unix epoch, with a half-hour deadline) is a placeholder, the post-close windows other than the tally, openings' and destruction windows are taken as zero for the counted extent, though the delivery check applies the real delivery deadline (every delivery record is boarded or sent long before it), so the counted extent ends one period after close and the seal is the destruction window's end, and nothing is anchored, so trustees act on segments the run computes rather than on checkpoints they saw on L1 (P1-13b, P4-1, P1-18)",
  "delivery: ciphertexts reach trustees in memory, with no contract path; a direct ballot is boarded by the operator when the servers return, with no receipt, never as a contract event; each online seat's node boards its share receipt right after the ballot, and the operator boards it unchecked rather than under the delivery boarding rules; a posting voter's client posts each offline seat once, right after cast, as a contract-path record the delivery check reads with its cast time as its submission time, though no contract records it and nothing puts it on the board or the archive; offline seats never come back, so no seat catches up on postings or complains, and nothing is resent (P1-12c, P1-18, P4-2)",
  "trustees: offline seats go down after the ceremony, for the whole voting period, tally and destruction; faulty seats lie only in their summed shares, which their own node's check refuses to seal, so no lie reaches another seat as a summed-share message, no recipient's refusal is shown, and a cell's excluded seats are those that sent nothing (openCell never sees a failing sum); summed-share messages travel in memory, never over a channel, every honest seat combines, and the lowest seat combined signs each cell's opening",
  "challenges: the checker records each tracking code and checks the opening in memory, with the election the run built rather than one fetched from chain and IPFS; a voter who publishes asks once, in the first period after the counted extent, and the operator's boarding rules are applied here rather than by the verifier's 6.2, which isn't run (P1-21 part 2)",
  "re-voting: L1 is simulated, a block every 12 seconds with random hashes, all finalized; every reference is admitted and every voter's last ballot selected, so no ballot is replayed, ties, or names a block before opening, after close or reorganised away (P1-21 part 2)",
  "destruction: every online seat signs its statement at the moment the tally rule sets, and the operator boards each one; nothing destroys the run's key material, which lives until the report is returned",
  "not yet simulated: anchoring and wipe-and-rebuild (P1-21 part 2)",
] as const);

export type CellOutcome = "opened" | "tally-quorum" | "tally-opening" | "tally-range";

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
    /** Every ballot cast, re-votes' earlier ballots included. */
    readonly cast: number;
    readonly server: number;
    readonly direct: number;
    /** Earlier ballots the re-vote rule didn't select: cast, but not counted. */
    readonly superseded: number;
    /** Attempts challenged before a fresh one was cast, each opening checked by the voter's checker. */
    readonly challenged: number;
    /** Challenged attempts whose openings their voters asked to publish, each boarded after the counted extent. */
    readonly published: number;
    /** Shares posted through the contract path: one per offline seat for each ballot of a posting voter. */
    readonly postings: number;
    /**
     * Ballots the re-vote rule selected that the delivery check kept out of
     * the counted set: a voter's last ballot that has an offline seat it
     * didn't post.
     */
    readonly undelivered: number;
  };
  /** The board the operator wrote, which passed the verifier's entry checks (4.1); nothing anchors it. */
  readonly board: {
    readonly entries: number;
    /** Entries in the counted extent, every one a ballot or a share receipt. */
    readonly counted: number;
    /** Share receipts, one from each online seat per ballot cast. */
    readonly shareReceipts: number;
    /** Tally openings, one per opened cell. */
    readonly openings: number;
    /** Spoiled-ballot openings, one per published challenge. */
    readonly spoiled: number;
    /** The chain head after its last entry, in hex. */
    readonly head: string;
    /** The key that signed every receipt, which the voters' clients pinned, in hex. */
    readonly receiptKey: string;
  };
  readonly trustees: {
    /** Every seat not offline, faulty ones included. */
    readonly online: readonly number[];
    readonly offline: readonly number[];
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
   * `destroyed` and every offline one `destruction-missing`.
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

export function expectCells(scenario: Scenario): CellExpectation {
  const { panel, threshold, offline, faulty } = scenario.trustees;
  const honest = Array.from({ length: panel }, (_, i) => i + 1).filter(
    (s) => !offline.includes(s) && !faulty.includes(s),
  );
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

/** Runs `scenario` and reports each cell's result against the plan. Throws only on a bug. */
export function runSimulation(
  scenario: Scenario,
  options: SimulationOptions = {},
): SimulationReport {
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
  const online = seats.map((s) => s.index).filter((i) => !offline.includes(i));

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
  const secondsAt = (at: number) => opensAt + BigInt(Math.floor(at * Number(closesAt - opensAt)));

  // Every ballot cast, in time order: a re-voting voter's earlier ballot,
  // then each voter's last, which the plan counts.
  const casts = plan.voters
    .flatMap((voter) => [
      ...(voter.earlier === null ? [] : [{ voter, ballot: voter.earlier, last: false }]),
      { voter, ballot: voter as PlannedBallot, last: true },
    ])
    .sort(
      (a, b) =>
        a.ballot.at - b.ballot.at ||
        a.voter.index - b.voter.index ||
        Number(a.last) - Number(b.last),
    );
  // The board and its operator. The client accepts a receipt's segment
  // within one period of its cast's, from the election's first segment to
  // its seal (board client rule 1).
  const operator = new SimulatedBoard(
    election.definition.election_id,
    SIMULATED_BOARD_ENTRY_VERSION,
  );
  const firstSegment = segmentAt(opensAt);
  const after = postClose(closesAt);
  const { seal } = after;
  // A ballot record's placeholder membership proof (SIMULATION_STUBS): the
  // verification key's alpha (G1) and beta (G2) points, which decode.
  const vk = membershipVkEncoding();
  const placeholderProof = decodeMembershipProof(
    Uint8Array.from([...vk.subarray(0, 192), ...vk.subarray(0, 64)]),
  );
  // Per board position, each online seat's shares of the ballot there, which
  // the trustees keep until the re-vote rule has selected, and whether it is
  // its voter's last.
  interface Kept {
    readonly shares: ReadonlyMap<number, readonly Share[]>;
    readonly last: boolean;
    /** Whether the plan expects the voter's ballots delivered to every qualified seat. */
    readonly delivered: boolean;
  }
  const kept: Kept[] = [];
  // Ballots submitted directly while our servers are down, which the
  // operator boards when they return (SIMULATION_STUBS), each with its
  // online seats' share receipts.
  let pending: (Kept & { readonly payload: Uint8Array; readonly receipts: Uint8Array[] })[] = [];
  const returnsAt = segmentAt(secondsAt(scenario.outage?.to ?? 1));
  // Each online seat's node boards its share receipt once the ballot is on
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
  let server = 0;
  let challenged = 0;
  // The openings voters will ask to publish after close, each with the
  // tracking code their checker recorded before the choice.
  const publications: {
    readonly voter: PlannedVoter;
    readonly recorded: Uint8Array;
    readonly payload: Uint8Array;
  }[] = [];
  casts.forEach(({ voter, ballot, last }, done) => {
    const ctx: ValidityContext = {
      ...rules,
      definitionHash,
      tier: voter.tier,
      nullifier: BigInt(voter.index + 1),
    };
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
    const shares = new Map<number, readonly Share[]>();
    const receipts: Uint8Array[] = [];
    for (const seat of online) {
      const s = seats[seat - 1] as SeatSecrets;
      const result = intake(
        ctx,
        { seat, kemSecret: s.kem.secretKey, signingSecret: s.signingSecret },
        vote,
        encrypted.ciphertexts[seat - 1] as Uint8Array,
      );
      // An honest client's ballot that intake refuses is a bug in the protocol code.
      if (!result.ok)
        throw new Error(`simulation: intake refused an honest ballot (${result.code})`);
      // The voter's client checks each receipt at cast against the seat's
      // registered signing key ([[share-encryption]], Intake and receipts).
      if (!checkShareReceipt(registered, ctx, vote, seat, result.receipt))
        throw new Error("simulation: an honest seat's receipt failed its check");
      shares.set(seat, result.shares);
      receipts.push(encodeShareReceipt(shareReceiptRecord(definitionHash, seat, result)));
    }
    // The L1 reference, made after the cast choice (Client rule 6): the
    // newest settled block (Client rule 2), strictly newer than every block
    // the voter named before (Client rule 3). With none yet, the client
    // waits until the next block is settled and names that; the close rule
    // that would refuse a wait past close isn't simulated (P1-18).
    const before = named.get(voter.index);
    const seconds = secondsAt(ballot.at);
    const settled = l1.settledAt(seconds);
    const l1RefNumber = before !== undefined && settled <= before ? before + 1n : settled;
    named.set(voter.index, l1RefNumber);
    const record: BallotRecord = {
      definition_hash: definitionHash,
      tier: voter.tier,
      nullifier: ctx.nullifier,
      l1_ref_number: l1RefNumber,
      l1_ref_hash: l1.block(l1RefNumber).hash,
      membership_proof: placeholderProof,
      committed_vote: vote,
    };
    const payload = encodeBallot(record);
    // Client rule 4 (docs/spec/delivery.md): an offline seat's intake fails
    // by every route, so a voter who chooses to posts that seat's ciphertext
    // and ML-KEM message through the contract path, which our outage doesn't
    // touch; any other voter's ballot stays undelivered (T-15, T-25).
    if (voter.posts)
      for (const seat of offline) {
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
    const { delivered } = voter;
    if (ballot.path === "direct") pending.push({ payload, receipts, shares, last, delivered });
    else {
      // The servers are back: what was submitted directly is boarded first.
      boardPending();
      const segment = segmentAt(seconds);
      const receipt = operator.submit(segment, payload);
      kept[Number(receipt.index)] = { shares, last, delivered };
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
        throw new Error(
          `simulation: an honest operator's receipt failed its check (${check.code})`,
        );
      server++;
    }
    options.onProgress?.({ stage: "cast", done: done + 1, total: casts.length });
  });
  boardPending();

  // The counted extent, as the trustees read it once its checkpoint is due:
  // every entry decodes under the pinned version and names the election and
  // its index (verifier 4.1), and each is a ballot or a share receipt
  // boarded by s_S.
  const checked = checkBoard(
    election.definition.election_id,
    operator.entries,
    SIMULATED_BOARD_ENTRY_VERSION,
  );
  if (
    checked.entries.some(
      (e) =>
        e.segment > after.counted ||
        (recordTypeOf(e.payload) !== RECORD_TYPES.ballot &&
          recordTypeOf(e.payload) !== RECORD_TYPES.shareReceipt),
    )
  )
    throw new Error("simulation: an entry outside the counted extent's ballots and receipts");

  // From each boarded ballot record: its L1 reference's admission (5.8) and
  // M as the verifier recomputes it from the ballot and the definition (5.7).
  // Ballots are keyed by board index, which receipts interleave.
  const admitted: AdmittedBallot[] = [];
  const boarded = new Map<number, BallotRecord>();
  checked.entries.forEach((entry, index) => {
    if (recordTypeOf(entry.payload) !== RECORD_TYPES.ballot) return;
    const b = decodeBallot(entry.payload, 1);
    const ref = { l1RefNumber: b.l1_ref_number, l1RefHash: b.l1_ref_hash };
    const verdict = checkL1Reference(ref, finalized, window);
    if (verdict !== "admitted")
      throw new Error(`simulation: an honest ballot's L1 reference wasn't admitted (${verdict})`);
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
    boarded.set(index, b);
  });

  // Verifier 5.7 and 6.1: one counted ballot per tier and nullifier. Honest
  // voters re-vote on strictly newer blocks and nothing replays a ballot, so
  // anything but each voter's last ballot selected is a bug.
  const selection = selectBallots(admitted);
  if (
    selection.repeats.length > 0 ||
    selection.ties.length > 0 ||
    selection.selected.length !== plan.voters.length ||
    selection.selected.some((b) => kept[Number(b.index)]?.last !== true)
  )
    throw new Error("simulation: the re-vote rule didn't select each voter's last ballot");

  // Verifier 5.9 (docs/spec/delivery.md, Delivery check): a selected ballot
  // stays in the counted set only if every qualified seat has a share
  // receipt or a passing contract-path posting in time. Every online seat
  // receipted every ballot, so a ballot is delivered exactly when its voter
  // posted each offline seat; anything else is a bug, as is any record the
  // check reports (T-25, T-41).
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
    [
      ...checked.entries
        .filter((e) => recordTypeOf(e.payload) === RECORD_TYPES.shareReceipt)
        .map((e): DeliveryEntry => ({ path: "board", segment: e.segment, payload: e.payload })),
      ...postings,
    ],
    1,
  );
  const unposted = registered.map((r) => r.index).filter((s) => offline.includes(s));
  if (
    delivery.records.length > 0 ||
    delivery.rejected.length > 0 ||
    delivery.ballots.some((d, i) => {
      const { delivered } = kept[Number(selection.selected[i]?.index)] as Kept;
      return (
        d.counted !== delivered ||
        d.excludedBy.length > 0 ||
        !same(d.missing, delivered ? [] : unposted)
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
  const firstPassing = tally.cells.map((cell) => {
    const first = cell.passing[0];
    return first === undefined ? null : (tallyEntries[first.at] as { segment: number }).segment;
  });
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
  // every offline one missing, and nothing else on the board.
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

  // Verifier 4.1 over the whole board, through the seal: the chain ends at
  // the operator's head (T-23).
  const sealed = checkBoard(
    election.definition.election_id,
    operator.entries,
    SIMULATED_BOARD_ENTRY_VERSION,
  );
  if (!same32(sealed.links.at(-1) ?? new Uint8Array(32), operator.head))
    throw new Error("simulation: the board's chain doesn't end at the operator's head");
  if (sealed.entries.some((e) => e.segment > seal))
    throw new Error("simulation: an entry after the seal");
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
      superseded: casts.length - selection.selected.length,
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
    },
    trustees: { online, offline, faulty, summedShareMessages: messages },
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
