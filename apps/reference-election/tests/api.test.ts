import { decodeBallot, encodeBallot, encodeBallotV3, identityKey } from "@abolishus/crypto";
import { hexToBytes } from "@noble/hashes/utils.js";
import { afterEach, expect, test } from "vite-plus/test";
import { type OperatorApi, startApi } from "../src/api.ts";
import {
  castingFor,
  castQuestions,
  castVote,
  electorateOf,
  newVoters,
  proverArtifacts,
  questionCastingFor,
} from "../src/casting.ts";
import {
  boardEntry,
  definitionBytes,
  displayText,
  type L2Deployment,
  newTrustees,
  placeholder,
  questionsDisplayText,
  runCeremony,
  runQuestionCeremony,
} from "../src/election.ts";

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
const PERIOD = 3600n;
// The window opens a period after the clock's epoch: the transcript is
// boarded in segment 0 and ballots in segment 1.
const clock = { epoch: timing.opensAt - PERIOD, period: PERIOD };
const refs = [
  { number: 7n, hash: new Uint8Array(32).fill(7) },
  { number: 8n, hash: new Uint8Array(32).fill(8) },
] as const;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const apis: OperatorApi[] = [];
afterEach(async () => {
  for (const a of apis.splice(0)) await a.close();
});

// A key ceremony and a depth-32 Groth16 proof: well past the 5-second default.
test(
  "the API boards an honest ballot as the fixture's board holds it, and refuses another ballot's proof, an unknown election and a ballot outside the window",
  { timeout: 120_000 },
  async () => {
    const voters = newVoters(2);
    const electorate = electorateOf(voters);
    const trustees = newTrustees();
    const c = runCeremony(timing, l2, trustees, displayText(), {
      counter: 0n,
      absent: 0,
      electorate,
    });
    const id = c.definition.value.election_id;
    const time = { now: timing.opensAt + 60n };
    const api = await startApi({ panels: [c.panel], clock, now: () => time.now });
    apis.push(api);
    await api.open(definitionBytes(c.definition), id, 0, c.transcript);

    const casting = castingFor(
      c.definition.value,
      c.panel,
      c.transcript,
      electorate,
      proverArtifacts(),
    );
    const [voter] = voters;
    if (voter === undefined) throw new Error("no voter");
    const ballot = await castVote(casting, voter, [0, 1, 0], refs[0]);
    const expected = hex(boardEntry(c.definition, 1n, 1, ballot.bytes));
    const first = await api.submit(id, ballot.bytes);
    expect(first.ok && hex(first.entry)).toBe(expected);
    // The same bytes again return the same entry, writing nothing (T-38).
    const again = await api.submit(id, ballot.bytes);
    expect(again.ok && hex(again.entry)).toBe(expected);

    // Another reference under the same proof is another M (T-45).
    const forged = encodeBallot({
      ...ballot.record,
      l1_ref_number: refs[1].number,
      l1_ref_hash: refs[1].hash,
    });
    expect(await api.submit(id, forged)).toEqual({
      ok: false,
      code: "BALLOT_REJECTED",
      admission: "membership-proof",
    });
    expect(await api.submit(hexToBytes("ab".repeat(32)), ballot.bytes)).toEqual({
      ok: false,
      code: "ELECTION_NOT_FOUND",
    });
    time.now = timing.closesAt + 1n;
    expect(await api.submit(id, forged)).toEqual({ ok: false, code: "ELECTION_NOT_OPEN" });
  },
);

test(
  "the API boards a version-3 ballot of a poll of questions as the fixture's board holds it, and refuses another ballot's proof",
  { timeout: 120_000 },
  async () => {
    const voters = newVoters(2);
    const electorate = electorateOf(voters);
    const trustees = newTrustees();
    const c = runQuestionCeremony(timing, l2, trustees, questionsDisplayText(), {
      counter: 0n,
      leaves: electorate.leaves,
      receiptKeys: [identityKey(crypto.getRandomValues(new Uint8Array(32)))],
    });
    const id = c.definition.value.election_id;
    const api = await startApi({ panels: [c.panel], clock, now: () => timing.opensAt + 60n });
    apis.push(api);
    await api.open(definitionBytes(c.definition), id, 0, c.transcript);

    const casting = questionCastingFor(
      c.definition.value,
      c.panel,
      c.transcript,
      electorate.leaves,
      proverArtifacts(),
    );
    const [voter] = voters;
    if (voter === undefined) throw new Error("no voter");
    const votes = [0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0] as const;
    const { ballot } = await castQuestions(casting, voter, votes, refs[0]);
    const submitted = await api.submit(id, ballot);
    expect(submitted.ok && hex(submitted.entry)).toBe(hex(boardEntry(c.definition, 1n, 1, ballot)));

    // Another reference under the same proof is another M (T-45).
    const forged = encodeBallotV3({
      ...decodeBallot(ballot, 3),
      l1_ref_number: refs[1].number,
      l1_ref_hash: refs[1].hash,
    });
    expect(await api.submit(id, forged)).toEqual({
      ok: false,
      code: "BALLOT_REJECTED",
      admission: "membership-proof",
    });
  },
);
