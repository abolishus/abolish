// Intake under definition version 5, the stubs the website creates (P2-14):
// a whole ceremony between seats over a version-5 stub, then ballots of
// version 3 made as the ballot client makes them (packages/crypto's seal with
// a real Groth16 membership proof), delivered to every seat.
import { readFileSync } from "node:fs";
import {
  type BallotRecordV3,
  castSealV3,
  checkBallotV3,
  checkCeremonyTranscript,
  checkShareReceiptV3,
  decodeBallot,
  decodeShareReceipt,
  type ElectionDefinitionV5,
  electionDefinitionV5Hash,
  encodeBallotV3,
  finishSealV3,
  identityCommitment,
  intakeCutoff,
  newIdentitySecret,
  questionBallotElection,
  type QuestionBallotElection,
  type RegisteredKeys,
  sealBallotV3,
  tierTreeRoot,
} from "@abolishus/crypto";
import { type MembershipProverArtifacts, proveMembership } from "@abolishus/membership-prover";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { IntakeSeat, type SeatStore } from "../src/index.ts";
import { RELEASE_WINDOWS } from "../src/stub.ts";
import { MemoryStore } from "../src/store.ts";
import { stubHashOf } from "../src/wire.ts";
import {
  electionV5,
  type ElectionV5,
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

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const secrets = Array.from({ length: 3 }, () => newIdentitySecret());
const leaves = secrets.map((s) => identityCommitment(s));
// Question 0 picks the first of two options, question 1 the first and third of three.
const VOTES = [1, 0, 1, 0, 1] as const;

interface Cast {
  readonly record: BallotRecordV3;
  readonly bytes: Uint8Array;
  /** Each seat's `ct_i`, by seat. */
  readonly ciphertexts: readonly Uint8Array[];
}

let e: ElectionV5;
let stores: SeatStore[];
let transcript: Uint8Array;
let definition: ElectionDefinitionV5;
let registered: readonly RegisteredKeys[];
let election: QuestionBallotElection;
let cutoff: bigint;
let honest: Cast;

beforeAll(async () => {
  stores = [new MemoryStore(), new MemoryStore(), new MemoryStore()];
  const base = electionV5(3, 2).stub.electorate[0];
  if (base === undefined) throw new Error("no tier");
  e = electionV5(3, 2, {
    stores,
    stub: {
      electorate: [{ ...base, cells: [{ root: tierTreeRoot(leaves), members: 3n }] }],
    },
  });
  const run = await runCeremony(e);
  for (const seat of e.seats) value(await seat.approve(e.stubBytes, run.transcript));
  transcript = run.transcript;
  const check = checkCeremonyTranscript(
    {
      l2ChainId: L2_CHAIN_ID,
      trusteeRegistry: TRUSTEE_REGISTRY,
      electionId: e.stub.election_id,
      stubHash: e.stubHash,
      panel: e.panelists.panel,
    },
    transcript,
    1,
  );
  if (!check.ok) throw new Error(`transcript: ${check.code}`);
  definition = { ...e.stub, ceremony_transcript_hash: check.hash };
  registered = check.registered;
  election = questionBallotElection(definition, registered);
  cutoff = intakeCutoff(e.stub.closes_at, BigInt(e.stub.l1_inclusion_bound), RELEASE_WINDOWS);
  const sealed = sealBallotV3(election, 0, [...VOTES]);
  const casting = castSealV3(sealed, secrets[0] as Uint8Array, leaves, {
    number: 100n,
    hash: new Uint8Array(32).fill(7),
  });
  const cast = finishSealV3(casting, await proveMembership(casting.witness, artifacts));
  const record = decodeBallot(cast.ballot, 3);
  if (!checkBallotV3(election, record).ok) throw new Error("an honest ballot fails admission");
  const ciphertexts: Uint8Array[] = [];
  for (const c of cast.ciphertexts) ciphertexts[c.seat - 1] = c.ciphertext;
  honest = { record, bytes: cast.ballot, ciphertexts };
}, 120_000);

interface Seats {
  intake: readonly IntakeSeat[];
  readonly registrations: Uint8Array[];
  clock: bigint;
}

function seatsOf(
  change: {
    store?: SeatStore;
    electorate?: () => Promise<boolean>;
    registered?: () => boolean;
  } = {},
): Seats {
  const seats: Seats = { intake: [], registrations: [], clock: e.stub.opens_at };
  seats.intake = e.seats.map(
    (ceremony, i) =>
      new IntakeSeat({
        panel: e.panelists.panel,
        l2ChainId: L2_CHAIN_ID,
        trusteeRegistry: TRUSTEE_REGISTRY,
        index: i + 1,
        ceremony,
        electorate: change.electorate ?? (() => Promise.resolve(true)),
        registration: (definitionHash) => {
          seats.registrations.push(definitionHash);
          return Promise.resolve(change.registered?.() ?? true);
        },
        store: change.store ?? (stores[i] as SeatStore),
        now: () => seats.clock,
      }),
  );
  return seats;
}

const deliver = (seat: IntakeSeat, record = honest.bytes, ciphertext = honest.ciphertexts[0]) =>
  seat.intake(e.stubBytes, transcript, record, ciphertext as Uint8Array);

describe("a version-5 stub's ceremony", () => {
  it("is approved by every seat, which records the version-5 definition it registers", async () => {
    for (const seat of e.seats) {
      const approved = await seat.approvedElection(e.stubHash);
      expect(approved && hex(approved.definitionHash)).toBe(
        hex(electionDefinitionV5Hash(definition)),
      );
      // M: the members of every region of every tier, as the capacity check counted them.
      expect(approved?.members).toBe(3n);
    }
  });

  it("is named by its version-5 stub hash on the coordinator's transport", () => {
    expect(hex(stubHashOf(e.stubBytes) as Uint8Array)).toBe(hex(e.stubHash));
  });
});

describe("a version-5 election's checks before intake", () => {
  it("refuses until the electorate check passes, then takes the ballot", async () => {
    let decided = false;
    const [seat] = seatsOf({
      store: new MemoryStore(),
      electorate: () => Promise.resolve(decided),
    }).intake;
    expect(await deliver(seat!)).toEqual({ ok: false, code: "intake-definition" });
    decided = true;
    expect((await deliver(seat!)).ok).toBe(true);
  });

  it("refuses until finalized L2 shows the version-5 definition registered", async () => {
    let decided = false;
    const seats = seatsOf({ store: new MemoryStore(), registered: () => decided });
    const [seat] = seats.intake;
    expect(await deliver(seat!)).toEqual({ ok: false, code: "intake-unregistered" });
    decided = true;
    expect((await deliver(seat!)).ok).toBe(true);
    expect(seats.registrations.map(hex)).toEqual(Array(2).fill(hex(election.definitionHash)));
  });

  it("refuses any transcript but the one the seat approved (T-37)", async () => {
    const [seat] = seatsOf({ store: new MemoryStore() }).intake;
    const altered = Uint8Array.from(transcript);
    altered[altered.length - 1]! ^= 1;
    expect(
      await seat!.intake(e.stubBytes, altered, honest.bytes, honest.ciphertexts[0] as Uint8Array),
    ).toEqual({ ok: false, code: "intake-transcript" });
  });
});

describe("intake of a version-3 ballot", () => {
  it("receipts a member's ballot at every seat, under the seat's registered signing key", async () => {
    const seats = seatsOf();
    for (const [i, seat] of seats.intake.entries()) {
      const out = await deliver(seat, honest.bytes, honest.ciphertexts[i]);
      if (!out.ok) expect.fail(`seat ${i + 1} refused: ${out.code}`);
      const receipt = decodeShareReceipt(out.receipt, 1);
      expect(receipt.seat).toBe(i + 1);
      expect(hex(receipt.definition_hash)).toBe(hex(election.definitionHash));
      expect(
        checkShareReceiptV3(
          registered,
          {
            definitionHash: election.definitionHash,
            cell: honest.record.cell,
            nullifier: honest.record.nullifier,
          },
          honest.record.committed_vote,
          i + 1,
          receipt.signature,
        ),
      ).toBe(true);
      // Not a receipt for any other seat's share.
      expect(
        checkShareReceiptV3(
          registered,
          {
            definitionHash: election.definitionHash,
            cell: honest.record.cell,
            nullifier: honest.record.nullifier,
          },
          honest.record.committed_vote,
          ((i + 1) % 3) + 1,
          receipt.signature,
        ),
      ).toBe(false);
      expect((await seat.receipted(e.stubHash)).map(hex)).toEqual([hex(out.ballotHash)]);
    }
    // Asked about the version-5 definition the seats approved, never a version-1 reading of it.
    expect(seats.registrations.map(hex)).toEqual(Array(3).fill(hex(election.definitionHash)));
  });

  it("refuses another seat's ciphertext, a cut record and a version-1 record, storing nothing", async () => {
    const store = new MemoryStore();
    const [seat] = seatsOf({ store }).intake;
    expect(await deliver(seat!, honest.bytes, honest.ciphertexts[1])).toEqual({
      ok: false,
      code: "share-hash",
    });
    expect(await deliver(seat!, honest.bytes.subarray(0, honest.bytes.length - 1))).toEqual({
      ok: false,
      code: "delivery-malformed",
    });
    // The same fields under version 1's layout: the election's pin decides how
    // a record is read, never the record (T-34).
    const v1 = Uint8Array.from(honest.bytes);
    v1[2] = 1;
    expect(await deliver(seat!, v1)).toEqual({ ok: false, code: "delivery-malformed" });
    expect(await store.list(`intake/${hex(e.stubHash)}`)).toEqual([]);
  });

  it("refuses a ballot whose membership proof doesn't verify (T-52)", async () => {
    const store = new MemoryStore();
    const [seat] = seatsOf({ store }).intake;
    // Another L1 reference changes M, which the proof binds.
    const tampered = encodeBallotV3({
      ...honest.record,
      l1_ref_number: honest.record.l1_ref_number + 1n,
    });
    expect(await deliver(seat!, tampered)).toEqual({ ok: false, code: "membership-proof" });
    expect(await store.list(`intake/${hex(e.stubHash)}`)).toEqual([]);
  });

  it("refuses a ballot naming a cell the definition doesn't have", async () => {
    const [seat] = seatsOf({ store: new MemoryStore() }).intake;
    const elsewhere = encodeBallotV3({ ...honest.record, cell: 1 });
    expect(await deliver(seat!, elsewhere)).toEqual({ ok: false, code: "ballot-cell" });
  });

  it("stays open until the intake cutoff and refuses from it on (T-54)", async () => {
    const seats = seatsOf({ store: new MemoryStore() });
    const [seat] = seats.intake;
    seats.clock = cutoff - 1n;
    expect((await deliver(seat!)).ok).toBe(true);
    seats.clock = cutoff;
    expect(await deliver(seat!)).toEqual({ ok: false, code: "intake-closed" });
  });
});
