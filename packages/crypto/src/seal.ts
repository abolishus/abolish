// The ballot client's sealing of a version-3 ballot (docs/spec/ballot-validity.md,
// Casting and Casting (version 3); docs/spec/challenge.md, Client rules): the
// one place the plaintext votes, their sharing and the encapsulation
// randomness live, so `apps/ballot` reaches them only through these calls
// (AGENTS.md, the verifier's trust base). A seal is the core, made before the
// voter chooses; it is then either challenged (its opening revealed, never
// cast) or cast (its validity proofs, then the membership proof's witness for
// the prover, then the finished record, checked by the admission checks
// before it may leave the device). Nothing here sends anything (T-42, T-45,
// T-47, T-55).

import {
  ballotHashV3,
  type CommittedVoteV3,
  proveValidityV3,
  shareVoteV3,
  type VoteSharing,
} from "./ballot-validity.ts";
import {
  type BallotRecordV3,
  type BallotV2Code,
  cellContextOf,
  checkBallotV3,
  encodeBallotV3,
  type QuestionBallotElection,
} from "./ballot.ts";
import {
  cellBallotCore,
  type CellBallotCore,
  cellCoreHash,
  encodeOpeningV2,
  openChallengeV2,
} from "./challenge.ts";
import { equalBytes } from "./nullifier-key.ts";
import { decodeMembershipProof } from "./membership-proof.ts";
import {
  finishMembershipProof,
  type MembershipProverInput,
  membershipProverInput,
  MembershipProverError,
  type MembershipWitness,
  secretScalar,
} from "./membership-prover.ts";
import { poseidon2 } from "./poseidon.ts";
import { membershipMessage } from "./revoting.ts";
import {
  type EncryptedShares,
  encryptShares,
  kemKeygen,
  type KemPublicKey,
} from "./share-encryption.ts";

/** A sealed core: what the client shows before the voter chooses to cast or to challenge. */
export interface SealedBallotV3 {
  /** The cell the voter's leaf is in. */
  readonly cell: number;
  /** The core's tracking code, always the full 32 bytes (T-42). */
  readonly trackingCode: Uint8Array;
}

/** The L1 block a cast names, read by the client itself (docs/spec/revoting.md, Client rules 1 to 3). */
export interface L1Reference {
  readonly number: bigint;
  readonly hash: Uint8Array;
}

/** A cast in progress: the witness for the prover's realm; everything else stays here. */
export interface BallotCastingV3 {
  readonly witness: MembershipWitness;
}

/** A finished ballot, admitted by the client's own run of the admission checks. */
export interface CastBallotV3 {
  /** The record's encoding, `0x0002` version 3, as it is boarded. */
  readonly ballot: Uint8Array;
  readonly ballotHash: Uint8Array;
  readonly nullifier: bigint;
  /** Each qualified seat's share ciphertext, for its intake (Casting step 5); no other seat has one. */
  readonly ciphertexts: readonly { readonly seat: number; readonly ciphertext: Uint8Array }[];
}

/**
 * The finished record failed the client's own admission checks (Casting step
 * 4): a fault on this device, and the record is never sent.
 */
export class BallotSealError extends Error {
  override readonly name = "BallotSealError";
  constructor(readonly code: BallotV2Code) {
    super(code);
  }
}

interface Seal {
  readonly election: QuestionBallotElection;
  readonly definitionHash: Uint8Array;
  readonly cell: number;
  readonly tier: number;
  readonly root: bigint;
  readonly scope: bigint;
  readonly encrypted: EncryptedShares;
  readonly sharing: VoteSharing;
  /** The core whose tracking code was shown; its share hashes are the ones proved over. */
  readonly core: CellBallotCore;
  readonly trackingCode: Uint8Array;
  readonly qualified: readonly number[];
  /** Set by the first cast: the challenge is then refused (the sharing is proved). */
  challenged: boolean;
  cast?: { readonly nullifier: bigint; readonly vote: CommittedVoteV3 };
}

const SEALS = new WeakMap<SealedBallotV3, Seal>();

interface Casting {
  readonly seal: Seal;
  readonly input: MembershipProverInput;
  readonly record: Omit<BallotRecordV3, "membership_proof">;
}

const CASTINGS = new WeakMap<BallotCastingV3, Casting>();

/**
 * Seals `votes` (0 or 1 per option, every question's options in order) in
 * `cell` of an election `questionBallotElection` made: the version-3 sharing,
 * each registered seat's shares encrypted to its registered key, and the
 * tracking code of the core (Casting (version 3), step 1; [[challenge]],
 * Client rules). A seat outside the registered key set has no ciphertext and
 * a zero share hash in the core; its shares are sealed to a key made here and
 * dropped, so they never reach anyone. All randomness is the CSPRNG's.
 * Throws if the votes break a question's limits or the cell isn't the
 * partition's.
 */
export function sealBallotV3(
  election: QuestionBallotElection,
  cell: number,
  votes: readonly (0 | 1)[],
): SealedBallotV3 {
  const { definitionHash, ballotVersion, keys } = cellContextOf(election);
  if (ballotVersion !== 3)
    throw new TypeError("sealBallotV3: expected a context made by questionBallotElection");
  const target = Number.isInteger(cell) ? election.cells[cell] : undefined;
  if (target === undefined) throw new RangeError("sealBallotV3: the partition has no such cell");
  const sharing = shareVoteV3(
    { questions: election.questions, threshold: election.threshold, panelSize: election.panelSize },
    votes,
  );
  const byIndex = new Map(keys.map((k) => [k.index, k.kemKey]));
  const seatKeys: KemPublicKey[] = [];
  for (let seat = 1; seat <= election.panelSize; seat++)
    seatKeys.push(byIndex.get(seat) ?? kemKeygen().publicKey);
  const encrypted = encryptShares({ definitionHash }, sharing, seatKeys);
  const core = cellBallotCore(election, cell, encrypted);
  const trackingCode = cellCoreHash(core);
  const sealed: SealedBallotV3 = Object.freeze({
    cell,
    trackingCode: Uint8Array.from(trackingCode),
  });
  SEALS.set(sealed, {
    election,
    definitionHash,
    cell,
    tier: target.tier,
    root: target.root,
    scope: target.scope,
    encrypted,
    sharing,
    core,
    trackingCode,
    qualified: Object.freeze([...byIndex.keys()].sort((a, b) => a - b)),
    challenged: false,
  });
  return sealed;
}

function sealOf(sealed: SealedBallotV3): Seal {
  const seal = SEALS.get(sealed);
  if (seal === undefined) throw new TypeError("expected a sealBallotV3 result");
  return seal;
}

/**
 * The voter challenged: the opening (`0x0003` version 2) of exactly the core
 * whose code was shown, for the voter's second device ([[challenge]], Client
 * rules). The seal is spent: it is never cast, and a seal already cast is
 * never opened (T-42, T-45). The voter's next attempt is a new seal.
 */
export function challengeSealV3(sealed: SealedBallotV3): {
  readonly opening: Uint8Array;
  readonly trackingCode: Uint8Array;
} {
  const seal = sealOf(sealed);
  if (seal.cast !== undefined)
    throw new TypeError("challengeSealV3: this seal was cast; it is never opened");
  const { opening, coreHash } = openChallengeV2(seal.election, seal.cell, seal.encrypted);
  seal.challenged = true;
  return { opening: encodeOpeningV2(opening), trackingCode: coreHash };
}

/**
 * The voter chose to cast (Casting step 2): the nullifier `Poseidon2(ŝ, s)`
 * under the cell's scope from the definition, the validity proofs binding it,
 * the ballot hash, `M` over `l1` and the prover's witness, built from
 * `leaves` (the cell tree's, in order, rebuilt on the device; T-10, T-13)
 * by `membershipProverInput`, which also refuses a secret, a non-member or
 * leaves that don't climb to the cell's root. Only the witness leaves for
 * the prover; finish with `finishSealV3`.
 *
 * Casting the same seal again (a retry after a failed proof, or a recast under
 * a new L1 block, revoting Client rule 4) keeps its first validity proofs, so
 * every record of one seal carries one committed vote; a different secret is
 * refused. Throws `MembershipProverError`.
 */
export function castSealV3(
  sealed: SealedBallotV3,
  secret: Uint8Array,
  leaves: Iterable<bigint>,
  l1: L1Reference,
): BallotCastingV3 {
  const seal = sealOf(sealed);
  if (seal.challenged)
    throw new TypeError("castSealV3: this seal was challenged; it is never cast");
  const { number: l1RefNumber, hash: l1RefHash } = l1;
  const nullifier = poseidon2(seal.scope, secretScalar(secret));
  if (seal.cast !== undefined && seal.cast.nullifier !== nullifier)
    throw new TypeError("castSealV3: this seal was cast with another identity");
  const vote =
    seal.cast?.vote ??
    proveValidityV3(
      {
        questions: seal.election.questions,
        threshold: seal.election.threshold,
        panelSize: seal.election.panelSize,
        definitionHash: seal.definitionHash,
        cell: seal.cell,
        nullifier,
      },
      seal.sharing,
      // The core's hashes: an unqualified seat's is zero, never its ciphertext's.
      seal.core.shareHashes,
    );
  seal.cast = { nullifier, vote };
  const ballotHash = ballotHashV3(
    { definitionHash: seal.definitionHash, cell: seal.cell, nullifier },
    vote,
  );
  const message = membershipMessage({
    definitionHash: seal.definitionHash,
    tier: seal.tier,
    ballotHash,
    l1RefNumber,
    l1RefHash,
  });
  const input = membershipProverInput(secret, leaves, {
    definitionHash: seal.definitionHash,
    tier: seal.tier,
    root: seal.root,
    message,
  });
  // The same scope and secret, so the same nullifier: a mismatch is a fault here.
  if (input.signals.nullifier !== nullifier) throw new MembershipProverError("secret");
  const casting: BallotCastingV3 = Object.freeze({ witness: input.witness });
  CASTINGS.set(casting, {
    seal,
    input,
    record: {
      definition_hash: Uint8Array.from(seal.definitionHash),
      cell: seal.cell,
      nullifier,
      l1_ref_number: l1RefNumber,
      l1_ref_hash: Uint8Array.from(l1RefHash),
      committed_vote: vote,
    },
  });
  return casting;
}

/**
 * The finished ballot from the prover's `proof` for `casting` (Casting steps
 * 3 and 4): the proof finished by `finishMembershipProof` (verified against
 * the signals computed here, re-randomised and verified again), the record
 * assembled, its core checked to be the one whose code was shown (Client
 * rule 3), and the record run through the admission checks
 * (`checkBallotV3`), so a record that fails is never returned. Throws
 * `MembershipProverError` (`proof`, `rerandomised`) or `BallotSealError`.
 */
export function finishSealV3(casting: BallotCastingV3, proof: Uint8Array): CastBallotV3 {
  const made = CASTINGS.get(casting);
  if (made === undefined) throw new TypeError("expected a castSealV3 result");
  const { seal, input, record: unproven } = made;
  const membership = finishMembershipProof(input, proof);
  const record: BallotRecordV3 = {
    ...unproven,
    membership_proof: decodeMembershipProof(membership),
  };
  const vote = record.committed_vote;
  const cast = cellCoreHash({
    definitionHash: seal.definitionHash,
    ballotVersion: 3,
    cell: seal.cell,
    vss: vote.vss,
    shareHashes: vote.share_hashes,
  });
  if (!equalBytes(cast, seal.trackingCode))
    throw new TypeError("finishSealV3: the cast core isn't the one shown");
  const checked = checkBallotV3(seal.election, record);
  if (!checked.ok) throw new BallotSealError(checked.code);
  return Object.freeze({
    ballot: encodeBallotV3(record),
    ballotHash: checked.ballotHash,
    nullifier: record.nullifier,
    ciphertexts: Object.freeze(
      seal.qualified.map((seat) =>
        Object.freeze({
          seat,
          ciphertext: Uint8Array.from(seal.encrypted.ciphertexts[seat - 1] as Uint8Array),
        }),
      ),
    ),
  });
}
