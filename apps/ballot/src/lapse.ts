// When a poll's postings lapse ([[delivery]], Client rule 4): a seat no route
// receipted may be posted only until `c_D = t_D − F`, so that, forced
// through L1, its submission time is at or before the delivery deadline
// `t_D`. After it a posting delivers nothing, and the `ct_i` and `m_i` kept
// for it only wait to be read off a seized device by anyone who later breaks
// the share's classical encryption (T-18), so the client erases them.

import { deliveryDeadlines } from "@abolishus/crypto";

/**
 * `c_D = t_D − F` for a poll closing at `closesAt` with `l1InclusionBound`,
 * under the release's `forcedInclusion` (`F`), in seconds.
 */
export function postingCutoff(
  closesAt: bigint,
  l1InclusionBound: bigint,
  forcedInclusion: bigint,
): bigint {
  if (typeof forcedInclusion !== "bigint" || forcedInclusion < 0n)
    throw new RangeError("forcedInclusion must be a bigint ≥ 0");
  return deliveryDeadlines(closesAt, l1InclusionBound).delivery - forcedInclusion;
}

/**
 * Whether `cutoff` has passed by both the L2's finalized head (`chainTime`,
 * seconds) and this device's clock (`nowMs`, milliseconds): at `cutoff`
 * itself a posting may still be sent. Both, so neither an RPC that reports
 * a head from the future nor a clock set ahead alone makes the client erase
 * what a posting still in time would need (T-25); either one lagging only
 * keeps the shares longer (T-18).
 */
export function postingLapsed(cutoff: bigint, chainTime: bigint, nowMs: number): boolean {
  return chainTime > cutoff && passedOnDevice(cutoff, nowMs);
}

/** Whether `cutoff` has passed by this device's clock alone: whether the chain's time is worth reading at all. */
export function passedOnDevice(cutoff: bigint, nowMs: number): boolean {
  if (!Number.isFinite(nowMs)) throw new RangeError("nowMs must be finite");
  return BigInt(Math.floor(nowMs / 1000)) > cutoff;
}
