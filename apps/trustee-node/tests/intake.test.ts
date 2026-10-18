import { readFileSync } from "node:fs";
import {
  ballotElection,
  type BallotElection,
  ballotCore,
  ballotHash,
  type BallotRecord,
  checkBallot,
  checkCeremonyTranscript,
  checkShareReceipt,
  decodeMembershipProof,
  decodeShareReceipt,
  type ElectionDefinition,
  electionDefinitionHash,
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
import { beforeAll, describe, expect, it } from "vite-plus/test";
import {
  CeremonySeat,
  type IntakeConfig,
  IntakeSeat,
  type RegistrationCheck,
  type SeatStore,
} from "../src/index.ts";
import { RELEASE_WINDOWS } from "../src/stub.ts";
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

const TIER = 0;
const secrets = Array.from({ length: 3 }, () => newIdentitySecret());
const leaves = secrets.map((s) => identityCommitment(s));
const root = tierTreeRoot(leaves);

interface Setup {
  readonly e: Election;
  readonly stores: readonly SeatStore[];
  readonly transcript: Uint8Array;
  readonly definition: ElectionDefinition;
  readonly registered: readonly RegisteredKeys[];
  readonly election: BallotElection;
  readonly cutoff: bigint;
}

async function setup(): Promise<Setup> {
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

interface Cast {
  readonly record: BallotRecord;
  readonly bytes: Uint8Array;
  readonly ciphertexts: readonly Uint8Array[];
}

/** One ballot of voter `v` for option `option`, made as the ballot client makes it (Casting). */
async function cast(s: Setup, v: number, option: 0 | 1): Promise<Cast> {
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
  return prove(s, v, sealed, { number: 100n, hash: new Uint8Array(32).fill(7) });
}

/** The same core cast again under another L1 reference (revoting, Client rule 4): the same public part. */
function castAgain(s: Setup, v: number, earlier: Cast, l1Ref: L1Ref): Promise<Cast> {
  const { committed_vote: vote, nullifier } = earlier.record;
  return prove(s, v, { vote, nullifier, ciphertexts: earlier.ciphertexts }, l1Ref);
}

interface L1Ref {
  readonly number: bigint;
  readonly hash: Uint8Array;
}

/** Casting steps 2 to 4 for a sealed core: `M` over `l1Ref`, the membership proof and the admission checks. */
async function prove(
  s: Setup,
  v: number,
  sealed: {
    readonly vote: BallotRecord["committed_vote"];
    readonly nullifier: bigint;
    readonly ciphertexts: readonly Uint8Array[];
  },
  l1Ref: L1Ref,
): Promise<Cast> {
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

interface Seats {
  intake: readonly IntakeSeat[];
  readonly registrations: { definitionHash: Uint8Array; keySetHash: Uint8Array }[];
  clock: bigint;
}

function seatsOf(s: Setup, change: Partial<IntakeConfig> = {}, ceremony = s.e.seats): Seats {
  const seats: Seats = { intake: [], registrations: [], clock: s.e.stub.opens_at };
  const registration: RegistrationCheck = async (definitionHash, keySetHash) => {
    seats.registrations.push({ definitionHash, keySetHash });
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

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

let s: Setup;
let honest: Cast;

beforeAll(async () => {
  s = await setup();
  honest = await cast(s, 0, 1);
}, 120_000);

describe("intake", () => {
  it("receipts a member's ballot at every seat, under the seat's registered signing key", async () => {
    const seats = seatsOf(s);
    for (const [i, seat] of seats.intake.entries()) {
      const out = await seat.intake(
        s.e.stubBytes,
        s.transcript,
        honest.bytes,
        honest.ciphertexts[i] as Uint8Array,
      );
      if (!out.ok) expect.fail(`seat ${i + 1} refused: ${out.code}`);
      const receipt = decodeShareReceipt(out.receipt, 1);
      expect(receipt.seat).toBe(i + 1);
      expect(hex(receipt.definition_hash)).toBe(hex(electionDefinitionHash(s.definition)));
      expect(
        checkShareReceipt(
          s.registered,
          {
            definitionHash: s.election.definitionHash,
            tier: TIER,
            nullifier: honest.record.nullifier,
          },
          honest.record.committed_vote,
          i + 1,
          receipt.signature,
        ),
      ).toBe(true);
      expect((await seat.receipted(s.e.stubHash)).map(hex)).toEqual([hex(out.ballotHash)]);
    }
    // The registration check is asked about the definition and the key set the seat approved.
    expect(seats.registrations.map((r) => hex(r.definitionHash))).toEqual(
      Array(3).fill(hex(electionDefinitionHash(s.definition))),
    );
  });

  it("gives the same receipt again for the same delivery, after a restart too", async () => {
    const first = await seatsOf(s).intake[0]!.intake(
      s.e.stubBytes,
      s.transcript,
      honest.bytes,
      honest.ciphertexts[0] as Uint8Array,
    );
    // A new node process over the same store: its ceremony seat and intake both restart.
    const restarted = s.e.seats.map(
      (_, i) =>
        new CeremonySeat({
          panel: s.e.panelists.panel,
          l2ChainId: L2_CHAIN_ID,
          trusteeRegistry: TRUSTEE_REGISTRY,
          index: i + 1,
          identitySecret: s.e.panelists.secrets[i] as Uint8Array,
          electorate: () => Promise.resolve(true),
          store: s.stores[i] as SeatStore,
        }),
    );
    const again = await seatsOf(s, {}, restarted).intake[0]!.intake(
      s.e.stubBytes,
      s.transcript,
      honest.bytes,
      honest.ciphertexts[0] as Uint8Array,
    );
    expect(first.ok && again.ok).toBe(true);
    if (first.ok && again.ok) expect(hex(again.receipt)).toBe(hex(first.receipt));
    expect(await s.stores[0]!.list(`intake/${hex(s.e.stubHash)}`)).toHaveLength(1);
  });

  it("keeps every L1 reference a receipted ballot was delivered under (T-25, T-54)", async () => {
    const store = new MemoryStore();
    const [seat] = seatsOf(s, { store }).intake;
    const recast = await castAgain(s, 0, honest, {
      number: 101n,
      hash: new Uint8Array(32).fill(8),
    });
    const first = await seat!.intake(
      s.e.stubBytes,
      s.transcript,
      honest.bytes,
      honest.ciphertexts[0] as Uint8Array,
    );
    const second = await seat!.intake(
      s.e.stubBytes,
      s.transcript,
      recast.bytes,
      recast.ciphertexts[0] as Uint8Array,
    );
    if (!first.ok || !second.ok) expect.fail("an honest delivery was refused");
    // One public part: the same ballot hash and the same receipt.
    expect(hex(second.receipt)).toBe(hex(first.receipt));
    expect(await store.list(`intake/${hex(s.e.stubHash)}`)).toEqual([hex(first.ballotHash)]);
    expect(await store.list(`copies/${hex(s.e.stubHash)}/${hex(first.ballotHash)}`)).toEqual([
      `100-${"07".repeat(32)}`,
      `101-${"08".repeat(32)}`,
    ]);
  });

  it("stores and signs nothing for a delivery that finishes at the cutoff (T-54)", async () => {
    const store = new MemoryStore();
    const times = [s.cutoff - 1n, s.cutoff];
    const [seat] = seatsOf(s, { store, now: () => times.shift() ?? s.cutoff }).intake;
    const out = await seat!.intake(
      s.e.stubBytes,
      s.transcript,
      honest.bytes,
      honest.ciphertexts[0] as Uint8Array,
    );
    expect(out).toEqual({ ok: false, code: "intake-closed" });
    expect(await store.list(`intake/${hex(s.e.stubHash)}`)).toEqual([]);
  });

  it("refuses another seat's ciphertext and a malformed record, storing nothing", async () => {
    const stores = [new MemoryStore()];
    const [seat] = seatsOf(s, { store: stores[0] as SeatStore }).intake;
    const wrong = await seat!.intake(
      s.e.stubBytes,
      s.transcript,
      honest.bytes,
      honest.ciphertexts[1] as Uint8Array,
    );
    expect(wrong).toEqual({ ok: false, code: "share-hash" });
    const cut = await seat!.intake(
      s.e.stubBytes,
      s.transcript,
      honest.bytes.subarray(0, honest.bytes.length - 1),
      honest.ciphertexts[0] as Uint8Array,
    );
    expect(cut).toEqual({ ok: false, code: "delivery-malformed" });
    expect(await stores[0]!.list(`intake/${hex(s.e.stubHash)}`)).toEqual([]);
  });

  it("refuses a ballot whose membership proof doesn't verify (T-52)", async () => {
    const stores = [new MemoryStore()];
    const [seat] = seatsOf(s, { store: stores[0] as SeatStore }).intake;
    const proof = honest.record.membership_proof;
    const tampered = encodeBallot({
      ...honest.record,
      // Another L1 reference changes M, which the proof binds.
      l1_ref_number: honest.record.l1_ref_number + 1n,
      membership_proof: proof,
    });
    const out = await seat!.intake(
      s.e.stubBytes,
      s.transcript,
      tampered,
      honest.ciphertexts[0] as Uint8Array,
    );
    expect(out).toEqual({ ok: false, code: "membership-proof" });
    expect(await stores[0]!.list(`intake/${hex(s.e.stubHash)}`)).toEqual([]);
  });
});

describe("the election's checks before intake", () => {
  const deliver = (seat: IntakeSeat, stubBytes = s.e.stubBytes, transcript = s.transcript) =>
    seat.intake(stubBytes, transcript, honest.bytes, honest.ciphertexts[0] as Uint8Array);

  it("refuses a stub the seat never approved", async () => {
    const other = election(3, 2);
    const [seat] = seatsOf(s).intake;
    expect(await deliver(seat!, other.stubBytes)).toEqual({ ok: false, code: "intake-unapproved" });
    expect(await deliver(seat!, new Uint8Array([1, 2, 3]))).toEqual({
      ok: false,
      code: "intake-unapproved",
    });
  });

  it("refuses any transcript but the one the seat approved (T-37)", async () => {
    const [seat] = seatsOf(s).intake;
    const altered = Uint8Array.from(s.transcript);
    altered[altered.length - 1]! ^= 1;
    expect(await deliver(seat!, s.e.stubBytes, altered)).toEqual({
      ok: false,
      code: "intake-transcript",
    });
  });

  it("refuses until the electorate check passes, then takes the ballot", async () => {
    let decided = false;
    const [seat] = seatsOf(s, {
      store: new MemoryStore(),
      electorate: () => Promise.resolve(decided),
    }).intake;
    expect(await deliver(seat!)).toEqual({ ok: false, code: "intake-definition" });
    decided = true;
    expect((await deliver(seat!)).ok).toBe(true);
  });

  it("refuses until finalized L2 shows the definition registered", async () => {
    let decided = false;
    const [seat] = seatsOf(s, {
      store: new MemoryStore(),
      registration: () => Promise.resolve(decided),
    }).intake;
    expect(await deliver(seat!)).toEqual({ ok: false, code: "intake-unregistered" });
    decided = true;
    expect((await deliver(seat!)).ok).toBe(true);
  });

  it("refuses an election whose pins this node doesn't hold", async () => {
    const [seat] = seatsOf(s, { l2ChainId: L2_CHAIN_ID + 1n }).intake;
    expect(await deliver(seat!)).toEqual({ ok: false, code: "intake-definition" });
  });

  it("stays open until the intake cutoff and refuses from it on (T-54)", async () => {
    const seats = seatsOf(s, { store: new MemoryStore() });
    const [seat] = seats.intake;
    seats.clock = s.cutoff - 1n;
    expect((await deliver(seat!)).ok).toBe(true);
    seats.clock = s.cutoff;
    expect(await deliver(seat!)).toEqual({ ok: false, code: "intake-closed" });
  });
});
