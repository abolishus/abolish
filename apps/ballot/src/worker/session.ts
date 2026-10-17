// What the ballot worker keeps between requests: the version-5 poll it last
// checked, as `sealingElectionV5` made it from the poll's ceremony
// transcript, and the seals made under it. A seal's votes, sharing and
// encryption randomness stay inside @abolishus/crypto's seal; the page gets
// a number to name it by and its tracking code, then either its opening
// (challenged, and spent) or its cast: the finished record, proved through
// the prover worker, after which the seal is never opened (T-42, T-45). A
// poll checked anew replaces the last one, and its seals go with it.

import {
  type BallotCastingV3,
  BallotSealError,
  castSealV3,
  challengeSealV3,
  decodeElectionDefinitionV5,
  finishSealV3,
  MembershipProverError,
  type QuestionBallotElection,
  sealBallotV3,
  type SealedBallotV3,
  sealingElectionV5,
} from "@abolishus/crypto";

import { checkElection, type ElectionCheck } from "../election.ts";
import { askProver } from "./prove.ts";
import {
  type CastRequest,
  type CastResult,
  type ChallengeRequest,
  type ChallengeResult,
  type CheckElectionRequest,
  PROVER_TIMEOUT_MS,
  type SealRequest,
  type SealResult,
} from "./protocol.ts";

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export class BallotSession {
  #poll: { readonly definitionHash: string; readonly election: QuestionBallotElection } | undefined;
  readonly #seals = new Map<number, SealedBallotV3>();
  /** Seals the voter chose to cast: never opened from then on, even if no cast finished (T-45). */
  readonly #cast = new Set<number>();
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
    this.#cast.clear();
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
    if (this.#cast.has(request.seal)) return { ok: false, problem: "cast" };
    this.#seals.delete(request.seal);
    return { ok: true, ...challengeSealV3(sealed) };
  }

  /**
   * The finished ballot for a seal the voter cast: `castSealV3` builds the
   * record and the witness here, the prover worker at `request.prover` gets
   * the witness alone, and `finishSealV3` verifies and re-randomises its
   * proof and runs the admission checks, so only a record this device
   * admitted reaches the page (Casting (version 3), steps 2 to 4; T-07,
   * T-12, T-55). The seal is marked cast before anything else, so no later
   * challenge opens it, whatever happens here (T-45).
   */
  async cast(request: CastRequest, timeoutMs = PROVER_TIMEOUT_MS): Promise<CastResult> {
    const { prover } = request;
    try {
      const sealed = this.#seals.get(request.seal);
      if (sealed === undefined) return { ok: false, problem: "unknown" };
      this.#cast.add(request.seal);
      let casting: BallotCastingV3;
      try {
        casting = castSealV3(sealed, request.secret, request.leaves, {
          number: request.l1Number,
          hash: request.l1Hash,
        });
      } catch (e) {
        // For a seal held here and never opened, the one TypeError left is a
        // recast under another identity's secret: that secret is refused.
        if (e instanceof TypeError) return { ok: false, problem: "secret" };
        throw e;
      } finally {
        // castSealV3 read its own copy; this realm's copy of the secret goes
        // now (T-12). The witness's decimal string can't be wiped.
        request.secret.fill(0);
      }
      const answer = await askProver(prover, casting.witness, timeoutMs);
      if (!answer.ok) return answer;
      const cast = finishSealV3(casting, answer.proof);
      return {
        ok: true,
        ballot: Uint8Array.from(cast.ballot),
        ballotHash: Uint8Array.from(cast.ballotHash),
        ciphertexts: cast.ciphertexts.map(({ seat, ciphertext }) => ({
          seat,
          ciphertext: Uint8Array.from(ciphertext),
        })),
      };
    } catch (e) {
      if (e instanceof MembershipProverError) return { ok: false, problem: e.code };
      if (e instanceof BallotSealError) return { ok: false, problem: "ballot", code: e.code };
      throw e;
    } finally {
      prover.close();
    }
  }
}
