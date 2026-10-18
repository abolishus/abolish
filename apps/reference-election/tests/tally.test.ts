import {
  checkDestruction,
  checkTally,
  decodeBallot,
  decodeShareReceipt,
  tallyRules,
} from "@abolishus/crypto";
import { expect, test } from "vite-plus/test";
import { castingFor, castVote, electorateOf, newVoters, proverArtifacts } from "../src/casting.ts";
import {
  definitionHash,
  displayText,
  type L2Deployment,
  newTrustees,
  placeholder,
  runCeremony,
} from "../src/election.ts";
import { type Counted, destructionStatements, intake, tallyOpening } from "../src/tally.ts";

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

// A key ceremony and two depth-32 Groth16 proofs: well past the 5-second default.
test(
  "every seat's receipts deliver the ballots, the cell opens to the votes cast, and every seat states destruction",
  { timeout: 180_000 },
  async () => {
    const voters = newVoters(2);
    const electorate = electorateOf(voters);
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
    const hash = definitionHash(c.definition);
    const ballots: Counted[] = [];
    for (const [i, votes] of [
      [0, [0, 1, 0]],
      [1, [0, 1, 0]],
    ] as const) {
      const voter = voters[i];
      if (voter === undefined) throw new Error("no voter");
      const ballot = await castVote(casting, voter, votes, ref);
      const taken = intake(casting.election, c.secrets, ballot.bytes, ballot.ciphertexts);
      // One receipt and one set of shares per seat, each receipt naming its seat.
      expect(taken.receipts.map((r) => decodeShareReceipt(r, 1).seat)).toEqual([
        1, 2, 3, 4, 5, 6, 7,
      ]);
      expect([...taken.shares.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7]);
      ballots.push({ payload: ballot.bytes, shares: taken.shares });
    }

    const vss = ballots.map((b) => decodeBallot(b.payload, 1).committed_vote.vss);

    const opening = tallyOpening(c.definition, casting.registered, c.secrets, ballots);
    const tally = checkTally(
      { definitionHash: hash, rules: tallyRules(c.definition), registered: casting.registered },
      [vss],
      [opening],
      1,
    );
    expect(tally.ok).toBe(true);
    const [cell] = tally.cells;
    expect(cell?.ok && cell.counts).toEqual([0n, 2n, 0n]);
    // Signed by seat 1, the lowest seat combined, under its registered key.
    expect(cell?.passing.map((p) => p.signer)).toEqual([1]);

    // Statements one segment after the opening's are each seat's own, in time.
    const destruction = checkDestruction(
      { definitionHash: hash, registered: casting.registered },
      destructionStatements(c.definition, c.secrets).map((payload) => ({ segment: 5, payload })),
      { firstPassing: [4], windowSegment: 200 },
      1,
    );
    expect(destruction.seats.map((s) => s.code)).toEqual(Array(7).fill("destroyed"));
    expect(destruction.unattributed).toEqual([]);
  },
);

test(
  "a seat holding no share of a counted ballot can't sum, so no opening is made",
  { timeout: 120_000 },
  async () => {
    const voters = newVoters(1);
    const electorate = electorateOf(voters);
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
    const [voter] = voters;
    if (voter === undefined) throw new Error("no voter");
    const ballot = await castVote(casting, voter, [1, 0, 0], ref);
    const taken = intake(casting.election, c.secrets, ballot.bytes, ballot.ciphertexts);
    const shares = new Map(taken.shares);
    shares.delete(3);
    expect(() =>
      tallyOpening(c.definition, casting.registered, c.secrets, [
        { payload: ballot.bytes, shares },
      ]),
    ).toThrow("seat 3 holds no share of a ballot");
  },
);
