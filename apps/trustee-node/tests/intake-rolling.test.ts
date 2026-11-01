// Intake of a rolling poll's ballots (P2-17 part 7c-3b): a whole ceremony
// between seats over a rolling version-7 stub, then version-5 ballots made
// as a client makes them (shares to the registered keys, validity proofs
// under the rolling scope, a real Groth16 membership proof against a step's
// root), delivered to every seat, which judges each against the root of the
// step it names, computed from the chain its `rolling` check gives, and
// only for a step the proven block is past (T-08, T-25, T-52).
//
// Stub check 4 refuses every rolling stub until roots can be sent and read
// ([[P1-12f]] parts 3b and 3c), so this file lifts that one refusal, and
// only it, as those parts will: every other check runs as the node runs it.
import { readFileSync } from "node:fs";
import {
  type BallotRecordV5,
  ballotHashV5,
  checkCeremonyTranscript,
  checkShareReceiptV5,
  decodeMembershipProof,
  decodeShareReceipt,
  type ElectionDefinitionV7,
  electionDefinitionV7Hash,
  encodeBallotV5,
  encodeElectionDefinitionV5,
  encryptSharesV4,
  finishMembershipProof,
  identityCommitment,
  membershipMessage,
  newIdentitySecret,
  proveValidityV5,
  type RegisteredKeys,
  type RollingBallotChain,
  type RollingBallotElection,
  rollingBallotElection,
  rollingMembershipNullifier,
  rollingMembershipProverInput,
  RollingTierTree,
  type RollingTierEvent,
  SEAT_PANELS,
  shareVoteV4,
} from "@abolishus/crypto";
import { type MembershipProverArtifacts, proveMembership } from "@abolishus/membership-prover";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { IntakeSeat, type SeatStore } from "../src/index.ts";
import { MAX_CLOCK_SKEW, ROLLING_CHAIN_MAX_AGE, ROLLING_CHAIN_RETRY } from "../src/intake.ts";
import { ComplaintDuty } from "../src/complaint.ts";
import { ReceiptDuty } from "../src/delivery.ts";
import { decideObligation } from "../src/obligation.ts";
import type { RollingIntakeChain } from "../src/rolling-chain.ts";
import { checkStub, type StubCheck } from "../src/stub.ts";
import { MemoryStore } from "../src/store.ts";
import {
  type ElectionV7,
  L2_CHAIN_ID,
  rollingElection,
  runCeremony,
  stubV5For,
  TRUSTEE_REGISTRY,
  value,
} from "./fixture.ts";

vi.mock(import("../src/stub.ts"), async (original) => {
  const stub = await original();
  return {
    ...stub,
    checkStub: vi.fn(async (...args: Parameters<typeof stub.checkStub>): Promise<StubCheck> => {
      const checked = await stub.checkStub(...args);
      if (checked.ok || checked.code !== "stub-capacity") return checked;
      const record = stub.decodeStub(args[0]);
      return record.version === 7
        ? { ok: true, stub: record, stubHash: stub.stubHash(record) }
        : checked;
    }),
  };
});

const ARTIFACTS = new URL(
  "../../../packages/membership-prover/artifacts/snark-artifacts/",
  import.meta.url,
);
const artifacts: MembershipProverArtifacts = {
  zkey: readFileSync(new URL("semaphore-32.zkey", ARTIFACTS)),
  wasm: readFileSync(new URL("semaphore-32.wasm", ARTIFACTS)),
};

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const GROUP = 1n;
const secrets = Array.from({ length: 3 }, () => newIdentitySecret());
const leaves = secrets.map((s) => identityCommitment(s));
// The first two members join before the opening state's block; the third
// after the definition's registration, between steps EARLY and LATE
// (boundaries τ_n = 600n + 300).
const OPENING: RollingTierEvent = {
  blockNumber: 5n,
  timestamp: 1_005_000n,
  groupId: GROUP,
  kind: "add",
  commitments: [leaves[0] as bigint, leaves[1] as bigint],
};
const JOINER: RollingTierEvent = {
  blockNumber: 20n,
  timestamp: 1_020_910n,
  groupId: GROUP,
  kind: "add",
  commitments: [leaves[2] as bigint],
};
const REGISTERED_AT = 1_010_000n;
const EARLY = 1700; // τ = 1,020,300: the opening tree
const LATE = 1702; // τ = 1,021,500: the joiner's tree too
// The proven block's timestamp: past EARLY's boundary only, then past LATE's.
const SAFE_EARLY = 1_021_000n;
const SAFE_LATE = 1_022_000n;
// The proven block's number: past the joiner's and the tier's `root_l2_block`.
const PROVEN = 30n;
const CHAIN: RollingBallotChain = { events: [OPENING, JOINER], registeredAt: REGISTERED_AT };
const VOTES = [1, 0, 1, 0, 1] as const;

const treeOf = (events: readonly RollingTierEvent[]) => {
  const tree = new RollingTierTree([GROUP]);
  for (const e of events) tree.apply(e);
  return tree;
};

interface Cast {
  readonly record: BallotRecordV5;
  readonly bytes: Uint8Array;
  /** Each seat's `ct_i`, by seat. */
  readonly ciphertexts: readonly Uint8Array[];
}

let e: ElectionV7;
let stores: SeatStore[];
let transcript: Uint8Array;
let definition: ElectionDefinitionV7;
let registered: readonly RegisteredKeys[];
let election: RollingBallotElection;
let early: Cast;
let late: Cast;

// A version-5 ballot of `voter` at `step`, against the tree of `events`, as
// the reference election's `castRolling` makes one.
async function cast(voter: number, step: number, events: readonly RollingTierEvent[]) {
  const { definitionHash } = election;
  const rules = {
    questions: election.questions,
    threshold: election.threshold,
    panelSize: election.panelSize,
    authorThreshold: election.authorThreshold,
    authorPanelSize: election.authorPanelSize,
  };
  const secret = secrets[voter] as Uint8Array;
  const sharing = shareVoteV4(rules, [...VOTES]);
  const encrypted = encryptSharesV4(
    { definitionHash },
    sharing,
    registered.map((k) => k.kemKey),
    [],
  );
  const nullifier = rollingMembershipNullifier(secret, { definitionHash, tier: 0 });
  const named = { definitionHash, cell: 0, nullifier };
  const vote = proveValidityV5({ ...rules, ...named }, sharing, encrypted.hashes, []);
  const l1Ref = { number: 100n, hash: new Uint8Array(32).fill(7) };
  const tree = treeOf(events);
  const message = membershipMessage({
    definitionHash,
    tier: 0,
    ballotHash: ballotHashV5({ ...named, step }, vote),
    l1RefNumber: l1Ref.number,
    l1RefHash: l1Ref.hash,
  });
  const input = rollingMembershipProverInput(secret, tree.leaves, {
    definitionHash,
    tier: 0,
    root: tree.root(),
    message,
  });
  const proof = finishMembershipProof(input, await proveMembership(input.witness, artifacts));
  const record: BallotRecordV5 = {
    definition_hash: definitionHash,
    cell: 0,
    nullifier,
    l1_ref_number: l1Ref.number,
    l1_ref_hash: l1Ref.hash,
    membership_proof: decodeMembershipProof(proof),
    step,
    committed_vote: vote,
  };
  return { record, bytes: encodeBallotV5(record), ciphertexts: encrypted.ciphertexts };
}

beforeAll(async () => {
  stores = [new MemoryStore(), new MemoryStore(), new MemoryStore()];
  const opening = treeOf([OPENING]);
  e = rollingElection(3, 2, {
    stores,
    stub: {
      rolling_electorate: [
        {
          tier: 0,
          root_l2_block: 7n,
          groups: [GROUP],
          root: opening.root(),
          group_size: BigInt(opening.memberCount),
        },
      ],
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
  election = rollingBallotElection(definition, registered, CHAIN);
  early = await cast(0, EARLY, [OPENING]);
  late = await cast(2, LATE, [OPENING, JOINER]);
}, 120_000);

interface Seats {
  intake: readonly IntakeSeat[];
  /** The definition hash of each chain read, in order. */
  readonly reads: string[];
  clock: bigint;
  chain: RollingIntakeChain | undefined;
}

function seatsOf(
  change: { store?: SeatStore; registered?: () => boolean; noChainCheck?: true } = {},
): Seats {
  const seats: Seats = {
    intake: [],
    reads: [],
    // Within the skew guard of both proven blocks, long before `c_I`.
    clock: SAFE_LATE,
    chain: { chain: CHAIN, safeAt: SAFE_LATE, block: PROVEN },
  };
  seats.intake = e.seats.map(
    (ceremony, i) =>
      new IntakeSeat({
        panel: e.panelists.panel,
        l2ChainId: L2_CHAIN_ID,
        trusteeRegistry: TRUSTEE_REGISTRY,
        index: i + 1,
        ceremony,
        electorate: () => Promise.resolve(true),
        registration: () => Promise.resolve(change.registered?.() ?? true),
        store: change.store ?? (stores[i] as SeatStore),
        now: () => seats.clock,
        ...(change.noChainCheck
          ? {}
          : {
              rolling: (d) => {
                seats.reads.push(hex(electionDefinitionV7Hash(d.value)));
                return Promise.resolve(seats.chain);
              },
            }),
      }),
  );
  return seats;
}

const deliver = (seat: IntakeSeat, ballot: Cast = early, index = 1, bytes = ballot.bytes) =>
  seat.intake(e.stubBytes, transcript, bytes, ballot.ciphertexts[index - 1] as Uint8Array);

describe("a rolling stub's ceremony", () => {
  it("is approved by every seat, which records the rolling flag in place of M", async () => {
    for (const seat of e.seats) {
      const approved = await seat.approvedElection(e.stubHash);
      expect(approved && hex(approved.definitionHash)).toBe(
        hex(electionDefinitionV7Hash(definition)),
      );
      expect(approved).toMatchObject({ rolling: true });
      expect(approved).not.toHaveProperty("members");
    }
  });

  it("decides no batch obligation for it: a rolling election's is its roots", async () => {
    const [seat] = e.seats;
    const approved = await seat!.approvedElection(e.stubHash);
    if (approved === undefined) expect.fail("not approved");
    const view = vi.fn(() => Promise.reject(new Error("no view is read")));
    await expect(
      decideObligation({ store: new MemoryStore(), view, now: () => e.stub.closes_at }, approved),
    ).resolves.toEqual({ state: "roots" });
    expect(view).not.toHaveBeenCalled();
  });

  it("settles its receipt and complaint duties on its roots, sending and storing nothing", async () => {
    const [seat] = e.seats;
    const approved = await seat!.approvedElection(e.stubHash);
    if (approved === undefined) expect.fail("not approved");
    const store = new MemoryStore();
    const writes = [vi.spyOn(store, "putOnce"), vi.spyOn(store, "remove")];
    const view = vi.fn(() => Promise.reject(new Error("no view is read")));
    const contract = {
      send: vi.fn(() => Promise.reject(new Error("nothing is sent"))),
      recorded: vi.fn(() => Promise.reject(new Error("nothing is read"))),
      postings: vi.fn(() => Promise.reject(new Error("nothing is read"))),
    };
    const ballots = vi.fn(() => Promise.reject(new Error("no ballot is read")));
    const base = { store, view, now: () => e.stub.closes_at + 10n ** 6n, election: approved };
    expect(await new ReceiptDuty({ ...base, contract }).step()).toEqual({ state: "roots" });
    expect(await new ComplaintDuty({ ...base, contract, ballots }).step()).toEqual({
      state: "roots",
    });
    for (const f of [view, contract.send, contract.recorded, contract.postings, ballots, ...writes])
      expect(f).not.toHaveBeenCalled();
  });

  it("is counted in later stubs' check 4 as a rolling election, with no M", async () => {
    const [seat] = e.seats;
    const other = encodeElectionDefinitionV5(stubV5For(e.panelists.panel));
    vi.mocked(checkStub).mockClear();
    await seat!.keys(other, crypto.getRandomValues(new Uint8Array(32)));
    const served = vi.mocked(checkStub).mock.calls[0]?.[3];
    expect(served && [...served.values()]).toEqual([
      {
        rolling: true,
        seats: 3,
        closesAt: e.stub.closes_at,
        l1InclusionBound: BigInt(e.stub.l1_inclusion_bound),
      },
    ]);
  });
});

describe("intake of a version-5 ballot", () => {
  it("receipts a member's ballot at a settled step at every seat, in a version-2 receipt binding the step", async () => {
    const seats = seatsOf();
    const signers = {
      default: registered.map((k) => ({ index: k.index, signingKey: k.signingKey })),
      author: [],
    };
    const named = {
      definitionHash: election.definitionHash,
      cell: 0,
      nullifier: early.record.nullifier,
    };
    for (const [i, seat] of seats.intake.entries()) {
      const out = await deliver(seat, early, i + 1);
      if (!out.ok) expect.fail(`seat ${i + 1} refused: ${out.code}`);
      const receipt = decodeShareReceipt(out.receipt, 2);
      expect(receipt).toMatchObject({ seat: i + 1, panel: SEAT_PANELS.default });
      expect(hex(receipt.definition_hash)).toBe(hex(election.definitionHash));
      expect(hex(out.ballotHash)).toBe(
        hex(ballotHashV5({ ...named, step: EARLY }, early.record.committed_vote)),
      );
      const checks = (step: number) =>
        checkShareReceiptV5(
          signers,
          { ...named, step },
          early.record.committed_vote,
          SEAT_PANELS.default,
          i + 1,
          receipt.signature,
        );
      // T-38: not a receipt for the same vote under another step.
      expect([checks(EARLY), checks(LATE)]).toEqual([true, false]);
      expect((await seat.receipted(e.stubHash)).map(hex)).toEqual([hex(out.ballotHash)]);
    }
    // The chain was read for the definition the seats registered, with its transcript.
    expect(new Set(seats.reads)).toEqual(new Set([hex(election.definitionHash)]));
  });

  it("refuses a step the proven block isn't past, storing nothing, and takes it once it is", async () => {
    const store = new MemoryStore();
    const seats = seatsOf({ store });
    const [, , seat] = seats.intake;
    seats.chain = { chain: CHAIN, safeAt: SAFE_EARLY, block: PROVEN };
    expect(await deliver(seat!, late, 3)).toEqual({ ok: false, code: "step-unsettled" });
    expect(await store.list(`intake/${hex(e.stubHash)}`)).toEqual([]);
    // Read again only once the last read is ROLLING_CHAIN_MAX_AGE old.
    seats.chain = { chain: CHAIN, safeAt: SAFE_LATE, block: PROVEN };
    seats.clock += ROLLING_CHAIN_MAX_AGE - 1n;
    expect(await deliver(seat!, late, 3)).toEqual({ ok: false, code: "step-unsettled" });
    expect(seats.reads).toHaveLength(1);
    seats.clock += 1n;
    expect((await deliver(seat!, late, 3)).ok).toBe(true);
    expect(seats.reads).toHaveLength(2);
  });

  it("refuses a step outside the poll and a ballot relabelled to another step", async () => {
    const [seat] = seatsOf({ store: new MemoryStore() }).intake;
    // Before the registration: no step there is the poll's, whatever settles.
    const before = encodeBallotV5({ ...early.record, step: 1680 });
    expect(await deliver(seat!, early, 1, before)).toEqual({
      ok: false,
      code: "root-step-range",
    });
    // The step is in the ballot hash, so M, which the proof binds (T-38).
    const relabelled = encodeBallotV5({ ...early.record, step: LATE });
    expect(await deliver(seat!, early, 1, relabelled)).toEqual({
      ok: false,
      code: "membership-proof",
    });
  });

  it("refuses with intake-chain while no chain can be had, reading again once ROLLING_CHAIN_RETRY has passed", async () => {
    const seats = seatsOf({ store: new MemoryStore() });
    const [seat] = seats.intake;
    seats.chain = undefined;
    expect(await deliver(seat!)).toEqual({ ok: false, code: "intake-chain" });
    // A failed read is kept for ROLLING_CHAIN_RETRY only (T-52).
    seats.chain = { chain: CHAIN, safeAt: SAFE_LATE, block: PROVEN };
    seats.clock += ROLLING_CHAIN_RETRY - 1n;
    expect(await deliver(seat!)).toEqual({ ok: false, code: "intake-chain" });
    expect(seats.reads).toHaveLength(1);
    seats.clock += 1n;
    expect((await deliver(seat!)).ok).toBe(true);
    expect(seats.reads).toHaveLength(2);
  });

  it("takes no rolling ballot without a chain check", async () => {
    const [seat] = seatsOf({ store: new MemoryStore(), noChainCheck: true }).intake;
    expect(await deliver(seat!)).toEqual({ ok: false, code: "intake-chain" });
  });

  it("refuses a proven block stamped further ahead of the node's clock than the skew allows (T-08)", async () => {
    const seats = seatsOf({ store: new MemoryStore() });
    const [seat] = seats.intake;
    seats.clock = SAFE_LATE - MAX_CLOCK_SKEW - ROLLING_CHAIN_RETRY;
    expect(await deliver(seat!)).toEqual({ ok: false, code: "intake-chain" });
    // Read again once the failure's ROLLING_CHAIN_RETRY has passed: the block is then at the bound.
    seats.clock += ROLLING_CHAIN_RETRY;
    expect((await deliver(seat!)).ok).toBe(true);
  });

  it("refuses a chain whose opening state isn't the definition's", async () => {
    const seats = seatsOf({ store: new MemoryStore() });
    const [seat] = seats.intake;
    seats.chain = { chain: { ...CHAIN, events: [JOINER] }, safeAt: SAFE_LATE, block: PROVEN };
    expect(await deliver(seat!)).toEqual({ ok: false, code: "intake-chain" });
  });

  it("reads no chain before finalized L2 shows the definition registered", async () => {
    let decided = false;
    const seats = seatsOf({ store: new MemoryStore(), registered: () => decided });
    const [seat] = seats.intake;
    expect(await deliver(seat!)).toEqual({ ok: false, code: "intake-unregistered" });
    expect(seats.reads).toEqual([]);
    decided = true;
    expect((await deliver(seat!)).ok).toBe(true);
  });
});
