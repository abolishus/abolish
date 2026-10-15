import {
  checkCeremonyTranscript,
  type ElectionDefinition,
  electionStubHash,
  encodeElectionDefinition,
  decodeCeremonyTranscript,
  encodeCeremonyTranscript,
  keySetEntry,
  keySetHash,
  verifyCeremonyRegistration,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test, vi } from "vite-plus/test";
import { CeremonySeat, FileStore, type SeatResult, type SeatStore } from "../src/index.ts";
import { MemoryStore } from "../src/store.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Election,
  election,
  L2_CHAIN_ID,
  runCeremony,
  stubFor,
  TRUSTEE_REGISTRY,
  value,
} from "./fixture.ts";

/** A store whose `putOnce` throws, writing nothing, after `after` successful writes. */
class CrashingStore implements SeatStore {
  readonly #inner: SeatStore;
  #left: number;
  constructor(inner: SeatStore, after: number) {
    this.#inner = inner;
    this.#left = after;
  }
  get(key: string) {
    return this.#inner.get(key);
  }
  putOnce(key: string, value: Uint8Array) {
    if (this.#left-- <= 0) return Promise.reject(new Error("crash"));
    return this.#inner.putOnce(key, value);
  }
  list(prefix: string) {
    return this.#inner.list(prefix);
  }
}

const FIELDS = ["keys", "challenges", "answers", "reveals"] as const;

function seatOver(e: Election, index: number, store: SeatStore): CeremonySeat {
  return new CeremonySeat({
    panel: e.panelists.panel,
    l2ChainId: L2_CHAIN_ID,
    trusteeRegistry: TRUSTEE_REGISTRY,
    index,
    identitySecret: e.panelists.secrets[index - 1] as Uint8Array,
    electorate: () => Promise.resolve(true),
    store,
  });
}

// Each test runs whole ceremonies: under a second here, but over the default
// 5 s on a loaded CI runner.
vi.setConfig({ testTimeout: 60_000 });

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 100);
// A whole ceremony per run, about a third of a second, so a tenth of the
// runs (100 under CI's 1000), as crypto's own ceremony properties scale theirs.
const CEREMONY_RUNS = Math.max(10, Math.ceil(NUM_RUNS / 10));

describe("an honest ceremony", () => {
  test("every seat approves the transcript, over the key set its own check returns", async () => {
    const e = election(4, 2);
    const run = await runCeremony(e);
    const checked = checkCeremonyTranscript(
      {
        l2ChainId: L2_CHAIN_ID,
        trusteeRegistry: TRUSTEE_REGISTRY,
        electionId: e.stub.election_id,
        stubHash: e.stubHash,
        panel: e.panelists.panel,
      },
      run.transcript,
      1,
    );
    if (!checked.ok) expect.fail(checked.code);
    expect(checked.registered.map((k) => k.index)).toEqual([1, 2, 3, 4]);
    for (const [i, seat] of e.seats.entries()) {
      const approval = value(await seat.approve(e.stubBytes, run.transcript));
      expect(approval.registration).toEqual({
        l2ChainId: L2_CHAIN_ID,
        trusteeRegistry: TRUSTEE_REGISTRY,
        index: i + 1,
        stubHash: e.stubHash,
        ceremonyTranscriptHash: checked.hash,
        keySetHash: keySetHash(checked.registered.map(keySetEntry)),
      });
      expect(
        verifyCeremonyRegistration(e.panelists.panel, approval.registration, approval.signature),
      ).toBe(true);
    }
  });

  test("a node restarted between rounds continues from its records", async () => {
    const stores = [new MemoryStore(), new MemoryStore(), new MemoryStore()];
    const e = election(3, 2, { stores });
    const runId = crypto.getRandomValues(new Uint8Array(32));
    const keys = await Promise.all(
      e.seats.map(async (s) => value(await s.keys(e.stubBytes, runId))),
    );
    const challenges = await Promise.all(
      e.seats.map(async (s) => value(await s.challenges(e.stubHash, runId, keys))),
    );
    // New seat objects over the same stores, as after a restart.
    const restarted = e.panelists.secrets.map(
      (identitySecret, i) =>
        new CeremonySeat({
          panel: e.panelists.panel,
          l2ChainId: L2_CHAIN_ID,
          trusteeRegistry: TRUSTEE_REGISTRY,
          index: i + 1,
          identitySecret,
          electorate: () => Promise.resolve(true),
          store: stores[i] as SeatStore,
        }),
    );
    const answers = await Promise.all(
      restarted.map(async (s) => value(await s.answers(e.stubHash, runId, { keys, challenges }))),
    );
    const reveals = await Promise.all(
      restarted.map(async (s) =>
        value(await s.reveals(e.stubHash, runId, { keys, challenges, answers })),
      ),
    );
    const transcript = encodeCeremonyTranscript({
      run_id: runId,
      keys,
      challenges,
      answers,
      reveals,
    });
    for (const s of restarted) value(await s.approve(e.stubBytes, transcript));
  });
});

describe("runs", () => {
  test("a run it has seen gets the round-1 message it sent, never a second one; a fresh run_id gets fresh keys", async () => {
    const e = election(3, 2);
    const seat = e.seats[0] as CeremonySeat;
    const runId = crypto.getRandomValues(new Uint8Array(32));
    const first = value(await seat.keys(e.stubBytes, runId));
    expect(value(await seat.keys(e.stubBytes, runId))).toEqual(first);
    const other = value(await seat.keys(e.stubBytes, crypto.getRandomValues(new Uint8Array(32))));
    expect(other.signing_key).not.toEqual(first.signing_key);
    expect(other.kem_key.ek).not.toEqual(first.kem_key.ek);
  });

  test("refuses a run it joined but crashed before recording its round-1 message", async () => {
    const e = election(3, 2);
    const store = new MemoryStore();
    const seat = new CeremonySeat({
      panel: e.panelists.panel,
      l2ChainId: L2_CHAIN_ID,
      trusteeRegistry: TRUSTEE_REGISTRY,
      index: 1,
      identitySecret: e.panelists.secrets[0] as Uint8Array,
      electorate: () => Promise.resolve(true),
      store: new CrashingStore(store, 1),
    });
    const runId = crypto.getRandomValues(new Uint8Array(32));
    await expect(seat.keys(e.stubBytes, runId)).rejects.toThrow("crash");
    const restarted = new CeremonySeat({
      panel: e.panelists.panel,
      l2ChainId: L2_CHAIN_ID,
      trusteeRegistry: TRUSTEE_REGISTRY,
      index: 1,
      identitySecret: e.panelists.secrets[0] as Uint8Array,
      electorate: () => Promise.resolve(true),
      store,
    });
    expect(await restarted.keys(e.stubBytes, runId)).toEqual({ ok: false, code: "run-seen" });
  });

  test("concurrent requests to join one run get one round-1 message between them", async () => {
    const e = election(3, 2);
    const seat = e.seats[0] as CeremonySeat;
    const runId = crypto.getRandomValues(new Uint8Array(32));
    const results = await Promise.all(
      Array.from({ length: 5 }, () => seat.keys(e.stubBytes, runId)),
    );
    const sent = results.flatMap((r) => (r.ok ? [r.value] : []));
    expect(sent.length).toBeGreaterThan(0);
    for (const m of sent) expect(m).toEqual(sent[0]);
    for (const r of results) if (!r.ok) expect(r.code).toBe("run-seen");
  });

  test("refuses a round of a run it never joined", async () => {
    const e = election(3, 2);
    const run = await runCeremony(e);
    const stranger = election(3, 2).seats[0] as CeremonySeat;
    expect(await stranger.challenges(e.stubHash, run.runId, run.keys)).toEqual({
      ok: false,
      code: "no-run",
    });
  });
});

describe("one message per round", () => {
  test("resends the recorded message over the same earlier rounds, and refuses any other", async () => {
    const e = election(4, 2);
    const runId = crypto.getRandomValues(new Uint8Array(32));
    const keys = await Promise.all(
      e.seats.map(async (s) => value(await s.keys(e.stubBytes, runId))),
    );
    const seat = e.seats[0] as CeremonySeat;
    const first = value(await seat.challenges(e.stubHash, runId, keys));
    expect(value(await seat.challenges(e.stubHash, runId, keys))).toEqual(first);
    // Round 1 without seat 4: another round 2 would be a second message.
    expect(await seat.challenges(e.stubHash, runId, keys.slice(0, 3))).toEqual({
      ok: false,
      code: "view",
    });
  });

  test("refuses earlier rounds that leave out or change its own message", async () => {
    const e = election(3, 2);
    const runId = crypto.getRandomValues(new Uint8Array(32));
    const keys = await Promise.all(
      e.seats.map(async (s) => value(await s.keys(e.stubBytes, runId))),
    );
    const seat = e.seats[0] as CeremonySeat;
    expect(await seat.challenges(e.stubHash, runId, keys.slice(1))).toEqual({
      ok: false,
      code: "view",
    });
    const own = keys[0] as (typeof keys)[number];
    const changed = { ...own, pok_z: own.pok_z === 1n ? 2n : 1n };
    expect(await seat.challenges(e.stubHash, runId, [changed, ...keys.slice(1)])).toEqual({
      ok: false,
      code: "view",
    });
  });

  test("refuses earlier rounds crypto's checks reject", async () => {
    const e = election(3, 2);
    const runId = crypto.getRandomValues(new Uint8Array(32));
    const keys = await Promise.all(
      e.seats.map(async (s) => value(await s.keys(e.stubBytes, runId))),
    );
    const other = keys[1] as (typeof keys)[number];
    const forged = { ...other, signature: (keys[2] as (typeof keys)[number]).signature };
    expect(
      await (e.seats[0] as CeremonySeat).challenges(e.stubHash, runId, [
        keys[0] as (typeof keys)[number],
        forged,
        keys[2] as (typeof keys)[number],
      ]),
    ).toEqual({ ok: false, code: "rounds" });
  });

  test("reveals at most once per run: over another round 3 it refuses", async () => {
    const e = election(4, 2);
    const run = await runCeremony(e);
    const seat = e.seats[0] as CeremonySeat;
    const rounds = { keys: run.keys, challenges: run.challenges, answers: run.answers };
    expect(value(await seat.reveals(e.stubHash, run.runId, rounds))).toEqual(run.reveals[0]);
    // A round 3 rebuilt without seat 4's answers, after seat 1 revealed.
    expect(
      await seat.reveals(e.stubHash, run.runId, { ...rounds, answers: run.answers.slice(0, 3) }),
    ).toEqual({ ok: false, code: "view" });
  });

  test("reveals only after a round 3 holding its own answers", async () => {
    const e = election(3, 2);
    const run = await runCeremony(e, { 3: [1] });
    expect(run.reveals.map((m) => m.index)).toEqual([2, 3]);
  });
});

describe("races and crashes", () => {
  test("answers only over the round 2 it holds its challenges in, once", async () => {
    const e = election(4, 2);
    const run = await runCeremony(e);
    const seat = e.seats[0] as CeremonySeat;
    expect(
      await seat.answers(e.stubHash, run.runId, {
        keys: run.keys,
        challenges: run.challenges.filter((m) => m.index !== 4),
      }),
    ).toEqual({ ok: false, code: "view" });
  });

  test("of concurrent reveals over two different round 3s, at most one is given", async () => {
    const e = election(4, 2);
    const runId = crypto.getRandomValues(new Uint8Array(32));
    const keys = await Promise.all(
      e.seats.map(async (s) => value(await s.keys(e.stubBytes, runId))),
    );
    const challenges = await Promise.all(
      e.seats.map(async (s) => value(await s.challenges(e.stubHash, runId, keys))),
    );
    const answers = await Promise.all(
      e.seats.map(async (s) => value(await s.answers(e.stubHash, runId, { keys, challenges }))),
    );
    const seat = e.seats[0] as CeremonySeat;
    const results = await Promise.all([
      seat.reveals(e.stubHash, runId, { keys, challenges, answers }),
      seat.reveals(e.stubHash, runId, { keys, challenges, answers: answers.slice(0, 3) }),
      seat.reveals(e.stubHash, runId, { keys, challenges, answers: answers.slice(0, 2) }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results) if (!r.ok) expect(r.code).toBe("view");
  });

  test("of concurrent approvals of two transcripts of one stub, at most one is given", async () => {
    const e = election(3, 2);
    const a = await runCeremony(e);
    const b = await runCeremony(e);
    const seat = e.seats[0] as CeremonySeat;
    const results = await Promise.all([
      seat.approve(e.stubBytes, a.transcript),
      seat.approve(e.stubBytes, b.transcript),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results) if (!r.ok) expect(r.code).toBe("approved-other");
  });

  test("a whole ceremony over file stores", async () => {
    const root = await mkdtemp(join(tmpdir(), "trustee-node-ceremony-"));
    try {
      const stores = await Promise.all(
        [1, 2, 3].map((i) => FileStore.open(join(root, `seat-${i}`))),
      );
      const e = election(3, 2, { stores });
      const run = await runCeremony(e);
      for (const seat of e.seats) value(await seat.approve(e.stubBytes, run.transcript));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a crash at any write, then a restart and the same request again, never gives two messages in a round", async () => {
    // Seat 1 writes six records over a run: begun, secrets, round 1 to 4.
    for (let crashAt = 0; crashAt < 6; crashAt++) {
      const e = election(3, 2);
      const store = new MemoryStore();
      const crashing = seatOver(e, 1, new CrashingStore(store, crashAt));
      const restarted = seatOver(e, 1, store);
      const others = e.seats.slice(1);
      const runId = crypto.getRandomValues(new Uint8Array(32));
      const sent = new Map<number, Uint8Array[]>();
      const ask = async <M extends { index: number }>(
        round: number,
        call: (s: CeremonySeat) => Promise<SeatResult<M>>,
      ): Promise<M | undefined> => {
        let result: SeatResult<M>;
        try {
          result = await call(crashing);
        } catch (e) {
          if (!(e instanceof Error && e.message === "crash")) throw e;
          result = await call(restarted);
        }
        if (!result.ok) return undefined;
        const bytes = encodeCeremonyTranscript({
          run_id: runId,
          keys: [],
          challenges: [],
          answers: [],
          reveals: [],
          [FIELDS[round - 1] as string]: [result.value],
        });
        sent.set(round, [...(sent.get(round) ?? []), bytes]);
        // Asked again after the restart, it gives the same message.
        const again = await call(restarted);
        expect(again).toEqual(result);
        return result.value;
      };
      const own1 = await ask(1, (s) => s.keys(e.stubBytes, runId));
      if (own1 === undefined) continue;
      const keys = [
        own1,
        ...(await Promise.all(others.map(async (s) => value(await s.keys(e.stubBytes, runId))))),
      ];
      const own2 = await ask(2, (s) => s.challenges(e.stubHash, runId, keys));
      if (own2 === undefined) continue;
      const challenges = [
        own2,
        ...(await Promise.all(
          others.map(async (s) => value(await s.challenges(e.stubHash, runId, keys))),
        )),
      ];
      const own3 = await ask(3, (s) => s.answers(e.stubHash, runId, { keys, challenges }));
      if (own3 === undefined) continue;
      const answers = [
        own3,
        ...(await Promise.all(
          others.map(async (s) => value(await s.answers(e.stubHash, runId, { keys, challenges }))),
        )),
      ];
      const own4 = await ask(4, (s) => s.reveals(e.stubHash, runId, { keys, challenges, answers }));
      expect(own4).toBeDefined();
      for (const messages of sent.values())
        for (const m of messages) expect(m).toEqual(messages[0]);
    }
  });
});

describe("approval", () => {
  test("refuses a transcript that changes a message it saw", async () => {
    const e = election(4, 2);
    const run = await runCeremony(e);
    const t = decodeCeremonyTranscript(run.transcript, 1);
    // Seat 4's round-1 message as another view of round 1 would carry it.
    const altered = encodeCeremonyTranscript({ ...t, keys: t.keys.slice(0, 3) });
    expect(await (e.seats[0] as CeremonySeat).approve(e.stubBytes, altered)).toEqual({
      ok: false,
      code: "view",
    });
  });

  test("refuses a transcript without its reveals", async () => {
    const e = election(4, 2);
    const run = await runCeremony(e);
    const t = decodeCeremonyTranscript(run.transcript, 1);
    const withheld = encodeCeremonyTranscript({ ...t, reveals: t.reveals.slice(1) });
    expect(await (e.seats[0] as CeremonySeat).approve(e.stubBytes, withheld)).toEqual({
      ok: false,
      code: "view",
    });
  });

  test("approves with max(k, n − 1) qualified seats and refuses with fewer", async () => {
    // 2-of-4: rule 7 needs 3 qualified seats.
    const one = election(4, 2);
    const withOne = await runCeremony(one, { 4: [4] });
    value(await (one.seats[0] as CeremonySeat).approve(one.stubBytes, withOne.transcript));
    const two = election(4, 2);
    const withTwo = await runCeremony(two, { 4: [3, 4] });
    expect(await (two.seats[0] as CeremonySeat).approve(two.stubBytes, withTwo.transcript)).toEqual(
      { ok: false, code: "participation" },
    );
  });

  test("approves one transcript per stub, whatever the run", async () => {
    const e = election(3, 2);
    const a = await runCeremony(e);
    const b = await runCeremony(e);
    const seat = e.seats[0] as CeremonySeat;
    const first = value(await seat.approve(e.stubBytes, a.transcript));
    expect(value(await seat.approve(e.stubBytes, a.transcript))).toEqual(first);
    expect(await seat.approve(e.stubBytes, b.transcript)).toEqual({
      ok: false,
      code: "approved-other",
    });
    expect(await seat.keys(e.stubBytes, crypto.getRandomValues(new Uint8Array(32)))).toEqual({
      ok: false,
      code: "stub-approved",
    });
  });

  test("refuses bytes that aren't a transcript", async () => {
    const e = election(3, 2);
    expect(await (e.seats[0] as CeremonySeat).approve(e.stubBytes, new Uint8Array(8))).toEqual({
      ok: false,
      code: "transcript",
    });
  });

  test("whatever the coordinator withholds, an approval is for a transcript that checks with max(k, n − 1) qualified seats including its own", async () => {
    const seatSet = fc.subarray([1, 2, 3, 4], { maxLength: 2 });
    await fc.assert(
      fc.asyncProperty(
        fc.record({ 1: seatSet, 2: seatSet, 3: seatSet, 4: seatSet }),
        fc.integer({ min: 1, max: 4 }),
        async (drops, index) => {
          const e = election(4, 2);
          const run = await runCeremony(e, drops);
          const approval = await (e.seats[index - 1] as CeremonySeat).approve(
            e.stubBytes,
            run.transcript,
          );
          if (!approval.ok) return true;
          const checked = checkCeremonyTranscript(
            {
              l2ChainId: L2_CHAIN_ID,
              trusteeRegistry: TRUSTEE_REGISTRY,
              electionId: e.stub.election_id,
              stubHash: e.stubHash,
              panel: e.panelists.panel,
            },
            run.transcript,
            1,
          );
          if (!checked.ok) return false;
          const qualified = checked.registered.map((k) => k.index);
          // Every message it sent is in the transcript as sent: none was dropped.
          return (
            qualified.length >= 3 &&
            qualified.includes(index) &&
            !Object.values(drops).some((dropped) => dropped.includes(index))
          );
        },
      ),
      { numRuns: CEREMONY_RUNS },
    );
  }, 600_000);
});

test("refuses an identity secret that isn't its seat's key", () => {
  const e = election(3, 2);
  expect(
    () =>
      new CeremonySeat({
        panel: e.panelists.panel,
        l2ChainId: L2_CHAIN_ID,
        trusteeRegistry: TRUSTEE_REGISTRY,
        index: 2,
        identitySecret: e.panelists.secrets[0] as Uint8Array,
        electorate: () => Promise.resolve(true),
        store: new MemoryStore(),
      }),
  ).toThrow(RangeError);
});

describe("stub check 4: the forced path over the elections a seat serves", () => {
  // Four seats with the release's windows fit at most 1,024 members alone
  // (docs/spec/delivery.md, Capacity), so two elections of 600 closing
  // together don't fit, and the same two a day apart do.
  const withStub = (e: Election, change: Partial<ElectionDefinition>): Election => {
    const stub = stubFor(e.panelists.panel, {
      election_id: crypto.getRandomValues(new Uint8Array(32)),
      ...change,
    });
    return {
      ...e,
      stub,
      stubBytes: encodeElectionDefinition(stub),
      stubHash: electionStubHash(stub),
    };
  };
  const members = (n: bigint, base: ElectionDefinition) => ({
    electorate: base.electorate.map((g) => ({ ...g, group_size: n })),
  });
  const seat = (e: Election, i: number) => e.seats[i] as CeremonySeat;

  test("an approved election counts against the next one, only where they overlap, never against itself", async () => {
    const e0 = election(4, 2);
    const first = withStub(e0, members(600n, e0.stub));
    const run = await runCeremony(first);
    for (const s of first.seats) value(await s.approve(first.stubBytes, run.transcript));
    value(await seat(first, 0).approve(first.stubBytes, run.transcript));
    const together = withStub(e0, members(600n, e0.stub));
    const runId = crypto.getRandomValues(new Uint8Array(32));
    for (const s of first.seats)
      expect(await s.keys(together.stubBytes, runId)).toEqual({ ok: false, code: "stub-capacity" });
    const dayLater = withStub(e0, {
      ...members(600n, e0.stub),
      opens_at: e0.stub.opens_at + 86_400n,
      closes_at: e0.stub.closes_at + 86_400n,
    });
    expect((await seat(first, 0).keys(dayLater.stubBytes, runId)).ok).toBe(true);
  });

  test("a seat that serves nothing takes the largest election that fits and refuses one member more", async () => {
    const e0 = election(4, 2);
    const runId = crypto.getRandomValues(new Uint8Array(32));
    const at = withStub(e0, members(1_024n, e0.stub));
    const over = withStub(e0, members(1_025n, e0.stub));
    expect((await seat(e0, 0).keys(at.stubBytes, runId)).ok).toBe(true);
    expect(await seat(e0, 1).keys(over.stubBytes, runId)).toEqual({
      ok: false,
      code: "stub-capacity",
    });
  });

  test("of concurrent approvals of two elections that don't fit together, at most one is given", async () => {
    const e0 = election(4, 2);
    const a = withStub(e0, members(600n, e0.stub));
    const b = withStub(e0, members(600n, e0.stub));
    const runA = await runCeremony(a);
    const runB = await runCeremony(b);
    const [x, y] = await Promise.all([
      seat(e0, 0).approve(a.stubBytes, runA.transcript),
      seat(e0, 0).approve(b.stubBytes, runB.transcript),
    ]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
    expect([x, y].find((r) => !r.ok)).toEqual({ ok: false, code: "stub-capacity" });
  });

  test("a restarted seat over the same file store still counts what it approved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "served-"));
    try {
      const e0 = election(4, 2);
      const first = withStub(e0, members(600n, e0.stub));
      const store = await FileStore.open(dir);
      const run = await runCeremony({
        ...first,
        seats: [seatOver(first, 1, store), ...first.seats.slice(1)],
      });
      value(await seatOver(first, 1, store).approve(first.stubBytes, run.transcript));
      const restarted = seatOver(first, 1, await FileStore.open(dir));
      const together = withStub(e0, members(600n, e0.stub));
      expect(
        await restarted.keys(together.stubBytes, crypto.getRandomValues(new Uint8Array(32))),
      ).toEqual({
        ok: false,
        code: "stub-capacity",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
