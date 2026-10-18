import {
  checkBallot,
  checkBallotV3,
  checkChallengeOpening,
  checkChallengeOpeningV2,
  decodeBallot,
  decodeOpening,
  identityKey,
  tierTreeRoot,
} from "@abolishus/crypto";
import { expect, test } from "vite-plus/test";
import {
  castingFor,
  castQuestions,
  castVote,
  challengeQuestions,
  challengeVote,
  electorateOf,
  newVoters,
  proverArtifacts,
  questionCastingFor,
} from "../src/casting.ts";
import {
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
const ref = { number: 7n, hash: new Uint8Array(32).fill(7) };

test("the electorate is the tier tree of the voters' commitments, in order", () => {
  const voters = newVoters(3);
  const e = electorateOf(voters);
  expect(e.leaves).toEqual(voters.map((v) => v.commitment));
  expect(e.root).toBe(tierTreeRoot(e.leaves));
  expect(e.size).toBe(3n);
  expect(new Set(e.leaves).size).toBe(3);
});

// A key ceremony and a depth-32 Groth16 proof: well past the 5-second default.
test(
  "a cast ballot passes admission under a context of its own, and a challenge opens to its vote",
  { timeout: 120_000 },
  async () => {
    const voters = newVoters(3);
    const electorate = electorateOf(voters);
    const trustees = newTrustees();
    const c = runCeremony(timing, l2, trustees, displayText(), {
      counter: 0n,
      absent: 0,
      electorate,
    });
    const artifacts = proverArtifacts();
    const casting = castingFor(c.definition.value, c.panel, c.transcript, electorate, artifacts);
    // A verifier's context, built apart from the casting device's.
    const other = castingFor(c.definition.value, c.panel, c.transcript, electorate, artifacts);
    const [voter] = voters;
    if (voter === undefined) throw new Error("no voter");

    const ballot = await castVote(casting, voter, [0, 1, 0], ref);
    const decoded = decodeBallot(ballot.bytes, 1);
    const checked = checkBallot(other.election, decoded);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.l1RefNumber).toBe(ref.number);
    // Another reference under the same proof is another M: refused (T-45).
    expect(
      checkBallot(other.election, { ...decoded, l1_ref_hash: new Uint8Array(32).fill(8) }),
    ).toMatchObject({ ok: false, code: "membership-proof" });

    const challenge = challengeVote(casting, [1, 0, 0]);
    const opened = checkChallengeOpening(other.election, decodeOpening(challenge.opening, 1));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.coreHash).toEqual(challenge.shown);
    expect(opened.votes).toEqual([1n, 0n, 0n]);
  },
);

test("a voter outside the group is refused before any proving", { timeout: 60_000 }, async () => {
  const [member, outsider] = newVoters(2);
  if (member === undefined || outsider === undefined) throw new Error("no voters");
  const electorate = electorateOf([member]);
  const c = runCeremony(timing, l2, newTrustees(), displayText(), {
    counter: 0n,
    absent: 0,
    electorate,
  });
  const casting = castingFor(
    c.definition.value,
    c.panel,
    c.transcript,
    electorate,
    proverArtifacts(),
  );
  await expect(castVote(casting, outsider, [1, 0, 0], ref)).rejects.toThrow("not-a-member");
});

test(
  "a poll of questions: its definition is version 5 with one cell, a cast ballot passes admission under a context of its own, and a challenge opens to its answers",
  { timeout: 120_000 },
  async () => {
    const voters = newVoters(3);
    const { leaves } = electorateOf(voters);
    // Given in descending order of their encodings, so the stub must sort them.
    const keys = [1, 2].map((b) => identityKey(new Uint8Array(32).fill(b)));
    keys.sort((a, b) => Buffer.compare(b, a));
    const c = runQuestionCeremony(timing, l2, newTrustees(), questionsDisplayText(), {
      counter: 0n,
      leaves,
      receiptKeys: keys,
    });
    const d = c.definition.value;
    expect(c.definition.version).toBe(5);
    expect(d.questions.map((q) => [q.option_count, q.min_selections, q.max_selections])).toEqual([
      [3, 0, 1],
      [4, 0, 4],
      [4, 2, 2],
    ]);
    // One region of three members, below the floor: one cell, the group's tree.
    expect(d.electorate).toHaveLength(1);
    expect(d.electorate[0]?.regions).toEqual([3n]);
    expect(d.electorate[0]?.cells).toEqual([{ root: tierTreeRoot(leaves), members: 3n }]);
    // Listed in ascending order of their encodings, as the rule requires.
    expect(d.receipt_keys).toEqual([...keys].reverse());

    const artifacts = proverArtifacts();
    const casting = questionCastingFor(d, c.panel, c.transcript, leaves, artifacts);
    const other = questionCastingFor(d, c.panel, c.transcript, leaves, artifacts);
    const [voter] = voters;
    if (voter === undefined) throw new Error("no voter");

    const votes = [0, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0] as const;
    const { ballot: bytes, ciphertexts } = await castQuestions(casting, voter, votes, ref);
    // One ciphertext for each seat, whose hash the ballot carries.
    expect(ciphertexts.map((x) => x.seat)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const decoded = decodeBallot(bytes, 3);
    const checked = checkBallotV3(other.election, decoded);
    expect(checked.ok).toBe(true);
    expect(decoded.cell).toBe(0);
    expect(decoded.l1_ref_number).toBe(ref.number);
    expect(
      checkBallotV3(other.election, { ...decoded, l1_ref_hash: new Uint8Array(32).fill(8) }),
    ).toMatchObject({ ok: false, code: "membership-proof" });

    const challenge = challengeQuestions(casting, votes);
    const opened = checkChallengeOpeningV2(other.election, decodeOpening(challenge.opening, 2));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.coreHash).toEqual(challenge.shown);
    expect(opened.votes).toEqual(votes.map(BigInt));
    expect(opened.withinRules).toBe(true);
  },
);

test(
  "answers outside a question's limits are refused before anything is sealed",
  { timeout: 60_000 },
  () => {
    const voters = newVoters(1);
    const { leaves } = electorateOf(voters);
    const c = runQuestionCeremony(timing, l2, newTrustees(), questionsDisplayText(), {
      counter: 0n,
      leaves,
      receiptKeys: [identityKey(new Uint8Array(32).fill(1))],
    });
    const casting = questionCastingFor(
      c.definition.value,
      c.panel,
      c.transcript,
      leaves,
      proverArtifacts(),
    );
    // Two picks under pick one, then one pick under pick exactly two.
    const outside = "a question's selection count is outside its limits";
    expect(() => challengeQuestions(casting, [1, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0])).toThrow(outside);
    expect(() => challengeQuestions(casting, [1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0])).toThrow(outside);
    // Too few answers for the poll's 11 options.
    expect(() => challengeQuestions(casting, [1, 0, 0])).toThrow("one entry per flat option");
  },
);
