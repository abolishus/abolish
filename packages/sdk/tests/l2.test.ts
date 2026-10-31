import {
  cellBallotElection,
  electionDefinitionV4Hash,
  electionId,
  electionStubV4Hash,
  identityKey,
  keySetHash,
  type Panel,
  panelId,
  PARAMETERS,
  signCeremonyRegistration,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { planElection, runSimulation, type Scenario } from "../src/index.ts";
import { SIMULATED_CREATOR, simulateElection } from "../src/simulation/election.ts";
import {
  type CeremonyRegistrationRecord,
  l2BlockAt,
  rule7Quorum,
  SIMULATED_L2_BLOCK_TIME,
  SIMULATED_REGISTRATION_LEAD,
  SimulatedElectionRegistry,
  SimulatedTrusteeRegistry,
} from "../src/simulation/l2.ts";
import { oneQuestion } from "./one-question.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const timeout = 240_000;

const base: Scenario = {
  voters: 6,
  election: "plurality",
  options: 2,
  trustees: { panel: 4, threshold: 2, offline: [3], faulty: [], departures: [] },
  tiers: { "0": 1, "1": 1, "2": 1 },
  outage: null,
  challenges: 0,
  revotes: 0,
  publications: 0,
  postings: 0,
  reorgs: 0,
  seed: 11,
};

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const receiptKey = () => identityKey(crypto.getRandomValues(new Uint8Array(32)));

// One ceremony shared by every case: it costs n² ML-KEM challenges.
const e = simulateElection(base, planElection(base), receiptKey());
const d = oneQuestion(e.definition);
const stubHash = electionStubV4Hash(d);
const quorum = rule7Quorum(e.panel);

// A trustee registry deployed as the run's is, with nothing recorded yet.
const trustees = (panel: Panel = e.panel, q = quorum) =>
  new SimulatedTrusteeRegistry(e.deployment.l2ChainId, e.deployment.trusteeRegistry, [
    { panel, quorum: q },
  ]);

const refusalOf = (r: SimulatedTrusteeRegistry, record: CeremonyRegistrationRecord) => {
  const result = r.registerCeremony(record);
  return result.ok ? "ok" : result.refusal;
};

// An election registry over a trustee registry holding the run's ceremony,
// with the run's election created, so its identifier is the definition's.
const elections = (recorded = true) => {
  const t = trustees();
  if (recorded) t.registerCeremony(e.registration);
  const r = new SimulatedElectionRegistry(e.deployment, t);
  expect(equal(r.createElection(SIMULATED_CREATOR), d.election_id)).toBe(true);
  return r;
};
const before = l2BlockAt(d.opens_at - SIMULATED_REGISTRATION_LEAD);

describe("the simulated election's registration", { timeout }, () => {
  it("takes its identifier from the registry's first election and registers the definition's hash", () => {
    expect(equal(d.election_id, electionId(d.l2_chain_id, e.deployment.electionRegistry, 0n))).toBe(
      true,
    );
    expect(equal(d.election_registry, e.deployment.electionRegistry)).toBe(true);
    expect(equal(d.trustee_registry, e.deployment.trusteeRegistry)).toBe(true);
    const held = e.electionRegistry.definitionHashOf(d.election_id);
    expect(held !== undefined && equal(held, electionDefinitionV4Hash(d))).toBe(true);
    expect(
      e.trusteeRegistry.ceremonyRecorded(
        stubHash,
        d.ceremony_transcript_hash,
        d.panel_id,
        d.threshold,
        d.panel_size,
      ),
    ).toBe(true);
  });

  it("records the key set the transcript check registered, approved by every registered seat", () => {
    const set = e.trusteeRegistry.keySetOf(stubHash, d.panel_id);
    expect(set?.seats.map((s) => s.index)).toEqual(e.registered.map((r) => r.index));
    for (const [i, r] of e.registered.entries())
      expect(equal(set?.seats[i]?.signingKey ?? new Uint8Array(), r.signingKey)).toBe(true);
    expect(e.registration.approvals.map((a) => a.index)).toEqual([1, 2, 3, 4]);
    expect(e.registration.approvals.length).toBeGreaterThanOrEqual(quorum);
  });

  it("records the board's parameters from the registered definition, by its hash, cells in partition order", () => {
    const p = e.electionRegistry.parametersOf(electionDefinitionV4Hash(d));
    expect(p).toMatchObject({
      ballotVersion: 2,
      threshold: d.threshold,
      panelSize: d.panel_size,
      optionCount: d.option_count,
      opensAt: d.opens_at,
      closesAt: d.closes_at,
      l1InclusionBound: d.l1_inclusion_bound,
      questions: [
        {
          method: 1,
          options: d.option_count,
          minSelections: d.min_selections,
          maxSelections: d.max_selections,
        },
      ],
    });
    const partition = cellBallotElection(d, e.registered).cells;
    expect(p?.cellCount).toBe(partition.length);
    expect(p?.cells.map((c) => c.tier)).toEqual(partition.map((c) => c.tier));
    expect(p?.cells.map((c) => c.root)).toEqual(
      d.electorate.flatMap((t) => t.cells.map((c) => c.root)),
    );
    expect(equal(p?.ceremony.stubHash ?? new Uint8Array(), stubHash)).toBe(true);
    expect(equal(p?.ceremony.panelId ?? new Uint8Array(), d.panel_id)).toBe(true);
    // Nothing for a hash never registered, and a copy each read.
    expect(e.electionRegistry.parametersOf(new Uint8Array(32))).toBeUndefined();
    if (p !== undefined) p.ceremony.stubHash.fill(0);
    const again = e.electionRegistry.parametersOf(electionDefinitionV4Hash(d));
    expect(equal(again?.ceremony.stubHash ?? new Uint8Array(), stubHash)).toBe(true);
  });

  it("gives every run its own deployment, so no two share an election identifier", () => {
    const other = simulateElection(base, planElection(base), receiptKey());
    expect(equal(other.deployment.electionRegistry, e.deployment.electionRegistry)).toBe(false);
    expect(equal(other.definition.election_id, d.election_id)).toBe(false);
  });
});

describe("SimulatedTrusteeRegistry", { timeout }, () => {
  it("pins rule 7's quorum, max(k, n − 1)", () => {
    const keys = (n: number) =>
      Array.from({ length: n }, () => identityKey(crypto.getRandomValues(new Uint8Array(32))));
    expect(rule7Quorum({ threshold: 4, keys: keys(7) })).toBe(6);
    expect(rule7Quorum({ threshold: 3, keys: keys(3) })).toBe(3);
    expect(rule7Quorum({ threshold: 2, keys: keys(4) })).toBe(3);
    expect(() => trustees(e.panel, 1)).toThrow(RangeError);
    expect(() => trustees(e.panel, 5)).toThrow(RangeError);
  });

  it("records the run's registration once, and refuses a second for the same stub and panel", () => {
    const r = trustees();
    expect(refusalOf(r, e.registration)).toBe("ok");
    expect(refusalOf(r, e.registration)).toBe("AlreadyRecorded");
    // With another transcript too: a quorum holds no second key set in reserve.
    expect(
      refusalOf(r, { ...e.registration, ceremonyTranscriptHash: new Uint8Array(32).fill(7) }),
    ).toBe("AlreadyRecorded");
  });

  it("refuses an unpinned panel and a zero transcript hash", () => {
    expect(refusalOf(trustees(), { ...e.registration, panelId: new Uint8Array(32) })).toBe(
      "UnknownPanel",
    );
    expect(
      refusalOf(trustees(), { ...e.registration, ceremonyTranscriptHash: new Uint8Array(32) }),
    ).toBe("ZeroTranscriptHash");
  });

  // Seats count once each, never signatures: ECDSA lets one key sign a
  // statement many ways (T-14, T-37).
  it("counts each seat once, so fewer than the quorum's distinct seats never record", () => {
    const short = { ...e.registration, approvals: e.registration.approvals.slice(0, quorum - 1) };
    expect(refusalOf(trustees(), short)).toBe("BelowQuorum");
    const first = e.registration.approvals[0];
    if (first === undefined) throw new Error("no approval");
    const repeated = {
      ...e.registration,
      approvals: [first, ...e.registration.approvals.slice(0, quorum - 1)],
    };
    expect(refusalOf(trustees(), repeated)).toBe("SeatsOutOfOrder");
    const reversed = { ...e.registration, approvals: [...e.registration.approvals].reverse() };
    expect(refusalOf(trustees(), reversed)).toBe("SeatsOutOfOrder");
  });

  it("refuses a key set below the threshold, out of seat order, or with a repeated or identity signing key", () => {
    const seats = e.registration.seats;
    const [s1, s2] = seats;
    if (s1 === undefined || s2 === undefined) throw new Error("no seats");
    expect(refusalOf(trustees(), { ...e.registration, seats: [s1] })).toBe("KeySetTooSmall");
    expect(refusalOf(trustees(), { ...e.registration, seats: [s2, s1, ...seats.slice(2)] })).toBe(
      "KeySetSeatsOutOfOrder",
    );
    const repeat = { ...s2, signingKey: s1.signingKey };
    expect(
      refusalOf(trustees(), { ...e.registration, seats: [s1, repeat, ...seats.slice(2)] }),
    ).toBe("DuplicateSigningKey");
    const identity = { ...s2, signingKey: e.panel.keys[0] as Uint8Array };
    expect(
      refusalOf(trustees(), { ...e.registration, seats: [s1, identity, ...seats.slice(2)] }),
    ).toBe("DuplicateSigningKey");
  });

  // Every approval signs this registry, its chain and the key set's hash, so
  // a record can't carry another key set or move to another deployment (T-37).
  it("refuses approvals of another key set, registry or chain", () => {
    const seats = e.registration.seats.slice(1);
    expect(refusalOf(trustees(), { ...e.registration, seats })).toBe("InvalidSignature");
    const elsewhere = new SimulatedTrusteeRegistry(
      e.deployment.l2ChainId,
      new Uint8Array(20).fill(9),
      [{ panel: e.panel, quorum }],
    );
    expect(refusalOf(elsewhere, e.registration)).toBe("InvalidSignature");
    const otherChain = new SimulatedTrusteeRegistry(
      e.deployment.l2ChainId + 1n,
      e.deployment.trusteeRegistry,
      [{ panel: e.panel, quorum }],
    );
    expect(refusalOf(otherChain, e.registration)).toBe("InvalidSignature");
  });

  it("refuses a record with any approval's signature altered, beyond the quorum too", () => {
    const approvals = e.registration.approvals;
    fc.assert(
      fc.property(
        fc.nat({ max: approvals.length - 1 }),
        fc.nat({ max: 63 }),
        fc.integer({ min: 1, max: 255 }),
        (at, byte, flip) => {
          const altered = approvals.map((a, i) => {
            if (i !== at) return a;
            const signature = Uint8Array.from(a.signature);
            signature[byte] = (signature[byte] ?? 0) ^ flip;
            return { ...a, signature };
          });
          return (
            refusalOf(trustees(), { ...e.registration, approvals: altered }) === "InvalidSignature"
          );
        },
      ),
      { numRuns },
    );
  });

  it("answers ceremonyRecorded only for the recorded transcript under the pinned threshold and size", () => {
    const r = trustees();
    const asked = (transcript: Uint8Array, k = d.threshold, n = d.panel_size, id = d.panel_id) =>
      r.ceremonyRecorded(stubHash, transcript, id, k, n);
    expect(asked(d.ceremony_transcript_hash)).toBe(false);
    r.registerCeremony(e.registration);
    expect(asked(d.ceremony_transcript_hash)).toBe(true);
    expect(asked(new Uint8Array(32).fill(1))).toBe(false);
    expect(asked(d.ceremony_transcript_hash, d.threshold + 1)).toBe(false);
    expect(asked(d.ceremony_transcript_hash, d.threshold, d.panel_size + 1)).toBe(false);
    expect(asked(d.ceremony_transcript_hash, d.threshold, d.panel_size, new Uint8Array(32))).toBe(
      false,
    );
  });

  // Keyed by stub and panel: another pinned panel's quorum can't block this
  // panel's record (T-25).
  it("keeps another pinned panel's record for the same stub apart", () => {
    const secrets = Array.from({ length: 4 }, () => crypto.getRandomValues(new Uint8Array(32)));
    const panel: Panel = { threshold: 2, keys: secrets.map((x) => identityKey(x)) };
    const r = new SimulatedTrusteeRegistry(e.deployment.l2ChainId, e.deployment.trusteeRegistry, [
      { panel: e.panel, quorum },
      { panel, quorum: rule7Quorum(panel) },
    ]);
    // The other panel's quorum approves another transcript for the run's stub first.
    const transcript = new Uint8Array(32).fill(4);
    const setHash = keySetHash(e.registration.seats);
    const theirs: CeremonyRegistrationRecord = {
      ...e.registration,
      panelId: panelId(panel),
      ceremonyTranscriptHash: transcript,
      approvals: secrets.map((secret, i) => ({
        index: i + 1,
        signature: signCeremonyRegistration(secret, panel, {
          l2ChainId: e.deployment.l2ChainId,
          trusteeRegistry: e.deployment.trusteeRegistry,
          index: i + 1,
          stubHash,
          ceremonyTranscriptHash: transcript,
          keySetHash: setHash,
        }),
      })),
    };
    expect(refusalOf(r, theirs)).toBe("ok");
    expect(refusalOf(r, e.registration)).toBe("ok");
    const asked = (t: Uint8Array, p: Panel) =>
      r.ceremonyRecorded(stubHash, t, panelId(p), p.threshold, p.keys.length);
    expect(asked(d.ceremony_transcript_hash, e.panel)).toBe(true);
    expect(asked(transcript, panel)).toBe(true);
    expect(asked(transcript, e.panel)).toBe(false);
    expect(asked(d.ceremony_transcript_hash, panel)).toBe(false);
  });

  it("refuses a key set whose signing key is no P-256 point", () => {
    const [s1, s2, ...rest] = e.registration.seats;
    if (s1 === undefined || s2 === undefined) throw new Error("no seats");
    const bad = { ...s2, signingKey: new Uint8Array(33).fill(0xff) };
    expect(refusalOf(trustees(), { ...e.registration, seats: [s1, bad, ...rest] })).toBe(
      "InvalidSigningKey",
    );
  });

  it("returns copies, so a caller can't change the recorded key set", () => {
    const r = trustees();
    const seats = e.registration.seats.map((x) => ({
      ...x,
      signingKey: Uint8Array.from(x.signingKey),
    }));
    r.registerCeremony({ ...e.registration, seats });
    (seats[0] as { signingKey: Uint8Array }).signingKey.fill(0);
    r.keySetOf(stubHash, d.panel_id)?.seats[0]?.signingKey.fill(0);
    const held = r.keySetOf(stubHash, d.panel_id)?.seats[0]?.signingKey;
    expect(
      held !== undefined && equal(held, e.registration.seats[0]?.signingKey ?? new Uint8Array()),
    ).toBe(true);
    expect(r.quorumOf(d.panel_id)).toBe(quorum);
    expect(r.quorumOf(new Uint8Array(32))).toBeUndefined();
  });
});

describe("SimulatedElectionRegistry", { timeout }, () => {
  const refusalOf = (
    r: SimulatedElectionRegistry,
    def = d,
    caller = SIMULATED_CREATOR,
    block = before,
  ) => {
    const result = r.registerDefinition(caller, def, block);
    return result.ok ? "ok" : result.refusal;
  };

  it("registers the definition once, for its creator only", () => {
    const r = elections();
    expect(refusalOf(r, d, "someone else")).toBe("NotCreator");
    expect(r.definitionHashOf(d.election_id)).toBeUndefined();
    expect(refusalOf(r)).toBe("ok");
    expect(refusalOf(r)).toBe("AlreadyRegistered");
  });

  it("refuses an election it didn't create", () => {
    const r = new SimulatedElectionRegistry(e.deployment, e.trusteeRegistry);
    expect(refusalOf(r)).toBe("UnknownElection");
  });

  it("refuses a definition without its ceremony recorded", () => {
    expect(refusalOf(elections(false))).toBe("CeremonyNotRecorded");
    // Another transcript than the one recorded for the stub.
    const other = { ...d, ceremony_transcript_hash: new Uint8Array(32).fill(3) };
    expect(refusalOf(elections(), other)).toBe("CeremonyNotRecorded");
  });

  it("refuses a definition naming another deployment", () => {
    const fields = [
      { board: new Uint8Array(20).fill(5) },
      { group_registry: new Uint8Array(20).fill(5) },
      { trustee_registry: new Uint8Array(20).fill(5) },
      { l1_anchor: new Uint8Array(20).fill(5) },
      { l1_relay: new Uint8Array(20).fill(5) },
      { l1_chain_id: d.l1_chain_id + 2n },
      { l2_chain_id: d.l2_chain_id + 2n },
      { election_registry: new Uint8Array(20).fill(5) },
    ];
    for (const f of fields) expect(refusalOf(elections(), { ...d, ...f })).toBe("WrongDeployment");
  });

  it("refuses an ill-formed definition with its rule", () => {
    const result = elections().registerDefinition(
      SIMULATED_CREATOR,
      { ...d, receipt_keys: [] },
      before,
    );
    expect(result).toEqual({ ok: false, refusal: "DefinitionIllFormed", rule: "receipt-keys" });
  });

  it("refuses a definition opening before the anchoring clock's epoch", () => {
    const t = trustees();
    t.registerCeremony(e.registration);
    const r = new SimulatedElectionRegistry({ ...e.deployment, epoch: d.opens_at + 1n }, t);
    r.createElection(SIMULATED_CREATOR);
    expect(refusalOf(r)).toBe("OpensBeforeEpoch");
  });

  it("asks only the deployment's trustee registry, and refuses a deployment that breaks the chain rule", () => {
    const elsewhere = new SimulatedTrusteeRegistry(
      e.deployment.l2ChainId,
      new Uint8Array(20).fill(9),
      [{ panel: e.panel, quorum }],
    );
    expect(() => new SimulatedElectionRegistry(e.deployment, elsewhere)).toThrow(RangeError);
    const otherChain = new SimulatedTrusteeRegistry(
      e.deployment.l2ChainId + 1n,
      e.deployment.trusteeRegistry,
      [{ panel: e.panel, quorum }],
    );
    expect(() => new SimulatedElectionRegistry(e.deployment, otherChain)).toThrow(RangeError);
    for (const broken of [
      { board: e.deployment.electionRegistry },
      { l1Relay: e.deployment.l1Anchor },
      { groupRegistry: new Uint8Array(20) },
      { l1ChainId: e.deployment.l2ChainId },
      { l1ChainId: 0n },
    ])
      expect(
        () => new SimulatedElectionRegistry({ ...e.deployment, ...broken }, trustees()),
      ).toThrow(RangeError);
  });

  it("refuses registration once voting has opened, or over an electorate not yet in the past", () => {
    expect(refusalOf(elections(), d, SIMULATED_CREATOR, l2BlockAt(d.opens_at))).toBe("AlreadyOpen");
    expect(
      refusalOf(elections(), d, SIMULATED_CREATOR, { number: 1n, timestamp: before.timestamp }),
    ).toBe("RootNotInPast");
    expect(
      refusalOf(elections(), d, SIMULATED_CREATOR, { number: 2n, timestamp: before.timestamp }),
    ).toBe("ok");
  });

  it("refuses an inclusion bound, sequencing window or drift outside the bytecode's bounds", () => {
    const cases = [
      [{ l1_inclusion_bound: PARAMETERS.MIN_INCLUSION_BOUND - 1 }, "InclusionBoundOutOfRange"],
      [{ l1_inclusion_bound: PARAMETERS.MAX_INCLUSION_BOUND + 1 }, "InclusionBoundOutOfRange"],
      [
        { sequencing_window: BigInt(PARAMETERS.MAX_SEQUENCING_WINDOW) + 1n },
        "SequencingWindowTooLarge",
      ],
      [
        { max_sequencer_drift: BigInt(PARAMETERS.MAX_SEQUENCER_DRIFT) + 1n },
        "SequencerDriftTooLarge",
      ],
    ] as const;
    for (const [f, refusal] of cases) expect(refusalOf(elections(), { ...d, ...f })).toBe(refusal);
  });
});

describe("SimulatedElectionRegistry's profile rule", { timeout }, () => {
  // Another 2-of-4 panel whose secrets the test holds, so a definition with
  // any profile gets its own stub's ceremony recorded first: the profile is
  // rule 9, after the ceremony.
  const secrets = Array.from({ length: 4 }, () => crypto.getRandomValues(new Uint8Array(32)));
  const panel: Panel = { threshold: 2, keys: secrets.map((x) => identityKey(x)) };
  const withPins = (pins: ReadonlyMap<number, number>) => {
    const def = {
      ...d,
      panel_id: panelId(panel),
      threshold: 2,
      panel_size: 4,
      profile: {
        ...d.profile,
        pins: d.profile.pins.map((p) => ({ ...p, version: pins.get(p.record_type) ?? p.version })),
      },
    };
    const t = new SimulatedTrusteeRegistry(e.deployment.l2ChainId, e.deployment.trusteeRegistry, [
      { panel, quorum: rule7Quorum(panel) },
    ]);
    const stub = electionStubV4Hash(def);
    const setHash = keySetHash(e.registration.seats);
    const recorded = t.registerCeremony({
      ...e.registration,
      panelId: panelId(panel),
      stubHash: stub,
      approvals: secrets.map((secret, i) => ({
        index: i + 1,
        signature: signCeremonyRegistration(secret, panel, {
          l2ChainId: e.deployment.l2ChainId,
          trusteeRegistry: e.deployment.trusteeRegistry,
          index: i + 1,
          stubHash: stub,
          ceremonyTranscriptHash: def.ceremony_transcript_hash,
          keySetHash: setHash,
        }),
      })),
    });
    expect(recorded).toEqual({ ok: true });
    const r = new SimulatedElectionRegistry(e.deployment, t);
    r.createElection(SIMULATED_CREATOR);
    const result = r.registerDefinition(SIMULATED_CREATOR, def, before);
    return result.ok ? "ok" : result.refusal;
  };

  it("registers the profile the deployment serves for definition version 4", () => {
    expect(withPins(new Map())).toBe("ok");
  });

  // Ballot 0x0002, opening 0x0003, board entry 0x0007, contract event
  // 0x0008 and display text 0x0009, each at any other version from 1 to 13
  // ([[contracts]], Election registry, Registration, rule 9).
  it("refuses every other version of a served pin", () => {
    const served: readonly (readonly [number, number])[] = [
      [0x0002, 2],
      [0x0003, 2],
      [0x0007, 5],
      [0x0008, 13],
      [0x0009, 1],
    ];
    for (const [type, version] of served)
      for (let v = 1; v <= 14; v++)
        if (v !== version) expect(withPins(new Map([[type, v]]))).toBe("ProfileNotServed");
  });

  it("leaves the receipt, ceremony-transcript and tally-opening pins to the verifier", () => {
    for (const type of [0x0004, 0x0005, 0x0006]) expect(withPins(new Map([[type, 2]]))).toBe("ok");
  });
});

describe("l2BlockAt", () => {
  it("puts a call in the block whose two seconds hold it", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1n << 62n }), (t) => {
        const b = l2BlockAt(t);
        return (
          b.timestamp <= t &&
          t < b.timestamp + SIMULATED_L2_BLOCK_TIME &&
          b.number * SIMULATED_L2_BLOCK_TIME === b.timestamp
        );
      }),
      { numRuns },
    );
    expect(() => l2BlockAt(-1n)).toThrow(RangeError);
  });
});

describe("runSimulation's registration", { timeout }, () => {
  it("reports the registry's election identifier and the approvals the ceremony was recorded from", async () => {
    const r = await runSimulation(base);
    expect(r.ok).toBe(true);
    expect(r.definition.electionId).toMatch(/^[0-9a-f]{64}$/);
    expect(r.ceremony.approvals).toEqual([1, 2, 3, 4]);
    expect(r.ceremony.quorum).toBe(3);
  });
});
