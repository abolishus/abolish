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

import { type Anchor, type AnchorClock, copyCheckpoints } from "@abolishus/crypto";
import { endOf, SIMULATED_ANCHOR_DEADLINE, SIMULATED_ANCHOR_PERIOD } from "./board.ts";
import type { SimulatedL1 } from "./l1.ts";

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
  /** The last period anchored or passed over. */
  #through: number;

  readonly clock: AnchorClock;

  /**
   * An authority for the election whose board starts in period `first` and
   * is sealed at `seal`. Nothing is anchored before `first`: no reader looks
   * at anchors for earlier periods (docs/spec/contracts.md, Board anchor,
   * Verification).
   */
  constructor(electionId: Uint8Array, first: number, seal: number, l1: SimulatedL1) {
    if (!Number.isSafeInteger(first) || first < 0 || first > seal)
      throw new RangeError("simulation: the first period must be from 0 to the seal");
    this.#electionId = Uint8Array.from(electionId);
    this.clock = anchorClock(seal);
    this.#through = first - 1;
    this.#l1 = l1;
  }

  /**
   * Every anchor made, in L1 order. A reader passes them all to
   * `verifyBoard` with the time of the newest finalized block it has read,
   * which counts only those in blocks up to it (docs/spec/board.md, Board
   * checks, step 1).
   */
  get anchors(): readonly Anchor[] {
    return this.#anchors;
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
