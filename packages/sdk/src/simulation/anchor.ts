// The simulated anchoring authority (docs/spec/board.md, Segments and
// checkpoints, Anchoring and Timing): once a period has ended, it anchors the
// checkpoint after it, from the operator's board, in the first simulated L1
// block after the period's end, for every period that added entries and for
// the seal even when it added none. Each checkpoint, CIDs included, is
// @abolishus/crypto's `copyCheckpoints` over the board's bytes, and whoever
// reads the anchors judges them with crypto's `verifyBoard`, as the verifier's
// 4.1 and 4.2 do (T-23, T-24, T-49). The contract, its clock and the
// authority's key are simulated: anchors live in memory, never in L1 state
// (SIMULATION_STUBS).

import { type Anchor, type AnchorClock, checkpointHash, copyCheckpoints } from "@abolishus/crypto";
import { endOf, SIMULATED_ANCHOR_DEADLINE, SIMULATED_ANCHOR_PERIOD } from "./board.ts";
import { SIMULATED_FINALITY, type SimulatedL1 } from "./l1.ts";

/** The anchoring clock of an election whose seal is `seal`: hourly from the Unix epoch. */
export function anchorClock(seal: number): AnchorClock {
  return {
    epoch: 0n,
    period: SIMULATED_ANCHOR_PERIOD,
    deadline: SIMULATED_ANCHOR_DEADLINE,
    lastSegment: seal,
  };
}

export class SimulatedAnchor {
  readonly #electionId: Uint8Array;
  readonly #l1: SimulatedL1;
  readonly #anchors: Anchor[] = [];
  /** The last period anchored or passed over, or −1 before any. */
  #through = -1;

  readonly clock: AnchorClock;

  constructor(electionId: Uint8Array, seal: number, l1: SimulatedL1) {
    this.#electionId = Uint8Array.from(electionId);
    this.clock = anchorClock(seal);
    this.#l1 = l1;
  }

  /** Every anchor made, in L1 order. */
  get anchors(): readonly Anchor[] {
    return this.#anchors;
  }

  /**
   * The anchors a reader at L1 time `now` sees: those in blocks finalized
   * by then. A board check counts only finalized anchors (docs/spec/board.md,
   * Board checks, step 1).
   */
  finalizedAt(now: bigint): Anchor[] {
    return this.#anchors.filter((a) => a.anchoredAt + SIMULATED_FINALITY <= now);
  }

  /**
   * Anchors each period after the last one handled through `segment`, once
   * the board holds every entry those periods will ever have: one that
   * added entries, and the seal even with none, when it is reached. A
   * period with no new entries is skipped, as the spec allows, so every
   * anchor names a size no earlier one has, or is the seal's.
   */
  anchorThrough(entries: readonly Uint8Array[], segment: number): void {
    if (segment > this.clock.lastSegment) throw new Error("simulation: anchoring past the seal");
    if (segment <= this.#through) return;
    const periods = Array.from(
      { length: segment - this.#through },
      (_, i) => this.#through + 1 + i,
    );
    const checkpoints = copyCheckpoints(this.#electionId, entries, periods);
    let size = this.#anchors.at(-1)?.checkpoint.size ?? 0n;
    for (const s of periods) {
      const checkpoint = checkpoints.get(s);
      // An empty board has no checkpoint (`checkpoint-size`).
      if (checkpoint === undefined) continue;
      if (checkpoint.size === size && s !== this.clock.lastSegment) continue;
      size = checkpoint.size;
      // In the first block after the period ends, well inside the deadline.
      const anchoredAt = this.#l1.block(this.#l1.firstAfter(endOf(s))).timestamp;
      this.#anchors.push({ checkpoint, anchoredAt });
    }
    this.#through = segment;
  }
}

/** An anchor as a report shows it: its segment, size, checkpoint hash in hex and L1 time. */
export interface AnchorReport {
  readonly segment: number;
  readonly size: number;
  readonly hash: string;
  readonly anchoredAt: number;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function reportAnchor(a: Anchor): AnchorReport {
  return {
    segment: a.checkpoint.segment,
    size: Number(a.checkpoint.size),
    hash: hex(checkpointHash(a.checkpoint)),
    anchoredAt: Number(a.anchoredAt),
  };
}
