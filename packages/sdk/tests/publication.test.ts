import {
  ballotElection,
  decodeOpening,
  type Element,
  encodeOpening,
  encryptShares,
  openChallenge,
  shareVote,
} from "@abolishus/crypto";
import { describe, expect, it } from "vite-plus/test";
import { planElection, type Scenario, selectionRange } from "../src/index.ts";
import { simulateElection } from "../src/simulation/election.ts";
import { admitOpening, type OpeningDesk } from "../src/simulation/publication.ts";

const scenario: Scenario = {
  voters: 4,
  election: "plurality",
  options: 3,
  trustees: { panel: 3, threshold: 2, offline: [], faulty: [], departures: [] },
  tiers: { "0": 1, "1": 0, "2": 0 },
  outage: null,
  challenges: 1,
  revotes: 0,
  publications: 1,
  postings: 1,
  seed: 9,
};

// One election for every case: the ceremony is the slow part.
const simulated = simulateElection(scenario, planElection(scenario));
const election = ballotElection(simulated.definition, simulated.registered);
const { definitionHash } = simulated;
const keys = simulated.registered.map((r) => r.kemKey);
const { min, max } = selectionRange(scenario);
const rules = {
  optionCount: scenario.options,
  minSelections: min,
  maxSelections: max,
  threshold: scenario.trustees.threshold,
  panelSize: scenario.trustees.panel,
};

// A challenged attempt's opening, as its voter's checker hands it over.
function opened(votes: readonly (0 | 1)[] = [0, 1, 0]) {
  const encrypted = encryptShares({ definitionHash }, shareVote(rules, votes), keys);
  return openChallenge(election, 0, encrypted);
}

// A counted ballot's commitments: another attempt's, never opened.
const other = opened([1, 0, 0]).opening;
const desk: OpeningDesk = {
  election,
  counted: [{ definitionHash, vss: other.vss }],
  countedUntil: 10,
  openingsUntil: 20,
};

describe("admitOpening", { timeout: 60_000 }, () => {
  it("admits an honest opening after the counted extent, with its core hash and vote, once", () => {
    const { opening, coreHash } = opened();
    const held = new Set<string>();
    const payload = encodeOpening(opening);
    const first = admitOpening(desk, held, 11, payload);
    expect(first).toMatchObject({ ok: true, votes: [0n, 1n, 0n] });
    if (first.ok) expect(first.coreHash).toEqual(coreHash);
    // The last segment of the window still takes one.
    expect(admitOpening(desk, new Set(), 20, payload).ok).toBe(true);
    // The same core again, even in another period, is a repeat.
    expect(admitOpening(desk, held, 12, payload)).toEqual({ ok: false, code: "opening-repeat" });
  });

  it("refuses an opening that doesn't decode or fails the opening checks, before any window", () => {
    const payload = encodeOpening(opened().opening);
    expect(admitOpening(desk, new Set(), 11, payload.subarray(0, -1))).toEqual({
      ok: false,
      code: "decode",
    });
    const o = decodeOpening(payload, 1);
    const stray = encodeOpening({ ...o, definition_hash: new Uint8Array(32).fill(7) });
    // Checked before the window: a stray opening boarded early is still stray.
    expect(admitOpening(desk, new Set(), 3, stray)).toEqual({ ok: false, code: "opening-stray" });
    const tampered = encodeOpening({
      ...o,
      polynomials: o.polynomials.map((p, j) => (j === 1 ? { f: [...p.f].reverse(), g: p.g } : p)),
    });
    expect(admitOpening(desk, new Set(), 11, tampered)).toMatchObject({
      ok: false,
      code: "opening-vss",
    });
  });

  it("refuses an opening at or before s_S and after the openings' window", () => {
    const payload = encodeOpening(opened().opening);
    expect(admitOpening(desk, new Set(), 10, payload)).toEqual({
      ok: false,
      code: "opening-early",
    });
    expect(admitOpening(desk, new Set(), 0, payload)).toEqual({
      ok: false,
      code: "opening-early",
    });
    expect(admitOpening(desk, new Set(), 21, payload)).toEqual({
      ok: false,
      code: "opening-late",
    });
  });

  it("refuses an opening of a commitment a counted ballot carries, whatever its tracking code", () => {
    const { opening } = opened();
    const payload = encodeOpening(opening);
    // The opened commitments of one option, cast under other share hashes and
    // another option order: the tracking code differs, the commitment doesn't.
    const cast = {
      definitionHash,
      vss: [other.vss[0], opening.vss[2], other.vss[1]].map((row) => row as Element[]),
    };
    const castDesk = { ...desk, counted: [...desk.counted, cast] };
    expect(admitOpening(castDesk, new Set(), 11, payload)).toEqual({
      ok: false,
      code: "opening-cast",
    });
    // A refused opening isn't held, so it isn't a repeat when it comes back
    // to a desk where it is admissible.
    const held = new Set<string>();
    admitOpening(castDesk, held, 11, payload);
    expect(admitOpening(desk, held, 11, payload).ok).toBe(true);
    // Under another definition hash nothing is cast.
    const elsewhere = { ...cast, definitionHash: new Uint8Array(32).fill(1) };
    expect(admitOpening({ ...desk, counted: [elsewhere] }, new Set(), 11, payload).ok).toBe(true);
  });
});
