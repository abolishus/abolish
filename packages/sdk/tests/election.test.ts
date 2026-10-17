import {
  ceremonyTranscriptHash,
  checkCeremonyTranscript,
  ELECTION_TYPES,
  type ElectionDefinitionV4,
  electionDefinitionV4Hash,
  electionDefinitionV4Rule,
  electionStubV4Hash,
  identityCommitment,
  identityKey,
  panelId,
  pinnedVersion,
  profileCombinationRule,
  RECORD_TYPES,
  tierTreeRoot,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { planElection, runSimulation, type Scenario } from "../src/index.ts";
import { simulateElection } from "../src/simulation/election.ts";
import type { SimulatedTier } from "../src/simulation/scenario.ts";
import { oneQuestion } from "./one-question.ts";

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

// The board operator's receipt key, which the definition lists.
const receiptKey = () => identityKey(crypto.getRandomValues(new Uint8Array(32)));

// The ceremony's context, rebuilt from the definition alone, as a trustee
// node and the verifier rebuild it (verifier 3.2).
const params = (d: ElectionDefinitionV4, keys: readonly Uint8Array[]) => ({
  l2ChainId: d.l2_chain_id,
  trusteeRegistry: d.trustee_registry,
  electionId: d.election_id,
  stubHash: electionStubV4Hash({ ...d, ceremony_transcript_hash: new Uint8Array(32) }),
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
        const key = receiptKey();
        const e = simulateElection(s, plan, key);
        const d = oneQuestion(e.definition);
        expect(electionDefinitionV4Rule(d)).toBeUndefined();
        expect(profileCombinationRule(d)).toBeUndefined();
        expect(d.election_type).toBe(ELECTION_TYPES[s.election as "plurality" | "approval"]);
        expect(d.option_count).toBe(s.options);
        expect([d.min_selections, d.max_selections]).toEqual(
          s.election === "plurality" ? [0, 1] : [0, s.options],
        );
        expect([d.threshold, d.panel_size]).toEqual([s.trustees.threshold, s.trustees.panel]);
        // Each tier one group in one region, so one cell, as version 1's tiers were.
        expect(d.electorate.map((t) => t.tier)).toEqual(plan.tiers);
        for (const t of d.electorate) {
          const voters = plan.voters.filter((v) => v.tier === t.tier);
          const members = BigInt(Math.max(1, voters.length));
          expect(t.groups).toHaveLength(1);
          expect(t.regions).toEqual([members]);
          expect(t.cells).toHaveLength(1);
          expect(t.cells[0]?.members).toBe(members);
          // The cell's root is the tier tree of its voters' commitments, each
          // from the voter's own secret; a tier no voter is in has one member
          // no voter holds the secret of.
          const leaves = e.leaves.get(t.tier as SimulatedTier) ?? [];
          expect(BigInt(leaves.length)).toBe(members);
          expect(t.cells[0]?.root).toBe(tierTreeRoot(leaves));
          if (voters.length > 0)
            expect(new Set(leaves)).toEqual(
              new Set(voters.map((v) => identityCommitment(e.identities[v.index] as Uint8Array))),
            );
        }
        // A fresh secret per voter.
        expect(e.identities).toHaveLength(s.voters);
        expect(new Set(e.identities.map((x) => x.join())).size).toBe(s.voters);
        expect(d.receipt_keys).toEqual([key]);
        expect(pinnedVersion(d, RECORD_TYPES.electionDefinition)).toBe(4);
        expect(pinnedVersion(d, RECORD_TYPES.ballot)).toBe(2);
        expect(pinnedVersion(d, RECORD_TYPES.spoiledBallotOpening)).toBe(2);
        expect(equal(e.definitionHash, electionDefinitionV4Hash(d))).toBe(true);
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
    const e = simulateElection(base, planElection(base), receiptKey());
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
    const e = simulateElection(base, planElection(base), receiptKey());
    const other = simulateElection(base, planElection(base), receiptKey());
    expect(equal(e.definition.election_id, other.definition.election_id)).toBe(false);
    expect(equal(e.definitionHash, other.definitionHash)).toBe(false);
    const moved = checkCeremonyTranscript(
      params(
        { ...oneQuestion(e.definition), election_id: other.definition.election_id },
        panelKeys(e),
      ),
      e.transcript,
      1,
    );
    expect(moved.ok).toBe(false);
    // The same election, with any other stub field: the stub hash differs.
    const restated = checkCeremonyTranscript(
      params(
        { ...oneQuestion(e.definition), option_count: oneQuestion(e.definition).option_count + 1 },
        panelKeys(e),
      ),
      e.transcript,
      1,
    );
    expect(restated.ok).toBe(false);
    // The receipt keys are in the stub, so the ceremony fixes them too (T-26).
    const rekeyed = checkCeremonyTranscript(
      params(
        { ...oneQuestion(e.definition), receipt_keys: other.definition.receipt_keys },
        panelKeys(e),
      ),
      e.transcript,
      1,
    );
    expect(rekeyed.ok).toBe(false);
    const swapped = checkCeremonyTranscript(
      params(oneQuestion(e.definition), panelKeys(other)),
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
