// The board's tally openings read back (docs/spec/tally.md, Destruction,
// When): every tally opening on the board through the latest counted
// checkpoint finalized L1 shows, read by the CIDs it names from untrusted
// sources and checked against the anchors, with its segment, in board
// order; nothing past the latest anchor, and nothing at all from a copy
// that isn't the anchored one.
import {
  type Anchor,
  type AnchorClock,
  type Checkpoint,
  contentDag,
  copyCheckpoints,
  encodeBoardEntry,
  RECORD_TYPES,
} from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import type { ApprovedElection } from "../src/ceremony.ts";
import { boardOpenings } from "../src/openings.ts";

const PERIOD = 3_600n;
const EPOCH = 1_000_000n;
const CLOCK: AnchorClock = { epoch: EPOCH, period: PERIOD, deadline: 43_200n, lastSegment: 200 };
const ELECTION_ID = new Uint8Array(32).fill(7);
const ELECTION = { electionId: ELECTION_ID } as ApprovedElection;
const key = (b: Uint8Array) => Buffer.from(b).toString("hex");
const concat = (parts: readonly Uint8Array[]) =>
  Uint8Array.from(parts.flatMap((p) => Array.from(p)));

/** A payload of `type` whose body names `n`; the board's entry checks read only its header. */
const payload = (type: number, n: number) => Uint8Array.of(type >> 8, type & 0xff, 1, n);
const ballot = (n: number) => payload(RECORD_TYPES.ballot, n);
const opening = (n: number) => payload(RECORD_TYPES.tallyOpening, n);

/** A board of these payloads in these segments, each segment's run anchored a minute after its period ends. */
function boardOf(
  rows: readonly (readonly [number, Uint8Array])[],
  wrongIndexAt?: number,
  /** Segments anchored again with no new entries. */
  reanchored: readonly number[] = [],
) {
  const entries = rows.map(([segment, p], index) =>
    encodeBoardEntry(
      {
        election_id: ELECTION_ID,
        index: BigInt(index === wrongIndexAt ? index + 1 : index),
        segment,
        payload: p,
      },
      1,
    ),
  );
  const segments = [...new Set(rows.map(([s]) => s))];
  const all = [...segments, ...reanchored].sort((a, b) => a - b);
  const checkpoints = copyCheckpoints(ELECTION_ID, entries, all);
  const anchors: Anchor[] = all.map((s) => ({
    checkpoint: checkpoints.get(s) as Checkpoint,
    anchoredAt: EPOCH + (BigInt(s) + 1n) * PERIOD + 60n,
  }));
  const blocks = new Map<string, Uint8Array>();
  const bySegment = new Map<number, string[]>();
  for (const s of segments) {
    const run = entries.filter((_, i) => rows[i]?.[0] === s);
    const dag = contentDag(concat(run));
    bySegment.set(
      s,
      dag.blocks.map((b) => key(b.cid)),
    );
    for (const b of dag.blocks) blocks.set(key(b.cid), b.bytes);
  }
  return { anchors, blocks, bySegment };
}

interface World {
  /** How many of the board's anchors finalized L1 shows. */
  shown: number;
  /** Segments whose anchors finalized L1 doesn't show yet, among those. */
  readonly pending: Set<number>;
  readonly withheld: Set<number>;
  /** Finalized L1's time, if not a minute past the last anchor shown. */
  now?: bigint;
  clock: AnchorClock;
  fetched: number;
  read: () => ReturnType<ReturnType<typeof boardOpenings>>;
}

function world(board: ReturnType<typeof boardOf>, shown = board.anchors.length): World {
  const w: World = {
    shown,
    pending: new Set(),
    withheld: new Set(),
    clock: CLOCK,
    fetched: 0,
    read: undefined as never,
  };
  const hidden = () =>
    new Set([...w.withheld].flatMap((s) => board.bySegment.get(s) ?? ([] as string[])));
  const read = boardOpenings({
    election: ELECTION,
    l1: {
      boardVersion: 1,
      read: async () => {
        const anchors = board.anchors
          .slice(0, w.shown)
          .filter((a) => !w.pending.has(a.checkpoint.segment));
        const last = anchors.at(-1);
        // Finalized L1 a minute past the last anchor shown.
        const now = w.now ?? (last === undefined ? EPOCH : last.anchoredAt + 60n);
        return { anchors, clock: w.clock, now };
      },
    },
    blocks: async (cid) => {
      w.fetched++;
      const b = board.blocks.get(key(cid));
      return b === undefined || hidden().has(key(cid)) ? [] : [b];
    },
    maxBytes: 1 << 20,
  });
  w.read = read;
  return w;
}

const ROWS = [
  [0, ballot(0)],
  [0, ballot(1)],
  [5, opening(2)],
  [5, ballot(3)],
  [9, opening(4)],
  [12, opening(5)],
] as const;

describe("the board's openings", () => {
  test("every tally opening through the latest anchor, in board order with its segment, and nothing else", async () => {
    const w = world(boardOf(ROWS));
    expect(await w.read()).toEqual({
      state: "read",
      checkpoint: expect.any(Uint8Array),
      openings: [
        { payload: opening(2), segment: 5 },
        { payload: opening(4), segment: 9 },
        { payload: opening(5), segment: 12 },
      ],
    });
  });

  test("nothing past the latest anchor finalized L1 shows, and a later anchor adds what it covers", async () => {
    const w = world(boardOf(ROWS), 2);
    const first = await w.read();
    expect(first.state === "read" && first.openings).toEqual([{ payload: opening(2), segment: 5 }]);
    w.shown = 3;
    const second = await w.read();
    expect(second.state === "read" && second.openings).toEqual([
      { payload: opening(2), segment: 5 },
      { payload: opening(4), segment: 9 },
    ]);
  });

  test("unread while nothing is anchored, or while a run can't be read from the sources", async () => {
    const w = world(boardOf(ROWS), 0);
    expect(await w.read()).toEqual({ state: "unread" });
    w.shown = 3;
    w.withheld.add(5);
    expect(await w.read()).toEqual({ state: "unread" });
    w.withheld.clear();
    expect((await w.read()).state).toBe("read");
  });

  test("a source's wrong blocks are no copy: unread, never openings", async () => {
    const board = boardOf(ROWS);
    const other = boardOf([
      [0, ballot(0)],
      [0, ballot(1)],
      [5, opening(9)],
      [5, ballot(3)],
    ]);
    const w = world(board, 2);
    // The run of segment 5 served as another board's bytes under the
    // anchored CIDs.
    const ours = board.bySegment.get(5) ?? [];
    const theirs = other.bySegment.get(5) ?? [];
    for (const [i, cid] of ours.entries())
      board.blocks.set(cid, other.blocks.get(theirs[i] as string) as Uint8Array);
    expect(await w.read()).toEqual({ state: "unread" });
  });

  test("an opening's run read only once its own checkpoint is anchored, even with a later one anchored first", async () => {
    const w = world(boardOf(ROWS), 3);
    // Segment 9's anchor is shown before segment 5's, as a deadline longer
    // than a period allows: the run between them isn't one checkpoint's.
    w.pending.add(5);
    expect(await w.read()).toEqual({ state: "unread" });
    w.pending.clear();
    expect((await w.read()).state).toBe("read");
  });

  test("a late anchor of an earlier segment makes the board read again, though the latest is the same", async () => {
    // Segment 7 is anchored again with no new entries, after segment 9.
    const w = world(boardOf(ROWS, undefined, [7]), 4);
    w.pending.add(7);
    const first = await w.read();
    expect(first.state).toBe("read");
    const fetched = w.fetched;
    w.pending.clear();
    const second = await w.read();
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
    expect(w.fetched).toBeGreaterThan(fetched);
  });

  test("a seal past the reader's last segment, never anchored, doesn't stop the read", async () => {
    const w = world(boardOf(ROWS), 3);
    // The reader stops at segment 10, whose deadline has long passed with no checkpoint of it.
    w.clock = { ...CLOCK, lastSegment: 10 };
    w.now = EPOCH + 100n * PERIOD;
    const read = await w.read();
    expect(read.state === "read" && read.openings).toEqual([
      { payload: opening(2), segment: 5 },
      { payload: opening(4), segment: 9 },
    ]);
  });

  test("a board failing a check no later read settles is reported, its openings never given", async () => {
    // The fourth entry's index isn't its position: board check 4.
    const w = world(boardOf(ROWS, 3));
    expect(await w.read()).toEqual({ state: "board-failed", code: "wrong-index" });
  });

  test("read once per checkpoint: the same checkpoint gives the same read and fetches nothing again", async () => {
    const w = world(boardOf(ROWS), 3);
    const first = await w.read();
    const fetched = w.fetched;
    expect(fetched).toBeGreaterThan(0);
    expect(await w.read()).toBe(first);
    expect(w.fetched).toBe(fetched);
    // An unread copy is never kept: the next read fetches again.
    w.shown = 4;
    w.withheld.add(12);
    expect(await w.read()).toEqual({ state: "unread" });
    const after = w.fetched;
    expect(await w.read()).toEqual({ state: "unread" });
    expect(w.fetched).toBeGreaterThan(after);
  });

  test("refuses a read budget that isn't a positive integer", () => {
    for (const maxBytes of [0, -1, 1.5, Number.NaN])
      expect(() =>
        boardOpenings({
          election: ELECTION,
          l1: { boardVersion: 1, read: async () => expect.fail("read") },
          blocks: async () => [],
          maxBytes,
        }),
      ).toThrow(RangeError);
  });
});
