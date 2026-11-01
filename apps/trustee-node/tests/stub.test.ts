import {
  deliveryWindowFits,
  type ElectionDefinitionV7,
  electionDefinitionV7Hash,
  electionStubV7Hash,
  ELECTORATE_MODES,
  encodeElectionDefinitionV7,
  forcedPathElectionOf,
  forcedPathFits,
  encodeElectionDefinition,
  encodeElectionDefinitionV3,
  encodeElectionDefinitionV4,
  encodeElectionDefinitionV5,
  encodeElectionDefinitionV6,
  type ElectionDefinition,
  type ElectionDefinitionV5,
  electionStubHash,
  electionStubV5Hash,
  panelId,
  POLL_CLASSES,
  RECORD_TYPES,
  RESULTS_MODES,
} from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import { CeremonySeat, checkStub, type ElectorateCheck, type Pins } from "../src/index.ts";
import {
  decodeStub,
  RELEASE_WINDOWS,
  type Stub,
  stubDefinitionHash,
  stubDemand,
  stubHash,
  stubRootBlock,
} from "../src/stub.ts";
import { MemoryStore } from "../src/store.ts";
import {
  L2_CHAIN_ID,
  panelOf,
  rollingStubFor,
  stubFor,
  stubV5For,
  TRUSTEE_REGISTRY,
} from "./fixture.ts";

const { panel, secrets } = panelOf(4, 2);
const pinned: Pins = { panel, l2ChainId: L2_CHAIN_ID, trusteeRegistry: TRUSTEE_REGISTRY };
const pass = () => Promise.resolve(true);
const check = (stub: ElectionDefinition, electorate: ElectorateCheck = pass) =>
  checkStub(encodeElectionDefinition(stub), pinned, electorate, new Map());

describe("stub check 4", () => {
  // Four seats: at most 15,360 members alone with the release's windows.
  const sized = (n: bigint, change: Partial<ElectionDefinition> = {}) => {
    const stub = stubFor(panel, change);
    return { ...stub, electorate: stub.electorate.map((g) => ({ ...g, group_size: n })) };
  };
  const demand = (stub: ElectionDefinition) => ({
    members: stub.electorate.reduce((m, g) => m + g.group_size, 0n),
    seats: stub.panel_size,
    closesAt: stub.closes_at,
    l1InclusionBound: BigInt(stub.l1_inclusion_bound),
  });

  test("refuses a stub whose obligation doesn't fit alone", async () => {
    expect((await check(sized(15_360n))).ok).toBe(true);
    expect(await check(sized(15_361n))).toEqual({ ok: false, code: "stub-capacity" });
  });

  test("counts the elections it serves, but not the stub's own entry", async () => {
    const stub = sized(1n);
    const served = new Map([["cd".repeat(32), demand(sized(15_360n))]]);
    expect(await checkStub(encodeElectionDefinition(stub), pinned, pass, served)).toEqual({
      ok: false,
      code: "stub-capacity",
    });
    const self = sized(15_360n);
    const own = Buffer.from(electionStubHash(self)).toString("hex");
    expect(
      (
        await checkStub(
          encodeElectionDefinition(self),
          pinned,
          pass,
          new Map([[own, demand(self)]]),
        )
      ).ok,
    ).toBe(true);
  });

  test("only after the electorate check, whose counts it reads", async () => {
    expect(await check(sized(15_361n), () => Promise.resolve(false))).toEqual({
      ok: false,
      code: "stub-electorate",
    });
  });

  test("the release's windows are ones deliveryWindowFits accepts with hourly 12-hour-deadline anchoring", () => {
    expect(deliveryWindowFits({ period: 3_600n, deadline: 43_200n, ...RELEASE_WINDOWS })).toBe(
      true,
    );
  });
});

describe("stub checks", () => {
  test("accepts a stub its pins fix, with the hash recomputed from its bytes", async () => {
    const stub = stubFor(panel);
    expect(await check(stub)).toEqual({
      ok: true,
      stub: { version: 1, value: stub },
      stubHash: electionStubHash(stub),
    });
  });

  test("refuses bytes that don't decode", async () => {
    const bytes = encodeElectionDefinition(stubFor(panel));
    expect(await checkStub(bytes.subarray(0, bytes.length - 1), pinned, pass, new Map())).toEqual({
      ok: false,
      code: "stub-decode",
    });
  });

  test("refuses a definition version it doesn't read", async () => {
    const bytes = encodeElectionDefinition(stubFor(panel));
    for (const version of [3, 5, 6, 7, 200]) {
      const other = Uint8Array.from(bytes);
      other[2] = version;
      expect(await checkStub(other, pinned, pass, new Map())).toMatchObject({ ok: false });
      const result = await checkStub(other, pinned, pass, new Map());
      expect(result.ok ? undefined : result.code).toMatch(/^stub-(version|decode)$/);
    }
  });

  test("refuses a stub that already names a transcript", async () => {
    expect(
      await check(stubFor(panel, { ceremony_transcript_hash: new Uint8Array(32).fill(1) })),
    ).toEqual({ ok: false, code: "stub-transcript-hash" });
  });

  test("refuses a stub that breaks a well-formedness rule", async () => {
    expect(await check(stubFor(panel, { option_count: 1 }))).toEqual({
      ok: false,
      code: "stub-rule",
    });
  });

  test("refuses a stub naming another panel, chain or registry", async () => {
    const other = panelOf(4, 2).panel;
    for (const change of [
      { panel_id: panelId(other) },
      { l2_chain_id: L2_CHAIN_ID + 1n },
      { trustee_registry: new Uint8Array(20).fill(0xee) },
    ] satisfies Partial<ElectionDefinition>[])
      expect(await check(stubFor(panel, change))).toEqual({ ok: false, code: "stub-pins" });
    // A stub for another panel entirely, its own fields consistent.
    expect(await check(stubFor(other))).toEqual({ ok: false, code: "stub-pins" });
  });

  test("refuses a profile it doesn't read", async () => {
    const stub = stubFor(panel);
    const pinsOf = stub.profile.pins.map((p) =>
      p.record_type === RECORD_TYPES.boardEntry ? { ...p, version: 99 } : p,
    );
    const result = await check({ ...stub, profile: { ...stub.profile, pins: pinsOf } });
    expect(result.ok ? undefined : result.code).toMatch(/^stub-(profile|rule)$/);
  });

  test("refuses a pinned version this release doesn't read, for every record type", async () => {
    const stub = stubFor(panel);
    for (const type of [
      RECORD_TYPES.electionDefinition,
      RECORD_TYPES.ballot,
      RECORD_TYPES.spoiledBallotOpening,
      RECORD_TYPES.receipt,
      RECORD_TYPES.ceremonyTranscript,
      RECORD_TYPES.tallyOpening,
      RECORD_TYPES.boardEntry,
      RECORD_TYPES.contractEvent,
      RECORD_TYPES.displayText,
    ])
      // Contract-event versions 1 to 12 too: the registry registers only version 13.
      for (const version of type === RECORD_TYPES.contractEvent
        ? [1, 2, 5, 6, 7, 8, 9, 10, 11, 12, 14]
        : [2, 9]) {
        const pins = stub.profile.pins.map((p) => (p.record_type === type ? { ...p, version } : p));
        const result = await checkStub(
          encodeElectionDefinition({ ...stub, profile: { ...stub.profile, pins } }),
          pinned,
          pass,
          new Map(),
        );
        // Some versions are known but don't pair with definition version 1;
        // either way the node lends no keys.
        expect(result.ok, `0x${type.toString(16)} = ${version}`).toBe(false);
      }
  });

  test("refuses a stub whose threshold or panel size alone differs from the pinned panel", async () => {
    expect(await check(stubFor(panel, { threshold: 3 }))).toEqual({ ok: false, code: "stub-pins" });
    const bigger = panelOf(5, 2).panel;
    expect(await check(stubFor(panel, { panel_size: bigger.keys.length }))).toEqual({
      ok: false,
      code: "stub-pins",
    });
  });

  test("refuses a membership key other than the pinned one", async () => {
    expect(await check(stubFor(panel, { membership_vk_hash: new Uint8Array(32).fill(7) }))).toEqual(
      { ok: false, code: "stub-membership-key" },
    );
  });

  test("refuses a stub whose electorate the chain doesn't confirm, and never asks before the other checks pass", async () => {
    let asked = 0;
    const electorate = () => {
      asked++;
      return Promise.resolve(false);
    };
    expect(await check(stubFor(panel), electorate)).toEqual({
      ok: false,
      code: "stub-electorate",
    });
    expect(asked).toBe(1);
    await check(stubFor(panel, { l2_chain_id: 1n }), electorate);
    expect(asked).toBe(1);
  });

  test("the electorate check can't change the stub that is hashed and returned", async () => {
    const stub = stubFor(panel);
    const result = await check(stub, (seen) => {
      (seen.value as { election_id: Uint8Array }).election_id = new Uint8Array(32).fill(9);
      return Promise.resolve(true);
    });
    expect(result).toEqual({
      ok: true,
      stub: { version: 1, value: stub },
      stubHash: electionStubHash(stub),
    });
  });

  test("a seat refuses to join a run over a stub that fails, recording nothing", async () => {
    const store = new MemoryStore();
    const seat = new CeremonySeat({
      ...pinned,
      index: 1,
      identitySecret: secrets[0] as Uint8Array,
      electorate: () => Promise.resolve(false),
      store,
    });
    const runId = crypto.getRandomValues(new Uint8Array(32));
    const stub = encodeElectionDefinition(stubFor(panel));
    expect(await seat.keys(stub, runId)).toEqual({ ok: false, code: "stub-electorate" });
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    expect(
      await store.get(`runs/${hex(electionStubHash(stubFor(panel)))}/${hex(runId)}/begun`),
    ).toBeUndefined();
  });
});

describe("version-5 stubs, as the website creates them", () => {
  const checkV5 = (stub: ElectionDefinitionV5, electorate: ElectorateCheck = pass) =>
    checkStub(encodeElectionDefinitionV5(stub), pinned, electorate, new Map());

  test("accepts one its pins fix, with the version-5 stub hash, and gives the electorate check the version-5 stub", async () => {
    const stub = stubV5For(panel);
    const seen: unknown[] = [];
    expect(
      await checkV5(stub, (s) => {
        seen.push(s);
        return Promise.resolve(true);
      }),
    ).toEqual({ ok: true, stub: { version: 5, value: stub }, stubHash: electionStubV5Hash(stub) });
    expect(seen).toEqual([{ version: 5, value: stub }]);
    // Not the version-1 hash of the same fields: the hash follows the layout.
    expect(Buffer.from(electionStubV5Hash(stub)).toString("hex")).not.toBe(
      Buffer.from(electionStubHash(stubFor(panel))).toString("hex"),
    );
  });

  test("refuses one that breaks version 5's own rules (T-28, T-34)", async () => {
    const [first] = stubV5For(panel).questions;
    if (first === undefined) throw new Error("no question");
    for (const change of [
      { questions: [] },
      { questions: [{ ...first, option_count: 1 }] },
      { questions: [{ ...first, max_selections: 0 }] },
      { receipt_keys: [] },
    ] satisfies Partial<ElectionDefinitionV5>[])
      expect(await checkV5(stubV5For(panel, change))).toEqual({ ok: false, code: "stub-rule" });
  });

  test("refuses one that already names a transcript, or another panel, chain or registry", async () => {
    expect(
      await checkV5(stubV5For(panel, { ceremony_transcript_hash: new Uint8Array(32).fill(1) })),
    ).toEqual({ ok: false, code: "stub-transcript-hash" });
    for (const change of [
      { panel_id: panelId(panelOf(4, 2).panel) },
      { l2_chain_id: L2_CHAIN_ID + 1n },
      { trustee_registry: new Uint8Array(20).fill(0xee) },
      { threshold: 3 },
    ] satisfies Partial<ElectionDefinitionV5>[])
      expect(await checkV5(stubV5For(panel, change))).toEqual({ ok: false, code: "stub-pins" });
  });

  test("refuses a membership key other than the pinned one", async () => {
    expect(
      await checkV5(stubV5For(panel, { membership_vk_hash: new Uint8Array(32).fill(7) })),
    ).toEqual({ ok: false, code: "stub-membership-key" });
  });

  test("refuses a pinned version this release doesn't read, for every record type", async () => {
    const stub = stubV5For(panel);
    for (const p of stub.profile.pins)
      for (const version of [p.version - 1, p.version + 1].filter((v) => v > 0)) {
        const pins = stub.profile.pins.map((q) => (q === p ? { ...q, version } : q));
        const result = await checkStub(
          encodeElectionDefinitionV5({ ...stub, profile: { ...stub.profile, pins } }),
          pinned,
          pass,
          new Map(),
        );
        // The definition's own pin no longer matches its layout; any other is one 2.3 refuses.
        expect(result, `0x${p.record_type.toString(16)} = ${version}`).toEqual({
          ok: false,
          code: p.record_type === RECORD_TYPES.electionDefinition ? "stub-decode" : "stub-profile",
        });
      }
  });

  test("sizes the forced path by the members of every region (check 4)", async () => {
    // Four seats: at most 15,360 members alone, here split over two regions.
    const sized = (a: bigint, b: bigint) => {
      const [tier] = stubV5For(panel).electorate;
      if (tier === undefined) throw new Error("no tier");
      return stubV5For(panel, {
        electorate: [
          {
            ...tier,
            groups: [
              { group_id: 1n, region: 0 },
              { group_id: 2n, region: 1 },
            ],
            regions: [a, b],
            cells: [
              { root: 1n << 200n, members: a },
              { root: 1n << 201n, members: b },
            ],
          },
        ],
      });
    };
    expect((await checkV5(sized(10_000n, 5_360n))).ok).toBe(true);
    expect(await checkV5(sized(10_000n, 5_361n))).toEqual({ ok: false, code: "stub-capacity" });
  });

  test("refuses versions 3 and 4, which decode, as versions it doesn't read, and version 5's layout under a version-7 byte as undecodable", async () => {
    const v5 = stubV5For(panel);
    const v1 = stubFor(panel);
    const pinsFor = (definition: number) =>
      v1.profile.pins.map((p) =>
        p.record_type === RECORD_TYPES.electionDefinition
          ? { ...p, version: definition }
          : p.record_type === RECORD_TYPES.ballot
            ? { ...p, version: 2 }
            : p,
      );
    const { questions: _, receipt_keys, ...rest } = v5;
    const head = {
      ...rest,
      election_type: v1.election_type,
      option_count: v1.option_count,
      min_selections: v1.min_selections,
      max_selections: v1.max_selections,
    };
    const v3 = encodeElectionDefinitionV3({
      ...head,
      profile: { protocol_major: 1, pins: pinsFor(3) },
    });
    const v4 = encodeElectionDefinitionV4({
      ...head,
      profile: { protocol_major: 1, pins: pinsFor(4) },
      receipt_keys,
    });
    const v7 = Uint8Array.from(encodeElectionDefinitionV5(v5));
    v7[2] = 7;
    for (const bytes of [v3, v4])
      expect(await checkStub(bytes, pinned, pass, new Map())).toEqual({
        ok: false,
        code: "stub-version",
      });
    expect(await checkStub(v7, pinned, pass, new Map())).toEqual({
      ok: false,
      code: "stub-decode",
    });
  });

  test("refuses version 6 (an author panel) as a version it doesn't read", async () => {
    const stub = stubV5For(panel);
    const pins = stub.profile.pins.map((p) =>
      p.record_type === RECORD_TYPES.electionDefinition
        ? { ...p, version: 6 }
        : p.record_type === RECORD_TYPES.ballot
          ? { ...p, version: 4 }
          : p,
    );
    const bytes = encodeElectionDefinitionV6({
      ...stub,
      profile: { ...stub.profile, pins },
      poll_class: POLL_CLASSES.everyday,
      results_mode: RESULTS_MODES.sealed,
      live_every: 0,
      live_batch: 0,
      author_threshold: 0,
      author_keys: [],
      author_transcript_hash: new Uint8Array(32),
    });
    expect(await checkStub(bytes, pinned, pass, new Map())).toEqual({
      ok: false,
      code: "stub-version",
    });
  });
});

describe("version-7 stubs, a rolling poll's", () => {
  const checkV7 = (stub: ElectionDefinitionV7, electorate: ElectorateCheck = pass) =>
    checkStub(encodeElectionDefinitionV7(stub), pinned, electorate, new Map());

  test("decodes one, hashing it under version 7, its root block its rolling tiers' latest", () => {
    const stub = rollingStubFor(panel, {
      rolling_electorate: [
        { tier: 0, root_l2_block: 7n, groups: [1n], root: 1n << 200n, group_size: 3n },
        { tier: 1, root_l2_block: 9n, groups: [2n], root: 1n << 201n, group_size: 2n },
      ],
    });
    const decoded = decodeStub(encodeElectionDefinitionV7(stub));
    expect(decoded).toEqual({ version: 7, value: stub });
    expect(stubHash(decoded)).toEqual(electionStubV7Hash(stub));
    const transcript = new Uint8Array(32).fill(4);
    expect(stubDefinitionHash(decoded, transcript)).toEqual(
      electionDefinitionV7Hash({ ...stub, ceremony_transcript_hash: transcript }),
    );
    expect(stubRootBlock(decoded)).toBe(9n);
  });

  test("runs checks 1 to 3, the electorate check given the version-7 stub, then refuses it at check 4", async () => {
    const stub = rollingStubFor(panel);
    const seen: Stub[] = [];
    const result = await checkV7(stub, (s) => {
      seen.push(s);
      return Promise.resolve(true);
    });
    expect(result).toEqual({ ok: false, code: "stub-capacity" });
    expect(seen).toEqual([{ version: 7, value: stub }]);
    // Crypto's capacity check agrees: it refuses every set holding a rolling election.
    expect(forcedPathFits([forcedPathElectionOf(stub)], RELEASE_WINDOWS)).toBe(false);
  });

  test("refuses one at check 4 however small, whatever the seat serves", async () => {
    const empty = rollingStubFor(panel, {
      rolling_electorate: [{ tier: 0, root_l2_block: 7n, groups: [1n], root: 0n, group_size: 0n }],
    });
    const served = new Map([["cd".repeat(32), stubDemand(stubFor(panel))]]);
    for (const map of [new Map(), served])
      expect(await checkStub(encodeElectionDefinitionV7(empty), pinned, pass, map)).toEqual({
        ok: false,
        code: "stub-capacity",
      });
  });

  test("refuses one whose opening state the chain doesn't confirm, before check 4", async () => {
    expect(await checkV7(rollingStubFor(panel), () => Promise.resolve(false))).toEqual({
      ok: false,
      code: "stub-electorate",
    });
  });

  test("never asks the chain about one failing checks 1 to 3", async () => {
    const asked: Stub[] = [];
    const electorate: ElectorateCheck = (s) => {
      asked.push(s);
      return Promise.resolve(true);
    };
    const cases: [Partial<ElectionDefinitionV7>, string][] = [
      [{ ceremony_transcript_hash: new Uint8Array(32).fill(1) }, "stub-transcript-hash"],
      // `rolling-class`: a rolling poll on the civic record (T-34).
      [{ poll_class: POLL_CLASSES.civicReferendum }, "stub-rule"],
      [{ l2_chain_id: L2_CHAIN_ID + 1n }, "stub-pins"],
      [{ trustee_registry: new Uint8Array(20).fill(0xee) }, "stub-pins"],
      [{ membership_vk_hash: new Uint8Array(32).fill(7) }, "stub-membership-key"],
    ];
    for (const [change, code] of cases)
      expect(await checkV7(rollingStubFor(panel, change), electorate), code).toEqual({
        ok: false,
        code,
      });
    expect(asked).toEqual([]);
  });

  test("refuses a pinned version this release doesn't read, for every record type", async () => {
    const stub = rollingStubFor(panel);
    for (const p of stub.profile.pins)
      for (const version of [p.version - 1, p.version + 1].filter((v) => v > 0)) {
        const pins = stub.profile.pins.map((q) => (q === p ? { ...q, version } : q));
        const result = await checkV7({ ...stub, profile: { ...stub.profile, pins } });
        expect(result, `0x${p.record_type.toString(16)} = ${version}`).toEqual({
          ok: false,
          code: p.record_type === RECORD_TYPES.electionDefinition ? "stub-decode" : "stub-profile",
        });
      }
  });

  test("refuses a fixed, live or author-panel version 7 as one it doesn't read, before the other checks", async () => {
    const asked: Stub[] = [];
    const electorate: ElectorateCheck = (s) => {
      asked.push(s);
      return Promise.resolve(true);
    };
    const [tier] = stubV5For(panel).electorate;
    if (tier === undefined) throw new Error("no tier");
    const author = panelOf(2, 2).panel.keys;
    const cases: Partial<ElectionDefinitionV7>[] = [
      { electorate_mode: ELECTORATE_MODES.fixed, electorate: [tier], rolling_electorate: [] },
      { results_mode: RESULTS_MODES.live, live_every: 3_600, live_batch: 10 },
      { author_threshold: 2, author_keys: [...author] },
      // Either author field alone, which version 7's rule refuses too.
      { author_threshold: 1 },
      { author_keys: [...author] },
    ];
    for (const change of cases)
      expect(await checkV7(rollingStubFor(panel, change), electorate)).toEqual({
        ok: false,
        code: "stub-version",
      });
    expect(asked).toEqual([]);
  });

  test("records no demand for a rolling election, which no seat approves yet", () => {
    expect(() => stubDemand(rollingStubFor(panel))).toThrow(/rolling/);
  });
});
