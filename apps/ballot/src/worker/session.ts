// What the ballot worker keeps between requests: the version-5 poll it last
// checked, as `sealingElectionV5` made it from the poll's ceremony
// transcript, the voter's cell in it as `voterCellV5` rebuilt it from the
// board, and the seals made under it. A seal's votes, sharing and
// encryption randomness stay inside @abolishus/crypto's seal; the page gets
// a number to name it by and its tracking code, then either its opening
// (challenged, and spent) or its cast: the finished record, proved through
// the prover worker, after which the seal is never opened (T-42, T-45). A
// poll checked anew replaces the last one, and its seals go with it.

import {
  BallotSealError,
  castSealV3,
  challengeSealV3,
  type ContractEventRecord,
  decodeContractEvent,
  DecodeError,
  decodeElectionDefinitionV5,
  type ElectionDefinitionV5,
  finishSealV3,
  identityCommitment,
  isForbiddenCommitment,
  MembershipProverError,
  type QuestionBallotElection,
  sealBallotV3,
  type SealedBallotV3,
  sealingElectionV5,
  tier0Registration,
  TierMembershipError,
  voterCellV5,
} from "@abolishus/crypto";

import { checkElection, type ElectionCheck } from "../election.ts";
import { askProver } from "./prove.ts";
import {
  type CastRequest,
  type CastResult,
  type ChallengeRequest,
  type ChallengeResult,
  type CheckElectionRequest,
  type CommitmentRequest,
  type CommitmentResult,
  type FindCellRequest,
  type FindCellResult,
  PROVER_TIMEOUT_MS,
  type SealRequest,
  type SealResult,
  type Tier0OutcomeRequest,
  type Tier0OutcomeResult,
} from "./protocol.ts";

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export class BallotSession {
  #poll:
    | {
        readonly definitionHash: string;
        readonly definition: ElectionDefinitionV5;
        readonly election: QuestionBallotElection;
      }
    | undefined;
  /** The voter's cell in the poll, found by `findCell`: what `cast` proves with. */
  #voter:
    | { readonly commitment: bigint; readonly cell: number; readonly leaves: Iterable<bigint> }
    | undefined;
  readonly #seals = new Map<number, SealedBallotV3>();
  /**
   * Seals the voter chose to cast, never opened from then on even if no cast
   * finished (T-45), each with the identity commitment of its first cast's
   * secret once one was accepted: a recast under another is refused.
   */
  readonly #cast = new Map<number, bigint | undefined>();
  #nextSeal = 0;

  /**
   * The election check (election.ts), then for a version-5 poll the check
   * of its ceremony transcript under the panel it names, so a poll is shown
   * only if this device can seal to the keys its ceremony registered, never
   * to keys whoever served the records chose (T-37, T-54).
   */
  checkElection(request: CheckElectionRequest): ElectionCheck {
    this.#poll = undefined;
    this.#voter = undefined;
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
    this.#poll = {
      definitionHash: check.election.definitionHash,
      definition,
      election: sealing.election,
    };
    return check;
  }

  /**
   * The identity commitment of `request.secret`, for a Tier 0 registration
   * ([[registration]], Request). It leaves the held poll, voter and seals as
   * they were: registering needs none of them.
   */
  commitment(request: CommitmentRequest): CommitmentResult {
    const { secret } = request;
    try {
      return { ok: true, commitment: identityCommitment(secret) };
    } catch (e) {
      if (e instanceof MembershipProverError) return { ok: false, problem: "secret" };
      throw e;
    } finally {
      secret.fill(0);
    }
  }

  /**
   * Where the identity commitment of `request.secret` stands among the
   * published Tier 0 groups, from the group registry's whole log
   * (`tier0Registration`; [[registration]], Outcome). Each record is decoded
   * strictly under the pinned version first, so the replay reads only
   * canonical contract-event records (T-31). Like `commitment`, it needs no
   * poll and leaves the held one, the voter and the seals as they were.
   */
  tier0Outcome(request: Tier0OutcomeRequest): Tier0OutcomeResult {
    const { secret } = request;
    try {
      let commitment: bigint;
      try {
        commitment = identityCommitment(secret);
      } catch (e) {
        if (e instanceof MembershipProverError) return { ok: false, problem: "secret" };
        throw e;
      }
      // The commitment is all the replay needs (T-12).
      secret.fill(0);
      // No secret is known to commit to a forbidden value, but
      // `tier0Registration` would throw for one, a worker failure rather
      // than the refusal it is.
      if (isForbiddenCommitment(commitment)) return { ok: false, problem: "secret" };
      const records: ContractEventRecord[] = [];
      for (const bytes of request.records) {
        try {
          records.push(decodeContractEvent(bytes, request.version));
        } catch (e) {
          if (e instanceof DecodeError) return { ok: false, problem: "record" };
          throw e;
        }
      }
      const outcome = tier0Registration(
        records,
        { block: request.block, groups: request.groups },
        commitment,
        request.region,
        {
          version: request.version,
          chainId: request.chainId,
          registry: request.registry,
          registrars: request.registrars,
          threshold: request.threshold,
        },
      );
      return { ok: true, outcome };
    } catch (e) {
      if (e instanceof TierMembershipError) return { ok: false, problem: "registry", code: e.code };
      throw e;
    } finally {
      secret.fill(0);
    }
  }

  /**
   * The voter's cell in the held poll, rebuilt from the whole board for the
   * identity commitment of `request.secret` (`voterCellV5`; T-10, T-13). The
   * leaves stay here for `cast`, so the page never supplies them; a later
   * call replaces the voter, and a refused one leaves none.
   */
  findCell(request: FindCellRequest): FindCellResult {
    const { secret } = request;
    try {
      this.#voter = undefined;
      const poll = this.#poll;
      if (poll === undefined || poll.definitionHash !== toHex(request.definitionHash))
        return { ok: false, problem: "no-election" };
      const commitment = identityCommitment(secret);
      // The commitment is all the search needs (T-12).
      secret.fill(0);
      const found = voterCellV5(
        poll.definition,
        request.entries,
        { commitment, tier: request.tier, group: request.group },
        { registrars: request.registrars, threshold: request.threshold },
      );
      if (!found.ok) return { ok: false, problem: "cell", code: found.code };
      this.#voter = { commitment, cell: found.cell, leaves: found.leaves };
      return { ok: true, cell: found.cell };
    } catch (e) {
      if (e instanceof MembershipProverError) return { ok: false, problem: "secret" };
      throw e;
    } finally {
      secret.fill(0);
    }
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
   * record and the witness here, over the leaves `findCell` kept for the
   * seal's cell and the identity it was given, the prover worker at `request.prover` gets
   * the witness alone, and `finishSealV3` verifies and re-randomises its
   * proof and runs the admission checks, so only a record this device
   * admitted reaches the page (Casting (version 3), steps 2 to 4; T-07,
   * T-12, T-55). The seal is marked cast before anything else, so no later
   * challenge opens it, whatever happens here (T-45).
   */
  async cast(request: CastRequest, timeoutMs = PROVER_TIMEOUT_MS): Promise<CastResult> {
    const { prover, secret } = request;
    try {
      const sealed = this.#seals.get(request.seal);
      if (sealed === undefined) return { ok: false, problem: "unknown" };
      const first = this.#cast.get(request.seal);
      this.#cast.set(request.seal, first);
      const voter = this.#voter;
      if (voter === undefined || voter.cell !== sealed.cell)
        return { ok: false, problem: "no-cell" };
      // One seal, one identity: its records all carry one nullifier.
      const commitment = identityCommitment(secret);
      if (commitment !== voter.commitment || (first !== undefined && first !== commitment))
        return { ok: false, problem: "secret" };
      const casting = castSealV3(sealed, secret, voter.leaves, {
        number: request.l1Number,
        hash: request.l1Hash,
      });
      this.#cast.set(request.seal, commitment);
      // castSealV3 read its own copy; this realm's copy of the secret goes
      // now (T-12). The witness's decimal string can't be wiped.
      secret.fill(0);
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
      secret.fill(0);
      prover.close();
    }
  }
}
