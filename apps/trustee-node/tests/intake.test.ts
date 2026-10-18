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
  type FinalizedL1,
  finishMembershipProof,
  identityCommitment,
  intakeCutoff,
  L1_REF_MARGIN,
  membershipMessage,
  membershipProverInput,
  newIdentitySecret,
  proveValidity,
  type RegisteredKeys,
  shareVote,
  tierTreeRoot,
  type ViewBallot,
} from "@abolishus/crypto";
import { type MembershipProverArtifacts, proveMembership } from "@abolishus/membership-prover";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import {
  CeremonySeat,
  decideObligation,
  encodeDelivery,
  type IntakeConfig,
  IntakeSeat,
  type ObligationStatus,
  type ObligationView,
  type RegistrationCheck,
  type SeatStore,
  serveIntake,
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

describe("the intake endpoint over a seat", () => {
  it("returns the receipt the seat gives in-process, and a refusal's code", async () => {
    const [seat] = seatsOf(s, { store: new MemoryStore() }).intake;
    const endpoint = await serveIntake(seat!, { host: "127.0.0.1", port: 0, queue: 4 });
    try {
      const body = (ciphertext: Uint8Array) =>
        Buffer.from(
          encodeDelivery({
            stub: s.e.stubBytes,
            transcript: s.transcript,
            record: honest.bytes,
            ciphertext,
          }),
        );
      const deliver = (ciphertext: Uint8Array) =>
        fetch(endpoint.url, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: body(ciphertext),
        });
      const res = await deliver(honest.ciphertexts[0] as Uint8Array);
      expect(res.status).toBe(200);
      const direct = await seat!.intake(
        s.e.stubBytes,
        s.transcript,
        honest.bytes,
        honest.ciphertexts[0] as Uint8Array,
      );
      if (!direct.ok) expect.fail(direct.code);
      expect(hex(new Uint8Array(await res.arrayBuffer()))).toBe(hex(direct.receipt));
      const refused = await deliver(honest.ciphertexts[1] as Uint8Array);
      expect(refused.status).toBe(422);
      expect(await refused.text()).toBe("share-hash");
    } finally {
      await endpoint.close();
    }
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

describe("the obligation decided at the intake cutoff", () => {
  // Finalized L1 with 12-second blocks: block 100, which the casts name, is the
  // first at `opens_at − L1_REF_MARGIN`, and the head is the first after
  // `closes_at`. Block `n` hashes to `n` repeated, but 100 and 101 to the
  // casts' 0x07 and 0x08 unless `reorged`.
  const l1Of = (closedAt: bigint, reorged = false): FinalizedL1 => {
    const start = s.e.stub.opens_at - L1_REF_MARGIN - 100n * 12n;
    const head = (closedAt - start) / 12n + 1n;
    return {
      head,
      block(n) {
        const fill = reorged ? 0xee : n === 100n ? 0x07 : n === 101n ? 0x08 : Number(n % 256n);
        return { hash: new Uint8Array(32).fill(fill), timestamp: start + n * 12n };
      },
    };
  };
  const SEGMENT = 50n;
  const viewOf = (change: Partial<ObligationView> = {}): ObligationView => ({
    l1: l1Of(s.e.stub.closes_at),
    low: 0n,
    board: [],
    boardSegment: SEGMENT,
    absent: [],
    ...change,
  });
  /** A board copy for voter `v`'s nullifier under another ballot hash, as a newer ballot the seat never receipted. */
  const boardCopy = (nullifier: bigint, l1RefNumber: bigint, fill: number): ViewBallot => {
    const ballotHash = new Uint8Array(32).fill(fill);
    const l1RefHash = new Uint8Array(32).fill(Number(l1RefNumber % 256n));
    return {
      ballotHash,
      tier: TIER,
      nullifier,
      message: membershipMessage({
        definitionHash: s.election.definitionHash,
        tier: TIER,
        ballotHash,
        l1RefNumber,
        l1RefHash,
      }),
      l1RefNumber,
      l1RefHash,
      entry: { path: "board", value: SEGMENT },
    };
  };

  async function receipted(store: SeatStore, ...casts: Cast[]) {
    const seats = seatsOf(s, { store });
    for (const c of casts) {
      const out = await seats.intake[0]!.intake(
        s.e.stubBytes,
        s.transcript,
        c.bytes,
        c.ciphertexts[0] as Uint8Array,
      );
      if (!out.ok) expect.fail(out.code);
    }
    const approved = await s.e.seats[0]!.approvedElection(s.e.stubHash);
    if (approved === undefined) expect.fail("the seat approved the stub");
    return { seats, approved };
  }

  const options = (store: SeatStore, view: ObligationView, now = s.cutoff) => ({
    store,
    view: () => Promise.resolve(view),
    now: () => now,
  });
  const hashes = (status: ObligationStatus) =>
    status.state === "decided"
      ? { receipts: status.receipts.map(hex), complaints: status.complaints.map(hex) }
      : status;
  const honestHash = () =>
    hex(
      ballotHash(
        {
          definitionHash: s.election.definitionHash,
          tier: TIER,
          nullifier: honest.record.nullifier,
        },
        honest.record.committed_vote,
      ),
    );

  it("decides nothing while intake is open, then owes the receipt of the ballot it receipted", async () => {
    const store = new MemoryStore();
    const { approved } = await receipted(store, honest);
    expect(await decideObligation(options(store, viewOf(), s.cutoff - 1n), approved)).toEqual({
      state: "open",
      until: s.cutoff,
    });
    expect(hashes(await decideObligation(options(store, viewOf()), approved))).toEqual({
      receipts: [honestHash()],
      complaints: [honestHash()],
    });
    expect(approved.members).toBe(3n);
  });

  it("waits for finalized L1 past the close", async () => {
    const store = new MemoryStore();
    const { approved } = await receipted(store, honest);
    const early = viewOf({ l1: l1Of(s.e.stub.closes_at - 12n) });
    expect(await decideObligation(options(store, early), approved)).toEqual({
      state: "waiting-l1",
    });
    expect(await store.list("obligations")).toEqual([]);
  });

  it("decides once: a view that changes later changes nothing it owes (T-52, T-54)", async () => {
    const store = new MemoryStore();
    const { approved } = await receipted(store, honest);
    const first = await decideObligation(options(store, viewOf()), approved);
    const newer = boardCopy(honest.record.nullifier, 110n, 0xb1);
    const later = viewOf({ board: [newer] });
    expect(await decideObligation(options(store, later, s.cutoff + 3600n), approved)).toEqual(
      first,
    );
    // A decision taken over the later view would have owed nothing.
    expect(hashes(await decideObligation(options(new MemoryStore(), later), approved))).toEqual({
      receipts: [],
      complaints: [hex(newer.ballotHash)],
    });
  });

  it("owes nothing for a ballot a newer one on the board supersedes, which it complains over", async () => {
    const store = new MemoryStore();
    const { approved } = await receipted(store, honest);
    const newer = boardCopy(honest.record.nullifier, 110n, 0xb1);
    const other = boardCopy(123n, 105n, 0xc1);
    const status = await decideObligation(
      options(store, viewOf({ board: [newer, other] })),
      approved,
    );
    expect(hashes(status)).toEqual({
      receipts: [],
      complaints: [hex(newer.ballotHash), hex(other.ballotHash)].sort(),
    });
  });

  it("drops a ballot it shows absent from the view, but a copy boarded late doesn't displace it", async () => {
    const absentStore = new MemoryStore();
    const a = await receipted(absentStore, honest);
    const absent = viewOf({ absent: [Buffer.from(honestHash(), "hex")] });
    expect(hashes(await decideObligation(options(absentStore, absent), a.approved))).toEqual({
      receipts: [],
      complaints: [],
    });
    const lateStore = new MemoryStore();
    const b = await receipted(lateStore, honest);
    const late = {
      ...boardCopy(honest.record.nullifier, 110n, 0xb1),
      entry: { path: "board" as const, value: SEGMENT + 1n },
    };
    expect(
      hashes(await decideObligation(options(lateStore, viewOf({ board: [late] })), b.approved)),
    ).toEqual({
      receipts: [honestHash()],
      complaints: [honestHash()],
    });
  });

  it("owes the receipt of a ballot whose block was reorganised away, once per voter (T-25)", async () => {
    const store = new MemoryStore();
    const recast = await castAgain(s, 0, honest, {
      number: 101n,
      hash: new Uint8Array(32).fill(8),
    });
    const { approved } = await receipted(store, honest, recast);
    const view = viewOf({ l1: l1Of(s.e.stub.closes_at, true) });
    expect(hashes(await decideObligation(options(store, view), approved))).toEqual({
      receipts: [honestHash()],
      complaints: [honestHash()],
    });
  });

  it("refuses a view that holds a ballot shown absent from the board, and an obligation over 2M", async () => {
    const store = new MemoryStore();
    const { approved } = await receipted(store, honest);
    const copy = boardCopy(7n, 105n, 0xd1);
    await expect(
      decideObligation(
        options(store, viewOf({ board: [copy], absent: [copy.ballotHash] })),
        approved,
      ),
    ).rejects.toThrow("shown absent");
    // Three members: a view naming seven voters' ballots holds copies no member made.
    const flood = Array.from({ length: 7 }, (_, i) => boardCopy(BigInt(1000 + i), 105n, 0xe0 + i));
    await expect(
      decideObligation(options(store, viewOf({ board: flood })), approved),
    ).rejects.toThrow("bound of 2M");
    expect(await store.list("obligations")).toEqual([]);
  });

  it("gives no receipt for a delivery whose records become durable at the cutoff", async () => {
    const store = new MemoryStore();
    const times = [s.cutoff - 1n, s.cutoff - 1n, s.cutoff];
    const [seat] = seatsOf(s, { store, now: () => times.shift() ?? s.cutoff }).intake;
    const out = await seat!.intake(
      s.e.stubBytes,
      s.transcript,
      honest.bytes,
      honest.ciphertexts[0] as Uint8Array,
    );
    expect(out).toEqual({ ok: false, code: "intake-closed" });
  });
});
