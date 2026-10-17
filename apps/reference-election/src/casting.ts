// Stage 4 of the reference election, in part: Tier 0 voters, their ballots and
// a Benaloh challenge, each made in the order docs/spec/ballot-validity.md
// (Casting) gives a ballot client, through @abolishus/crypto's production
// entry points and the client's own Groth16 prover
// (@abolishus/membership-prover, run here in Node rather than in the ballot
// client's prover worker). Nothing here judges a ballot for the run: the
// verifier does, in a process of its own (stage 9). Each ballot is still
// checked by `checkBallot` before it is boarded, as Casting step 4 requires of
// a client, so a fault here stops the run at the ballot rather than showing up
// as a rejected entry.

import { readFileSync } from "node:fs";
import {
  type BallotElection,
  type BallotRecord,
  ballotCore,
  ballotElection,
  ballotHash,
  checkBallot,
  checkCeremonyTranscript,
  decodeMembershipProof,
  type ElectionDefinition,
  electionStubHash,
  encodeBallot,
  encodeOpening,
  encryptShares,
  finishMembershipProof,
  identityCommitment,
  membershipMessage,
  membershipProverInput,
  newIdentitySecret,
  openChallenge,
  type Panel,
  proveValidity,
  type RegisteredKeys,
  shareVote,
  tierTreeRoot,
  trackingCode,
} from "@abolishus/crypto";
import { type MembershipProverArtifacts, proveMembership } from "@abolishus/membership-prover";

const ARTIFACTS = new URL(
  "../../../packages/membership-prover/artifacts/snark-artifacts/",
  import.meta.url,
);

/** The vendored proving key and witness calculator; the prover checks both by sha256 before use. */
export function proverArtifacts(): MembershipProverArtifacts {
  return {
    zkey: readFileSync(new URL("semaphore-32.zkey", ARTIFACTS)),
    wasm: readFileSync(new URL("semaphore-32.wasm", ARTIFACTS)),
  };
}

/** Every ballot here is in the definition's one group, of Tier 0. */
const TIER = 0;

export interface Voter {
  readonly secret: Uint8Array;
  /** The secret's identity commitment: the voter's leaf in the tier tree. */
  readonly commitment: bigint;
}

export function newVoters(count: number): Voter[] {
  return Array.from({ length: count }, () => {
    const secret = newIdentitySecret();
    return { secret, commitment: identityCommitment(secret) };
  });
}

/** A Tier 0 group of voters, in tier-tree order: its leaves, its root and its size. */
export interface Electorate {
  readonly leaves: readonly bigint[];
  readonly root: bigint;
  readonly size: bigint;
}

export function electorateOf(voters: readonly Voter[]): Electorate {
  const leaves = voters.map((v) => v.commitment);
  return { leaves, root: tierTreeRoot(leaves), size: BigInt(leaves.length) };
}

/** What every ballot of one election is made against, derived as a client derives it. */
export interface Casting {
  readonly election: BallotElection;
  /** The key set the transcript check registered, in seat order. */
  readonly registered: readonly RegisteredKeys[];
  readonly electorate: Electorate;
  readonly artifacts: MembershipProverArtifacts;
}

/**
 * A client's context for `definition`: the key set its ceremony transcript
 * check registers, never a key list from elsewhere, so shares go only to the
 * seats the trustee registry recorded (T-37); and the tier's leaves, from
 * which every path is rebuilt on the device and checked against the
 * definition's root (T-10, T-13).
 */
export function castingFor(
  definition: ElectionDefinition,
  panel: Panel,
  transcript: Uint8Array,
  electorate: Electorate,
  artifacts: MembershipProverArtifacts,
): Casting {
  const check = checkCeremonyTranscript(
    {
      l2ChainId: definition.l2_chain_id,
      trusteeRegistry: definition.trustee_registry,
      electionId: definition.election_id,
      stubHash: electionStubHash(definition),
      panel,
    },
    transcript,
    1,
  );
  if (!check.ok) throw new Error(`the ceremony's transcript fails: ${check.code}`);
  // `ballotElection` takes only the key set this check returned, as returned.
  const { registered } = check;
  // A seat outside the registered key set would get no shares; every run
  // that casts here has every seat registered, so the fixture refuses
  // anything else rather than choose a key for one.
  if (registered.length !== definition.panel_size || registered.some((k, i) => k.index !== i + 1))
    throw new Error("the fixture casts only where every seat is registered");
  return {
    election: ballotElection(definition, registered),
    registered,
    electorate,
    artifacts,
  };
}

/** An L1 block a ballot names (docs/spec/revoting.md, Client rules 1 and 2). */
export interface L1Ref {
  readonly number: bigint;
  readonly hash: Uint8Array;
}

/**
 * Casting step 1: the vote's sharing and one ciphertext per seat, each under
 * its registered key, with all randomness from the CSPRNG.
 */
function sealVote(c: Casting, votes: readonly (0 | 1)[]) {
  const sharing = shareVote(c.election, votes);
  const encrypted = encryptShares(
    { definitionHash: c.election.definitionHash },
    sharing,
    c.registered.map((k) => k.kemKey),
  );
  return { sharing, encrypted };
}

/** A challenged attempt: the tracking code shown before the choice, and the opening handed over. */
export interface Challenge {
  readonly shown: Uint8Array;
  readonly opening: Uint8Array;
}

/**
 * A challenged attempt (docs/spec/challenge.md, Client rules): the core is
 * sealed and its tracking code shown, and instead of casting it the voter
 * has it opened. The opening reveals the vote and every registered seat's
 * encapsulation randomness, and crypto marks the sharing opened, so it can
 * never be cast (T-42, T-45).
 */
export function challengeVote(c: Casting, votes: readonly (0 | 1)[]): Challenge {
  const { encrypted } = sealVote(c, votes);
  const shown = trackingCode(c.election, TIER, encrypted);
  return { shown, opening: encodeOpening(openChallenge(c.election, TIER, encrypted).opening) };
}

/** A cast ballot: its record, for the controls to alter, and its encoding. */
export interface CastBallot {
  readonly record: BallotRecord;
  readonly bytes: Uint8Array;
}

/**
 * One ballot of `voter` for `votes`, naming `l1Ref`, in Casting's order:
 * the core (step 1), then, once the voter casts, the validity proofs binding
 * the nullifier, `ballot_hash` and `M` over the L1 reference (step 2), the
 * membership proof under the pinned key, finished (verified against signals
 * computed here, then re-randomised) by @abolishus/crypto (step 3), and the
 * admission checks on the finished record (step 4).
 */
export async function castVote(
  c: Casting,
  voter: Voter,
  votes: readonly (0 | 1)[],
  l1Ref: L1Ref,
): Promise<CastBallot> {
  const { definitionHash } = c.election;
  const group = c.election.tiers.find((g) => g.tier === TIER);
  if (group === undefined) throw new Error("the definition lists no Tier 0 group");
  const { sharing, encrypted } = sealVote(c, votes);
  const core = ballotCore(c.election, TIER, encrypted);
  // ν = Poseidon2(ŝ, s) doesn't depend on M (docs/spec/membership.md,
  // Statement), and the validity proofs must bind it before M exists. The
  // prover's input built under a placeholder message gives it, from crypto's
  // own derivation; the proof is made from a second input under the real M,
  // and `checkBallot` below confirms both name the same ν.
  const placeholder = { definitionHash, tier: TIER, root: group.root, message: new Uint8Array(32) };
  const { nullifier } = membershipProverInput(
    voter.secret,
    c.electorate.leaves,
    placeholder,
  ).signals;
  const ctx = { ...c.election, definitionHash, tier: TIER, nullifier };
  const vote = proveValidity(ctx, sharing, core.shareHashes);
  const message = membershipMessage({
    definitionHash,
    tier: TIER,
    ballotHash: ballotHash({ definitionHash, tier: TIER, nullifier }, vote),
    l1RefNumber: l1Ref.number,
    l1RefHash: l1Ref.hash,
  });
  const input = membershipProverInput(voter.secret, c.electorate.leaves, {
    definitionHash,
    tier: TIER,
    root: group.root,
    message,
  });
  const proof = finishMembershipProof(input, await proveMembership(input.witness, c.artifacts));
  const record: BallotRecord = {
    definition_hash: definitionHash,
    tier: TIER,
    nullifier,
    l1_ref_number: l1Ref.number,
    l1_ref_hash: l1Ref.hash,
    membership_proof: decodeMembershipProof(proof),
    committed_vote: vote,
  };
  const checked = checkBallot(c.election, record);
  if (!checked.ok) throw new Error(`an honest ballot fails admission: ${checked.code}`);
  return { record, bytes: encodeBallot(record) };
}
