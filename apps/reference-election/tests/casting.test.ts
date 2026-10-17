import {
  checkBallot,
  checkChallengeOpening,
  decodeBallot,
  decodeOpening,
  tierTreeRoot,
} from "@abolishus/crypto";
import { expect, test } from "vite-plus/test";
import {
  castingFor,
  castVote,
  challengeVote,
  electorateOf,
  newVoters,
  proverArtifacts,
} from "../src/casting.ts";
import {
  displayText,
  type L2Deployment,
  newTrustees,
  placeholder,
  runCeremony,
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
    const casting = castingFor(c.definition, c.panel, c.transcript, electorate, artifacts);
    // A verifier's context, built apart from the casting device's.
    const other = castingFor(c.definition, c.panel, c.transcript, electorate, artifacts);
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
  const casting = castingFor(c.definition, c.panel, c.transcript, electorate, proverArtifacts());
  await expect(castVote(casting, outsider, [1, 0, 0], ref)).rejects.toThrow("not-a-member");
});
