// Runs a simulated election in memory through @abolishus/crypto's own code:
// a well-formed definition and its signed key ceremony (./election.ts), each
// voter's sharing and share encryption, the tracking code shown before the
// cast-or-challenge choice, a challenged attempt's opening and its checker's
// verdict (./challenge.ts), the cast attempt's validity proof, each online
// trustee's intake (proof checks, decryption,
// share checks, receipt) and the receipt's check under the seat's registered
// signing key, each ballot's L1 reference on a simulated L1 (./l1.ts), the
// ballot record on the board (./board.ts) with the operator's receipt and
// the client's check of it at cast, the verifier's board check, and from the
// boarded records: each ballot's admission check, the re-vote rule's
// selection of each voter's counted ballot, the summed shares of those, each
// cell's combination from the k lowest passing seats, its signed opening on
// the board and the verifier's tally check over the board's openings, then
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
  checkDestruction,
  checkL1Reference,
  checkReceiptAtCast,
  checkShareReceipt,
  checkTally,
  type CommittedVote,
  coreHash,
  decodeBallot,
  decodeBoardEntry,
  decodeMembershipProof,
  deriveTotal,
  encodeBallot,
  encodeDestructionStatement,
  encodeOpening,
  encodeReceipt,
  encodeTallyOpening,
  encryptShares,
  GROUP_ORDER,
  intake,
  l1RefMin,
  membershipMessage,
  membershipVkEncoding,
  openCell,
  openChallenge,
  openedCommitments,
  opensBallotCommitment,
  proveValidity,
  RECORD_TYPES,
  type SeatDestruction,
  type SeatSecrets,
  selectBallots,
  type Share,
  shareVote,
  signDestructionStatement,
  signTallyOpening,
  type SpoiledBallotOpening,
  sumShares,
  type TallyRules,
  trackingCode,
  type ValidityContext,
} from "@abolishus/crypto";
import { afterAnchored, postClose, SimulatedBoard, segmentAt } from "./board.ts";
import { checkChallenge } from "./challenge.ts";
import { SIMULATED_BOARD_ENTRY_VERSION, simulateElection } from "./election.ts";
import { SimulatedL1 } from "./l1.ts";
import { type Plan, type PlannedBallot, planElection, selectionRange } from "./plan.ts";
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
  "board: the operator boards each server ballot as it arrives and signs a receipt the voter's client checks at cast, under one receipt key fresh per run that no definition lists or registry holds; the anchoring clock (hourly from the Unix epoch, with a half-hour deadline) is a placeholder, the post-close windows other than the tally and destruction windows are taken as zero, so the counted extent ends one period after close and the seal is the destruction window's end, and nothing is anchored, so trustees act on segments the run computes rather than on checkpoints they saw on L1 (P1-13b, P4-1, P1-18)",
  "delivery: ciphertexts reach trustees in memory, with no contract path; a direct ballot is boarded by the operator when the servers return, with no receipt, never as a contract event (P1-12c, P4-2)",
  "trustees: offline seats go down after the ceremony, for the whole voting period, tally and destruction; faulty seats lie only in their summed shares; summed shares reach the combiner in memory, never as summed-share messages, and the lowest seat combined signs each cell's opening",
  "challenges: the checker records each tracking code and checks the opening in memory, with the election the run built rather than one fetched from chain and IPFS; no opening is published to the board after close (P1-21 part 2)",
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
  };
  /** The board the operator wrote, which passed the verifier's entry checks (4.1); nothing anchors it. */
  readonly board: {
    readonly entries: number;
    /** Entries in the counted extent, every one a ballot. */
    readonly counted: number;
    /** Tally openings, one per opened cell. */
    readonly openings: number;
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
// summed-share check must catch (verifier 7.2).
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
  }
  const kept: Kept[] = [];
  // Ballots submitted directly while our servers are down, which the
  // operator boards when they return (SIMULATION_STUBS).
  let pending: (Kept & { readonly payload: Uint8Array })[] = [];
  const returnsAt = segmentAt(secondsAt(scenario.outage?.to ?? 1));
  const boardPending = () => {
    for (const { payload, ...k } of pending) kept[operator.board(returnsAt, payload)] = k;
    pending = [];
  };
  // Per voter, the newest block it named (Client rule 3's own records).
  const named = new Map<number, bigint>();
  let server = 0;
  let challenged = 0;
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
      const verdict = checkChallenge(
        ballots,
        recorded,
        voter,
        encodeOpening(openChallenge(ballots, voter.tier, attempt).opening),
      );
      if (!verdict.ok)
        throw new Error(`simulation: an honest challenge failed its check (${verdict.code})`);
      opening = verdict.opening;
      challenged++;
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
    if (ballot.path === "direct") pending.push({ payload, shares, last });
    else {
      // The servers are back: what was submitted directly is boarded first.
      boardPending();
      const segment = segmentAt(seconds);
      const receipt = operator.submit(segment, payload);
      kept[Number(receipt.index)] = { shares, last };
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
  // its index (verifier 4.1), and each is a ballot boarded by s_S.
  const checked = checkBoard(
    election.definition.election_id,
    operator.entries,
    SIMULATED_BOARD_ENTRY_VERSION,
  );
  if (
    checked.entries.some(
      (e) => e.segment > after.counted || recordTypeOf(e.payload) !== RECORD_TYPES.ballot,
    )
  )
    throw new Error("simulation: an entry outside the counted extent's ballots");

  // From each boarded ballot record: its L1 reference's admission (5.8) and
  // M as the verifier recomputes it from the ballot and the definition (5.7).
  const admitted: AdmittedBallot[] = [];
  const boarded: { readonly tier: SimulatedTier; readonly vss: CommittedVote["vss"] }[] = [];
  checked.entries.forEach((entry, index) => {
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
    boarded.push({ tier: b.tier, vss: b.committed_vote.vss });
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
  for (const b of selection.selected) {
    const { shares } = kept[Number(b.index)] as Kept;
    const { tier, vss } = boarded[Number(b.index)] as (typeof boarded)[number];
    const cell = cellOf(tier);
    for (const [seat, share] of shares)
      cell.sums.set(seat, sumShares(tallyRules, [sumOf(cell, seat), share]));
    cell.vss.push(vss);
  }

  // Each cell, in partition order (the definition's electorate order), from
  // t_S: the k lowest passing seats combine, and the lowest of them signs the
  // opening, which the operator boards (docs/spec/tally.md, Combination and
  // Opening record).
  const openingSegment = segmentAt(after.tallyFrom);
  const opens = plan.tiers.map((tier, c) => {
    const cell = cellOf(tier);
    const summed = new Map<number, readonly Share[]>();
    for (const seat of online) {
      const sum = sumOf(cell, seat);
      summed.set(seat, faulty.includes(seat) ? corrupt(sum) : sum);
    }
    const opened = openCell(tallyRules, cell.vss, summed);
    if (opened.ok) {
      const signer = opened.combined[0] as number;
      const record = signTallyOpening((seats[signer - 1] as SeatSecrets).signingSecret, {
        definition_hash: definitionHash,
        cell: c,
        aggregate_hash: aggregateHash(aggregateCell(tallyRules, cell.vss)),
        signer,
        opening: opened.counts.map((v, j) => ({ v, r: opened.randomness[j] as bigint })),
      });
      operator.board(openingSegment, encodeTallyOpening(record));
    }
    return { tier, cell, opened };
  });

  // Verifier 7.2 over every tally opening on the board, in board order, each
  // with its segment for the destruction rule.
  const onBoard = (type: number) =>
    operator.entries.flatMap((bytes) => {
      const e = decodeBoardEntry(bytes, SIMULATED_BOARD_ENTRY_VERSION);
      return recordTypeOf(e.payload) === type ? [{ segment: e.segment, payload: e.payload }] : [];
    });
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

  // Destruction (docs/spec/tally.md, When): with every cell's first passing
  // opening seen anchored, a node destroys once that checkpoint is due;
  // otherwise at t_D. Each online seat then signs its statement, the signing
  // key's last use, and the operator boards it (T-14, T-40, T-69).
  const firstPassing = tally.cells.map((cell) => {
    const first = cell.passing[0];
    return first === undefined ? null : (tallyEntries[first.at] as { segment: number }).segment;
  });
  const destroyedIn = firstPassing.every((s) => s !== null)
    ? afterAnchored(Math.max(...firstPassing))
    : segmentAt(after.destroyBy);
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
    destruction.from !== destroyedIn ||
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
    },
    board: {
      entries: sealed.entries.length,
      counted: checked.entries.length,
      openings: tallyEntries.length,
      head: hex(operator.head),
      receiptKey: hex(operator.receiptKey),
    },
    trustees: { online, offline, faulty },
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
