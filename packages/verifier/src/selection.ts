// Selection (6.1, docs/spec/verifier.md, Selection): each tier and
// nullifier's counted ballot, chosen by @abolishus/crypto's `selectBallots`
// (docs/spec/revoting.md, Selection) over the ballots every admission check
// admitted from the counted extent. The rule is a function of that set alone
// (R3), so 6.1 is decided only once the set is fixed: every admission row
// settled, the copy authenticated by 4.1 and 4.2, the board sealed, every
// ordinary ballot's timestamp authenticated by 4.4, and every admitted ballot
// at or below the floor of `s_S`. Short of any of these, a later entry or a
// later finding could change which ballot counts, so 6.1 is unverifiable,
// never a pass over a set that isn't final (T-33, T-38, T-45, T-53).

import { type AnchorClock, selectBallots } from "@abolishus/crypto";
import type { CountedCandidate } from "./ballots.ts";

/** One ballot entry, by its position in the copy, from 0. */
export interface SelectedBallot {
  readonly entry: number;
}

/** What 6.1 found, reported in `ballots` once it passes. */
export interface SelectionReport {
  /** At most one per (tier, ν): the input to the tally, in copy order. */
  readonly selected: readonly SelectedBallot[];
  /** Listed with `revote-tie`: distinct ballots sharing their group's highest block, in copy order. */
  readonly ties: readonly SelectedBallot[];
}

export interface SelectionOutcome {
  readonly status: "pass" | "unverifiable";
  readonly code?: "not-reached" | "not-sealed" | "not-implemented";
  readonly at?: { readonly entry: number } | Record<string, never>;
}

export interface SelectionInputs {
  /** Whether every admission row (5.1 to 5.5, 5.7, 5.8) passed or failed. */
  readonly admissionSettled: boolean;
  /** Ballot admission's candidates: present only where 5.5 ran. */
  readonly candidates: readonly CountedCandidate[] | undefined;
  /** Every entry carrying an ordinary-path ballot, in copy order. */
  readonly ordinary: readonly number[];
  /** The anchored extent's size, given only when 4.1 and 4.2 pass. */
  readonly extent: number | undefined;
  /** Whether 4.4 passed: only its accumulator replay authenticates `l2_timestamp`. */
  readonly eventsPass: boolean;
  readonly clock: AnchorClock;
  /** The finalized L1 time the board checks ran at, once they ran. */
  readonly now: bigint | undefined;
  /** `s_F = period(closes_at) + 1`, the floor of `s_S`. */
  readonly floor: bigint;
}

const NOT_REACHED: SelectionOutcome = { status: "unverifiable", code: "not-reached", at: {} };

/** 6.1's row and, once it passes, the selection. */
export function selectionCheck(inputs: SelectionInputs): {
  readonly row: SelectionOutcome;
  readonly report?: SelectionReport;
} {
  const { candidates, extent, clock, now } = inputs;
  // An admission check that can't be evaluated may yet admit or reject a
  // ballot, which could change any group's choice (Principles).
  if (!inputs.admissionSettled || candidates === undefined) return { row: NOT_REACHED };
  // Only the anchored board counts, and only 4.1 and 4.2 passing say what
  // it is (T-53).
  if (extent === undefined || now === undefined) return { row: NOT_REACHED };
  // The seal's checkpoint fixes the board's final extent: before its window
  // closes, an entry can still be boarded within the counted extent, so the
  // set isn't final. Once it has closed, 4.2's pass means the seal is
  // anchored (docs/spec/board.md, Board checks, `unsealed`).
  const sealEnds = clock.epoch + (BigInt(clock.lastSegment) + 1n) * clock.period + clock.deadline;
  if (!(sealEnds < now)) return { row: { status: "unverifiable", code: "not-sealed", at: {} } };
  // An ordinary ballot's window rests on its record's `l2_timestamp`, which
  // only 4.4's accumulator replay authenticates: until 4.4 passes, the
  // operator could move one into or out of the window, admitted or not
  // (T-35, T-71).
  const unproven = inputs.ordinary.find((e) => e < extent);
  if (!inputs.eventsPass && unproven !== undefined)
    return { row: { status: "unverifiable", code: "not-reached", at: { entry: unproven } } };
  const anchored = candidates.filter((c) => c.entry < extent);
  // `s_S` isn't known yet, only its floor: an admitted ballot boarded after
  // the floor may or may not be in the counted extent (docs/spec/tally.md,
  // Tally window).
  const beyond = anchored.find((c) => BigInt(c.segment) > inputs.floor);
  if (beyond !== undefined)
    return {
      row: { status: "unverifiable", code: "not-implemented", at: { entry: beyond.entry } },
    };
  const chosen = selectBallots(anchored.map((c) => c.ballot));
  // Admission already rejected every repeat (5.7), so none is left here.
  if (chosen.repeats.length !== 0) throw new Error("selectionCheck: a repeat was admitted");
  const entry = (b: { readonly index: bigint }) => ({ entry: Number(b.index) });
  return {
    row: { status: "pass" },
    report: { selected: chosen.selected.map(entry), ties: chosen.ties.map(entry) },
  };
}
