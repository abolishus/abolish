// The board operator's side of publishing a spoiled-ballot opening
// (docs/spec/challenge.md, Publication): after the counted extent, at a
// voter's request, it boards an opening only if it decodes strictly and
// passes the opening checks, falls in the openings' window, opens no
// commitment of a ballot admitted in the counted extent, and repeats no core
// already boarded. Every check is @abolishus/crypto's; this file only applies
// them in Publication's order. A verifier's 6.2 runs the same rules over the
// board and attributes any break to the operator (T-42, T-47).

import {
  type BallotCore,
  type BallotElection,
  type ChallengeOpeningCode,
  checkChallengeOpening,
  DecodeError,
  decodeOpening,
  openedCommitments,
  openingCoreHash,
  opensBallotCommitment,
  type SpoiledBallotOpening,
} from "@abolishus/crypto";

/** Why the operator refuses an opening: a check of challenge.md, or a publication rule. */
export type OpeningRefusal =
  | "decode"
  | ChallengeOpeningCode
  | "opening-early"
  | "opening-late"
  | "opening-cast"
  | "opening-repeat";

export type OpeningAdmission =
  | {
      readonly ok: true;
      readonly opening: SpoiledBallotOpening;
      /** The opened core's tracking code. */
      readonly coreHash: Uint8Array;
      /** `v_j` for each option, as the client committed to it. */
      readonly votes: readonly bigint[];
    }
  | { readonly ok: false; readonly code: OpeningRefusal };

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** What the operator holds when openings arrive: the counted extent is fixed by then. */
export interface OpeningDesk {
  /** The registered definition and key set the openings are checked against. */
  readonly election: BallotElection;
  /** Every ballot admitted in the counted extent, superseded ones included. */
  readonly counted: readonly Pick<BallotCore, "definitionHash" | "vss">[];
  /** `s_S`: an opening is boarded only in a later segment. */
  readonly countedUntil: number;
  /** The anchoring period containing `t_S + OPENING_WINDOW`: the last segment for one. */
  readonly openingsUntil: number;
}

/**
 * Whether the operator may board `payload` in `segment`, given the core
 * hashes already boarded or held (hex), which it adds an admitted one to.
 * The order is Publication's, after decoding and the checks.
 */
export function admitOpening(
  desk: OpeningDesk,
  boarded: Set<string>,
  segment: number,
  payload: Uint8Array,
): OpeningAdmission {
  let opening: SpoiledBallotOpening;
  try {
    opening = decodeOpening(payload, 1);
  } catch (e) {
    if (e instanceof DecodeError) return { ok: false, code: "decode" };
    throw e;
  }
  const checked = checkChallengeOpening(desk.election, opening);
  if (!checked.ok) return { ok: false, code: checked.code };
  // Boarding it before the counted extent is fixed could open a vote that
  // still lands and counts, and its timing could say when its voter cast.
  if (segment <= desk.countedUntil) return { ok: false, code: "opening-early" };
  if (segment > desk.openingsUntil) return { ok: false, code: "opening-late" };
  // Any counted ballot's commitment, at any option, never its tracking code:
  // an opened commitment or its randomness can be cast under other share
  // hashes, so publishing it would open a counted vote (T-45, T-47).
  const opened = openedCommitments(opening);
  if (desk.counted.some((b) => opensBallotCommitment(opened, b)))
    return { ok: false, code: "opening-cast" };
  const key = hex(openingCoreHash(opening));
  if (boarded.has(key)) return { ok: false, code: "opening-repeat" };
  boarded.add(key);
  return { ok: true, opening, coreHash: checked.coreHash, votes: checked.votes };
}
