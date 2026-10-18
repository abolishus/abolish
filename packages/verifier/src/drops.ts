// The drop rule (docs/spec/receipts.md, Drops): an `unanchored` or `forked`
// receipt is also a drop if the ballot it covers would have been admitted
// and no admitted entry of the anchored board carries its (tier, ν, M). The
// payload is judged by the same judge, close rule and L1-reference check as
// every ballot on the board (ballots.ts), as a board-path ballot of the
// receipt's segment, the path a receipt is issued on. A copy carrying the
// same (tier, ν, M) under other bytes (a re-randomised proof, a
// direct-submitted copy, a resubmission) means the ballot wasn't lost, so
// presence is by M recomputed, never by bytes (T-38). Presence is judged
// only over the admitted ballots of a whole sealed, anchored board, once
// selection (6.1) has passed: on any other copy an entry carrying the
// ballot may be missing or not yet admitted, and a drop would frame an
// operator who boarded it (T-26, T-53).

import {
  DecodeError,
  type DecodeErrorCode,
  RECORD_TYPES,
  type ReceiptVerdict,
} from "@abolishus/crypto";
import {
  type AdmissionCode,
  type BallotOutcome,
  type CountedCandidate,
  type Judge,
  type WindowCode,
} from "./ballots.ts";
import type { L1RefCode, referenceJudge } from "./references.ts";

/** Why a receipt's ballot is no drop: its verdict isn't one, its ballot could never count, or it is on the board. */
export type NotDropCode =
  | "not-alarm"
  | "present"
  | AdmissionCode
  | WindowCode
  | L1RefCode
  | "decode";

/** Why this judge can't decide yet, or under this release. */
export type DropUnjudgedCode =
  | "not-reached"
  | "unsupported-version"
  | "l1-blocks-missing"
  | "l1-blocks-short"
  | "l1-ref-pending"
  | "board-unsettled";

export type DropOutcome =
  | { readonly status: "drop" }
  | {
      readonly status: "not-drop";
      readonly code: NotDropCode;
      /** With `present`: the first admitted entry carrying the ballot's (tier, ν, M). */
      readonly entry?: number;
      /** With `decode`: the strict-decoding code (docs/spec/notation.md). */
      readonly decodeError?: DecodeErrorCode;
    }
  | { readonly status: "unjudged"; readonly code: DropUnjudgedCode };

export interface DropInputs {
  /** The receipt's verdict, as `judgeReceipt` reached it. */
  readonly verdict: ReceiptVerdict;
  /** The receipt's `segment`: the segment the payload's entry would have had. */
  readonly segment: number;
  /** The complete record the receipt covers, header included. */
  readonly payload: Uint8Array;
  /** The election's ballot judge (`judgeFor`), or the outcome no ballot can escape. */
  readonly judge: Judge | BallotOutcome;
  /** The run of finalized L1 headers' reference judge, or `undefined` without one. */
  readonly references: ReturnType<typeof referenceJudge> | undefined;
  /** `s_A`, the board path's last segment (the close rule, 5.5). */
  readonly lastBoardSegment: bigint;
  /**
   * The admitted ballots of the anchored extent of a sealed board, once
   * selection (6.1) passed over it; `undefined` while it hasn't.
   */
  readonly admitted: readonly CountedCandidate[] | undefined;
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Judges whether a receipt's ballot was dropped, in order, the first that
 * applies: `not-alarm` unless the verdict is `unanchored` or `forked`; the
 * payload's own admission (5.1 to 5.4), close rule (5.5) and L1 reference
 * (5.8), any rejection being no drop and a check that can't run leaving it
 * unjudged; `board-unsettled` while `admitted` isn't given; `present` if an
 * admitted entry carries its (tier, ν, M); otherwise a drop.
 */
export function judgeDropRule(input: DropInputs): DropOutcome {
  const { verdict } = input.verdict;
  if (verdict !== "unanchored" && verdict !== "forked")
    return { status: "not-drop", code: "not-alarm" };
  const { judge } = input;
  if (typeof judge !== "function")
    return {
      status: "unjudged",
      code: judge.code === "unsupported-version" ? "unsupported-version" : "not-reached",
    };
  const { payload } = input;
  // The record type first, as the operator's admission reads it: a payload
  // of another type is no ballot, whatever its bytes would decode to.
  if (
    payload.length < 2 ||
    (((payload[0] as number) << 8) | (payload[1] as number)) !== RECORD_TYPES.ballot
  )
    return { status: "not-drop", code: "decode", decodeError: "unexpected-record-type" };
  let checked;
  try {
    ({ checked } = judge(payload));
  } catch (e) {
    if (!(e instanceof DecodeError)) throw e;
    return { status: "not-drop", code: "decode", decodeError: e.code };
  }
  if (!checked.ok) return { status: "not-drop", code: checked.code };
  // A ballot the close rule rejects could never have counted, so its loss
  // isn't a drop (docs/spec/receipts.md, Drops). A board-path ballot is
  // judged by its segment alone, at most `s_A` (docs/spec/close.md, Window).
  if (BigInt(input.segment) > input.lastBoardSegment)
    return { status: "not-drop", code: "window-boarded-late" };
  const { references } = input;
  if (references === undefined) return { status: "unjudged", code: "l1-blocks-missing" };
  if (references === "l1-blocks-short") return { status: "unjudged", code: references };
  const reference = references(checked);
  if (reference === "pending") return { status: "unjudged", code: "l1-ref-pending" };
  if (reference !== "admitted") return { status: "not-drop", code: reference };
  if (input.admitted === undefined) return { status: "unjudged", code: "board-unsettled" };
  // Whatever its selection outcome: a copy that stands, a superseded
  // re-vote or a tie all show the ballot reached the board.
  const present = input.admitted.find(
    (c) =>
      c.ballot.tier === checked.tier &&
      c.ballot.nullifier === checked.nullifier &&
      equal(c.ballot.message, checked.message),
  );
  if (present !== undefined) return { status: "not-drop", code: "present", entry: present.entry };
  return { status: "drop" };
}
