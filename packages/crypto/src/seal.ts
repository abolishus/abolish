// The ballot client's sealing of a version-3 ballot (docs/spec/ballot-validity.md,
// Casting and Casting (version 3); docs/spec/challenge.md, Client rules): the
// one place the plaintext votes, their sharing and the encapsulation
// randomness live, so `apps/ballot` reaches them only through these calls
// (AGENTS.md, the verifier's trust base). A seal is the core, made before the
// voter chooses; it is then either challenged (its opening revealed, never
// cast) or cast (its validity proofs, then the membership proof's witness for
// the prover, then the finished record, checked by the admission checks
// before it may leave the device). Nothing here sends anything (T-42, T-45,
// T-47, T-55). What a seal is made under comes first: the poll's registered
// key set, from its ceremony transcript checked as the verifier checks it
// (T-37, T-54).

import { type BoardEntryVersion, decodeBoardEntry } from "./board.ts";
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
  questionBallotElection,
} from "./ballot.ts";
import {
  type CeremonyErrorCode,
  ceremonyTranscriptHash,
  checkCeremonyTranscript,
} from "./ceremony.ts";
import {
  cellBallotCore,
  type CellBallotCore,
  cellCoreHash,
  encodeOpeningV2,
  openChallengeV2,
} from "./challenge.ts";
import { DecodeError, type DecodeErrorCode } from "./codec.ts";
import type { ElectionDefinitionV5 } from "./election-definition.ts";
import { equalBytes } from "./nullifier-key.ts";
import { decodeMembershipProof, membershipVkHash } from "./membership-proof.ts";
import {
  finishMembershipProof,
  type MembershipProverInput,
  membershipProverInput,
  MembershipProverError,
  type MembershipWitness,
  secretScalar,
} from "./membership-prover.ts";
import { poseidon2 } from "./poseidon.ts";
import { electionStubV5Hash, pinnedVersion, profileCombinationRule } from "./protocol.ts";
import { RECORD_TYPES } from "./record.ts";
import { membershipMessage } from "./revoting.ts";
import {
  type EncryptedShares,
  encryptShares,
  kemKeygen,
  type KemPublicKey,
} from "./share-encryption.ts";
import { type Panel, panelId } from "./trustee.ts";

/**
 * Why no ballot of a version-5 poll can be sealed on this device: the first
 * check of `sealingElectionV5` that failed, under the verifier's names for
 * the same checks ([[verifier]] 1.3, 2.3, 2.5, 3.2).
 */
export type SealingElectionCode =
  /** It pins a profile 2.3 refuses. */
  | "profile-combination"
  /** It pins a board-entry or transcript version this release doesn't read. */
  | "unsupported-version"
  /** It names another membership key than the one this release proves under (1.3). */
  | "membership-key"
  /** A cell's root is 0, which anyone can prove membership of (T-04). */
  | "cell-root"
  /** The panel it names isn't one this release pins, with its threshold and size (2.5). */
  | "panel-unpinned"
  /** No entry given is the transcript the definition names. */
  | "ceremony-transcript-missing"
  /** The transcript the definition names doesn't decode. */
  | "ceremony-decode"
  /** It fails a transcript-level check, or too few seats qualified (3.1, 3.2). */
  | Exclude<CeremonyErrorCode, DecodeErrorCode>
  /** Fewer than `max(k, n − 1)` seats qualified (3.2; ADR 0006 rule 7). */
  | "ceremony-participation";

export type SealingElection =
  | { readonly ok: true; readonly election: QuestionBallotElection }
  | {
      readonly ok: false;
      readonly code: SealingElectionCode;
      /** The decoding error, for `ceremony-decode`. */
      readonly decodeError?: DecodeErrorCode;
    };

/**
 * The context ballots of a version-5 poll are sealed under
 * (`questionBallotElection`), from its definition, the panels this release
 * pins and board entries that may carry its ceremony transcript (each an
 * encoded entry, as `GET /board/entries` serves it; only an entry of this
 * election, under the pinned board-entry version, whose payload hashes to
 * `ceremony_transcript_hash` counts, wherever it sits). The checks are the
 * verifier's for an election whose ballots it admits, in its order: the
 * profile (2.3), the membership key (1.3), the pinned panel the definition
 * names with its threshold and size (2.5), and the transcript, checked under
 * a context rebuilt from the definition and that panel, never from the
 * transcript (3.1's transcript part), with quorum and participation
 * `max(k, n − 1)` (3.2). So a client seals only to the keys a ceremony of
 * this poll's pinned panel registered, and never to keys whoever served the
 * records chose (T-37, T-54, T-40). The caller has checked the definition
 * against the registry and run 2.1 (`checkElectionRecordToShow`); the L2
 * side of 3.1, the trustee registry's record of the ceremony, isn't read.
 */
export function sealingElectionV5(
  definition: ElectionDefinitionV5,
  panels: readonly Panel[],
  entries: readonly Uint8Array[],
): SealingElection {
  const refuse = (code: SealingElectionCode, decodeError?: DecodeErrorCode): SealingElection =>
    decodeError === undefined ? { ok: false, code } : { ok: false, code, decodeError };
  const combination = profileCombinationRule(definition);
  if (combination !== undefined) return refuse(combination);
  if (!equalBytes(definition.membership_vk_hash, membershipVkHash()))
    return refuse("membership-key");
  if (definition.electorate.some((t) => t.cells.some((c) => c.root === 0n)))
    return refuse("cell-root");
  // The transcript's context binds the panel's identifier, so any other
  // panel would only fail its signatures; the threshold and size must be
  // the definition's too, or its sharing wouldn't be the panel's (2.5).
  const panel = panels.find(
    (p) =>
      equalBytes(panelId(p), definition.panel_id) &&
      p.threshold === definition.threshold &&
      p.keys.length === definition.panel_size,
  );
  if (panel === undefined) return refuse("panel-unpinned");
  if (pinnedVersion(definition, RECORD_TYPES.ceremonyTranscript) !== 1)
    return refuse("unsupported-version");
  // profileCombinationRule refused a board-entry version this release
  // doesn't have.
  const boardEntryVersion = pinnedVersion(definition, RECORD_TYPES.boardEntry) as BoardEntryVersion;
  const transcript = entries
    .map((encoded) => payloadOf(encoded, boardEntryVersion, definition.election_id))
    .find(
      (payload) =>
        payload !== undefined &&
        equalBytes(ceremonyTranscriptHash(payload), definition.ceremony_transcript_hash),
    );
  if (transcript === undefined) return refuse("ceremony-transcript-missing");
  const checked = checkCeremonyTranscript(
    {
      l2ChainId: definition.l2_chain_id,
      trusteeRegistry: definition.trustee_registry,
      electionId: definition.election_id,
      stubHash: electionStubV5Hash(definition),
      panel,
    },
    transcript,
    1,
  );
  if (!checked.ok)
    return TRANSCRIPT_CODES.has(checked.code)
      ? refuse(checked.code as Exclude<CeremonyErrorCode, DecodeErrorCode>)
      : refuse("ceremony-decode", checked.code as DecodeErrorCode);
  // ADR 0006 rule 7: a coordinator can't shrink the qualified set to `k`,
  // and the tally's failure margin with it (T-54, T-40).
  if (checked.registered.length < Math.max(panel.threshold, panel.keys.length - 1))
    return refuse("ceremony-participation");
  return { ok: true, election: questionBallotElection(definition, checked.registered) };
}

const TRANSCRIPT_CODES: ReadonlySet<string> = new Set<CeremonyErrorCode>([
  "ceremony-order",
  "ceremony-shape",
  "ceremony-signature",
  "ceremony-quorum",
]);

/** An entry's payload if it is an entry of `electionId` under `version`; `undefined` otherwise. */
function payloadOf(
  encoded: Uint8Array,
  version: BoardEntryVersion,
  electionId: Uint8Array,
): Uint8Array | undefined {
  try {
    const entry = decodeBoardEntry(encoded, version);
    return equalBytes(entry.election_id, electionId) ? entry.payload : undefined;
  } catch (e) {
    // An entry that doesn't decode carries no transcript.
    if (e instanceof DecodeError) return undefined;
    throw e;
  }
}

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
  /**
   * The sharing and the shares' encryption, with every polynomial and
   * encapsulation: dropped once a cast's validity proofs and witness are made,
   * since a recast needs only the committed vote and a cast's randomness is
   * erased (docs/spec/challenge.md, Client rules; T-18, T-45).
   */
  secrets?: { readonly sharing: VoteSharing; readonly encrypted: EncryptedShares };
  /** The core whose tracking code was shown; its share hashes are the ones proved over. */
  readonly core: CellBallotCore;
  readonly trackingCode: Uint8Array;
  /** Each qualified seat's share ciphertext, which is public once delivered. */
  readonly ciphertexts: readonly { readonly seat: number; readonly ciphertext: Uint8Array }[];
  challenged: boolean;
  /** Set when validity is first proved: the voter chose to cast, so the seal is never opened. */
  proved: boolean;
  /** Set once a cast's witness is made: the seal is then never opened. */
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
  const qualified = [...byIndex.keys()].sort((a, b) => a - b);
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
    secrets: { sharing, encrypted },
    core,
    trackingCode,
    ciphertexts: Object.freeze(
      qualified.map((seat) =>
        Object.freeze({
          seat,
          ciphertext: Uint8Array.from(encrypted.ciphertexts[seat - 1] as Uint8Array),
        }),
      ),
    ),
    challenged: false,
    proved: false,
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
  if (seal.proved || seal.secrets === undefined)
    throw new TypeError("challengeSealV3: this seal was cast; it is never opened");
  if (seal.challenged) throw new TypeError("challengeSealV3: this seal was already opened");
  // Spent before the opening is made: a throw below still leaves it uncastable.
  seal.challenged = true;
  const { opening, coreHash } = openChallengeV2(seal.election, seal.cell, seal.secrets.encrypted);
  if (!equalBytes(coreHash, seal.trackingCode))
    throw new TypeError("challengeSealV3: the opened core isn't the one shown");
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
 * The seal is marked cast, and its sharing and encapsulation randomness
 * dropped, only once the witness is made, so a refused secret or bad leaves
 * leave it as it was. Casting it again (a proof that failed before any
 * record existed, or a recast under a newer L1 block, revoting Client rule 4)
 * keeps its first validity proofs, so every record of one seal carries one
 * committed vote; a different secret is refused. A retry of a record already
 * sent resends that record's bytes (Casting: a retry sends the identical
 * record), never a new cast. Throws `MembershipProverError`, or `RangeError`
 * for an L1 reference that isn't a u64 and 32 bytes.
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
  if (typeof l1RefNumber !== "bigint" || l1RefNumber < 0n || l1RefNumber >> 64n !== 0n)
    throw new RangeError("castSealV3: the L1 block number isn't a u64");
  if (!(l1RefHash instanceof Uint8Array) || l1RefHash.length !== 32)
    throw new RangeError("castSealV3: the L1 block hash isn't 32 bytes");
  const nullifier = poseidon2(seal.scope, secretScalar(secret));
  if (seal.cast !== undefined && seal.cast.nullifier !== nullifier)
    throw new TypeError("castSealV3: this seal was cast with another identity");
  const { secrets } = seal;
  // A first cast proves validity again if an earlier attempt was refused
  // before its witness (fresh nonces over the same core; nothing left the device).
  if (seal.cast === undefined) seal.proved = true;
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
      // Dropped only when `cast` is set, so a seal not yet cast still holds it.
      (secrets as NonNullable<typeof secrets>).sharing,
      // The core's hashes: an unqualified seat's is zero, never its ciphertext's.
      seal.core.shareHashes,
    );
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
  if (seal.cast === undefined) {
    seal.cast = { nullifier, vote };
    // Erased as far as the platform allows: the ML-KEM messages' bytes are
    // zeroed, and the polynomials and scalars (immutable bigints) dropped.
    for (const { m } of secrets?.encrypted.randomness ?? []) m.fill(0);
    delete seal.secrets;
  }
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
      seal.ciphertexts.map(({ seat, ciphertext }) =>
        Object.freeze({ seat, ciphertext: Uint8Array.from(ciphertext) }),
      ),
    ),
  });
}
