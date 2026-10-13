import {
  checkCeremonyTranscript,
  decodeCeremonyTranscript,
  encodeCeremonyTranscript,
  keySetEntry,
  keySetHash,
  verifyCeremonyRegistration,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { CeremonySeat, MemoryStore, type SeatStore } from "../src/index.ts";
import { election, L2_CHAIN_ID, runCeremony, TRUSTEE_REGISTRY, value } from "./fixture.ts";

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
  test("refuses a run it has seen, and takes a fresh run_id with fresh keys", async () => {
    const e = election(3, 2);
    const seat = e.seats[0] as CeremonySeat;
    const runId = crypto.getRandomValues(new Uint8Array(32));
    const first = value(await seat.keys(e.stubBytes, runId));
    expect(await seat.keys(e.stubBytes, runId)).toEqual({ ok: false, code: "run-seen" });
    const other = value(await seat.keys(e.stubBytes, crypto.getRandomValues(new Uint8Array(32))));
    expect(other.signing_key).not.toEqual(first.signing_key);
    expect(other.kem_key.ek).not.toEqual(first.kem_key.ek);
  });

  test("concurrent requests to join one run: exactly one joins", async () => {
    const e = election(3, 2);
    const seat = e.seats[0] as CeremonySeat;
    const runId = crypto.getRandomValues(new Uint8Array(32));
    const results = await Promise.all(
      Array.from({ length: 5 }, () => seat.keys(e.stubBytes, runId)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
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
