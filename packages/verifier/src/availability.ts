// The availability check (4.6, docs/spec/availability.md, Availability check;
// docs/spec/verifier.md, Availability): whether each panel's threshold of
// seats attested, through the L2 contract path, that it held the board an
// election's result rests on, before any result existed. It reads only L1
// (the counted checkpoints) and the board contract's events, replayed
// against its event accumulator proven under an L2 output root, never the
// board copy, so a withheld board fails here rather than leaving the
// election unverifiable for good (T-24, T-25, T-53, T-54;
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
  anchoredCheckpoints,
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
  type ContractEventError,
  contractEventLog,
  type ContractEventRecord,
  DecodeError,
  type DecodeErrorCode,
  decodeContractEvent,
  type EventAccumulatorProofError,
  type EventContracts,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";

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
  | "decode";

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
  };
  readonly ballotExtent: {
    /** `t_A`. */
    readonly deadline: string;
    /** `C_A`, or `null` where no counted checkpoint is at or before `s_A`. */
    readonly checkpoint: { readonly segment: number; readonly hash: string } | null;
    /** Absent while the point's evidence isn't held. */
    readonly panels?: readonly PanelAvailabilityReport[];
  };
  /** Every availability record in event order, by its position in the board's events, with its code; the counted extent's are left out. */
  readonly records: readonly AvailabilityRecordReport[];
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
  // 2.3 fails every profile pinning an earlier one; a later version is a
  // later release's to read (T-36).
  if (eventVersion === undefined || eventVersion > 8)
    return { row: { status: "unverifiable", code: "unsupported-version", at: {} } };
  if (eventVersion !== 8) return { row: { status: "unverifiable", code: "not-reached" } };
  // `C_A`: the counted checkpoint with the largest segment at or before
  // `s_A = period(closes_at) + 1`, from L1 alone. A failure of the board
  // checks' first steps is 4.2's, which no attestation can settle.
  let counted;
  try {
    counted = anchoredCheckpoints(inputs.electionId, inputs.anchors, clock, inputs.now);
  } catch (e) {
    if (e instanceof BoardError) return { row: { status: "unverifiable", code: "not-reached" } };
    throw e;
  }
  const sA = countedFloor(inputs.closesAt, clock);
  if (sA < 0n) return { row: { status: "unverifiable", code: "not-reached" } };
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
  try {
    proven = accumulatorAtOutputRoot(inputs.l2.proof, inputs.contracts.board);
  } catch (e) {
    if (e instanceof OutputRootError)
      return { row: { status: "unverifiable", code: e.code, at: {} } };
    throw e;
  }
  const records: ContractEventRecord[] = [];
  for (const [at, bytes] of inputs.l2.events.entries())
    try {
      records.push(decodeContractEvent(bytes, eventVersion));
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      return {
        row: { status: "unverifiable", code: "decode", at: { event: at, decodeError: e.code } },
      };
    }
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
    .filter((r) => !("point" in r) || r.point === AVAILABILITY_POINTS.ballotExtent)
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
    },
    ballotExtent: {
      deadline: tA.toString(),
      checkpoint:
        cA === undefined ? null : { segment: cA.segment, hash: bytesToHex(checkpointHash(cA)) },
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
    records: ballotRecords,
  };
  if (!held)
    return { row: { status: "unverifiable", code: "availability-pending", at: {} }, report };
  // A failure at one point fails the election whatever the other's evidence.
  const failure = judged.failures.find((f) => f.point === AVAILABILITY_POINTS.ballotExtent);
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
