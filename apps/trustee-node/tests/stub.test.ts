import {
  deliveryWindowFits,
  encodeElectionDefinition,
  type ElectionDefinition,
  electionStubHash,
  panelId,
  RECORD_TYPES,
} from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import { CeremonySeat, checkStub, type ElectorateCheck, type Pins } from "../src/index.ts";
import { RELEASE_WINDOWS } from "../src/stub.ts";
import { MemoryStore } from "../src/store.ts";
import { L2_CHAIN_ID, panelOf, stubFor, TRUSTEE_REGISTRY } from "./fixture.ts";

const { panel, secrets } = panelOf(4, 2);
const pinned: Pins = { panel, l2ChainId: L2_CHAIN_ID, trusteeRegistry: TRUSTEE_REGISTRY };
const pass = () => Promise.resolve(true);
const check = (stub: ElectionDefinition, electorate: ElectorateCheck = pass) =>
  checkStub(encodeElectionDefinition(stub), pinned, electorate, new Map());

describe("stub check 4", () => {
  // Four seats: at most 1,024 members alone with the release's windows.
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
    expect((await check(sized(1_024n))).ok).toBe(true);
    expect(await check(sized(1_025n))).toEqual({ ok: false, code: "stub-capacity" });
  });

  test("counts the elections it serves, but not the stub's own entry", async () => {
    const stub = sized(1n);
    const served = new Map([["cd".repeat(32), demand(sized(1_024n))]]);
    expect(await checkStub(encodeElectionDefinition(stub), pinned, pass, served)).toEqual({
      ok: false,
      code: "stub-capacity",
    });
    const self = sized(1_024n);
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
    expect(await check(sized(1_025n), () => Promise.resolve(false))).toEqual({
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
    expect(await check(stub)).toEqual({ ok: true, stub, stubHash: electionStubHash(stub) });
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
      // Contract-event version 1 too: the registry registers only version 3.
      for (const version of type === RECORD_TYPES.contractEvent ? [1, 2, 9] : [2, 9]) {
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
      (seen as { election_id: Uint8Array }).election_id = new Uint8Array(32).fill(9);
      return Promise.resolve(true);
    });
    expect(result).toEqual({ ok: true, stub, stubHash: electionStubHash(stub) });
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
