// What the ballot worker keeps between requests: the version-5 poll it last
// checked, as `sealingElectionV5` made it from the poll's ceremony
// transcript, and the seals made under it. A seal's votes, sharing and
// encryption randomness stay inside @abolishus/crypto's seal; the page gets
// a number to name it by and its tracking code, then either its opening
// (challenged, and spent) or, from part 3b-3, its cast (T-42, T-45). A poll
// checked anew replaces the last one, and its seals go with it.

import {
  challengeSealV3,
  decodeElectionDefinitionV5,
  type QuestionBallotElection,
  sealBallotV3,
  type SealedBallotV3,
  sealingElectionV5,
} from "@abolishus/crypto";

import { checkElection, type ElectionCheck } from "../election.ts";
import type {
  ChallengeRequest,
  ChallengeResult,
  CheckElectionRequest,
  SealRequest,
  SealResult,
} from "./protocol.ts";

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export class BallotSession {
  #poll: { readonly definitionHash: string; readonly election: QuestionBallotElection } | undefined;
  readonly #seals = new Map<number, SealedBallotV3>();
  #nextSeal = 0;

  /**
   * The election check (election.ts), then for a version-5 poll the check
   * of its ceremony transcript under the panel it names, so a poll is shown
   * only if this device can seal to the keys its ceremony registered, never
   * to keys whoever served the records chose (T-37, T-54).
   */
  checkElection(request: CheckElectionRequest): ElectionCheck {
    this.#poll = undefined;
    this.#seals.clear();
    const check = checkElection(
      request.electionId,
      request.registeredHash,
      request.definition,
      request.displayText,
    );
    if (!check.ok || check.election.version !== 5) return check;
    // The show check decoded these bytes under version 5 already.
    const definition = decodeElectionDefinitionV5(request.definition);
    const sealing = sealingElectionV5(definition, request.panels, request.entries);
    if (!sealing.ok) return { ok: false, problem: "ceremony-failed", code: sealing.code };
    this.#poll = { definitionHash: check.election.definitionHash, election: sealing.election };
    return check;
  }

  /** A seal of `request.votes` in its cell, kept here; its tracking code goes to the page. */
  seal(request: SealRequest): SealResult {
    const poll = this.#poll;
    if (poll === undefined || poll.definitionHash !== toHex(request.definitionHash))
      return { ok: false, problem: "no-election" };
    let sealed: SealedBallotV3;
    try {
      sealed = sealBallotV3(poll.election, request.cell, request.votes);
    } catch (error) {
      // Votes outside a question's limits, or a cell outside the partition.
      if (error instanceof RangeError) return { ok: false, problem: "refused" };
      throw error;
    }
    const seal = this.#nextSeal++;
    this.#seals.set(seal, sealed);
    return { ok: true, seal, trackingCode: Uint8Array.from(sealed.trackingCode) };
  }

  /** The opening of a seal this worker holds; the seal is spent, so it is never cast (T-42, T-45). */
  challenge(request: ChallengeRequest): ChallengeResult {
    const sealed = this.#seals.get(request.seal);
    if (sealed === undefined) return { ok: false, problem: "unknown" };
    this.#seals.delete(request.seal);
    return { ok: true, ...challengeSealV3(sealed) };
  }
}
