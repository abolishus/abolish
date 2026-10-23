// The summed-share rule (docs/spec/availability.md, What a seat does, No
// summed share before the quorum; docs/spec/tally.md, Summed shares): a seat
// sends no summed share over the counted set before `t_A' + R`, and then only
// once its own L2 node's chain derived from finalized L1 has reached a block
// after `t_A'`, so that it reads every availability record that can count and
// no other seat reads more, and it has read there `k` attestations of the
// default panel at each point that count. If either point lacks the quorum
// it never sends one: the election has failed `unavailable` before any
// result exists, so no seat attests knowing a result and no seat's
// attestation can be withheld once one exists (T-54, T-14, T-24).
//
// The verdict is crypto's availability check (verifier 4.6) over the board
// contract's attestation and complaint events as the seat's own L2 node
// shows them, with `C_A` and `C_S` from the seat's own finalized L1 reader:
// never the operator's or another seat's word. Definition versions 1 and 5,
// the only ones the node approves, have no author panel.
import {
  type AvailabilityEvent,
  type AvailabilityPoint,
  type AvailabilityPanel,
  availabilityWindows,
  checkAvailability,
  checkpointHash,
  countedAttestations,
  type DeadlineClock,
  SEAT_PANELS,
  type SeatPanel,
} from "@abolishus/crypto";
import { countedDue, type FinalizedBoardAnchors, pointExtent } from "./availability.ts";
import type { ApprovedElection } from "./ceremony.ts";
import { RELEASE_WINDOWS } from "./stub.ts";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Every availability attestation and complaint the board contract emitted
 * for the definition, in its event order, each with its L2 block's timestamp,
 * as the seat's own L2 node shows its finalized history (derived from
 * finalized L1), and that finalized block's timestamp.
 */
export type AvailabilityRecords = (definitionHash: Uint8Array) => Promise<{
  readonly finalizedAt: bigint;
  readonly events: readonly AvailabilityEvent[];
}>;

export interface SummingOptions {
  readonly election: ApprovedElection;
  /** The counted extent's L1 reader (through `s_S`), as the counted availability duty reads it. */
  readonly l1: FinalizedBoardAnchors;
  /** The anchoring clock the deployment pins, from which `t_S`, and so `t_A'`, follow. */
  readonly counted: DeadlineClock;
  readonly records: AvailabilityRecords;
  /** The node's wall clock, in seconds. */
  readonly clock: () => bigint;
}

/** The default panel as the approved key set gives it: `k` and each seat's per-election signing key. */
export type SummingPanel = Omit<AvailabilityPanel, "panel">;

export type SummingStatus =
  /**
   * Not yet: the wall clock is before `t_A' + R` (`wall`), `C_S` isn't fixed
   * on finalized L1 (`l1`), or the seat's L2 node hasn't derived a block
   * after `t_A'` (`l2`), each until the time given on that clock.
   */
  | { readonly state: "waiting"; readonly on: "wall" | "l1" | "l2"; readonly until: bigint }
  /**
   * A point lacks the panel's quorum of attestations in time: the election
   * failed `unavailable`, and the seat never sends a summed share.
   */
  | {
      readonly state: "unavailable";
      readonly failures: readonly {
        readonly point: AvailabilityPoint;
        readonly panel: SeatPanel;
      }[];
    }
  /**
   * A root is available (`q − k + 1` of the panel's seats name it in
   * counted-extent attestations that count), and the seat holds no leaf
   * object (the node fetches none, P1-12f part 3c): it sends nothing, as the
   * rule requires, and the operator is alerted. Honest seats name roots
   * only in elections that commit them, which the stub's capacity check
   * refuses, so only `q − k + 1` seats naming one falsely get here, which
   * the spec's collusion residual covers.
   */
  | { readonly state: "unheld-roots" }
  /** Both points hold the quorum: the seat may sum over the counted set. */
  | { readonly state: "available" };

/** The rule the tally duty asks before it reads the counted set. */
export interface SummingRule {
  check(panel: SummingPanel): Promise<SummingStatus>;
}

/**
 * The summed-share rule for one approved election over the seat's own
 * nodes. Throws `L1AnchorError` `outside-clock` here for a close before the
 * pinned clock's epoch, and `clock` from `check` for a reader under another
 * clock, as the counted availability duty does.
 */
export function summingRule(options: SummingOptions): SummingRule {
  const { election } = options;
  const windows = availabilityWindows(
    election.closesAt,
    election.l1InclusionBound,
    countedDue(election, options.counted),
    RELEASE_WINDOWS,
  );
  return {
    async check(panel) {
      const wall = options.clock();
      if (wall < windows.summing) return { state: "waiting", on: "wall", until: windows.summing };
      const { anchors, clock, now } = await options.l1.read(election.electionId);
      // The counted extent first: it refuses a reader under another clock,
      // or one stopping before `s_S`, which would fix another `C_S`.
      const cS = pointExtent(election, options.counted, anchors, clock, now);
      const cA = pointExtent(election, undefined, anchors, clock, now);
      for (const x of [cA, cS])
        if ("state" in x && x.state === "waiting")
          return { state: "waiting", on: "l1", until: x.until };
      const { finalizedAt, events } = await options.records(election.definitionHash);
      // Every record submitted by `t_A'` is in a block at or before it, so
      // once the derived head is past it no later read shows one more that
      // counts, and the verdict below is final (T-71).
      if (finalizedAt <= windows.countedDeadline)
        return { state: "waiting", on: "l2", until: windows.countedDeadline + 1n };
      // A board failing the board checks, or with no counted checkpoint at a
      // point, names none: no record counts there, and the point fails.
      const hash = (x: typeof cA) => ("state" in x ? null : checkpointHash(x.checkpoint));
      const report = checkAvailability(
        {
          definitionHash: election.definitionHash,
          panels: [{ panel: SEAT_PANELS.default, ...panel }],
          checkpoints: { ballot: hash(cA), counted: hash(cS) },
          deadlines: { ballot: windows.ballotDeadline, counted: windows.countedDeadline },
        },
        events,
      );
      if (report.verdict === "unavailable")
        return { state: "unavailable", failures: report.failures };
      // A root is available once `q − k + 1` of the panel's `q` seats name
      // it in counted-extent attestations that count; one named by fewer is
      // withheld, delivers nothing and needs no leaves, so one seat naming a
      // root can't stop the others summing (docs/spec/delivery.md, Leaf
      // availability; T-54).
      const named = new Map<string, number>();
      for (const a of countedAttestations(report))
        for (const root of new Set(a.roots.map(hex))) named.set(root, (named.get(root) ?? 0) + 1);
      const available = panel.registered.length - panel.threshold + 1;
      if ([...named.values()].some((n) => n >= available)) return { state: "unheld-roots" };
      return { state: "available" };
    },
  };
}
