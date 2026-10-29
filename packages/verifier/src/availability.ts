// The availability check (4.6, docs/spec/availability.md, Availability check;
// docs/spec/verifier.md, Availability): whether each panel's threshold of
// seats attested, through the L2 contract path, that it held the board an
// election's result rests on, before any result existed. It reads only L1
// (the counted checkpoints) and the board contract's events (the bundle's,
// or the archive's contract-event runs once no L2 node serves them),
// replayed against its event accumulator proven under an L2 output root
// (the bundle's, or an archived record's), never the board copy, so a
// withheld board fails here rather than leaving the election unverifiable
// for good (T-24, T-25, T-53, T-54;
// 0029-board-data-availability).
//
// Both points are decided: the ballot extent at `C_A` and `t_A`, and the
// counted extent at `C_S` and `t_A'`, whose `s_S` and `t_S` the definition
// and the anchor's clock fix with the release's contract-event window
// (docs/spec/tally.md, Tally window), never a bundle's word (T-34). A point
// whose evidence isn't held (the finalized L1 block before its segment's
// anchoring deadline, or no accumulator proven at or after its deadline) is
// unverifiable, never failed, so a withheld or erased attestation event
// can't fail an honest election; 4.6 passes only once both are held.

import {
  type Anchor,
  type AnchorClock,
  AVAILABILITY_POINTS,
  type AvailabilityEvent,
  type AvailabilityPanel,
  type AvailabilityRecordReport,
  type PanelAvailability,
  availabilityWindows,
  BoardError,
  checkAvailability,
  checkContractEvent,
  checkEventAccumulatorProof,
  checkpointHash,
  countedCheckpoints,
  countedExtent,
  type ContractEventError,
  contractEventLog,
  type ContractEventRecord,
  DecodeError,
  decodeAvailabilityAttestation,
  decodeAvailabilityComplaint,
  type DecodeErrorCode,
  decodeContractEvent,
  type EventAccumulatorProofError,
  type EventContracts,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { ArchivedAccumulator } from "./evidence.ts";
import { countedFloor } from "./openings.ts";
import {
  accumulatorAtOutputRoot,
  type OutputRootAccumulator,
  type OutputRootEvidence,
  OutputRootError,
  type OutputRootErrorCode,
} from "./output-root.ts";

/**
 * `F`, the forced-inclusion delay, and `R`, the margin, that this release
 * pins (docs/spec/delivery.md, Capacity; docs/spec/availability.md,
 * Windows): Base's 12-hour forced-inclusion delay and an hour of missed
 * slots, and one hour, the values the trustee node's release sizes its
 * intake cutoff by. Never a definition's or a bundle's own values, which
 * would let whoever writes them move `t_A` (T-34). Changing either is a new
 * release.
 */
export const PINNED_FORCED_INCLUSION = 46_800n;
export const PINNED_MARGIN = 3_600n;

/** The board contract's events and the evidence its accumulator is proven by (bundle format 6). */
export interface L2BoardEvidence {
  /** Every log of the board contract, from `n = 0`, each `encode(contract-event record)` under the pinned version. */
  readonly events: readonly Uint8Array[];
  /** The output root, its preimage and the board account's storage proof. */
  readonly proof: OutputRootEvidence;
}

/** Why a point's evidence isn't held: no verdict on it (docs/spec/availability.md, Availability check). */
export type AvailabilityEvidenceCode =
  | "availability-pending"
  | OutputRootErrorCode
  | EventAccumulatorProofError
  | ContractEventError
  | "decode"
  /** A failure resting on an archived record, whose output root no reader checks on L1 yet (T-71). */
  | "evidence-unchecked";

export interface AvailabilityInputs {
  readonly definitionHash: Uint8Array;
  readonly electionId: Uint8Array;
  readonly closesAt: bigint;
  readonly l1InclusionBound: bigint;
  readonly l2ChainId: bigint;
  /** The contract-event version the profile pins. */
  readonly eventVersion: number | undefined;
  /** The definition's L2 contracts; the board's is the one whose events are read. */
  readonly contracts: EventContracts;
  /** The default panel, then the author panel if the election has one, with their thresholds and key sets. */
  readonly panels: readonly AvailabilityPanel[];
  readonly anchors: readonly Anchor[];
  readonly clock: AnchorClock;
  /** The finalized L1 time the anchors were read at. */
  readonly now: bigint;
  readonly l2: L2BoardEvidence;
  /**
   * The board's accumulator from the permanent archive, where the run read
   * it (docs/spec/verifier.md, Archive, step 5): taken where the bundle's
   * own proof doesn't hold, or is before `t_A` and earlier than it.
   */
  readonly archived?: ArchivedAccumulator;
  /**
   * The board's events from the permanent archive's contract-event runs,
   * from index 0, where 4.4's replay read them (docs/spec/verifier.md,
   * Contract events, step 6): replayed in place of the bundle's where these
   * don't reach the proven count and those do.
   */
  readonly archivedEvents?: readonly ContractEventRecord[];
}

export interface AvailabilityOutcome {
  readonly status: "pass" | "fail" | "unverifiable";
  readonly code?: "unavailable" | AvailabilityEvidenceCode | "unsupported-version" | "not-reached";
  readonly at?:
    | { readonly point: number; readonly panel: number }
    | { readonly event: number; readonly decodeError?: DecodeErrorCode }
    | Record<string, never>;
}

/** One panel at the ballot extent, as the report lists it (seats ascending). */
export interface PanelAvailabilityReport {
  readonly panel: number;
  readonly holds: boolean;
  readonly attested: readonly number[];
  /** Each with the CID its complaint names, as hex. */
  readonly complained: readonly { readonly seat: number; readonly cid: string }[];
  readonly silent: readonly number[];
}

/** One panel at the counted extent: as at the ballot extent, each attesting seat with the obligation roots it names, as hex. */
export interface CountedPanelAvailabilityReport extends Omit<PanelAvailabilityReport, "attested"> {
  readonly attested: readonly { readonly seat: number; readonly roots: readonly string[] }[];
}

/** One point as the report lists it: its deadline, and once its evidence is held, its checkpoint and panels. */
export interface PointAvailabilityReport<Panel> {
  /** `t_A` or `t_A'`. */
  readonly deadline: string;
  /** `C_A` or `C_S`, or `null` where no counted checkpoint is at or before `s_A` or `s_S`; absent, as `panels` is, while the point's evidence isn't held. */
  readonly checkpoint?: { readonly segment: number; readonly hash: string } | null;
  readonly panels?: readonly Panel[];
}

/** What 4.6 found, reported once the accumulator replayed. */
export interface AvailabilityReport {
  /** The L2 block the board's accumulator was proven at. */
  readonly proven: {
    readonly block: string;
    readonly hash: string;
    readonly timestamp: string;
    readonly count: string;
    /** Where the proof came from: the bundle's `l2Board`, or an archived record. */
    readonly source: "bundle" | "archive";
    /** For an archived record: its listing and the game whose claim it is worth (T-71). */
    readonly evidence?: {
      readonly cid: string;
      readonly transaction: string;
      readonly gameIndex: string;
      readonly game: string;
      readonly outputRoot: string;
    };
  };
  /** Where the events replayed came from: the bundle's `l2Board`, or the archive's runs. */
  readonly events: "bundle" | "archive";
  readonly ballotExtent: PointAvailabilityReport<PanelAvailabilityReport>;
  readonly countedExtent: PointAvailabilityReport<CountedPanelAvailabilityReport>;
  /**
   * Once the ballot extent's evidence is held: the availability records of
   * each point whose evidence is held, in event order, by their positions in
   * the board's events, with their codes.
   */
  readonly records?: readonly AvailabilityRecordReport[];
}

export interface AvailabilityResult {
  readonly row: AvailabilityOutcome;
  readonly report?: AvailabilityReport;
}

/** Check 4.6 over the board contract's events (docs/spec/availability.md, Availability check). */
export function availabilityChecks(inputs: AvailabilityInputs): AvailabilityResult {
  const { clock, eventVersion } = inputs;
  // Version 8 is the first whose tables name the availability events, and
  // 2.3 fails every profile pinning an earlier one; versions 9 to 13 name
  // them as version 8 does, and a later version is a later release's to
  // read (T-36).
  if (eventVersion === undefined || eventVersion > 13)
    return { row: { status: "unverifiable", code: "unsupported-version", at: {} } };
  if (
    eventVersion !== 8 &&
    eventVersion !== 9 &&
    eventVersion !== 10 &&
    eventVersion !== 11 &&
    eventVersion !== 12 &&
    eventVersion !== 13
  )
    return { row: { status: "unverifiable", code: "not-reached" } };
  const pinned = eventVersion;
  // `C_A`: the counted checkpoint with the largest segment at or before
  // `s_A = period(closes_at) + 1`, from L1 alone. A failure of the board
  // checks' first steps is 4.2's, which no attestation can settle; a seal
  // never anchored is not, since withholding it mustn't hide a failure here.
  let counted: ReturnType<typeof countedCheckpoints>;
  try {
    counted = countedCheckpoints(inputs.electionId, inputs.anchors, clock, inputs.now);
  } catch (e) {
    if (e instanceof BoardError) return { row: { status: "unverifiable", code: "not-reached" } };
    throw e;
  }
  if (inputs.closesAt < clock.epoch)
    return { row: { status: "unverifiable", code: "not-reached" } };
  // `s_S` and `t_S`, its anchoring deadline, from the definition and the
  // clock alone (docs/spec/tally.md, Tally window).
  const sA = countedFloor(inputs.closesAt, clock);
  const { segment: sS, due: tS } = countedExtent(clock, inputs.closesAt, inputs.l1InclusionBound);
  const latestAtOrBefore = (segment: bigint) => {
    let found: (typeof counted)[number] | undefined;
    for (const cp of counted)
      if (BigInt(cp.segment) <= segment && (found === undefined || cp.segment > found.segment))
        found = cp;
    return found;
  };
  // No counted checkpoint is past the seal's segment, so under a clock
  // whose seal is before `s_S`, which no registered definition has, `C_S`
  // would quietly be an earlier checkpoint than the one honest seats name:
  // the counted extent isn't judged at all (the ballot extent still is).
  const sealedAfter = BigInt(clock.lastSegment) >= sS;
  const cA = latestAtOrBefore(sA);
  const cS = latestAtOrBefore(sS);
  const windows = availabilityWindows(inputs.closesAt, inputs.l1InclusionBound, tS, {
    forcedInclusion: PINNED_FORCED_INCLUSION,
    margin: PINNED_MARGIN,
  });
  const tA = windows.ballotDeadline;
  const tAPrime = windows.countedDeadline;

  let proven: OutputRootAccumulator | undefined;
  let failed: OutputRootErrorCode | undefined;
  try {
    proven = accumulatorAtOutputRoot(inputs.l2.proof, inputs.contracts.board);
  } catch (e) {
    if (!(e instanceof OutputRootError)) throw e;
    failed = e.code;
  }
  // The archive's record stands in for a bundle proof that doesn't hold or
  // is too early to hold both points; a bundle proof at or after `t_A'` is
  // enough, and an earlier archived one adds nothing (Archive, step 5). A
  // record dated after the finalized L1 time is never taken: it would hold
  // a point before the chain reached its deadline, and its date is its
  // writer's word.
  const { archived } = inputs;
  const used =
    archived !== undefined &&
    archived.accumulator.timestamp <= inputs.now &&
    (proven === undefined ||
      (proven.timestamp < tAPrime && archived.accumulator.timestamp > proven.timestamp))
      ? archived
      : undefined;
  if (used === undefined && proven === undefined)
    return { row: { status: "unverifiable", code: failed as OutputRootErrorCode, at: {} } };
  // A bundle proof at or after `t_A` decides the ballot extent on its own,
  // so a later archived record taken for the counted extent, the archive's
  // word (T-71), can't turn that proof's failure into `evidence-unchecked`.
  if (used !== undefined && proven !== undefined && proven.timestamp >= tA) {
    const bundle = judgeUnder(proven, undefined);
    if (
      bundle.row.status === "fail" &&
      bundle.row.at !== undefined &&
      "point" in bundle.row.at &&
      bundle.row.at.point === AVAILABILITY_POINTS.ballotExtent
    )
      return bundle;
  }
  return judgeUnder(used?.accumulator ?? (proven as OutputRootAccumulator), used);

  function judgeUnder(
    proven: OutputRootAccumulator,
    used: ArchivedAccumulator | undefined,
  ): AvailabilityResult {
    // The bundle's events where they reach the proven count, else the
    // archive's where those do: the replay against the proof is what holds
    // either to the board's history, so a run's events count for no more
    // than the proof they replay to (T-53, T-71). Where neither reaches it,
    // the bundle's are replayed as they are.
    const { archivedEvents } = inputs;
    const fromArchive =
      archivedEvents !== undefined &&
      BigInt(inputs.l2.events.length) < proven.count &&
      BigInt(archivedEvents.length) >= proven.count;
    // Only the first `count`: the proof fixes them, and the events the runs
    // give past it are the archive's word, which mustn't leave unverifiable
    // a point the proven prefix decides.
    const records: ContractEventRecord[] = fromArchive
      ? archivedEvents.slice(0, Number(proven.count))
      : [];
    if (!fromArchive)
      for (const [at, bytes] of inputs.l2.events.entries())
        try {
          records.push(decodeContractEvent(bytes, pinned));
        } catch (e) {
          if (!(e instanceof DecodeError)) throw e;
          return {
            row: { status: "unverifiable", code: "decode", at: { event: at, decodeError: e.code } },
          };
        }
    // The replay takes a counted log's 1 to 4 topics on trust; one with none
    // isn't any log our contracts emit, so the archive isn't the board's.
    if (records.slice(0, Number(proven.count)).some((r) => r.topics.length === 0))
      return { row: { status: "unverifiable", code: "event-topics", at: {} } };
    const replay = checkEventAccumulatorProof(
      inputs.l2ChainId,
      inputs.contracts.board,
      records.map(contractEventLog),
      proven,
    );
    if (replay !== null) return { row: { status: "unverifiable", code: replay, at: {} } };
    // Only the logs the accumulator covers are evidence; any after them are
    // in later blocks, which the OP Stack stamps strictly later, so none of
    // them is in time for a point the proof's block is at or after.
    const events: AvailabilityEvent[] = [];
    const eventAt: number[] = [];
    // Each record's point, read from the record the event check decoded, so
    // a record of a point whose evidence isn't held is left out of the report
    // whatever its code (stray, seat and signature codes carry none).
    const pointAt: number[] = [];
    for (const [at, record] of records.slice(0, Number(proven.count)).entries()) {
      const checked = checkContractEvent(record, inputs.contracts, pinned);
      // Every log the board emits passes the event check (T-53), so one that
      // doesn't, or that isn't the board's, isn't the board's sequence: no
      // evidence, never a failure.
      if (!checked.ok) return { row: { status: "unverifiable", code: checked.error, at: {} } };
      if (checked.role !== "board")
        return { row: { status: "unverifiable", code: "unknown-contract", at: {} } };
      const event = checked.event;
      if (
        event.event !== "AvailabilityAttestationSubmitted" &&
        event.event !== "AvailabilityComplaintSubmitted"
      )
        continue;
      events.push({ payload: event.record, submittedAt: record.l2_timestamp });
      eventAt.push(at);
      pointAt.push(
        event.event === "AvailabilityAttestationSubmitted"
          ? decodeAvailabilityAttestation(event.record, 1).point
          : decodeAvailabilityComplaint(event.record, 1).point,
      );
    }

    const judged = checkAvailability(
      {
        definitionHash: inputs.definitionHash,
        panels: inputs.panels,
        checkpoints: {
          ballot: cA === undefined ? null : checkpointHash(cA),
          counted: cS === undefined ? null : checkpointHash(cS),
        },
        deadlines: { ballot: tA, counted: tAPrime },
      },
      events,
    );
    // A point waits on its evidence alone: L1 past its segment's anchoring
    // deadline, so its checkpoint is fixed, and the accumulator proven at or
    // after its deadline, so every record that counts is in the replayed
    // sequence. `t_S` is `s_S`'s anchoring deadline.
    const ballotHeld =
      inputs.now >= clock.epoch + (sA + 1n) * clock.period + clock.deadline &&
      proven.timestamp >= tA;
    const countedHeld = sealedAfter && inputs.now >= tS && proven.timestamp >= tAPrime;
    const heldPoint = (point: number | undefined) =>
      point === AVAILABILITY_POINTS.ballotExtent
        ? ballotHeld
        : point === AVAILABILITY_POINTS.countedExtent && countedHeld;
    const heldRecords = judged.records
      .filter((r) => heldPoint(pointAt[r.at]))
      .map((r) => ({ ...r, at: eventAt[r.at] as number }));
    const pointOf = (point: number) => judged.points.find((p) => p.point === point);
    const checkpointOf = (cp: (typeof counted)[number] | undefined) =>
      cp === undefined ? null : { segment: cp.segment, hash: bytesToHex(checkpointHash(cp)) };
    const panelOf = (p: PanelAvailability) => ({
      panel: p.panel,
      holds: p.holds,
      complained: p.complained.map((c) => ({ seat: c.seat, cid: bytesToHex(c.cid) })),
      silent: p.silent,
    });
    const ballotPoint = pointOf(AVAILABILITY_POINTS.ballotExtent);
    const countedPoint = pointOf(AVAILABILITY_POINTS.countedExtent);
    const report: AvailabilityReport = {
      proven: {
        block: proven.block.toString(),
        hash: bytesToHex(proven.blockHash),
        timestamp: proven.timestamp.toString(),
        count: proven.count.toString(),
        source: used === undefined ? "bundle" : "archive",
        ...(used !== undefined && {
          evidence: {
            cid: bytesToHex(used.cid),
            transaction: bytesToHex(used.transaction),
            gameIndex: used.gameIndex.toString(),
            game: bytesToHex(used.game),
            outputRoot: bytesToHex(used.outputRoot),
          },
        }),
      },
      events: fromArchive ? "archive" : "bundle",
      // Each point's checkpoint and every code judged against it are fixed only once held.
      ballotExtent: {
        deadline: tA.toString(),
        ...(ballotHeld && { checkpoint: checkpointOf(cA) }),
        ...(ballotHeld &&
          ballotPoint !== undefined && {
            panels: ballotPoint.panels.map((p) => ({
              ...panelOf(p),
              attested: p.attested.map((a) => a.seat),
            })),
          }),
      },
      countedExtent: {
        deadline: tAPrime.toString(),
        ...(countedHeld && { checkpoint: checkpointOf(cS) }),
        ...(countedHeld &&
          countedPoint !== undefined && {
            panels: countedPoint.panels.map((p) => ({
              ...panelOf(p),
              attested: p.attested.map((a) => ({ seat: a.seat, roots: a.roots.map(bytesToHex) })),
            })),
          }),
      },
      ...((ballotHeld || countedHeld) && { records: heldRecords }),
    };
    // A failure at one point fails the election whatever the other's
    // evidence, the ballot extent's first (docs/spec/availability.md,
    // Availability check).
    const failure = judged.failures.find((f) => heldPoint(f.point));
    // The archive's authority writes the record whole, and until P1-19 reads
    // its game on L1 its output root is its own word, so it could prove a
    // prefix of the events that leaves the attestations out (T-71): it can
    // show a point held, never fail one, which an unforgeable root must.
    if (failure !== undefined && used !== undefined)
      return { row: { status: "unverifiable", code: "evidence-unchecked", at: {} }, report };
    if (failure !== undefined)
      return {
        row: {
          status: "fail",
          code: "unavailable",
          at: { point: failure.point, panel: failure.panel },
        },
        report,
      };
    if (ballotHeld && !sealedAfter)
      return { row: { status: "unverifiable", code: "not-reached" }, report };
    if (!ballotHeld || !countedHeld)
      return { row: { status: "unverifiable", code: "availability-pending", at: {} }, report };
    return { row: { status: "pass" }, report };
  }
}
