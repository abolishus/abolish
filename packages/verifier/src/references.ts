// L1 references (docs/spec/verifier.md, L1 references; 5.8): each admitted
// ballot's named L1 block is judged by @abolishus/crypto's `checkL1Reference`
// against a run of finalized L1 headers, from a block before the window's
// start (`opens_at − 3600`) to the finalized head, with `l1_ref_min` found in
// the run by `l1RefMin` (docs/spec/revoting.md, Admission). The run is all
// the L1 the check reads: a ballot naming an ancient block is rejected by
// number alone, and one beyond the head by the head's timestamp, so no ballot
// can ask for evidence outside it (T-53, T-36).

import {
  checkL1Reference,
  type FinalizedL1,
  L1_REF_MARGIN,
  type L1ReferenceVerdict,
  l1RefMin,
} from "@abolishus/crypto";
import type { L1Header } from "./l1.ts";

/** Why a ballot's L1 reference rejects it (5.8). */
export type L1RefCode = Exclude<L1ReferenceVerdict, "admitted" | "pending">;

/** One ballot's L1 reference, as its admission check recomputed it into `M`. */
export interface L1Reference {
  readonly l1RefNumber: bigint;
  readonly l1RefHash: Uint8Array;
}

/**
 * How the run judges references, or `l1-blocks-short` when it starts too late
 * to show where the window starts: its first block is neither block 0 nor
 * before `opens_at − 3600`, so `l1_ref_min` could lie below it. `blocks` is a
 * parsed run (Bundle): consecutive, linked and with increasing timestamps.
 */
export function referenceJudge(
  blocks: readonly L1Header[],
  opensAt: bigint,
  closesAt: bigint,
): "l1-blocks-short" | ((ref: L1Reference) => L1ReferenceVerdict) {
  const first = blocks[0];
  const last = blocks.at(-1);
  if (first === undefined || last === undefined) throw new RangeError("referenceJudge: no blocks");
  const threshold = opensAt > L1_REF_MARGIN ? opensAt - L1_REF_MARGIN : 0n;
  if (first.number !== 0n && first.timestamp >= threshold) return "l1-blocks-short";
  const l1: FinalizedL1 = {
    head: last.number,
    block(n) {
      // `l1RefMin` and `checkL1Reference` only ask for numbers from the run's
      // first to its head: the search starts at the first, and a reference
      // below `l1_ref_min` is decided without a lookup.
      const b = n >= first.number ? blocks[Number(n - first.number)] : undefined;
      if (b === undefined) throw new RangeError(`referenceJudge: block ${n} outside the run`);
      return b;
    },
  };
  const min = l1RefMin(l1, first.number, opensAt);
  // The head is before the window: every reference waits for L1.
  if (min === undefined) return () => "pending";
  return (ref) => checkL1Reference(ref, l1, { l1RefMin: min, closesAt });
}
