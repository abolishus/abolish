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
// Only the ballot extent is decided. The counted extent's point needs `t_S`,
// the end of `s_S`, which needs the contract-event window `W_C` of every
// window `W_S` takes in (docs/spec/tally.md, Tally window); the verifier
// knows only its floor, so that point stays unverifiable, never judged
// against a guess, and 4.6 can fail but never pass yet. A point whose
// evidence isn't held (the finalized L1 block before the anchoring deadline
// of `s_A`, or no accumulator proven at or after `t_A`) is unverifiable,
// never failed, so a withheld or erased attestation event can't fail an
// honest election.

import {
  type Anchor,
  type AnchorClock,
  AVAILABILITY_POINTS,
  type AvailabilityEvent,
  type AvailabilityPanel,
  type AvailabilityRecordReport,
  availabilityWindows,
  BoardError,
  checkAvailability,
  checkContractEvent,
  checkEventAccumulatorProof,
  checkpointHash,
  countedCheckpoints,
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
  readonly status: "fail" | "unverifiable";
  readonly code:
    | "unavailable"
    | AvailabilityEvidenceCode
    | "unsupported-version"
    | "not-reached"
    | "not-implemented";
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
  readonly ballotExtent: {
    /** `t_A`. */
    readonly deadline: string;
    /** `C_A`, or `null` where no counted checkpoint is at or before `s_A`; absent, as `panels` is, while the point's evidence isn't held. */
    readonly checkpoint?: { readonly segment: number; readonly hash: string } | null;
    readonly panels?: readonly PanelAvailabilityReport[];
  };
  /** Once the ballot extent's evidence is held: its availability records in event order, by their positions in the board's events, with their codes. */
  readonly records?: readonly AvailabilityRecordReport[];
}

export interface AvailabilityResult {
  readonly row: AvailabilityOutcome;
  readonly report?: AvailabilityReport;
}

const NOT_IMPLEMENTED: AvailabilityOutcome = { status: "unverifiable", code: "not-implemented" };

/** Check 4.6 over the board contract's events (docs/spec/availability.md, Availability check). */
export function availabilityChecks(inputs: AvailabilityInputs): AvailabilityResult {
  const { clock, eventVersion } = inputs;
  // Version 8 is the first whose tables name the availability events, and
  // 2.3 fails every profile pinning an earlier one; versions 9 to 11 name
  // them as version 8 does, and a later version is a later release's to
  // read (T-36).
  if (eventVersion === undefined || eventVersion > 11)
    return { row: { status: "unverifiable", code: "unsupported-version", at: {} } };
  if (eventVersion !== 8 && eventVersion !== 9 && eventVersion !== 10 && eventVersion !== 11)
    return { row: { status: "unverifiable", code: "not-reached" } };
  // `C_A`: the counted checkpoint with the largest segment at or before
  // `s_A = period(closes_at) + 1`, from L1 alone. A failure of the board
  // checks' first steps is 4.2's, which no attestation can settle; a seal
  // never anchored is not, since withholding it mustn't hide a failure here.
  let counted;
  try {
    counted = countedCheckpoints(inputs.electionId, inputs.anchors, clock, inputs.now);
  } catch (e) {
    if (e instanceof BoardError) return { row: { status: "unverifiable", code: "not-reached" } };
    throw e;
  }
  if (inputs.closesAt < clock.epoch)
    return { row: { status: "unverifiable", code: "not-reached" } };
  const sA = countedFloor(inputs.closesAt, clock);
  let cA: (typeof counted)[number] | undefined;
  for (const cp of counted)
    if (BigInt(cp.segment) <= sA && (cA === undefined || cp.segment > cA.segment)) cA = cp;
  // Only `t_A` is used: `t_S`, and with it the counted extent's moments,
  // isn't known (above), so `countedDue` is a placeholder no row reads.
  const tA = availabilityWindows(inputs.closesAt, inputs.l1InclusionBound, 0n, {
    forcedInclusion: PINNED_FORCED_INCLUSION,
    margin: PINNED_MARGIN,
  }).ballotDeadline;

  let proven;
  let failed: OutputRootErrorCode | undefined;
  try {
    proven = accumulatorAtOutputRoot(inputs.l2.proof, inputs.contracts.board);
  } catch (e) {
    if (!(e instanceof OutputRootError)) throw e;
    failed = e.code;
  }
  // The archive's record stands in for a bundle proof that doesn't hold or
  // is too early to hold the point; a bundle proof at or after `t_A` is
  // enough, and an earlier archived one adds nothing (Archive, step 5). A
  // record dated after the finalized L1 time is never taken: it would hold
  // `t_A` before the chain reached it, and its date is its writer's word.
  const { archived } = inputs;
  const used =
    archived !== undefined &&
    archived.accumulator.timestamp <= inputs.now &&
    (proven === undefined ||
      (proven.timestamp < tA && archived.accumulator.timestamp > proven.timestamp))
      ? archived
      : undefined;
  if (used !== undefined) proven = used.accumulator;
  if (proven === undefined)
    return { row: { status: "unverifiable", code: failed as OutputRootErrorCode, at: {} } };
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
        records.push(decodeContractEvent(bytes, eventVersion));
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
  // a counted-extent record is left out whatever its code (stray, seat and
  // signature codes carry none).
  const pointAt: number[] = [];
  for (const [at, record] of records.slice(0, Number(proven.count)).entries()) {
    const checked = checkContractEvent(record, inputs.contracts, eventVersion);
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
      checkpoints: { ballot: cA === undefined ? null : checkpointHash(cA), counted: null },
      // The counted extent's deadline is unknown; its records are judged
      // by `checkAvailability` against this placeholder but never reported.
      deadlines: { ballot: tA, counted: 0n },
    },
    events,
  );
  const ballotRecords = judged.records
    .filter((r) => pointAt[r.at] === AVAILABILITY_POINTS.ballotExtent)
    .map((r) => ({ ...r, at: eventAt[r.at] as number }));
  const anchoringDeadline = clock.epoch + (sA + 1n) * clock.period + clock.deadline;
  // The point waits on its evidence alone: L1 past the anchoring deadline
  // of `s_A`, so `C_A` is fixed, and the accumulator proven at or after
  // `t_A`, so every record that counts is in the replayed sequence.
  const held = inputs.now >= anchoringDeadline && proven.timestamp >= tA;
  const point = judged.points.find((p) => p.point === AVAILABILITY_POINTS.ballotExtent);
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
    ballotExtent: {
      deadline: tA.toString(),
      // `C_A` and every code judged against it are fixed only once held.
      ...(held && {
        checkpoint:
          cA === undefined ? null : { segment: cA.segment, hash: bytesToHex(checkpointHash(cA)) },
      }),
      ...(held &&
        point !== undefined && {
          panels: point.panels.map((p) => ({
            panel: p.panel,
            holds: p.holds,
            attested: p.attested.map((a) => a.seat),
            complained: p.complained.map((c) => ({ seat: c.seat, cid: bytesToHex(c.cid) })),
            silent: p.silent,
          })),
        }),
    },
    ...(held && { records: ballotRecords }),
  };
  if (!held)
    return { row: { status: "unverifiable", code: "availability-pending", at: {} }, report };
  // A failure at one point fails the election whatever the other's evidence.
  const failure = judged.failures.find((f) => f.point === AVAILABILITY_POINTS.ballotExtent);
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
  return { row: NOT_IMPLEMENTED, report };
}
