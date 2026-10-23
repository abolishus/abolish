// The summed-share rule (docs/spec/availability.md, What a seat does, No
// summed share before the quorum): no summing before `t_A' + R`, nor before
// `C_S` is fixed on finalized L1 and the seat's own L2 node has derived a
// block after `t_A'`; then only if the default panel's threshold attested
// both points in time, and never with an attested root the seat doesn't
// hold (T-54, T-14, T-24).
import {
  type Anchor,
  type AnchorClock,
  AVAILABILITY_POINTS,
  type AvailabilityEvent,
  availabilityWindows,
  ceremonyTranscriptHash,
  type Checkpoint,
  checkpointHash,
  copyCheckpoints,
  countedExtent,
  electionDefinitionHash,
  encodeAvailabilityAttestation,
  encodeAvailabilityComplaint,
  encodeBoardEntry,
  RECORD_TYPES,
  SEAT_PANELS,
  signAvailabilityAttestation,
  signAvailabilityComplaint,
} from "@abolishus/crypto";
import fc from "fast-check";
import { beforeAll, describe, expect, test } from "vite-plus/test";
import type { ApprovedElection } from "../src/ceremony.ts";
import { L1AnchorError } from "../src/l1.ts";
import { MemoryStore } from "../src/store.ts";
import { RELEASE_WINDOWS } from "../src/stub.ts";
import { type SummingPanel, summingRule, type SummingStatus } from "../src/summing.ts";
import { election, runCeremony, value } from "./fixture.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const PERIOD = 3_600n;
const DEADLINE = 43_200n;

let elections: readonly ApprovedElection[];
let panel: SummingPanel;

beforeAll(async () => {
  const stores = [0, 1, 2].map(() => new MemoryStore());
  const e = election(3, 2, { stores });
  const run = await runCeremony(e);
  for (const seat of e.seats) value(await seat.approve(e.stubBytes, run.transcript));
  const approved = await Promise.all(e.seats.map((s) => s.approvedElection(e.stubHash)));
  elections = approved.map((x) => x ?? expect.fail("not approved"));
  expect(elections[0]?.definitionHash).toEqual(
    electionDefinitionHash({
      ...e.stub,
      ceremony_transcript_hash: ceremonyTranscriptHash(run.transcript),
    }),
  );
  panel = {
    threshold: 2,
    registered: run.keys.map((k) => ({ index: k.index, signingKey: k.signing_key })),
  };
});

interface World {
  readonly election: ApprovedElection;
  readonly clock: AnchorClock;
  readonly timing: { readonly epoch: bigint; readonly period: bigint; readonly deadline: bigint };
  readonly checkpoints: ReadonlyMap<number, Checkpoint>;
  readonly sA: bigint;
  readonly sS: bigint;
  /** When `C_S` is fixed on finalized L1. */
  readonly fixedAt: bigint;
  readonly windows: ReturnType<typeof availabilityWindows>;
  anchors: readonly Anchor[];
  wall: bigint;
  l1Now: bigint;
  l2At: bigint;
  events: AvailabilityEvent[];
  l1Reads: number;
  l2Reads: number;
  check(p?: SummingPanel): Promise<SummingStatus>;
}

/** A board with entries in segments around `s_A` and `s_S`, anchored a minute after each period ends, and the clocks all past the rule's moments. */
function world(segments?: (sA: number, sS: number) => readonly number[]): World {
  const e = elections[0] as ApprovedElection;
  const epoch = e.closesAt - 86_400n;
  const timing = { epoch, period: PERIOD, deadline: DEADLINE };
  const extent = countedExtent(timing, e.closesAt, e.l1InclusionBound);
  const sA = (e.closesAt - epoch) / PERIOD + 1n;
  const sS = extent.segment;
  const segs = (segments ?? ((a, s) => [0, 3, a - 1, a, s - 1, s, s + 1]))(Number(sA), Number(sS));
  const entries = segs.map((segment, index) =>
    encodeBoardEntry(
      {
        election_id: e.electionId,
        index: BigInt(index),
        segment,
        payload: Uint8Array.of(RECORD_TYPES.ballot >> 8, RECORD_TYPES.ballot & 0xff, 1, index),
      },
      1,
    ),
  );
  const distinct = [...new Set(segs)];
  const checkpoints = copyCheckpoints(e.electionId, entries, distinct);
  const windows = availabilityWindows(e.closesAt, e.l1InclusionBound, extent.due, RELEASE_WINDOWS);
  const fixedAt = epoch + (sS + 1n) * PERIOD + DEADLINE;
  const clock: AnchorClock = { ...timing, lastSegment: Number(sS) + 2 };
  const w: World = {
    election: e,
    clock,
    timing,
    checkpoints,
    sA,
    sS,
    fixedAt,
    windows,
    anchors: distinct.map((s) => ({
      checkpoint: checkpoints.get(s) as Checkpoint,
      anchoredAt: epoch + (BigInt(s) + 1n) * PERIOD + 60n,
    })),
    wall: windows.summing,
    l1Now: windows.summing,
    l2At: windows.countedDeadline + 1n,
    events: [],
    l1Reads: 0,
    l2Reads: 0,
    check: (p = panel) => rule.check(p),
  };
  const rule = summingRule({
    election: e,
    l1: {
      read: async () => {
        w.l1Reads++;
        return { anchors: w.anchors, clock: w.clock, now: w.l1Now };
      },
    },
    counted: timing,
    records: async (definitionHash) => {
      expect(definitionHash).toEqual(e.definitionHash);
      w.l2Reads++;
      return { finalizedAt: w.l2At, events: w.events };
    },
    clock: () => w.wall,
  });
  return w;
}

const cA = (w: World) => w.checkpoints.get(Number(w.sA)) as Checkpoint;
const cS = (w: World) => w.checkpoints.get(Number(w.sS)) as Checkpoint;

/** Seat `index`'s attestation of `point`, naming that point's checkpoint unless another is given. */
function attestation(
  w: World,
  index: number,
  point: 1 | 2,
  o: { checkpoint?: Checkpoint; roots?: readonly Uint8Array[]; secret?: Uint8Array } = {},
): Uint8Array {
  const seat = elections[index - 1] as ApprovedElection;
  return encodeAvailabilityAttestation(
    signAvailabilityAttestation(o.secret ?? seat.signingSecret, {
      definition_hash: seat.definitionHash,
      panel: SEAT_PANELS.default,
      seat: index,
      point,
      checkpoint_hash: checkpointHash(o.checkpoint ?? (point === 1 ? cA(w) : cS(w))),
      roots: o.roots ?? [],
    }),
  );
}

/** Attestations of both points by `seats`, each submitted at its point's deadline. */
function attest(w: World, seats: readonly number[], points: readonly (1 | 2)[] = [1, 2]) {
  for (const point of points)
    for (const index of seats)
      w.events.push({
        payload: attestation(w, index, point),
        submittedAt: point === 1 ? w.windows.ballotDeadline : w.windows.countedDeadline,
      });
  w.events.sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : 1));
}

describe("summingRule", () => {
  test("waits for t_A' + R on the wall clock, reading nothing before it", async () => {
    const w = world();
    attest(w, [1, 2]);
    w.wall = w.windows.summing - 1n;
    expect(await w.check()).toEqual({ state: "waiting", on: "wall", until: w.windows.summing });
    expect([w.l1Reads, w.l2Reads]).toEqual([0, 0]);
    w.wall = w.windows.summing;
    expect(await w.check()).toEqual({ state: "available" });
    // t_A' + R is after both points' deadlines, by R past the counted one.
    expect(w.windows.summing).toBe(w.windows.countedDeadline + RELEASE_WINDOWS.margin);
    expect(w.windows.countedDeadline).toBeGreaterThan(w.windows.ballotDeadline);
  });

  test("waits until C_S is fixed on finalized L1", async () => {
    const w = world();
    attest(w, [1, 2]);
    w.l1Now = w.fixedAt - 1n;
    expect(await w.check()).toEqual({ state: "waiting", on: "l1", until: w.fixedAt });
    expect(w.l2Reads).toBe(0);
    w.l1Now = w.fixedAt;
    expect(await w.check()).toEqual({ state: "available" });
  });

  test("waits until the seat's own L2 node has derived a block after t_A'", async () => {
    const w = world();
    attest(w, [1, 2]);
    w.l2At = w.windows.countedDeadline;
    expect(await w.check()).toEqual({
      state: "waiting",
      on: "l2",
      until: w.windows.countedDeadline + 1n,
    });
    w.l2At = w.windows.countedDeadline + 1n;
    expect(await w.check()).toEqual({ state: "available" });
  });

  test("k attestations at each point make it available; one short at either point is unavailable for good", async () => {
    const w = world();
    attest(w, [1, 2, 3]);
    expect(await w.check()).toEqual({ state: "available" });
    const ballotShort = world();
    attest(ballotShort, [1], [1]);
    attest(ballotShort, [1, 2], [2]);
    expect(await ballotShort.check()).toEqual({
      state: "unavailable",
      failures: [{ point: AVAILABILITY_POINTS.ballotExtent, panel: SEAT_PANELS.default }],
    });
    const countedShort = world();
    attest(countedShort, [1, 2, 3], [1]);
    attest(countedShort, [3], [2]);
    expect(await countedShort.check()).toEqual({
      state: "unavailable",
      failures: [{ point: AVAILABILITY_POINTS.countedExtent, panel: SEAT_PANELS.default }],
    });
    // Later reads, with the head further on, give the same verdict.
    countedShort.l2At += 86_400n;
    countedShort.wall += 86_400n;
    expect((await countedShort.check()).state).toBe("unavailable");
    // A threshold of three needs all three.
    const w3 = world();
    attest(w3, [1, 2]);
    expect((await w3.check({ ...panel, threshold: 3 })).state).toBe("unavailable");
  });

  test("records that don't count are no quorum", async () => {
    // Seat 2's ballot-extent attestation after t_A, with only seat 1's in time.
    const lateBallot = world();
    attest(lateBallot, [1], [1]);
    attest(lateBallot, [1, 2], [2]);
    lateBallot.events.unshift({
      payload: attestation(lateBallot, 2, 1),
      submittedAt: lateBallot.windows.ballotDeadline + 1n,
    });
    lateBallot.events.sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : 1));
    expect(await lateBallot.check()).toEqual({
      state: "unavailable",
      failures: [{ point: 1, panel: SEAT_PANELS.default }],
    });
    const cases: Array<[string, (w: World) => AvailabilityEvent]> = [
      [
        "late",
        (w) => ({ payload: attestation(w, 2, 2), submittedAt: w.windows.countedDeadline + 1n }),
      ],
      [
        "naming C_A at the counted extent",
        (w) => ({
          payload: attestation(w, 2, 2, { checkpoint: cA(w) }),
          submittedAt: w.windows.countedDeadline,
        }),
      ],
      [
        "naming a later checkpoint than C_S",
        (w) => ({
          payload: attestation(w, 2, 2, {
            checkpoint: w.checkpoints.get(Number(w.sS) + 1) as Checkpoint,
          }),
          submittedAt: w.windows.countedDeadline,
        }),
      ],
      [
        "signed by another seat's key",
        (w) => ({
          payload: attestation(w, 2, 2, {
            secret: (elections[2] as ApprovedElection).signingSecret,
          }),
          submittedAt: w.windows.countedDeadline,
        }),
      ],
      [
        "a complaint",
        (w) => ({
          payload: encodeAvailabilityComplaint(
            signAvailabilityComplaint((elections[1] as ApprovedElection).signingSecret, {
              definition_hash: w.election.definitionHash,
              panel: SEAT_PANELS.default,
              seat: 2,
              point: 2,
              checkpoint_hash: checkpointHash(cS(w)),
              cid: cS(w).object_cid,
            }),
          ),
          submittedAt: w.windows.countedDeadline,
        }),
      ],
      [
        "a repeat of seat 1's",
        (w) => ({ payload: attestation(w, 1, 2), submittedAt: w.windows.countedDeadline }),
      ],
    ];
    for (const [name, make] of cases) {
      const w = world();
      attest(w, [1, 2], [1]);
      attest(w, [1], [2]);
      w.events.push(make(w));
      expect(await w.check(), name).toEqual({
        state: "unavailable",
        failures: [{ point: 2, panel: SEAT_PANELS.default }],
      });
    }
    // Seat 2's attestation in time counts where those didn't.
    const w = world();
    attest(w, [1, 2], [1]);
    attest(w, [1], [2]);
    w.events.push({ payload: attestation(w, 2, 2), submittedAt: w.windows.countedDeadline });
    expect(await w.check()).toEqual({ state: "available" });
  });

  test("no counted checkpoint at or before s_S fails the counted extent, whatever is attested", async () => {
    // Nothing in the counted extent past C_A, and no checkpoint between.
    const w = world((sA, sS) => [0, sA, sS + 1]);
    attest(w, [1, 2], [1]);
    for (const index of [1, 2, 3])
      w.events.push({
        payload: attestation(w, index, 2, { checkpoint: cA(w) }),
        submittedAt: w.windows.countedDeadline,
      });
    // C_S is C_A here: the largest counted checkpoint at or before s_S.
    expect(await w.check()).toEqual({ state: "available" });
    const none = world((_, sS) => [sS + 1]);
    for (const point of [1, 2] as const)
      for (const index of [1, 2, 3])
        none.events.push({
          payload: attestation(none, index, point, {
            checkpoint: none.checkpoints.get(Number(none.sS) + 1) as Checkpoint,
          }),
          submittedAt: point === 1 ? none.windows.ballotDeadline : none.windows.countedDeadline,
        });
    expect(await none.check()).toEqual({
      state: "unavailable",
      failures: [
        { point: 1, panel: SEAT_PANELS.default },
        { point: 2, panel: SEAT_PANELS.default },
      ],
    });
  });

  test("a root available to the panel stops it summing; one named by fewer than q − k + 1 seats doesn't", async () => {
    // q = 3 and k = 2, so a root is available when two seats name it.
    const root = (b: number) => new Uint8Array(32).fill(b);
    const naming = (roots: ReadonlyMap<number, readonly Uint8Array[]>) => {
      const w = world();
      attest(w, [1, 2, 3], [1]);
      for (const index of [1, 2, 3])
        w.events.push({
          payload: attestation(w, index, 2, { roots: roots.get(index) ?? [] }),
          submittedAt: w.windows.countedDeadline,
        });
      return w.check();
    };
    // One seat alone can't keep the others from summing.
    expect(await naming(new Map([[2, [root(7)]]]))).toEqual({ state: "available" });
    expect(
      await naming(
        new Map([
          [1, [root(7)]],
          [2, [root(8)]],
        ]),
      ),
    ).toEqual({ state: "available" });
    expect(
      await naming(
        new Map([
          [1, [root(7)]],
          [3, [root(7), root(8)]],
        ]),
      ),
    ).toEqual({ state: "unheld-roots" });
    // A late attestation's roots don't count towards it.
    const w = world();
    attest(w, [1, 2], [1]);
    attest(w, [1, 2], [2]);
    w.events.push({
      payload: attestation(w, 3, 2, { roots: [root(7)] }),
      submittedAt: w.windows.countedDeadline + 1n,
    });
    expect(await w.check()).toEqual({ state: "available" });
  });

  test("a board failing from L1 alone names no checkpoint, so nothing counts", async () => {
    const w = world();
    attest(w, [1, 2, 3]);
    // Another checkpoint anchored in time for C_S's segment: equivocation.
    const cp = cS(w);
    const cid = Uint8Array.from(cp.object_cid);
    cid[cid.length - 1] = (cid.at(-1) as number) ^ 1;
    w.anchors = [
      ...w.anchors,
      {
        checkpoint: { ...cp, object_cid: cid },
        anchoredAt:
          (w.anchors.find((a) => a.checkpoint.segment === cp.segment) as Anchor).anchoredAt + 1n,
      },
    ];
    expect(await w.check()).toEqual({
      state: "unavailable",
      failures: [
        { point: 1, panel: SEAT_PANELS.default },
        { point: 2, panel: SEAT_PANELS.default },
      ],
    });
  });

  test("a reader under another clock, or stopping before s_S, is refused; so is a close before the clock's epoch", async () => {
    const w = world();
    attest(w, [1, 2]);
    (w as { clock: AnchorClock }).clock = { ...w.clock, deadline: DEADLINE + 1n };
    await expect(w.check()).rejects.toEqual(new L1AnchorError("clock"));
    const short = world();
    attest(short, [1, 2]);
    (short as { clock: AnchorClock }).clock = { ...short.clock, lastSegment: Number(short.sS) - 1 };
    await expect(short.check()).rejects.toEqual(new L1AnchorError("clock"));
    const e = elections[0] as ApprovedElection;
    expect(() =>
      summingRule({
        election: e,
        l1: { read: async () => expect.fail("read") },
        counted: { epoch: e.closesAt + 1n, period: PERIOD, deadline: DEADLINE },
        records: async () => expect.fail("read"),
        clock: () => 0n,
      }),
    ).toThrow(new L1AnchorError("outside-clock"));
  });

  test("over which seats attest each point, and in which order, available exactly when both reach k", async () => {
    const seats = fc.subarray([1, 2, 3]);
    await fc.assert(
      fc.asyncProperty(seats, seats, fc.integer({ min: 1, max: 3 }), async (b, c, k) => {
        const w = world();
        attest(w, b, [1]);
        attest(w, c, [2]);
        const got = await w.check({ ...panel, threshold: k });
        const failures = [
          ...(b.length < k ? [{ point: 1, panel: 1 }] : []),
          ...(c.length < k ? [{ point: 2, panel: 1 }] : []),
        ];
        expect(got).toEqual(
          failures.length === 0 ? { state: "available" } : { state: "unavailable", failures },
        );
      }),
      { numRuns },
    );
  });
});
