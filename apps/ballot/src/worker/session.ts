// What the ballot worker keeps between requests: the version-5 poll it last
// checked, as `sealingElectionV5` made it from the poll's ceremony
// transcript, the voter's cell in it as `voterCellV5` rebuilt it from the
// board, and the seals made under it. A seal's votes, sharing and
// encryption randomness stay inside @abolishus/crypto's seal; the page gets
// a number to name it by and its tracking code, then either its opening
// (challenged, and spent) or its cast: the finished record, proved through
// the prover worker, after which the seal is never opened (T-42, T-45). A
// poll checked anew replaces the last one, and its seals go with it. Apart
// from the poll, a recovery's PRF output waits here between finding the
// backup's locator and opening its envelope, so the page zeroes its copy
// as soon as the ceremony gives it; the recovery's own worker is
// terminated after, taking it along if no open came (T-41).

import {
  BallotSealError,
  castPostingRecordV3,
  type CastPostingRecordResult,
  castReceiptSeatV3,
  castSealV3,
  challengeSealV3,
  type ContractEventRecord,
  decodeBallot,
  decodeContractEvent,
  DecodeError,
  declineSealV3,
  decodeElectionDefinitionV5,
  type ElectionDefinitionV5,
  encodeElectionStubV5,
  finishSealV3,
  identityBackupLocator,
  IdentityBackupError,
  identityCommitment,
  isForbiddenCommitment,
  isIdentitySecret,
  MembershipProverError,
  openIdentityBackup,
  type QuestionBallotElection,
  receiptSealV3,
  sealBallotV3,
  type SealedBallotV3,
  sealIdentityBackup,
  sealingElectionV5,
  tier0Registration,
  TierMembershipError,
  voterCellV5,
} from "@abolishus/crypto";

import { checkElection, type ElectionCheck } from "../election.ts";
import { askProver } from "./prove.ts";
import {
  type BackupLocatorRequest,
  type BackupLocatorResult,
  type BackupOpenRequest,
  type BackupOpenResult,
  type BackupSealRequest,
  type BackupSealResult,
  type CastRequest,
  type CastResult,
  type ChallengeRequest,
  type ChallengeResult,
  type CheckElectionRequest,
  type CommitmentRequest,
  type CommitmentResult,
  type FindCellRequest,
  type FindCellResult,
  type IntakeRequest,
  type IntakeResult,
  type DeclineRequest,
  type DeclineResult,
  type PostingRequest,
  type PostingResult,
  PROVER_TIMEOUT_MS,
  type ReceiptRequest,
  type ReceiptResult,
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
        /** The ceremony transcript `election`'s keys came from, for each seat's intake. */
        readonly transcript: Uint8Array;
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
   * The PRF output the last `backupLocator` was given, for the one
   * `backupOpen` after it; a recovery that stops in between leaves it here
   * until the worker ends, so a recovery runs in a worker of its own,
   * terminated once it is done (T-41).
   */
  #backupPrf: Uint8Array | undefined;

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
      transcript: sealing.transcript,
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
   * `request.secret` sealed for the backup passkey whose PRF output is
   * `request.prf` ([[identity-backup]], Sealing), with a fresh nonce. Both
   * are zeroed whatever the outcome; `sealIdentityBackup` zeroes its own
   * copies and the wrap key (T-41). Like `commitment`, it needs no poll and
   * leaves the held one, the voter and the seals as they were.
   */
  backupSeal(request: BackupSealRequest): BackupSealResult {
    const { prf, secret } = request;
    try {
      if (!isIdentitySecret(secret)) return { ok: false, problem: "secret" };
      const { locator, envelope } = sealIdentityBackup(prf, secret);
      return { ok: true, locator, envelope };
    } finally {
      prf.fill(0);
      secret.fill(0);
    }
  }

  /**
   * The locator of `request.prf` ([[identity-backup]], Keys), for the page
   * to fetch the envelope under. The worker keeps a copy of the PRF output
   * for the `backupOpen` that follows, in place of any earlier one, and
   * zeroes the request's (T-41). Like `commitment`, it needs no poll.
   */
  backupLocator(request: BackupLocatorRequest): BackupLocatorResult {
    const { prf } = request;
    try {
      this.#backupPrf?.fill(0);
      this.#backupPrf = prf.slice();
      return { locator: identityBackupLocator(prf) };
    } finally {
      prf.fill(0);
    }
  }

  /**
   * Opens `request.envelope` under the PRF output `backupLocator` kept,
   * zeroed whatever the outcome so each passkey evaluation opens at most
   * once, and finds the published Tier 0 group counting the commitment of
   * the secret inside, from the group registry's whole log
   * (`tier0Registration`; [[0017-identity-recovery-backup]], Option A, step
   * 6; T-11, T-18). The secret is returned only once it is found there:
   * a secret in no group (an old envelope, a registration that never
   * landed) is zeroed here, never kept by the page. Like `commitment`, it
   * needs no poll and leaves the held one, the voter and the seals as they
   * were.
   */
  backupOpen(request: BackupOpenRequest): BackupOpenResult {
    const prf = this.#backupPrf;
    this.#backupPrf = undefined;
    if (prf === undefined) return { ok: false, problem: "no-passkey" };
    let secret: Uint8Array;
    try {
      secret = openIdentityBackup(prf, request.envelope);
    } catch (e) {
      if (e instanceof DecodeError) return { ok: false, problem: "envelope" };
      if (e instanceof IdentityBackupError)
        return { ok: false, problem: e.code === "backup-open" ? "open" : "secret" };
      throw e;
    } finally {
      prf.fill(0);
    }
    let found = false;
    try {
      let commitment: bigint;
      try {
        commitment = identityCommitment(secret);
      } catch (e) {
        if (e instanceof MembershipProverError) return { ok: false, problem: "secret" };
        throw e;
      }
      if (isForbiddenCommitment(commitment)) return { ok: false, problem: "secret" };
      const { groups } = request;
      const asked = groups.at(-1);
      if (asked === undefined) return { ok: false, problem: "not-registered" };
      const records: ContractEventRecord[] = [];
      for (const bytes of request.records) {
        try {
          records.push(decodeContractEvent(bytes, request.version));
        } catch (e) {
          if (e instanceof DecodeError) return { ok: false, problem: "record" };
          throw e;
        }
      }
      // The region the identity asked for is lost with the old device, so
      // any served region will do (the last listed group's): `registered`
      // and `moved` alike name the one group the first-occurrence rule
      // counts the commitment in.
      const outcome = tier0Registration(
        records,
        { block: request.block, groups },
        commitment,
        asked.region,
        {
          version: request.version,
          chainId: request.chainId,
          registry: request.registry,
          registrars: request.registrars,
          threshold: request.threshold,
        },
      );
      if (outcome.kind === "not-yet") return { ok: false, problem: "not-registered" };
      const home = groups.find((g) => g.group_id === outcome.group);
      // `tier0Registration` names only a listed group.
      if (home === undefined) throw new Error("the counted group isn't listed");
      found = true;
      return { ok: true, secret, group: home.group_id, region: home.region };
    } catch (e) {
      if (e instanceof TierMembershipError) return { ok: false, problem: "registry", code: e.code };
      throw e;
    } finally {
      if (!found) secret.fill(0);
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
        // A seat whose receipt passed here has no `m` left to copy.
        ciphertexts: cast.ciphertexts.map(({ seat, ciphertext, m }) =>
          m === undefined
            ? { seat, ciphertext: Uint8Array.from(ciphertext) }
            : { seat, ciphertext: Uint8Array.from(ciphertext), m: Uint8Array.from(m) },
        ),
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

  /**
   * The seat `request.receipt` receipts `request.ballot` for, checked under
   * the signing keys the held poll's ceremony registered (`castReceiptSeatV3`;
   * [[delivery]], Client rule 1). A ballot that isn't a version-3 record of
   * the held poll is `unknown`: the page asked about another poll's cast.
   * A pass also erases that seat's `m_i` from the seal this worker cast the
   * ballot from, if it still holds it (`receiptSealV3`), so a recast hands
   * none to the page (Client rule 2; T-18).
   */
  receipt(request: ReceiptRequest): ReceiptResult {
    const poll = this.#poll;
    if (poll === undefined) return { ok: false, problem: "unknown" };
    let seat: number | undefined;
    try {
      seat = castReceiptSeatV3(poll.election, request.ballot, request.receipt);
    } catch (e) {
      if (e instanceof DecodeError || e instanceof TypeError)
        return { ok: false, problem: "unknown" };
      throw e;
    }
    if (seat === undefined) return { ok: false, problem: "refused" };
    // Every seal given a witness here is cast; the ballot names at most one.
    for (const [id, commitment] of this.#cast) {
      const sealed = this.#seals.get(id);
      if (commitment === undefined || sealed === undefined) continue;
      if (receiptSealV3(sealed, request.ballot, request.receipt) !== undefined) break;
    }
    return { ok: true, seat };
  }

  /**
   * The held poll's stub and ceremony transcript, as each seat's intake
   * takes them beside a ballot ([[delivery]], Client rule 4): the
   * transcript `sealingElectionV5` checked, so a delivery names the keys its
   * shares were sealed to (T-37). Copies, so nothing the page does to them
   * reaches the poll held here.
   */
  intake(request: IntakeRequest): IntakeResult {
    const poll = this.#poll;
    if (poll === undefined || poll.definitionHash !== toHex(request.definitionHash))
      return { ok: false, problem: "no-election" };
    return {
      ok: true,
      stub: encodeElectionStubV5(poll.definition),
      transcript: poll.transcript.slice(),
    };
  }

  /**
   * Whether the share the page kept for `request.seat` of `request.ballot`
   * passes the public check of a posting under that seat's key in the held
   * poll's registered key set, with the posting record that would deliver
   * it (`castPostingRecordV3`; [[delivery]], Client rule 4). A ballot that isn't a version-3 record of the held poll, or a
   * seat outside its panel, is `unknown`. This realm's copy of `m` is zeroed
   * once judged: the page keeps its own until the seat is receipted or the
   * voter decides (T-18).
   */
  posting(request: PostingRequest): PostingResult {
    const { ballot, seat, ciphertext, m } = request;
    try {
      const poll = this.#poll;
      if (poll === undefined) return { ok: false, problem: "unknown" };
      let verdict: CastPostingRecordResult;
      try {
        verdict = castPostingRecordV3(poll.election, ballot, seat, { ciphertext, m });
      } catch (e) {
        if (e instanceof DecodeError || e instanceof TypeError || e instanceof RangeError)
          return { ok: false, problem: "unknown" };
        throw e;
      }
      return verdict.ok
        ? { ok: true, record: verdict.record }
        : { ok: false, problem: "refused", code: verdict.code };
    } finally {
      m.fill(0);
    }
  }

  /**
   * The voter declined to post the unreceipted seats of `request.ballot`, a
   * cast of the held poll: every seal this worker cast for it has each
   * `m_i` it still keeps zeroed and dropped (`declineSealV3`; [[delivery]],
   * Client rule 4), so no recast hands one to the page and none stays in
   * this realm (T-18). A ballot that isn't a version-3 record of the held
   * poll is `unknown`; a cast this worker never made erases nothing here.
   */
  decline(request: DeclineRequest): DeclineResult {
    const poll = this.#poll;
    if (poll === undefined) return { ok: false, problem: "unknown" };
    try {
      if (toHex(decodeBallot(request.ballot, 3).definition_hash) !== poll.definitionHash)
        return { ok: false, problem: "unknown" };
    } catch (e) {
      if (e instanceof DecodeError) return { ok: false, problem: "unknown" };
      throw e;
    }
    for (const [id, commitment] of this.#cast) {
      const sealed = this.#seals.get(id);
      if (commitment === undefined || sealed === undefined) continue;
      declineSealV3(sealed, request.ballot);
    }
    return { ok: true };
  }
}
