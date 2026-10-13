import {
  ceremonyTranscriptHash,
  checkCeremonyTranscript,
  ELECTION_TYPES,
  type ElectionDefinition,
  electionDefinitionHash,
  electionDefinitionRule,
  electionStubHash,
  identityKey,
  panelId,
  pinnedVersion,
  RECORD_TYPES,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { planElection, runSimulation, type Scenario } from "../src/index.ts";
import { simulateElection } from "../src/simulation/election.ts";

// The ceremony costs n² ML-KEM challenges, so the property runs a twentieth
// of the usual count (at least 10).
const numRuns = Math.max(10, Math.floor(Number(process.env["FC_NUM_RUNS"] ?? 100) / 20));
const timeout = 240_000;

const base: Scenario = {
  voters: 9,
  election: "plurality",
  options: 3,
  trustees: { panel: 4, threshold: 2, offline: [2], faulty: [], departures: [] },
  tiers: { "0": 2, "1": 1, "2": 1 },
  outage: null,
  challenges: 0,
  revotes: 0,
  publications: 0,
  postings: 0,
  reorgs: 0,
  seed: 3,
};

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// The ceremony's context, rebuilt from the definition alone, as a trustee
// node and the verifier rebuild it (verifier 3.2).
const params = (d: ElectionDefinition, keys: readonly Uint8Array[]) => ({
  l2ChainId: d.l2_chain_id,
  trusteeRegistry: d.trustee_registry,
  electionId: d.election_id,
  stubHash: electionStubHash({ ...d, ceremony_transcript_hash: new Uint8Array(32) }),
  panel: { threshold: d.threshold, keys },
});

const panelKeys = (e: ReturnType<typeof simulateElection>) =>
  e.seats.map((s) => identityKey(s.identitySecret));

const scenario = fc.record({
  voters: fc.integer({ min: 1, max: 40 }),
  election: fc.constantFrom("plurality" as const, "approval" as const),
  options: fc.integer({ min: 2, max: 64 }),
  trustees: fc.integer({ min: 2, max: 7 }).chain((panel) =>
    fc.integer({ min: 2, max: panel }).map((threshold) => ({
      panel,
      threshold,
      offline: [] as number[],
      faulty: [] as number[],
      departures: [],
    })),
  ),
  tiers: fc.record({
    "0": fc.integer({ min: 0, max: 3 }),
    "1": fc.integer({ min: 0, max: 3 }),
    "2": fc.integer({ min: 1, max: 3 }),
  }),
  outage: fc.constant(null),
  challenges: fc.constant(0),
  revotes: fc.constant(0),
  publications: fc.constant(0),
  postings: fc.constant(0),
  reorgs: fc.constant(0),
  seed: fc.integer({ min: 0, max: 0xffff_ffff }),
});

describe("simulateElection", { timeout }, () => {
  it("builds a well-formed definition from the scenario that binds a transcript the ceremony check passes", () => {
    fc.assert(
      fc.property(scenario, (s: Scenario) => {
        const plan = planElection(s);
        const e = simulateElection(s, plan);
        const d = e.definition;
        expect(electionDefinitionRule(d)).toBeUndefined();
        expect(d.election_type).toBe(ELECTION_TYPES[s.election]);
        expect(d.option_count).toBe(s.options);
        expect([d.min_selections, d.max_selections]).toEqual(
          s.election === "plurality" ? [0, 1] : [0, s.options],
        );
        expect([d.threshold, d.panel_size]).toEqual([s.trustees.threshold, s.trustees.panel]);
        expect(d.electorate.map((g) => g.tier)).toEqual(plan.tiers);
        for (const g of d.electorate) {
          const voters = plan.voters.filter((v) => v.tier === g.tier).length;
          expect(g.group_size).toBe(BigInt(Math.max(1, voters)));
        }
        expect(pinnedVersion(d, RECORD_TYPES.ballot)).toBe(1);
        expect(equal(e.definitionHash, electionDefinitionHash(d))).toBe(true);
        expect(equal(d.ceremony_transcript_hash, ceremonyTranscriptHash(e.transcript))).toBe(true);
        expect(equal(d.panel_id, panelId({ threshold: d.threshold, keys: panelKeys(e) }))).toBe(
          true,
        );
        const checked = checkCeremonyTranscript(params(d, panelKeys(e)), e.transcript, 1);
        expect(checked.ok).toBe(true);
        if (checked.ok) {
          expect(checked.registered.map((r) => r.index)).toEqual(
            Array.from({ length: s.trustees.panel }, (_, i) => i + 1),
          );
          expect(equal(checked.hash, e.transcriptHash)).toBe(true);
        }
      }),
      { numRuns },
    );
  });

  it("registers each seat's own keys, so a ballot is encrypted to the seat that decrypts it", () => {
    const e = simulateElection(base, planElection(base));
    for (const [i, r] of e.registered.entries()) {
      const seat = e.seats[i];
      expect(r.index).toBe(seat?.index);
      expect(equal(r.kemKey.ek, seat?.kem.publicKey.ek ?? new Uint8Array())).toBe(true);
      expect(seat !== undefined && r.kemKey.dh.equals(seat.kem.publicKey.dh)).toBe(true);
    }
  });

  // The transcript is signed over the stub, so it can't be moved to another
  // election, or used with another panel (T-37).
  it("binds the transcript to its own election and panel", () => {
    const e = simulateElection(base, planElection(base));
    const other = simulateElection(base, planElection(base));
    expect(equal(e.definition.election_id, other.definition.election_id)).toBe(false);
    expect(equal(e.definitionHash, other.definitionHash)).toBe(false);
    const moved = checkCeremonyTranscript(
      params({ ...e.definition, election_id: other.definition.election_id }, panelKeys(e)),
      e.transcript,
      1,
    );
    expect(moved.ok).toBe(false);
    // The same election, with any other stub field: the stub hash differs.
    const restated = checkCeremonyTranscript(
      params({ ...e.definition, option_count: e.definition.option_count + 1 }, panelKeys(e)),
      e.transcript,
      1,
    );
    expect(restated.ok).toBe(false);
    const swapped = checkCeremonyTranscript(
      params(e.definition, panelKeys(other)),
      e.transcript,
      1,
    );
    expect(swapped.ok).toBe(false);
  });
});

describe("runSimulation's ceremony", { timeout }, () => {
  it("reports the definition and transcript hashes, with offline seats registered before they go down", async () => {
    const r = await runSimulation(base);
    expect(r.ok).toBe(true);
    expect(r.definition.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.ceremony.transcriptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.ceremony.registered).toEqual([1, 2, 3, 4]);
    expect(r.trustees.offline).toEqual([2]);
  });
});
