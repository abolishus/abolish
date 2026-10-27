// When a poll's postings lapse ([[delivery]], Client rule 4): a seat no route
// receipted may be posted only until `c_D = t_D − F`, so that, forced
// through L1, its submission time is at or before the delivery deadline
// `t_D`. But the client posts only for a cast whose ballot never left the
// device, and no path admits a ballot past `closes_at`, so a posting for one
// of its own casts helps only if it is recorded, and the ballot sent, before
// the close ([[posting-relay]], The ballot's own deadline). The client reads
// its own cutoffs from the close, and past the close the `ct_i` and `m_i`
// kept for a posting only wait to be read off a seized device by anyone who
// later breaks the share's classical encryption (T-18), so it erases them.

import { deliveryDeadlines, PARAMETERS } from "@abolishus/crypto";

// [[posting-relay]], The ballot's own deadline, in seconds.
export const POSTING_BALLOT_MARGIN = 3_600n;
export const POSTING_SEND_TIME = 600n;
export const POSTING_LATE_FINALITY = 1_200n;

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

/** The cutoffs the client's own postings are read from, in seconds ([[posting-relay]], The ballot's own deadline). */
export interface PostingCutoffs {
  /**
   * The ballot cutoff `c_B = min(c_D, closes_at − POSTING_BALLOT_MARGIN)`:
   * the wallet's last send, recorded within `WALLET_WAIT` with time left to
   * send the ballot before the close.
   */
  readonly ballot: bigint;
  /**
   * The force cutoff `c_L = c_B − MAX_SEQUENCER_DRIFT`: a deposit in an L1
   * block by it reaches L2 by `c_B` unless the L2 halts, so the relay's
   * deadlines and the wallet's deposits are read from it (T-50).
   */
  readonly force: bigint;
  /**
   * The halt cutoff `c_W = c_B − F`: a deposit in an L1 block by it reaches
   * L2 by `c_B` whatever the sequencer does, so past it the offer warns
   * that a halted L2 can keep a posting out until after the close (T-25,
   * T-50).
   */
  readonly halt: bigint;
  /**
   * The last-offer cutoff `c_E = closes_at − POSTING_SEND_TIME −
   * POSTING_LATE_FINALITY`: a late run, best effort, sends until it, so an
   * honest relay's posting is usually recorded with time left to send the
   * ballot before the close (T-25).
   */
  readonly lastOffer: bigint;
  /**
   * The send cutoff `c_S = closes_at − POSTING_SEND_TIME`, past which a
   * recorded posting no longer sends its ballot: the ballot's own send.
   */
  readonly send: bigint;
}

/**
 * `c_B`, `c_L`, `c_W`, `c_E` and `c_S` for a poll closing at `closesAt` with `l1InclusionBound`,
 * under the release's `forcedInclusion` (`F`). The drift is the pinned
 * `MAX_SEQUENCER_DRIFT`, never the definition's own, which its creator could
 * set to 0 and leave a deposit no time to land (T-34).
 */
export function postingCutoffs(
  closesAt: bigint,
  l1InclusionBound: bigint,
  forcedInclusion: bigint,
): PostingCutoffs {
  const cutoff = postingCutoff(closesAt, l1InclusionBound, forcedInclusion);
  const margin = closesAt - POSTING_BALLOT_MARGIN;
  const ballot = margin < cutoff ? margin : cutoff;
  return {
    ballot,
    force: ballot - BigInt(PARAMETERS.MAX_SEQUENCER_DRIFT),
    halt: ballot - forcedInclusion,
    lastOffer: closesAt - POSTING_SEND_TIME - POSTING_LATE_FINALITY,
    send: closesAt - POSTING_SEND_TIME,
  };
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
