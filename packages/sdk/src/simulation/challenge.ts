// A simulated voter's Benaloh challenge (docs/spec/challenge.md, Client rules;
// 0021-challenged-ballots): the casting device builds a core and shows its
// tracking code before the choice, the voter's checker records it, the
// device opens the core and hands the opening over as bytes, and the checker
// decodes and checks it against the recorded code and the voter's choice.
// Every check is @abolishus/crypto's; this file only orders them as the
// checker's rules do and compares their results (AGENTS.md, Architecture;
// T-42, T-44).

import {
  type BallotElection,
  type ChallengeOpeningCode,
  checkChallengeOpening,
  DecodeError,
  decodeOpening,
  type DecodeErrorCode,
  type SpoiledBallotOpening,
} from "@abolishus/crypto";
import type { SimulatedTier } from "./scenario.ts";

/**
 * Why a checker reports an opening as evidence that the casting device
 * misbehaved (Client rules, checker rule 3), in the order the checks run:
 * the opening fails to decode, names another election (`opening-stray`) or
 * another tier than the voter's, fails a check of [[challenge]], opens another core than the code recorded before
 * the choice, opens a vote no valid ballot could carry, or opens another vote
 * than the voter chose.
 */
export type ChallengeVerdictCode =
  | "decode"
  | "checker-tier"
  | ChallengeOpeningCode
  | "checker-code"
  | "opening-vote-outside"
  | "checker-vote";

export type ChallengeVerdict =
  | { readonly ok: true; readonly opening: SpoiledBallotOpening }
  | {
      readonly ok: false;
      readonly code: ChallengeVerdictCode;
      /** With `decode`: the decode error's code. */
      readonly decodeError?: DecodeErrorCode;
    };

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The checker's verdict on one challenge: `bytes` is the opening the casting
 * device handed over, `recorded` the tracking code scanned before the choice,
 * all 32 bytes, and `voter` what the voter chose. `election` is the checker's
 * own, from the definition and the key set its ceremony check registered.
 */
export function checkChallenge(
  election: BallotElection,
  recorded: Uint8Array,
  voter: { readonly tier: SimulatedTier; readonly votes: readonly (0 | 1)[] },
  bytes: Uint8Array,
): ChallengeVerdict {
  let opening: SpoiledBallotOpening;
  try {
    opening = decodeOpening(bytes, 1);
  } catch (e) {
    if (!(e instanceof DecodeError)) throw e;
    return { ok: false, code: "decode", decodeError: e.code };
  }
  // Rule 3's order: the election, then the voter's tier, then the checks.
  if (!equalBytes(opening.definition_hash, election.definitionHash))
    return { ok: false, code: "opening-stray" };
  if (opening.tier !== voter.tier) return { ok: false, code: "checker-tier" };
  const checked = checkChallengeOpening(election, opening);
  if (!checked.ok) return { ok: false, code: checked.code };
  if (!equalBytes(checked.coreHash, recorded)) return { ok: false, code: "checker-code" };
  if (!checked.withinRules) return { ok: false, code: "opening-vote-outside" };
  if (
    checked.votes.length !== voter.votes.length ||
    checked.votes.some((v, j) => v !== BigInt(voter.votes[j] as number))
  )
    return { ok: false, code: "checker-vote" };
  return { ok: true, opening };
}
