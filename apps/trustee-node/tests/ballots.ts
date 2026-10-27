// An election with an electorate of three and ballots made as the ballot
// client makes them, with real Groth16 membership proofs, for the tests of
// intake and of what a seat decides it owes.
import { readFileSync } from "node:fs";
import {
  ballotElection,
  type BallotElection,
  ballotCore,
  ballotHash,
  type BallotRecord,
  checkBallot,
  checkCeremonyTranscript,
  decodeMembershipProof,
  type ElectionDefinition,
  encodeBallot,
  encryptShares,
  finishMembershipProof,
  identityCommitment,
  intakeCutoff,
  membershipMessage,
  membershipProverInput,
  newIdentitySecret,
  proveValidity,
  type RegisteredKeys,
  shareVote,
  tierTreeRoot,
} from "@abolishus/crypto";
import { type MembershipProverArtifacts, proveMembership } from "@abolishus/membership-prover";
import {
  type IntakeConfig,
  IntakeSeat,
  type RegistrationCheck,
  type SeatStore,
} from "../src/index.ts";
import { RELEASE_WINDOWS, stubDefinitionHash } from "../src/stub.ts";
import { MemoryStore } from "../src/store.ts";
import {
  election,
  type Election,
  L2_CHAIN_ID,
  runCeremony,
  TRUSTEE_REGISTRY,
  value,
} from "./fixture.ts";

const ARTIFACTS = new URL(
  "../../../packages/membership-prover/artifacts/snark-artifacts/",
  import.meta.url,
);
const artifacts: MembershipProverArtifacts = {
  zkey: readFileSync(new URL("semaphore-32.zkey", ARTIFACTS)),
  wasm: readFileSync(new URL("semaphore-32.wasm", ARTIFACTS)),
};

export const TIER = 0;
const secrets = Array.from({ length: 3 }, () => newIdentitySecret());
const leaves = secrets.map((s) => identityCommitment(s));
const root = tierTreeRoot(leaves);

export interface Setup {
  readonly e: Election;
  readonly stores: readonly SeatStore[];
  readonly transcript: Uint8Array;
  readonly definition: ElectionDefinition;
  readonly registered: readonly RegisteredKeys[];
  readonly election: BallotElection;
  readonly cutoff: bigint;
}

export async function setup(): Promise<Setup> {
  const stores = [new MemoryStore(), new MemoryStore(), new MemoryStore()];
  const e = election(3, 2, {
    stores,
    stub: { electorate: [{ tier: TIER, group_id: 1n, root, root_l2_block: 1n, group_size: 3n }] },
  });
  const run = await runCeremony(e);
  for (const seat of e.seats) value(await seat.approve(e.stubBytes, run.transcript));
  const check = checkCeremonyTranscript(
    {
      l2ChainId: L2_CHAIN_ID,
      trusteeRegistry: TRUSTEE_REGISTRY,
      electionId: e.stub.election_id,
      stubHash: e.stubHash,
      panel: e.panelists.panel,
    },
    run.transcript,
    1,
  );
  if (!check.ok) throw new Error(`transcript: ${check.code}`);
  const definition = { ...e.stub, ceremony_transcript_hash: check.hash };
  return {
    e,
    stores,
    transcript: run.transcript,
    definition,
    registered: check.registered,
    election: ballotElection(definition, check.registered),
    cutoff: intakeCutoff(e.stub.closes_at, BigInt(e.stub.l1_inclusion_bound), RELEASE_WINDOWS),
  };
}

export interface Cast {
  readonly record: BallotRecord;
  readonly bytes: Uint8Array;
  readonly ciphertexts: readonly Uint8Array[];
  /** Each seat's ML-KEM message `m_i`, which the voter would post with `ct_i` (Public posting). */
  readonly ms: readonly Uint8Array[];
}

/** One ballot of voter `v` for option `option`, made as the ballot client makes it (Casting). */
export async function cast(s: Setup, v: number, option: 0 | 1): Promise<Cast> {
  const { definitionHash } = s.election;
  const sharing = shareVote(s.election, option === 0 ? [1, 0] : [0, 1]);
  const encrypted = encryptShares(
    { definitionHash },
    sharing,
    s.registered.map((k) => k.kemKey),
  );
  const core = ballotCore(s.election, TIER, encrypted);
  const secret = secrets[v] as Uint8Array;
  const placeholder = { definitionHash, tier: TIER, root, message: new Uint8Array(32) };
  const { nullifier } = membershipProverInput(secret, leaves, placeholder).signals;
  const vote = proveValidity(
    { ...s.election, definitionHash, tier: TIER, nullifier },
    sharing,
    core.shareHashes,
  );
  const sealed = { vote, nullifier, ciphertexts: encrypted.ciphertexts };
  const ms = encrypted.randomness.map((r) => r.m);
  return {
    ...(await prove(s, v, sealed, { number: 100n, hash: new Uint8Array(32).fill(7) })),
    ms,
  };
}

/** The same core cast again under another L1 reference (revoting, Client rule 4): the same public part. */
export async function castAgain(s: Setup, v: number, earlier: Cast, l1Ref: L1Ref): Promise<Cast> {
  const { committed_vote: vote, nullifier } = earlier.record;
  const sealed = { vote, nullifier, ciphertexts: earlier.ciphertexts };
  return { ...(await prove(s, v, sealed, l1Ref)), ms: earlier.ms };
}

export interface L1Ref {
  readonly number: bigint;
  readonly hash: Uint8Array;
}

/** Casting steps 2 to 4 for a sealed core: `M` over `l1Ref`, the membership proof and the admission checks. */
export async function prove(
  s: Setup,
  v: number,
  sealed: {
    readonly vote: BallotRecord["committed_vote"];
    readonly nullifier: bigint;
    readonly ciphertexts: readonly Uint8Array[];
  },
  l1Ref: L1Ref,
): Promise<Omit<Cast, "ms">> {
  const { definitionHash } = s.election;
  const secret = secrets[v] as Uint8Array;
  const { vote, nullifier } = sealed;
  const message = membershipMessage({
    definitionHash,
    tier: TIER,
    ballotHash: ballotHash({ definitionHash, tier: TIER, nullifier }, vote),
    l1RefNumber: l1Ref.number,
    l1RefHash: l1Ref.hash,
  });
  const input = membershipProverInput(secret, leaves, {
    definitionHash,
    tier: TIER,
    root,
    message,
  });
  const proof = finishMembershipProof(input, await proveMembership(input.witness, artifacts));
  const record: BallotRecord = {
    definition_hash: definitionHash,
    tier: TIER,
    nullifier,
    l1_ref_number: l1Ref.number,
    l1_ref_hash: l1Ref.hash,
    membership_proof: decodeMembershipProof(proof),
    committed_vote: vote,
  };
  const checked = checkBallot(s.election, record);
  if (!checked.ok) throw new Error(`an honest ballot fails admission: ${checked.code}`);
  return { record, bytes: encodeBallot(record), ciphertexts: sealed.ciphertexts };
}

export interface Seats {
  intake: readonly IntakeSeat[];
  readonly registrations: { definitionHash: Uint8Array; keySetHash: Uint8Array }[];
  clock: bigint;
}

export function seatsOf(s: Setup, change: Partial<IntakeConfig> = {}, ceremony = s.e.seats): Seats {
  const seats: Seats = { intake: [], registrations: [], clock: s.e.stub.opens_at };
  const registration: RegistrationCheck = async (definition, keySetHash) => {
    seats.registrations.push({
      definitionHash: stubDefinitionHash(definition, definition.value.ceremony_transcript_hash),
      keySetHash,
    });
    return true;
  };
  seats.intake = ceremony.map(
    (seat, i) =>
      new IntakeSeat({
        panel: s.e.panelists.panel,
        l2ChainId: L2_CHAIN_ID,
        trusteeRegistry: TRUSTEE_REGISTRY,
        index: i + 1,
        ceremony: seat,
        electorate: () => Promise.resolve(true),
        registration,
        store: s.stores[i] as SeatStore,
        now: () => seats.clock,
        ...change,
      }),
  );
  return seats;
}
