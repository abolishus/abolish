// The availability duty at both points (docs/spec/availability.md, What a
// seat does): a seat attests the board through `C_A` (or `C_S`) once it is
// fixed and its copy, read by the anchored CIDs, passes the board checks;
// complains by `c_I` (or `c_A'`) naming the run it couldn't read; signs at
// most one of each per point, stored before sending; and resends the stored
// bytes until the board contract records them.
import {
  type Anchor,
  type AnchorClock,
  availabilityWindows,
  boardEntryHash,
  ceremonyTranscriptHash,
  checkAvailability,
  type Checkpoint,
  checkpointHash,
  contentDag,
  copyCheckpoints,
  countedExtent,
  decodeAvailabilityAttestation,
  decodeAvailabilityComplaint,
  electionDefinitionHash,
  encodeBoardEntry,
  identityKey,
  objectCid,
  RECORD_TYPES,
} from "@abolishus/crypto";
import { RpcError } from "@abolishus/node";
import fc from "fast-check";
import { beforeAll, describe, expect, test } from "vite-plus/test";
import { attested } from "../src/availability.ts";
import {
  type ApprovedElection,
  AvailabilitySeat,
  type AvailabilityKind,
  CeremonySeat,
  type ContractPath,
} from "../src/index.ts";
import { CountedAvailabilityDuties } from "../src/duties.ts";
import { L1AnchorError } from "../src/l1.ts";
import { RELEASE_WINDOWS } from "../src/stub.ts";
import { MemoryStore } from "../src/store.ts";
import { ViewError } from "../src/view.ts";
import {
  type Election,
  election,
  L2_CHAIN_ID,
  runCeremony,
  TRUSTEE_REGISTRY,
  value,
} from "./fixture.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const PERIOD = 3_600n;
const DEADLINE = 43_200n;
const key = (b: Uint8Array) => Buffer.from(b).toString("hex");
const concat = (parts: readonly Uint8Array[]) =>
  Uint8Array.from(parts.flatMap((p) => Array.from(p)));

interface Approved {
  readonly ceremony: Election;
  readonly definitionHash: Uint8Array;
  readonly elections: readonly ApprovedElection[];
  readonly stores: readonly MemoryStore[];
  readonly signingKeys: ReadonlyMap<number, Uint8Array>;
  readonly threshold: number;
  readonly transcript: Uint8Array;
}

let approved: Approved;

beforeAll(async () => {
  const stores = [0, 1, 2].map(() => new MemoryStore());
  const e = election(3, 2, { stores });
  const run = await runCeremony(e);
  for (const seat of e.seats) value(await seat.approve(e.stubBytes, run.transcript));
  const elections = await Promise.all(e.seats.map((s) => s.approvedElection(e.stubHash)));
  approved = {
    ceremony: e,
    definitionHash: electionDefinitionHash({
      ...e.stub,
      ceremony_transcript_hash: ceremonyTranscriptHash(run.transcript),
    }),
    elections: elections.map((x) => x ?? expect.fail("not approved")),
    stores,
    signingKeys: new Map(run.keys.map((k) => [k.index, k.signing_key])),
    threshold: 2,
    transcript: run.transcript,
  };
});

/** A board with entries in `segments`, anchored a minute after each period ends, under a clock from `opens_at`. */
function boardOf(
  electionId: Uint8Array,
  epoch: bigint,
  segments: readonly number[],
  wrongIndexAt?: number,
) {
  const entries = segments.map((segment, index) =>
    encodeBoardEntry(
      {
        election_id: electionId,
        // An entry whose `index` isn't its position fails step 4 only: the
        // checkpoints below are computed from these bytes as they are.
        index: BigInt(index === wrongIndexAt ? index + 1 : index),
        segment,
        payload: Uint8Array.of(RECORD_TYPES.ballot >> 8, RECORD_TYPES.ballot & 0xff, 1, index),
      },
      1,
    ),
  );
  const distinct = [...new Set(segments)];
  const checkpoints = copyCheckpoints(electionId, entries, distinct);
  const anchors: Anchor[] = distinct.map((s) => ({
    checkpoint: checkpoints.get(s) as Checkpoint,
    anchoredAt: epoch + (BigInt(s) + 1n) * PERIOD + 60n,
  }));
  // Each segment's run is its own object (docs/spec/board.md, Segments and checkpoints).
  const objects = new Map<number, Map<string, Uint8Array>>();
  for (const s of distinct) {
    const run = entries.filter((_, i) => segments[i] === s);
    objects.set(s, new Map(contentDag(concat(run)).blocks.map((b) => [key(b.cid), b.bytes])));
  }
  return { entries, checkpoints, anchors, objects };
}

interface World {
  readonly seat: AvailabilitySeat;
  readonly store: MemoryStore;
  readonly election: ApprovedElection;
  readonly sent: Uint8Array[];
  /** What the seat pinned, by CID, in order. */
  readonly pinned: Array<readonly [string, Uint8Array]>;
  failPin: boolean;
  readonly recorded: Map<AvailabilityKind, Uint8Array>;
  readonly withheld: Set<number>;
  wall: bigint;
  l1Now: bigint;
  failSend: boolean;
  anchors: readonly Anchor[];
  readonly clock: AnchorClock;
  readonly board: ReturnType<typeof boardOf>;
  readonly fixedAt: bigint;
  readonly cutoff: bigint;
  /** The point's segment, `s_A` or `s_S`. */
  readonly segment: bigint;
}

// `closes_at` is 86,400 seconds after `opens_at` in the local stub, so with
// hourly periods from `opens_at`, `s_A = 25`.
const SEGMENTS = [0, 0, 3, 10, 24, 25, 25, 26, 27];
const SEAL = 30;

function world(
  seatIndex = 1,
  options: {
    segments?: readonly number[];
    lastSegment?: number;
    wrongIndexAt?: number;
    /** The counted-extent duty (point 2) rather than the ballot extent's. */
    counted?: boolean;
  } = {},
): World {
  const election = approved.elections[seatIndex - 1] as ApprovedElection;
  // A store of its own per world, so each test's duty starts unsigned.
  const own = new MemoryStore();
  const epoch = election.closesAt - 86_400n;
  const clock: AnchorClock = {
    epoch,
    period: PERIOD,
    deadline: DEADLINE,
    lastSegment: options.lastSegment ?? SEAL,
  };
  const board = boardOf(
    election.electionId,
    epoch,
    options.segments ?? SEGMENTS,
    options.wrongIndexAt,
  );
  const timing = { epoch, period: PERIOD, deadline: DEADLINE };
  const sS = countedExtent(timing, election.closesAt, election.l1InclusionBound);
  const segment = options.counted ? sS.segment : (election.closesAt - epoch) / PERIOD + 1n;
  const fixedAt = epoch + (segment + 1n) * PERIOD + DEADLINE;
  const windows = availabilityWindows(
    election.closesAt,
    election.l1InclusionBound,
    sS.due,
    RELEASE_WINDOWS,
  );
  const w: World = {
    seat: undefined as unknown as AvailabilitySeat,
    store: own,
    election,
    sent: [],
    pinned: [],
    failPin: false,
    recorded: new Map(),
    withheld: new Set(),
    wall: fixedAt,
    l1Now: fixedAt,
    failSend: false,
    anchors: board.anchors,
    clock,
    board,
    fixedAt,
    cutoff: options.counted ? windows.countedCutoff : windows.ballotCutoff,
    segment,
  };
  const contract: ContractPath = {
    send: async (record, cutoff) => {
      // Every record is due by its point's cutoff, c_I or c_A'.
      expect(cutoff).toBe(w.cutoff);
      if (w.failSend) throw new Error("sequencer down and L1 unreachable");
      w.sent.push(Uint8Array.from(record));
    },
    recorded: async (kind, definitionHash, panel, seat, point) => {
      expect([key(definitionHash), panel, seat, point]).toEqual([
        key(election.definitionHash),
        1,
        election.index,
        options.counted ? 2 : 1,
      ]);
      return w.recorded.get(kind);
    },
  };
  const seat = new AvailabilitySeat({
    store: own,
    election,
    boardVersion: 1,
    l1: { read: async () => ({ anchors: w.anchors, clock, now: w.l1Now }) },
    blocks: async (cid) => {
      for (const [s, blocks] of board.objects) {
        if (w.withheld.has(s)) continue;
        const b = blocks.get(key(cid));
        if (b !== undefined) return [b];
      }
      return [];
    },
    pin: async (cid, object) => {
      if (w.failPin) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      w.pinned.push([key(cid), Uint8Array.from(object)]);
    },
    contract,
    ...(options.counted ? { counted: timing } : {}),
    clock: () => w.wall,
    sendMargin: 600n,
    maxBytes: 1 << 20,
  });
  (w as { seat: AvailabilitySeat }).seat = seat;
  return w;
}

const cA = (w: World) => w.board.checkpoints.get(25) as Checkpoint;

describe("approvedElection", () => {
  test("gives the approved run's per-election signing key and the definition the approval registers", async () => {
    for (const e of approved.elections) {
      // The secret's public key is the one the approved transcript registered for the seat.
      expect(key(identityKey(e.signingSecret))).toBe(
        key(approved.signingKeys.get(e.index) as Uint8Array),
      );
      expect(key(e.definitionHash)).toBe(key(approved.definitionHash));
      expect(key(e.stubHash)).toBe(key(approved.ceremony.stubHash));
      expect(key(e.electionId)).toBe(key(approved.ceremony.stub.election_id));
      expect([e.closesAt, e.l1InclusionBound]).toEqual([
        approved.ceremony.stub.closes_at,
        BigInt(approved.ceremony.stub.l1_inclusion_bound),
      ]);
    }
  });

  test("is the same after a restart over the same store, and undefined for a stub the seat didn't approve", async () => {
    const e = approved.ceremony;
    const restarted = new CeremonySeat({
      panel: e.panelists.panel,
      l2ChainId: L2_CHAIN_ID,
      trusteeRegistry: TRUSTEE_REGISTRY,
      index: 2,
      identitySecret: e.panelists.secrets[1] as Uint8Array,
      electorate: () => Promise.resolve(true),
      store: approved.stores[1] as MemoryStore,
    });
    expect(await restarted.approvedElection(e.stubHash)).toEqual(approved.elections[1]);
    expect(await restarted.approvedElection(new Uint8Array(32))).toBeUndefined();
    // The tally's transcript is the seat's own copy of the one it approved.
    expect(await restarted.approvedTranscript(e.stubHash)).toEqual(approved.transcript);
    expect(await restarted.approvedTranscript(new Uint8Array(32))).toBeUndefined();
    expect(await world(1).seat.step()).toMatchObject({ state: "sent" });
  });
});

describe("the ballot extent", () => {
  test("waits until C_A is fixed on finalized L1, then attests the board through it", async () => {
    const w = world();
    w.l1Now = w.fixedAt - 1n;
    expect(await w.seat.step()).toEqual({ state: "waiting", until: w.fixedAt });
    expect(w.sent).toEqual([]);
    w.l1Now = w.fixedAt;
    expect(await w.seat.step()).toEqual({ state: "sent", kind: "attestation" });
    expect(w.sent).toHaveLength(1);
    const a = decodeAvailabilityAttestation(w.sent[0] as Uint8Array, 1);
    expect(a.panel).toBe(1);
    expect(a.seat).toBe(1);
    expect(a.point).toBe(1);
    expect(key(a.definition_hash)).toBe(key(w.election.definitionHash));
    // C_A is segment 25's checkpoint, never a later one the seat also sees.
    expect(key(a.checkpoint_hash)).toBe(key(checkpointHash(cA(w))));
    expect(a.roots).toEqual([]);
  });

  test("reads only the runs through C_A: a later segment withheld doesn't stop it", async () => {
    const w = world();
    w.withheld.add(26).add(27);
    expect(await w.seat.step()).toEqual({ state: "sent", kind: "attestation" });
  });

  test("holds the extent it attested for the decision at c_I, and none before attesting", async () => {
    const w = world();
    w.l1Now = w.fixedAt - 1n;
    await w.seat.step();
    expect(await w.seat.heldExtent()).toBeUndefined();
    w.l1Now = w.fixedAt;
    expect(await w.seat.step()).toEqual({ state: "sent", kind: "attestation" });
    // Later segments withheld change nothing: only the runs through C_A are read.
    w.withheld.add(26).add(27);
    const held = await w.seat.heldExtent();
    expect(held?.boardSegment).toBe(25n);
    expect(held?.entries.map(key)).toEqual(w.board.entries.slice(0, Number(cA(w).size)).map(key));
  });

  test("refuses to hand over an extent other than the attested one, or one it no longer holds", async () => {
    const w = world();
    expect(await w.seat.step()).toEqual({ state: "sent", kind: "attestation" });
    // An L1 node hiding C_A's anchor shows an earlier checkpoint as C_A.
    w.anchors = w.board.anchors.filter((a) => a.checkpoint.segment !== 25);
    await expect(w.seat.heldExtent()).rejects.toBeInstanceOf(RpcError);
    w.anchors = w.board.anchors;
    w.withheld.add(10);
    await expect(w.seat.heldExtent()).rejects.toEqual(new ViewError("extent-lost"));
  });

  test("a threshold of seats' attestations makes the ballot extent available", async () => {
    const events = [];
    for (const index of [1, 2, 3]) {
      const w = world(index);
      await w.seat.step();
      events.push({ payload: w.sent[0] as Uint8Array, submittedAt: w.wall });
    }
    const w = world();
    const report = checkAvailability(
      {
        definitionHash: w.election.definitionHash,
        panels: [
          {
            panel: 1,
            threshold: approved.threshold,
            registered: [...approved.signingKeys].map(([index, signingKey]) => ({
              index,
              signingKey,
            })),
          },
        ],
        checkpoints: { ballot: checkpointHash(cA(w)), counted: null },
        deadlines: {
          ballot: availabilityWindows(
            w.election.closesAt,
            w.election.l1InclusionBound,
            0n,
            RELEASE_WINDOWS,
          ).ballotDeadline,
          counted: 0n,
        },
      },
      events,
    );
    expect(report.records.map((r) => r.code)).toEqual(["valid", "valid", "valid"]);
    expect(report.points[0]?.panels[0]?.attested.map((a) => a.seat)).toEqual([1, 2, 3]);
    expect(report.points[0]?.panels[0]?.holds).toBe(true);
  });

  test("resends the stored bytes until the contract records them, then stands down", async () => {
    const w = world();
    w.failSend = true;
    await expect(w.seat.step()).rejects.toThrow("sequencer down");
    const stored = await w.store.get(
      `availability/${key(w.election.definitionHash)}/ballot/attestation`,
    );
    expect(stored).toBeDefined();
    w.failSend = false;
    // Past the cutoff too: a stored record is still resent, since a forced
    // inclusion by `t_A` counts.
    w.wall = w.cutoff + 1n;
    expect(await w.seat.step()).toEqual({ state: "sent", kind: "attestation" });
    expect(await w.seat.step()).toEqual({ state: "sent", kind: "attestation" });
    expect(w.sent.map(key)).toEqual([key(stored as Uint8Array), key(stored as Uint8Array)]);
    w.recorded.set("attestation", stored as Uint8Array);
    expect(await w.seat.step()).toEqual({ state: "recorded" });
    expect(w.sent).toHaveLength(2);
  });

  test("raises an alarm when the contract holds another attestation for the seat's slot", async () => {
    const w = world();
    await w.seat.step();
    const other = Uint8Array.from(w.sent[0] as Uint8Array);
    other.set([(other.at(-1) as number) ^ 1], other.length - 1);
    w.recorded.set("attestation", other);
    expect(await w.seat.step()).toEqual({ state: "foreign-record", kind: "attestation" });
  });

  test("keeps fetching a withheld run, complains by the cutoff naming it, and attests once it holds it", async () => {
    const w = world();
    w.withheld.add(24);
    expect(await w.seat.step()).toEqual({ state: "fetching" });
    w.wall = w.cutoff - 600n;
    expect(await w.seat.step()).toEqual({ state: "sent", kind: "complaint" });
    const c = decodeAvailabilityComplaint(w.sent[0] as Uint8Array, 1);
    expect(key(c.cid)).toBe(key((w.board.checkpoints.get(24) as Checkpoint).object_cid));
    expect(key(c.checkpoint_hash)).toBe(key(checkpointHash(cA(w))));
    // A seat that complains pins nothing: it holds no copy to serve.
    expect(w.pinned).toEqual([]);
    // Once recorded, the seat still tries to attest; it never signs a second complaint.
    w.recorded.set("complaint", w.sent[0] as Uint8Array);
    expect(await w.seat.step()).toEqual({ state: "complained" });
    w.withheld.clear();
    expect(await w.seat.step()).toEqual({ state: "sent", kind: "attestation" });
    expect(w.sent.map((b) => b[1])).toEqual([
      RECORD_TYPES.availabilityComplaint & 0xff,
      RECORD_TYPES.availabilityAttestation & 0xff,
    ]);
  });

  test("a mirror's wrong blocks are no copy: the seat complains, never attests", async () => {
    const w = world();
    const objects = w.board.objects.get(25) as Map<string, Uint8Array>;
    for (const [cid, bytes] of objects) {
      const bad = Uint8Array.from(bytes);
      bad.set([(bad.at(-1) as number) ^ 1], bad.length - 1);
      objects.set(cid, bad);
    }
    w.wall = w.cutoff;
    expect(await w.seat.step()).toEqual({ state: "sent", kind: "complaint" });
    const c = decodeAvailabilityComplaint(w.sent[0] as Uint8Array, 1);
    expect(key(c.cid)).toBe(key(cA(w).object_cid));
  });

  test("signs nothing new after the cutoff", async () => {
    const w = world();
    w.wall = w.cutoff + 1n;
    expect(await w.seat.step()).toEqual({ state: "past-cutoff", complained: false });
    expect(w.sent).toEqual([]);
  });

  test("names no checkpoint when none is counted at or before s_A", async () => {
    const w = world(1, { segments: [26, 27] });
    expect(await w.seat.step()).toEqual({ state: "no-checkpoint" });
    expect(w.sent).toEqual([]);
  });

  test("a board that fails from L1 alone gets neither record", async () => {
    const w = world();
    const first = w.anchors[0] as Anchor;
    const forked: Checkpoint = { ...first.checkpoint, head: new Uint8Array(32).fill(7) };
    w.anchors = [...w.anchors, { checkpoint: forked, anchoredAt: first.anchoredAt + 1n }];
    expect(await w.seat.step()).toEqual({
      state: "board-failed",
      code: "checkpoint-equivocation",
    });
    w.wall = w.cutoff;
    expect(await w.seat.step()).toEqual({
      state: "board-failed",
      code: "checkpoint-equivocation",
    });
    expect(w.sent).toEqual([]);
  });

  test("a fully read board that fails a later board check gets neither record", async () => {
    // Segment 24's entry-hash list CID names no list of its entries: `checkpoint-cid`.
    const cid = world();
    cid.anchors = cid.anchors.map((a) =>
      a.checkpoint.segment === 24
        ? { ...a, checkpoint: { ...a.checkpoint, hashes_cid: a.checkpoint.object_cid } }
        : a,
    );
    // An entry whose index isn't its position: step 4's `wrong-index`.
    const index = world(1, { wrongIndexAt: 3 });
    for (const [w, code] of [
      [cid, "checkpoint-cid"],
      [index, "wrong-index"],
    ] as const) {
      expect(await w.seat.step()).toEqual({ state: "board-failed", code });
      w.wall = w.cutoff;
      expect(await w.seat.step()).toEqual({ state: "board-failed", code });
      expect(w.sent).toEqual([]);
    }
  });

  test("an anchored run whose bytes match neither its head nor its root is no copy: the seat complains naming it", async () => {
    const w = world();
    w.anchors = w.anchors.map((a) =>
      a.checkpoint.segment === 25
        ? {
            ...a,
            checkpoint: {
              ...a.checkpoint,
              head: new Uint8Array(32).fill(1),
              root: new Uint8Array(32).fill(2),
            },
          }
        : a,
    );
    expect(await w.seat.step()).toEqual({ state: "fetching" });
    w.wall = w.cutoff;
    expect(await w.seat.step()).toEqual({ state: "sent", kind: "complaint" });
    const c = decodeAvailabilityComplaint(w.sent[0] as Uint8Array, 1);
    expect(key(c.cid)).toBe(key(cA(w).object_cid));
  });

  test("a seal never anchored doesn't stop the attestation: it judges past the extent", async () => {
    // Nothing in segment 25, the seal: C_A is segment 24's checkpoint.
    const w = world(1, { segments: [0, 3, 24], lastSegment: 25 });
    w.l1Now = w.fixedAt + 1n;
    expect(await w.seat.step()).toEqual({ state: "sent", kind: "attestation" });
    const a = decodeAvailabilityAttestation(w.sent[0] as Uint8Array, 1);
    expect(key(a.checkpoint_hash)).toBe(
      key(checkpointHash(w.board.checkpoints.get(24) as Checkpoint)),
    );
    expect(w.pinned.map(([cid]) => cid)).toEqual(
      [0, 3, 24].flatMap((s) => {
        const cp = w.board.checkpoints.get(s) as Checkpoint;
        return [key(cp.object_cid), key(cp.hashes_cid)];
      }),
    );
  });

  test("pins every segment object and entry-hash list through C_A, and nothing past it, before it signs", async () => {
    const w = world();
    w.failPin = true;
    await expect(w.seat.step()).rejects.toThrow("disk full");
    // Nothing signed or sent while the extent can't be pinned.
    expect(w.sent).toEqual([]);
    expect(
      await w.store.get(`availability/${key(w.election.definitionHash)}/ballot/attestation`),
    ).toBeUndefined();
    w.failPin = false;
    expect(await w.seat.step()).toEqual({ state: "sent", kind: "attestation" });
    const expected = [0, 3, 10, 24, 25].flatMap((s) => {
      const run = w.board.entries.filter((_, i) => SEGMENTS[i] === s);
      const cp = w.board.checkpoints.get(s) as Checkpoint;
      return [
        [key(cp.object_cid), key(concat(run))],
        [key(cp.hashes_cid), key(concat(run.map(boardEntryHash)))],
      ];
    });
    expect(w.pinned.map(([cid, object]) => [cid, key(object)])).toEqual(expected);
    for (const [cid, object] of w.pinned) expect(key(objectCid(object))).toBe(cid);
  });

  test("a re-anchor with no new entries names a run already pinned: pinned once, and the seat still attests", async () => {
    const w = world();
    // Segment 11 has no entries, so its checkpoint carries segment 10's size and CIDs.
    const again = copyCheckpoints(w.election.electionId, w.board.entries, [11]).get(
      11,
    ) as Checkpoint;
    expect(again.size).toBe((w.board.checkpoints.get(10) as Checkpoint).size);
    w.anchors = [
      ...w.anchors,
      { checkpoint: again, anchoredAt: w.clock.epoch + 12n * PERIOD + 60n },
    ];
    expect(await w.seat.step()).toEqual({ state: "sent", kind: "attestation" });
    const cids = w.pinned.map(([cid]) => cid);
    expect(cids).toHaveLength(10);
    expect(new Set(cids).size).toBe(10);
  });

  test("two steps at once send only the stored attestation", async () => {
    const w = world();
    await Promise.all([w.seat.step(), w.seat.step(), w.seat.step()]);
    const stored = await w.store.get(
      `availability/${key(w.election.definitionHash)}/ballot/attestation`,
    );
    expect(w.sent.length).toBeGreaterThan(0);
    for (const b of w.sent) expect(key(b)).toBe(key(stored as Uint8Array));
  });

  test("stops sending a record the contract never recorded once t_A has passed", async () => {
    const w = world();
    await w.seat.step();
    w.wall = w.seat.deadline;
    expect(await w.seat.step()).toEqual({ state: "sent", kind: "attestation" });
    w.wall = w.seat.deadline + 1n;
    expect(await w.seat.step()).toEqual({ state: "unrecorded", kind: "attestation" });
    expect(w.sent).toHaveLength(2);
    // A record recorded in time is still found as such.
    w.recorded.set("attestation", w.sent[0] as Uint8Array);
    expect(await w.seat.step()).toEqual({ state: "recorded" });
  });

  test("whatever the sources, failures and timing: one attestation and one complaint at most, signed by the cutoff, resent byte for byte until recorded", async () => {
    const kindOf = (b: Uint8Array): AvailabilityKind =>
      b[1] === (RECORD_TYPES.availabilityComplaint & 0xff) ? "complaint" : "attestation";
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            withhold: fc.subarray([0, 3, 10, 24, 25]),
            fail: fc.boolean(),
            advance: fc.bigInt({ min: 0n, max: 40_000n }),
            record: fc.boolean(),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        async (steps) => {
          const w = world();
          const prefix = `availability/${key(w.election.definitionHash)}/ballot`;
          const signedAt = new Map<AvailabilityKind, bigint>();
          let sentAfterRecorded = 0;
          for (const s of steps) {
            w.withheld.clear();
            for (const seg of s.withhold) w.withheld.add(seg);
            w.failSend = s.fail;
            w.wall += s.advance;
            w.l1Now += s.advance;
            const before = w.sent.length;
            await w.seat.step().catch((e: unknown) => {
              if (!(e instanceof Error) || !e.message.includes("sequencer down")) throw e;
            });
            for (const kind of ["attestation", "complaint"] as const)
              if (!signedAt.has(kind) && (await w.store.get(`${prefix}/${kind}`)) !== undefined)
                signedAt.set(kind, w.wall);
            for (const b of w.sent.slice(before))
              if (w.recorded.has(kindOf(b))) sentAfterRecorded++;
            const last = w.sent.at(-1);
            if (s.record && last !== undefined) w.recorded.set(kindOf(last), last);
          }
          const byKind = new Map<AvailabilityKind, Set<string>>();
          for (const b of w.sent)
            byKind.set(kindOf(b), (byKind.get(kindOf(b)) ?? new Set()).add(key(b)));
          for (const [kind, sent] of byKind) {
            expect(sent.size).toBe(1);
            expect([...sent]).toEqual([
              key((await w.store.get(`${prefix}/${kind}`)) as Uint8Array),
            ]);
          }
          for (const at of signedAt.values()) expect(at).toBeLessThanOrEqual(w.cutoff);
          expect(sentAfterRecorded).toBe(0);
        },
      ),
      { numRuns },
    );
  });
});

describe("the counted extent", () => {
  // `s_S` and its neighbours, from a world's own clock and definition.
  const sS = () => Number(world(1, { counted: true }).segment);
  const counted = (index = 1, segments?: readonly number[]) => {
    const s = sS();
    return world(index, {
      counted: true,
      segments: segments ?? [0, 3, 25, s - 1, s, s + 1],
      lastSegment: s + 2,
    });
  };
  const cS = (w: World) => w.board.checkpoints.get(Number(w.segment)) as Checkpoint;

  test("s_S and t_S are the counted extent's, after the ballot extent's", () => {
    const b = world();
    const w = counted();
    expect(w.segment).toBeGreaterThan(b.segment);
    // `C_S` is fixed at `t_S`, its last segment's anchoring deadline.
    expect(w.fixedAt).toBe(
      countedExtent(
        { epoch: w.clock.epoch, period: PERIOD, deadline: DEADLINE },
        w.election.closesAt,
        w.election.l1InclusionBound,
      ).due,
    );
    expect(w.seat.cutoff).toBe(w.cutoff);
    expect(w.seat.deadline).toBe(w.cutoff + RELEASE_WINDOWS.forcedInclusion);
    expect(w.seat.cutoff).toBeGreaterThan(b.seat.deadline);
  });

  test("waits until C_S is fixed on finalized L1, then attests the board through it at point 2 with no roots", async () => {
    const w = counted();
    w.l1Now = w.fixedAt - 1n;
    expect(await w.seat.step()).toEqual({ state: "waiting", until: w.fixedAt });
    expect(w.sent).toEqual([]);
    w.l1Now = w.fixedAt;
    expect(await w.seat.step()).toEqual({ state: "sent", kind: "attestation" });
    const a = decodeAvailabilityAttestation(w.sent[0] as Uint8Array, 1);
    expect([a.panel, a.seat, a.point]).toEqual([1, 1, 2]);
    expect(key(a.definition_hash)).toBe(key(w.election.definitionHash));
    // C_S is segment s_S's checkpoint, never the later one the seat also sees.
    expect(key(a.checkpoint_hash)).toBe(key(checkpointHash(cS(w))));
    expect(a.roots).toEqual([]);
    // Stored under the point's own name, beside the ballot extent's.
    const prefix = `availability/${key(w.election.definitionHash)}`;
    expect(key((await w.store.get(`${prefix}/counted/attestation`)) as Uint8Array)).toBe(
      key(w.sent[0] as Uint8Array),
    );
    expect(await w.store.get(`${prefix}/ballot/attestation`)).toBeUndefined();
  });

  test("a seat that attested the ballot extent signs its own record at the counted extent", async () => {
    const s = sS();
    const segments = [0, 3, 25, s - 1, s, s + 1];
    const ballot = world(1, { segments, lastSegment: s + 2 });
    expect(await ballot.seat.step()).toEqual({ state: "sent", kind: "attestation" });
    // The counted duty over the same store and board.
    const w = counted(1, segments);
    const own = new AvailabilitySeat({
      store: ballot.store,
      election: w.election,
      boardVersion: 1,
      l1: { read: async () => ({ anchors: w.anchors, clock: w.clock, now: w.l1Now }) },
      blocks: async (cid) => {
        for (const blocks of w.board.objects.values()) {
          const b = blocks.get(key(cid));
          if (b !== undefined) return [b];
        }
        return [];
      },
      pin: async () => undefined,
      contract: { send: async (r) => void w.sent.push(r), recorded: async () => undefined },
      counted: { epoch: w.clock.epoch, period: PERIOD, deadline: DEADLINE },
      clock: () => w.wall,
      sendMargin: 600n,
      maxBytes: 1 << 20,
    });
    expect(await own.step()).toEqual({ state: "sent", kind: "attestation" });
    const [first, second] = [ballot.sent[0], w.sent[0]].map((b) =>
      decodeAvailabilityAttestation(b as Uint8Array, 1),
    );
    expect([first?.point, second?.point]).toEqual([1, 2]);
    expect(key(first?.checkpoint_hash as Uint8Array)).toBe(
      key(checkpointHash(ballot.board.checkpoints.get(25) as Checkpoint)),
    );
    expect(key(second?.checkpoint_hash as Uint8Array)).toBe(key(checkpointHash(cS(w))));
    expect(await attested(ballot.store, w.election.definitionHash, 1)).toBe(true);
    expect(await attested(ballot.store, w.election.definitionHash, 2)).toBe(true);
    expect(await own.heldExtent()).toMatchObject({ boardSegment: w.segment });
  });

  test("pins every run through C_S, and reads nothing past it", async () => {
    const w = counted();
    const s = Number(w.segment);
    w.withheld.add(s + 1);
    expect(await w.seat.step()).toEqual({ state: "sent", kind: "attestation" });
    expect(w.pinned.map(([cid]) => cid)).toEqual(
      [0, 3, 25, s - 1, s].flatMap((seg) => {
        const cp = w.board.checkpoints.get(seg) as Checkpoint;
        return [key(cp.object_cid), key(cp.hashes_cid)];
      }),
    );
  });

  test("complains by c_A' naming a withheld run, and signs nothing new after it", async () => {
    const w = counted();
    const s = Number(w.segment);
    w.withheld.add(s - 1);
    expect(await w.seat.step()).toEqual({ state: "fetching" });
    w.wall = w.cutoff - 600n;
    expect(await w.seat.step()).toEqual({ state: "sent", kind: "complaint" });
    const c = decodeAvailabilityComplaint(w.sent[0] as Uint8Array, 1);
    expect(c.point).toBe(2);
    expect(key(c.cid)).toBe(key((w.board.checkpoints.get(s - 1) as Checkpoint).object_cid));
    expect(key(c.checkpoint_hash)).toBe(key(checkpointHash(cS(w))));
    const late = counted();
    late.wall = late.cutoff + 1n;
    expect(await late.seat.step()).toEqual({ state: "past-cutoff", complained: false });
    expect(late.sent).toEqual([]);
  });

  test("names no checkpoint when none is counted at or before s_S", async () => {
    const s = sS();
    const w = counted(1, [s + 1]);
    expect(await w.seat.step()).toEqual({ state: "no-checkpoint" });
    expect(w.sent).toEqual([]);
  });

  test("refuses a reader whose clock isn't the pinned one, signing nothing", async () => {
    const w = counted();
    const seat = new AvailabilitySeat({
      store: w.store,
      election: w.election,
      boardVersion: 1,
      l1: {
        read: async () => ({
          anchors: w.anchors,
          clock: { ...w.clock, period: 1_800n },
          now: w.l1Now,
        }),
      },
      blocks: async () => [],
      pin: async () => undefined,
      contract: { send: async (r) => void w.sent.push(r), recorded: async () => undefined },
      counted: { epoch: w.clock.epoch, period: PERIOD, deadline: DEADLINE },
      clock: () => w.wall,
      sendMargin: 600n,
      maxBytes: 1 << 20,
    });
    await expect(seat.step()).rejects.toEqual(new L1AnchorError("clock"));
    expect(w.sent).toEqual([]);
  });

  test("refuses a reader stopping before s_S, so C_A is never attested as point 2", async () => {
    const w = counted();
    // The ballot extent's reader: its clock's last segment is s_A.
    w.l1Now = w.fixedAt;
    const seat = new AvailabilitySeat({
      store: w.store,
      election: w.election,
      boardVersion: 1,
      l1: {
        read: async () => ({
          anchors: w.anchors,
          clock: { ...w.clock, lastSegment: 25 },
          now: w.l1Now,
        }),
      },
      blocks: async () => [],
      pin: async () => undefined,
      contract: { send: async (r) => void w.sent.push(r), recorded: async () => undefined },
      counted: { epoch: w.clock.epoch, period: PERIOD, deadline: DEADLINE },
      clock: () => w.wall,
      sendMargin: 600n,
      maxBytes: 1 << 20,
    });
    await expect(seat.step()).rejects.toEqual(new L1AnchorError("clock"));
    expect(w.sent).toEqual([]);
    expect(await attested(w.store, w.election.definitionHash, 2)).toBe(false);
  });

  test("a recorded ballot-extent attestation leaves the counted extent's to do", async () => {
    const w = counted();
    const recordedPoints: number[] = [];
    const seat = new AvailabilitySeat({
      store: w.store,
      election: w.election,
      boardVersion: 1,
      l1: { read: async () => ({ anchors: w.anchors, clock: w.clock, now: w.l1Now }) },
      blocks: async (cid) => {
        for (const blocks of w.board.objects.values()) {
          const b = blocks.get(key(cid));
          if (b !== undefined) return [b];
        }
        return [];
      },
      pin: async () => undefined,
      contract: {
        send: async (r) => void w.sent.push(r),
        // The contract holds the seat's point-1 attestation only.
        recorded: async (_kind, _hash, _panel, _seat, point) => {
          recordedPoints.push(point);
          return point === 1 ? new Uint8Array(138) : undefined;
        },
      },
      counted: { epoch: w.clock.epoch, period: PERIOD, deadline: DEADLINE },
      clock: () => w.wall,
      sendMargin: 600n,
      maxBytes: 1 << 20,
    });
    expect(await seat.step()).toEqual({ state: "sent", kind: "attestation" });
    expect(recordedPoints).toEqual([2]);
  });

  test("raises an alarm when the contract holds another counted-extent attestation for the seat's slot", async () => {
    const w = counted();
    await w.seat.step();
    const other = Uint8Array.from(w.sent[0] as Uint8Array);
    other.set([(other.at(-1) as number) ^ 1], other.length - 1);
    w.recorded.set("attestation", other);
    expect(await w.seat.step()).toEqual({ state: "foreign-record", kind: "attestation" });
  });

  test("refuses an election closing before the pinned clock's epoch", () => {
    const w = counted();
    expect(
      () =>
        new AvailabilitySeat({
          store: w.store,
          election: w.election,
          boardVersion: 1,
          l1: { read: async () => ({ anchors: [], clock: w.clock, now: 0n }) },
          blocks: async () => [],
          pin: async () => undefined,
          contract: { send: async () => undefined, recorded: async () => undefined },
          counted: { epoch: w.election.closesAt + 1n, period: PERIOD, deadline: DEADLINE },
          clock: () => 0n,
          sendMargin: 600n,
          maxBytes: 1 << 20,
        }),
    ).toThrow(new L1AnchorError("outside-clock"));
  });

  test("a threshold of seats' attestations makes the counted extent available", async () => {
    const events = [];
    for (const index of [1, 2, 3]) {
      const w = counted(index);
      await w.seat.step();
      events.push({ payload: w.sent[0] as Uint8Array, submittedAt: w.wall });
    }
    const w = counted();
    const report = checkAvailability(
      {
        definitionHash: w.election.definitionHash,
        panels: [
          {
            panel: 1,
            threshold: approved.threshold,
            registered: [...approved.signingKeys].map(([index, signingKey]) => ({
              index,
              signingKey,
            })),
          },
        ],
        checkpoints: { ballot: null, counted: checkpointHash(cS(w)) },
        deadlines: { ballot: 0n, counted: w.seat.deadline },
      },
      events,
    );
    expect(report.records.map((r) => r.code)).toEqual(["valid", "valid", "valid"]);
    expect(report.points[1]?.panels[0]?.attested.map((a) => a.seat)).toEqual([1, 2, 3]);
    expect(report.points[1]?.panels[0]?.holds).toBe(true);
  });

  test("resends the stored bytes until recorded, and stops once t_A' has passed", async () => {
    const w = counted();
    await w.seat.step();
    w.wall = w.seat.deadline;
    expect(await w.seat.step()).toEqual({ state: "sent", kind: "attestation" });
    w.wall = w.seat.deadline + 1n;
    expect(await w.seat.step()).toEqual({ state: "unrecorded", kind: "attestation" });
    expect(new Set(w.sent.map(key)).size).toBe(1);
    w.recorded.set("attestation", w.sent[0] as Uint8Array);
    expect(await w.seat.step()).toEqual({ state: "recorded" });
  });

  test("the duties give an election up once t_A' passes before its reader can be set up", async () => {
    const w = counted();
    const events: unknown[] = [];
    let wall = w.seat.deadline;
    const duties = new CountedAvailabilityDuties(
      {
        seat: {
          approvedStubs: async () => [w.election.stubHash],
          approvedElection: async () => w.election,
        },
        build: async () => {
          throw new RpcError("eth_chainId: TimeoutError");
        },
        clock: () => wall,
        log: (e) => events.push(e),
      },
      { epoch: w.clock.epoch, period: PERIOD, deadline: DEADLINE },
    );
    await duties.step();
    wall += 1n;
    await duties.step();
    await duties.step();
    const stubHash = key(w.election.stubHash);
    expect(events).toEqual([
      {
        event: "counted-availability-error",
        stubHash,
        error: "RpcError",
        message: "eth_chainId: TimeoutError",
      },
      { event: "counted-availability-abandoned", stubHash },
    ]);
  });
});
