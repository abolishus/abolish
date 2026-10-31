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
  type BallotRecordV5,
  ballotCore,
  ballotElection,
  ballotHash,
  ballotHashV5,
  type CastBallotV3,
  castSealV3,
  challengeSealV3,
  checkBallot,
  checkBallotV5,
  checkCeremonyTranscript,
  decodeMembershipProof,
  type ElectionDefinition,
  type ElectionDefinitionV5,
  type ElectionDefinitionV7,
  electionStubHash,
  electionStubV5Hash,
  electionStubV7Hash,
  encodeBallot,
  encodeBallotV5,
  encodeOpening,
  encryptShares,
  encryptSharesV4,
  finishMembershipProof,
  finishSealV3,
  identityCommitment,
  membershipMessage,
  membershipProverInput,
  newIdentitySecret,
  openChallenge,
  type Panel,
  proveValidity,
  proveValidityV5,
  type QuestionBallotElection,
  questionBallotElection,
  type RegisteredKeys,
  rollingBallotElection,
  type RollingBallotChain,
  type RollingBallotElection,
  rollingMembershipNullifier,
  rollingMembershipProverInput,
  RollingTierTree,
  sealBallotV3,
  shareVote,
  shareVoteV4,
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
 * The key set `transcript`'s check registers for a definition with
 * `stubHash`, never a key list from elsewhere, so shares go only to the
 * seats the trustee registry recorded (T-37). A seat outside the registered
 * key set would get no shares; every run that casts here has every seat
 * registered, so the fixture refuses anything else rather than choose a key
 * for one.
 */
function registeredKeys(
  definition: Pick<
    ElectionDefinition,
    "l2_chain_id" | "trustee_registry" | "election_id" | "panel_size"
  >,
  stubHash: Uint8Array,
  panel: Panel,
  transcript: Uint8Array,
): readonly RegisteredKeys[] {
  const check = checkCeremonyTranscript(
    {
      l2ChainId: definition.l2_chain_id,
      trusteeRegistry: definition.trustee_registry,
      electionId: definition.election_id,
      stubHash,
      panel,
    },
    transcript,
    1,
  );
  if (!check.ok) throw new Error(`the ceremony's transcript fails: ${check.code}`);
  const { registered } = check;
  if (registered.length !== definition.panel_size || registered.some((k, i) => k.index !== i + 1))
    throw new Error("the fixture casts only where every seat is registered");
  return registered;
}

/**
 * A client's context for `definition`: the key set its ceremony transcript
 * check registers (T-37); and the tier's leaves, from which every path is
 * rebuilt on the device and checked against the definition's root (T-10,
 * T-13).
 */
export function castingFor(
  definition: ElectionDefinition,
  panel: Panel,
  transcript: Uint8Array,
  electorate: Electorate,
  artifacts: MembershipProverArtifacts,
): Casting {
  const registered = registeredKeys(definition, electionStubHash(definition), panel, transcript);
  // `ballotElection` takes only the key set the check returned, as returned.
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
  /** Each seat's share ciphertext, in seat order, for its intake (Casting step 5). */
  readonly ciphertexts: readonly Uint8Array[];
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
  return { record, bytes: encodeBallot(record), ciphertexts: encrypted.ciphertexts };
}

/** What every ballot of a version-5 poll is made against, derived as a client derives it. */
export interface QuestionCasting {
  readonly election: QuestionBallotElection;
  /** The key set the transcript check registered, in seat order. */
  readonly registered: readonly RegisteredKeys[];
  /** The one cell's leaves, in cell-tree order. */
  readonly leaves: readonly bigint[];
  readonly artifacts: MembershipProverArtifacts;
}

/**
 * `castingFor` for a version-5 definition (ballot version 3): the cells and
 * the questions' limits from the definition, which `questionBallotElection`
 * checks well-formed, and the key set the transcript check registered (T-37).
 */
export function questionCastingFor(
  definition: ElectionDefinitionV5,
  panel: Panel,
  transcript: Uint8Array,
  leaves: readonly bigint[],
  artifacts: MembershipProverArtifacts,
): QuestionCasting {
  const registered = registeredKeys(definition, electionStubV5Hash(definition), panel, transcript);
  return {
    election: questionBallotElection(definition, registered),
    registered,
    leaves,
    artifacts,
  };
}

/** The poll's one cell: every voter here is in the definition's one Tier 0 group. */
const CELL = 0;

/**
 * A challenged attempt at a version-3 ballot ([[challenge]], Client rules):
 * the core is sealed and its tracking code shown, then opened (`0x0003`
 * version 2) instead of cast; crypto spends the seal, so it can never be
 * cast (T-42, T-45).
 */
export function challengeQuestions(c: QuestionCasting, votes: readonly (0 | 1)[]): Challenge {
  const sealed = sealBallotV3(c.election, CELL, votes);
  // challengeSealV3 refuses to open any core but the one whose code was shown.
  return { shown: sealed.trackingCode, opening: challengeSealV3(sealed).opening };
}

/**
 * One version-3 ballot of `voter` for `votes` (each question's options in
 * order), naming `l1Ref`, through the ballot client's seal (Casting (version
 * 3)): the core, then the validity proofs, the nullifier under the cell's
 * scope and the witness built from the cell's leaves (T-10, T-13), proved by
 * the client's prover, and finished by `finishSealV3`, which verifies and
 * re-randomises the proof and runs the admission checks before returning
 * the record (Casting step 4; T-07, T-12), with each seat's share ciphertext.
 */
export async function castQuestions(
  c: QuestionCasting,
  voter: Voter,
  votes: readonly (0 | 1)[],
  l1Ref: L1Ref,
): Promise<CastBallotV3> {
  const sealed = sealBallotV3(c.election, CELL, votes);
  const casting = castSealV3(sealed, voter.secret, c.leaves, l1Ref);
  return finishSealV3(casting, await proveMembership(casting.witness, c.artifacts));
}

/** What every ballot of a rolling poll (ballot version 5) is made against, derived as a client derives it. */
export interface RollingCasting {
  readonly election: RollingBallotElection;
  /** The key set the transcript check registered, in seat order. */
  readonly registered: readonly RegisteredKeys[];
  readonly artifacts: MembershipProverArtifacts;
}

/**
 * `castingFor` for a rolling version-7 definition: the key set its
 * transcript check registers (T-37), and `rollingBallotElection` over the
 * group registry's events through the cast and the timestamp of the
 * definition's registration, from which @abolishus/crypto computes every
 * accepted step's root itself (T-08, T-53).
 */
export function rollingCastingFor(
  definition: ElectionDefinitionV7,
  panel: Panel,
  transcript: Uint8Array,
  chain: RollingBallotChain,
  artifacts: MembershipProverArtifacts,
): RollingCasting {
  const registered = registeredKeys(definition, electionStubV7Hash(definition), panel, transcript);
  return {
    election: rollingBallotElection(definition, registered, chain),
    registered,
    artifacts,
  };
}

/** A step's tree as a client rebuilds it: its leaves, removed ones 0, and its root. */
export interface StepTree {
  readonly step: number;
  readonly leaves: readonly bigint[];
  readonly root: bigint;
}

/**
 * Step `step`'s tree over `groups`: every event of `chain` in an L2 block
 * stamped at or before the step's boundary `boundary`, in chain order
 * ([[membership]], Root clock and steps), rebuilt from every leaf so no path
 * is ever asked of anyone (T-10, T-13).
 */
export function stepTree(
  chain: RollingBallotChain,
  groups: readonly bigint[],
  step: number,
  boundary: bigint,
): StepTree {
  const tree = new RollingTierTree([...groups]);
  for (const e of chain.events) if (e.timestamp <= boundary) tree.apply(e);
  return { step, leaves: tree.leaves, root: tree.root() };
}

/** A cast rolling ballot: its record and encoding, the root it proved against and each seat's ciphertext. */
export interface CastRollingBallot {
  readonly record: BallotRecordV5;
  readonly bytes: Uint8Array;
  readonly root: bigint;
  readonly ciphertexts: readonly Uint8Array[];
}

/** A rolling poll's one cell: its one rolling tier. */
const ROLLING_CELL = 0;

/**
 * One version-5 ballot of `voter` for `votes`, naming `l1Ref` and the step
 * whose tree is `at`, in Casting's order: the core, each registered seat's
 * shares encrypted to its registered key (step 1); the validity proofs
 * binding the nullifier under the tier's rolling scope, which has no root
 * in it, and the ballot hash binding the step (step 2); the membership
 * proof against the step's root under the same scope, through
 * @abolishus/crypto's rolling prover input and the client's prover, then
 * finished (step 3); and the admission checks with the root it proved
 * against supplied, as the board's rolling call takes it (step 4; T-08,
 * T-25).
 */
export async function castRolling(
  c: RollingCasting,
  voter: Voter,
  votes: readonly (0 | 1)[],
  l1Ref: L1Ref,
  at: StepTree,
): Promise<CastRollingBallot> {
  const { election, registered } = c;
  const { definitionHash } = election;
  const cell = election.cells[ROLLING_CELL];
  if (cell === undefined) throw new Error("the definition lists no rolling tier");
  const rules = {
    questions: election.questions,
    threshold: election.threshold,
    panelSize: election.panelSize,
    authorThreshold: election.authorThreshold,
    authorPanelSize: election.authorPanelSize,
  };
  const sharing = shareVoteV4(rules, votes);
  const encrypted = encryptSharesV4(
    { definitionHash },
    sharing,
    registered.map((k) => k.kemKey),
    [],
  );
  const nullifier = rollingMembershipNullifier(voter.secret, { definitionHash, tier: cell.tier });
  const named = { definitionHash, cell: ROLLING_CELL, nullifier };
  const vote = proveValidityV5({ ...rules, ...named }, sharing, encrypted.hashes, []);
  const message = membershipMessage({
    definitionHash,
    tier: cell.tier,
    ballotHash: ballotHashV5({ ...named, step: at.step }, vote),
    l1RefNumber: l1Ref.number,
    l1RefHash: l1Ref.hash,
  });
  const input = rollingMembershipProverInput(voter.secret, at.leaves, {
    definitionHash,
    tier: cell.tier,
    root: at.root,
    message,
  });
  const proof = finishMembershipProof(input, await proveMembership(input.witness, c.artifacts));
  const record: BallotRecordV5 = {
    definition_hash: definitionHash,
    cell: ROLLING_CELL,
    nullifier,
    l1_ref_number: l1Ref.number,
    l1_ref_hash: l1Ref.hash,
    membership_proof: decodeMembershipProof(proof),
    step: at.step,
    committed_vote: vote,
  };
  const checked = checkBallotV5(election, record, at.root);
  if (!checked.ok) throw new Error(`an honest rolling ballot fails admission: ${checked.code}`);
  return {
    record,
    bytes: encodeBallotV5(record),
    root: at.root,
    ciphertexts: encrypted.ciphertexts,
  };
}
