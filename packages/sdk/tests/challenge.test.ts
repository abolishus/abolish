import {
  ballotElection,
  decodeOpening,
  encodeOpening,
  encryptShares,
  GROUP_ORDER,
  openChallenge,
  shareVote,
  trackingCode,
} from "@abolishus/crypto";
import { describe, expect, it } from "vite-plus/test";
import { planElection, type Scenario, selectionRange } from "../src/index.ts";
import { checkChallenge } from "../src/simulation/challenge.ts";
import { simulateElection } from "../src/simulation/election.ts";

const scenario: Scenario = {
  voters: 4,
  election: "plurality",
  options: 3,
  trustees: { panel: 3, threshold: 2, offline: [], faulty: [] },
  tiers: { "0": 1, "1": 0, "2": 1 },
  outage: null,
  challenges: 0,
  seed: 5,
};

// One election for every case: the ceremony is the slow part.
const simulated = simulateElection(scenario, planElection(scenario));
const election = ballotElection(simulated.definition, simulated.registered);
const keys = simulated.registered.map((r) => r.kemKey);
const { min, max } = selectionRange(scenario);
const rules = {
  optionCount: scenario.options,
  minSelections: min,
  maxSelections: max,
  threshold: scenario.trustees.threshold,
  panelSize: scenario.trustees.panel,
};

const voter = { tier: 0, votes: [1, 0, 0] } as const;

// A casting device's attempt for `votes` and `tier`: the code it shows before
// the choice, and the opening it hands over on a challenge.
function attempt(votes: readonly (0 | 1)[], tier: 0 | 2 = 0, r = rules) {
  const encrypted = encryptShares(
    { definitionHash: simulated.definitionHash },
    shareVote(r, votes),
    keys,
  );
  const code = trackingCode(election, tier, encrypted);
  return { code, bytes: encodeOpening(openChallenge(election, tier, encrypted).opening) };
}

describe("checkChallenge", { timeout: 60_000 }, () => {
  it("passes an honest opening of the recorded code that opens to the voter's choice", () => {
    const a = attempt(voter.votes);
    const v = checkChallenge(election, a.code, voter, a.bytes);
    expect(v.ok).toBe(true);
    if (v.ok) expect(encodeOpening(v.opening)).toEqual(a.bytes);
  });

  it("reports an opening that doesn't decode", () => {
    const a = attempt(voter.votes);
    expect(checkChallenge(election, a.code, voter, a.bytes.subarray(0, -1))).toMatchObject({
      ok: false,
      code: "decode",
    });
  });

  it("reports an opening for another election first, before its tier", () => {
    const a = attempt(voter.votes, 2);
    const o = decodeOpening(a.bytes, 1);
    const stray = encodeOpening({ ...o, definition_hash: new Uint8Array(32).fill(7) });
    expect(checkChallenge(election, a.code, voter, stray)).toEqual({
      ok: false,
      code: "opening-stray",
    });
  });

  it("reports an opening for another tier than the voter's, though the election has it", () => {
    const a = attempt(voter.votes, 2);
    expect(checkChallenge(election, a.code, voter, a.bytes)).toEqual({
      ok: false,
      code: "checker-tier",
    });
  });

  it("reports an opening that fails crypto's check, with its code", () => {
    const a = attempt(voter.votes);
    const o = decodeOpening(a.bytes, 1);
    const [first, ...rest] = o.polynomials;
    if (first === undefined) throw new Error("no options");
    const f = [...first.f];
    f[1] = ((f[1] as bigint) + 1n) % GROUP_ORDER;
    const tampered = encodeOpening({ ...o, polynomials: [{ f, g: first.g }, ...rest] });
    expect(checkChallenge(election, a.code, voter, tampered)).toMatchObject({
      ok: false,
      code: "opening-vss",
    });
  });

  it("reports an opening of another core than the code recorded before the choice", () => {
    const shown = attempt(voter.votes);
    const opened = attempt(voter.votes);
    expect(checkChallenge(election, shown.code, voter, opened.bytes)).toEqual({
      ok: false,
      code: "checker-code",
    });
  });

  it("reports a device that committed to another vote than the voter chose", () => {
    const a = attempt([0, 1, 0]);
    expect(checkChallenge(election, a.code, voter, a.bytes)).toEqual({
      ok: false,
      code: "checker-vote",
    });
  });

  it("reports a device that committed to a vote no valid ballot could carry", () => {
    const a = attempt([1, 1, 0], 0, { ...rules, maxSelections: 2 });
    expect(checkChallenge(election, a.code, voter, a.bytes)).toEqual({
      ok: false,
      code: "opening-vote-outside",
    });
  });
});
