import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCeremonyTranscript,
  decodeCeremonyRegistration,
  deliveryDeadlines,
  identityKey,
  keySetHash,
  verifyCeremonyRegistration,
} from "@abolishus/crypto";
import { afterEach, expect, test } from "vite-plus/test";
import { castingFor, castVote, electorateOf, newVoters, proverArtifacts } from "../src/casting.ts";
import {
  boundDefinition,
  displayText,
  type L2Deployment,
  newTrustees,
  placeholder,
  singleStub,
  type Trustees,
} from "../src/election.ts";
import {
  electorateCheck,
  nodeCeremony,
  nodeIntake,
  nodeKeys,
  registrationFrom,
  type SeatNode,
  type ServedSeats,
  serveSeats,
  startSeats,
  stubOf,
} from "../src/seats.ts";
import { intake } from "../src/tally.ts";

const l2: L2Deployment = {
  l2ChainId: 31338n,
  electionRegistry: placeholder("test/election-registry"),
  board: placeholder("test/board"),
  trusteeRegistry: placeholder("test/trustee-registry"),
  groupRegistry: placeholder("test/group-registry"),
  l1Relay: placeholder("test/l1-relay"),
};
const timing = {
  l1ChainId: 31337n,
  l1Anchor: placeholder("test/anchor"),
  opensAt: 1_800_000_000n,
  closesAt: 1_800_001_800n,
  inclusionBound: 600,
};
const ref = { number: 7n, hash: new Uint8Array(32).fill(7) };
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const roots: string[] = [];
const served: ServedSeats[] = [];
afterEach(async () => {
  for (const e of served.splice(0)) await e.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

interface Setup {
  readonly root: string;
  readonly trustees: Trustees;
  readonly nodes: readonly SeatNode[];
  readonly voters: ReturnType<typeof newVoters>;
  readonly electorate: ReturnType<typeof electorateOf>;
  readonly clock: { now: bigint };
  readonly registered: { value: boolean };
}

async function setup(): Promise<Setup> {
  const root = mkdtempSync(join(tmpdir(), "reference-election-seats-test-"));
  roots.push(root);
  const trustees = newTrustees();
  const voters = newVoters(2);
  const electorate = electorateOf(voters);
  const clock = { now: timing.opensAt };
  const registered = { value: true };
  const nodes = await startSeats(root, trustees, {
    l2ChainId: l2.l2ChainId,
    trusteeRegistry: l2.trusteeRegistry,
    electorate: electorateCheck(electorate),
    registration: () => Promise.resolve(registered.value),
    now: () => clock.now,
  });
  return { root, trustees, nodes, voters, electorate, clock, registered };
}

const stubFor = (s: Setup, counter = 0n) =>
  singleStub(timing, l2, s.trustees.panel, displayText(), { counter, electorate: s.electorate });

// Seven nodes' ceremonies, each round's proofs and records on disk: past the 5-second default.
test(
  "every node approves an honest ceremony, and their approvals make a record the registry accepts",
  { timeout: 120_000 },
  async () => {
    const s = await setup();
    const stub = stubFor(s);
    const run = await nodeCeremony(s.nodes, stub, 0);
    const approvals = run.approvals.map((a) => {
      if (!a.ok) throw new Error(`refused: ${a.code}`);
      return a.value;
    });
    const record = decodeCeremonyRegistration(
      registrationFrom(stub, s.trustees.panel, run, approvals),
    );
    const check = checkCeremonyTranscript(
      {
        l2ChainId: stub.l2_chain_id,
        trusteeRegistry: stub.trustee_registry,
        electionId: stub.election_id,
        stubHash: run.stubHash,
        panel: s.trustees.panel,
      },
      run.transcript,
      1,
    );
    if (!check.ok) throw new Error(check.code);
    expect(record.approvals.map((a) => a.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const a of record.approvals)
      expect(
        verifyCeremonyRegistration(
          s.trustees.panel,
          {
            l2ChainId: l2.l2ChainId,
            trusteeRegistry: l2.trusteeRegistry,
            index: a.index,
            stubHash: run.stubHash,
            ceremonyTranscriptHash: check.hash,
            keySetHash: keySetHash(record.keySet),
          },
          a.signature,
        ),
      ).toBe(true);
    // The keys the fixture tallies with are the ones the transcript registered.
    const keys = await nodeKeys(s.nodes, run.stubHash);
    expect(keys.map((k) => hex(identityKey(k.signingSecret)))).toEqual(
      check.registered.map((k) => hex(k.signingKey)),
    );
    expect(hex(boundDefinition(stub, run.transcript).value.ceremony_transcript_hash)).toBe(
      hex(check.hash),
    );
  },
);

test(
  "an approval of another transcript is never put in the record",
  { timeout: 120_000 },
  async () => {
    const s = await setup();
    const one = stubFor(s, 0n);
    const other = stubFor(s, 1n);
    const a = await nodeCeremony(s.nodes, one, 0);
    const b = await nodeCeremony(s.nodes, other, 0);
    const approvals = [...a.approvals, ...b.approvals].map((r) => {
      if (!r.ok) throw new Error(`refused: ${r.code}`);
      return r.value;
    });
    expect(() => registrationFrom(one, s.trustees.panel, a, approvals)).toThrow(
      /approved another key set or transcript/,
    );
  },
);

test(
  "a ceremony two seats sat out is refused by every node that ran it, and leaves no keys",
  { timeout: 120_000 },
  async () => {
    const s = await setup();
    const run = await nodeCeremony(s.nodes, stubFor(s), 2);
    expect(run.approvals.map((a) => (a.ok ? "approved" : a.code))).toEqual(
      Array(5).fill("participation"),
    );
    expect(await nodeKeys(s.nodes, run.stubHash)).toEqual([]);
  },
);

test("the electorate check takes only the voters' one Tier 0 tree", async () => {
  const s = await setup();
  const check = electorateCheck(s.electorate);
  const stub = stubFor(s);
  const [tier] = stub.electorate;
  if (tier === undefined) throw new Error("no tier");
  const v1 = (value: typeof stub) => ({ version: 1 as const, value });
  expect(await check(v1(stub))).toBe(true);
  for (const other of [
    { ...tier, root: s.electorate.root + 1n },
    { ...tier, group_size: s.electorate.size + 1n },
    { ...tier, group_id: 2n },
    { ...tier, tier: 1 as const },
  ])
    expect(await check(v1({ ...stub, electorate: [other] }))).toBe(false);
  expect(await check(v1({ ...stub, electorate: [tier, tier] }))).toBe(false);
});

// A ceremony and a depth-32 Groth16 proof: well past the 5-second default.
test(
  "every node receipts an honest ballot delivered to its endpoint as its keys sign it, and refuses it unregistered or past the cutoff",
  { timeout: 180_000 },
  async () => {
    const s = await setup();
    const stub = stubFor(s);
    const run = await nodeCeremony(s.nodes, stub, 0);
    const { value } = boundDefinition(stub, run.transcript);
    expect(hex(stubOf(value))).toBe(hex(run.stubBytes));
    const casting = castingFor(
      value,
      s.trustees.panel,
      run.transcript,
      s.electorate,
      proverArtifacts(),
    );
    const [voter] = s.voters;
    if (voter === undefined) throw new Error("no voter");
    const ballot = await castVote(casting, voter, [0, 1, 0], ref);
    const seats = await serveSeats(s.root, s.nodes);
    served.push(seats);
    const deliver = () =>
      nodeIntake(seats.endpoints, value, run.transcript, ballot.bytes, ballot.ciphertexts);

    // Until the registry shows the definition, no node takes it.
    s.registered.value = false;
    await expect(deliver()).rejects.toThrow(/intake-unregistered/);
    s.registered.value = true;

    const signed = await deliver();
    const own = intake(
      casting.election,
      await nodeKeys(s.nodes, run.stubHash),
      ballot.bytes,
      ballot.ciphertexts,
    );
    expect(signed.map(hex)).toEqual(own.receipts.map(hex));

    s.clock.now = deliveryDeadlines(timing.closesAt, BigInt(timing.inclusionBound)).delivery;
    await expect(deliver()).rejects.toThrow(/intake-closed/);
  },
);
