import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  type Anchor,
  type AnchorClock,
  BOARD_PAYLOAD_TYPES,
  BOARD_PAYLOAD_TYPES_V3,
  BOARD_PAYLOAD_TYPES_V4,
  BOARD_PAYLOAD_TYPES_V5,
  BOARD_PAYLOAD_TYPES_V6,
  boardPayloadTypes,
  BOARD_TREE,
  type BoardEntry,
  type BoardEntryVersion,
  BoardError,
  checkBoard,
  type Checkpoint,
  checkpointHash,
  checkpointOf,
  copyCheckpoints,
  decodeCheckpoint,
  encodeCheckpoint,
  isTimely,
  consistencyProof,
  DecodeError,
  decodeBoardEntry,
  EncodeError,
  encodeBoardEntry,
  inclusionProof,
  MAX_BOARD_PAYLOAD,
  merkleRoot,
  merkleRoots,
  contentDag,
  objectCid,
  readBoardCopy,
  RECORD_TYPES,
  splitSegmentObject,
  UNPINNED,
  verifyConsistency,
  verifyBoard,
  verifyInclusion,
} from "../src/index.ts";

// Properties of docs/spec/board.md: strict, canonical envelopes (T-31), a
// tree whose proofs are complete and sound (T-23, T-24), and board checks
// that catch any change to an anchored board (T-23).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const run = <T>(p: fc.IPropertyWithHooks<T> | fc.IProperty<T>) => fc.assert(p, { numRuns });

const ELECTION = new Uint8Array(32).fill(0xe1);
const allowedTypes = [...BOARD_PAYLOAD_TYPES];

test("the allowed payload types can't be changed at run time", () => {
  expect(Object.isFrozen(BOARD_PAYLOAD_TYPES)).toBe(true);
});
const recordOf = (type: number, body: Uint8Array) =>
  Uint8Array.of(type >> 8, type & 0xff, 1, ...body);

const payloadArb = fc
  .tuple(fc.constantFrom(...allowedTypes), fc.uint8Array({ maxLength: 40 }))
  .map(([t, body]) => recordOf(t, body));

const entryArb: fc.Arbitrary<BoardEntry> = fc.record({
  election_id: fc.uint8Array({ minLength: 32, maxLength: 32 }),
  index: fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
  segment: fc.integer({ min: 0, max: 0xffffffff }),
  payload: payloadArb,
});

const hash32 = fc.uint8Array({ minLength: 32, maxLength: 32 });

describe("board-entry envelope", () => {
  test("decode(encode(e)) = e", () => {
    run(
      fc.property(entryArb, (e) => {
        expect(decodeBoardEntry(encodeBoardEntry(e, 1), 1)).toEqual(e);
      }),
    );
  });

  test("any input is rejected or re-encodes to itself", () => {
    const mutated = fc
      .tuple(entryArb, fc.nat(), fc.integer({ min: 0, max: 255 }))
      .map(([e, at, byte]) => {
        const b = encodeBoardEntry(e, 1);
        b[at % b.length] = byte;
        return b;
      });
    run(
      fc.property(fc.oneof(mutated, fc.uint8Array({ maxLength: 80 })), (b) => {
        let e: BoardEntry;
        try {
          e = decodeBoardEntry(b, UNPINNED);
        } catch (err) {
          expect(err).toBeInstanceOf(DecodeError);
          return;
        }
        // Unpinned, either version decodes; re-encode under the one it carries.
        expect(encodeBoardEntry(e, b[2] as BoardEntryVersion)).toEqual(b);
      }),
    );
  });

  test("the encoder refuses what the decoder would reject", () => {
    const base = { election_id: ELECTION, index: 0n, segment: 0 };
    for (const t of [
      0,
      RECORD_TYPES.electionDefinition,
      RECORD_TYPES.receipt,
      RECORD_TYPES.boardEntry,
      RECORD_TYPES.displayText,
      0xff00,
    ])
      expect(() =>
        encodeBoardEntry({ ...base, payload: recordOf(t, Uint8Array.of(0)) }, 1),
      ).toThrow(EncodeError);
    expect(() => encodeBoardEntry({ ...base, payload: Uint8Array.of(0, 2) }, 1)).toThrow(
      EncodeError,
    );
    const big = new Uint8Array(MAX_BOARD_PAYLOAD + 1);
    big[1] = RECORD_TYPES.ballot;
    expect(() => encodeBoardEntry({ ...base, payload: big }, 1)).toThrow(EncodeError);
    const max = big.slice(0, MAX_BOARD_PAYLOAD);
    expect(decodeBoardEntry(encodeBoardEntry({ ...base, payload: max }, 1), 1).payload.length).toBe(
      MAX_BOARD_PAYLOAD,
    );
  });

  test("payload header errors are reported at the payload's first byte", () => {
    const base = { election_id: ELECTION, index: 0n, segment: 0 };
    const good = encodeBoardEntry({ ...base, payload: recordOf(2, Uint8Array.of(7)) }, 1);
    const wrongType = good.slice();
    wrongType[52] = RECORD_TYPES.displayText;
    expect(() => decodeBoardEntry(wrongType, 1)).toThrow(
      expect.objectContaining({ code: "unexpected-record-type", offset: 51 }),
    );
    const short = Uint8Array.of(...good.subarray(0, 47), 0, 0, 0, 2, 0, 2);
    expect(() => decodeBoardEntry(short, 1)).toThrow(
      expect.objectContaining({ code: "truncated", offset: 51 }),
    );
  });

  test("a hostile payload length is rejected before anything is read", () => {
    const b = encodeBoardEntry(
      {
        election_id: ELECTION,
        index: 0n,
        segment: 0,
        payload: recordOf(2, new Uint8Array()),
      },
      1,
    );
    const view = new DataView(b.buffer);
    view.setUint32(47, 0xffffffff);
    expect(() => decodeBoardEntry(b, 1)).toThrow(
      expect.objectContaining({ code: "length-over-max", offset: 47 }),
    );
  });
});

// Distinct leaves: with two equal leaves, one proof legitimately proves both positions.
const leavesArb = (max: number) =>
  fc.uniqueArray(hash32, {
    minLength: 1,
    maxLength: max,
    selector: (b) => Buffer.from(b).toString("hex"),
  });

describe("board tree", () => {
  test("merkleRoots agrees with merkleRoot on every prefix", () => {
    run(
      fc.property(leavesArb(70), (leaves) => {
        const sizes = new Set(leaves.map((_, i) => i + 1));
        const roots = merkleRoots(BOARD_TREE, leaves, sizes);
        for (const n of sizes)
          expect(roots.get(n)).toEqual(merkleRoot(BOARD_TREE, leaves.slice(0, n)));
      }),
    );
  });

  test("inclusion proofs are complete and bind leaf, index, size and root", () => {
    run(
      fc.property(leavesArb(70), fc.nat(), fc.nat(), (leaves, a, bit) => {
        const n = leaves.length;
        const i = a % n;
        const root = merkleRoot(BOARD_TREE, leaves);
        const leaf = leaves[i] as Uint8Array;
        const p = inclusionProof(BOARD_TREE, leaves, i);
        expect(p.length).toBeLessThanOrEqual(64);
        expect(verifyInclusion(BOARD_TREE, BigInt(i), BigInt(n), leaf, p, root)).toBe(true);
        const flipped = leaf.slice();
        flipped[bit % 32] = (flipped[bit % 32] as number) ^ (1 << (bit % 8));
        expect(verifyInclusion(BOARD_TREE, BigInt(i), BigInt(n), flipped, p, root)).toBe(false);
        if (n > 1) {
          expect(verifyInclusion(BOARD_TREE, BigInt((i + 1) % n), BigInt(n), leaf, p, root)).toBe(
            false,
          );
          const q = p.map((x) => x.slice());
          const k = bit % q.length;
          (q[k] as Uint8Array)[0] = ((q[k] as Uint8Array)[0] as number) ^ 1;
          expect(verifyInclusion(BOARD_TREE, BigInt(i), BigInt(n), leaf, q, root)).toBe(false);
          expect(verifyInclusion(BOARD_TREE, BigInt(i), BigInt(n), leaf, p.slice(1), root)).toBe(
            false,
          );
        }
        expect(verifyInclusion(BOARD_TREE, BigInt(i), BigInt(n), leaf, [...p, leaf], root)).toBe(
          false,
        );
        // Not asserted: the same path can verify under another size with the
        // same root (index 0 of 3 and of 4 hash alike). A proof binds the root,
        // so size and root are always taken together from a checked checkpoint.
      }),
    );
  });

  test("consistency proofs are complete and bind both sizes and roots", () => {
    run(
      fc.property(leavesArb(70), fc.nat(), fc.nat(), (leaves, a, bit) => {
        const n = leaves.length;
        const m = (a % n) + 1;
        const r1 = merkleRoot(BOARD_TREE, leaves.slice(0, m));
        const r2 = merkleRoot(BOARD_TREE, leaves);
        const p = consistencyProof(BOARD_TREE, leaves, m);
        expect(p.length).toBeLessThanOrEqual(65);
        expect(verifyConsistency(BOARD_TREE, BigInt(m), BigInt(n), r1, r2, p)).toBe(true);
        if (m === n) {
          expect(p).toEqual([]);
          return;
        }
        const q = p.map((x) => x.slice());
        const k = bit % q.length;
        (q[k] as Uint8Array)[bit % 32] = ((q[k] as Uint8Array)[bit % 32] as number) ^ 1;
        expect(verifyConsistency(BOARD_TREE, BigInt(m), BigInt(n), r1, r2, q)).toBe(false);
        expect(verifyConsistency(BOARD_TREE, BigInt(m), BigInt(n), r1, r2, p.slice(0, -1))).toBe(
          false,
        );
        expect(verifyConsistency(BOARD_TREE, BigInt(m), BigInt(n), r1, r2, [...p, r1])).toBe(false);
        // The larger tree with its last leaf changed isn't an extension.
        const forked: Uint8Array[] = leaves.slice();
        forked[n - 1] = r1;
        expect(
          verifyConsistency(
            BOARD_TREE,
            BigInt(m),
            BigInt(n),
            r1,
            merkleRoot(BOARD_TREE, forked),
            p,
          ),
        ).toBe(false);
        expect(verifyConsistency(BOARD_TREE, BigInt(m), BigInt(n), r2, r1, p)).toBe(false);
      }),
    );
  });

  test("malformed arguments verify as false and never throw", () => {
    const leaves = [new Uint8Array(32), new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)];
    const root = merkleRoot(BOARD_TREE, leaves);
    const p = inclusionProof(BOARD_TREE, leaves, 1);
    const leaf = leaves[1] as Uint8Array;
    expect(verifyInclusion(BOARD_TREE, 1n, 3n, leaf, p, root)).toBe(true);
    expect(verifyInclusion(BOARD_TREE, 1 as never, 3n, leaf, p, root)).toBe(false);
    expect(verifyInclusion(BOARD_TREE, -1n, 3n, leaf, p, root)).toBe(false);
    expect(verifyInclusion(BOARD_TREE, 1n, 1n << 64n, leaf, p, root)).toBe(false);
    expect(verifyInclusion(BOARD_TREE, 1n, 3n, leaf, p, root.slice(1))).toBe(false);
    expect(verifyInclusion(BOARD_TREE, 1n, 3n, leaf, p, Uint8Array.of(...root, 0))).toBe(false);
    expect(
      verifyInclusion(
        BOARD_TREE,
        1n,
        3n,
        leaf,
        [Uint8Array.of(...(p[0] as Uint8Array), 0), p[1] as Uint8Array],
        root,
      ),
    ).toBe(false);
    expect(
      verifyInclusion(
        BOARD_TREE,
        1n,
        3n,
        leaf,
        [p[0] as Uint8Array, (p[1] as Uint8Array).slice(1)],
        root,
      ),
    ).toBe(false);
    expect(verifyInclusion(BOARD_TREE, 1n, 3n, leaf, new Proxy(p, {}), root)).toBe(true);
    expect(verifyInclusion(BOARD_TREE, 1n, 3n, leaf, "ab" as never, root)).toBe(false);
    expect(
      verifyInclusion(
        BOARD_TREE,
        1n,
        3n,
        leaf,
        Array.from({ length: 66 }, () => root),
        root,
      ),
    ).toBe(false);
    expect(verifyConsistency(BOARD_TREE, 0n, 0n, root, root, [])).toBe(false);
    expect(verifyConsistency(BOARD_TREE, 0n, 3n, root, root, [root])).toBe(false);
    expect(verifyConsistency(BOARD_TREE, 0n, 3n, root, root, [])).toBe(false);
    expect(verifyConsistency(BOARD_TREE, 2n, 3n, root, root, [])).toBe(false);
    expect(verifyConsistency(BOARD_TREE, 4n, 3n, root, root, [root])).toBe(false);
  });

  test("proof generation refuses sizes and indices outside the tree", () => {
    const leaves = [new Uint8Array(32)];
    expect(() => merkleRoot(BOARD_TREE, [])).toThrow(RangeError);
    expect(() => inclusionProof(BOARD_TREE, leaves, 1)).toThrow(RangeError);
    expect(() => inclusionProof(BOARD_TREE, leaves, -1)).toThrow(RangeError);
    expect(() => consistencyProof(BOARD_TREE, leaves, 0)).toThrow(RangeError);
    expect(() => consistencyProof(BOARD_TREE, leaves, 2)).toThrow(RangeError);
  });
});

/** A valid board: non-decreasing segments, each ending with its openings in byte order. */
const boardArb = fc
  .array(
    fc.record({
      gap: fc.integer({ min: 1, max: 3 }),
      others: fc.array(
        payloadArb.filter((p) => p[1] !== RECORD_TYPES.spoiledBallotOpening),
        { maxLength: 4 },
      ),
      openings: fc.uniqueArray(fc.uint8Array({ maxLength: 6 }), {
        maxLength: 3,
        selector: (b) => Buffer.from(b).toString("hex"),
      }),
    }),
    { minLength: 1, maxLength: 6 },
  )
  .map((segments) => {
    const entries: Uint8Array[] = [];
    let segment = -1;
    for (const s of segments) {
      segment += s.gap;
      const openings = s.openings
        .map((b) => recordOf(RECORD_TYPES.spoiledBallotOpening, b))
        .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      for (const payload of [...s.others, ...openings])
        entries.push(
          encodeBoardEntry(
            {
              election_id: ELECTION,
              index: BigInt(entries.length),
              segment,
              payload,
            },
            1,
          ),
        );
    }
    return { entries, last: segment };
  })
  .filter(({ entries }) => entries.length > 0);

const PERIOD = 3600n;
const DEADLINE = 7200n;
const end = (s: number) => (BigInt(s) + 1n) * PERIOD;
/** The clock of a board whose seal is `last`, and a finalized time after the seal's window. */
const clockFor = (last: number): AnchorClock => ({
  epoch: 0n,
  period: PERIOD,
  deadline: DEADLINE,
  lastSegment: last,
});
const closedAt = (last: number) => end(last) + DEADLINE + 1n;

/** Each checkpoint anchored a minute after its period ends. */
const anchorOf = (checkpoint: Checkpoint): Anchor => ({
  checkpoint,
  anchoredAt: end(checkpoint.segment) + 60n,
});

function checkpointsFor(entries: readonly Uint8Array[], last: number): Anchor[] {
  const board = checkBoard(ELECTION, entries, 1);
  const out: Anchor[] = [];
  for (let s = 0; s <= last; s++) {
    const cp = checkpointOf(board, s);
    if (cp !== undefined) out.push(anchorOf(cp));
  }
  return out;
}

/** The verdict on a closed election whose seal is `last`. */
function verdict(entries: readonly Uint8Array[], anchors: readonly Anchor[], last: number): string {
  try {
    verifyBoard(ELECTION, entries, 1, anchors, clockFor(last), closedAt(last));
  } catch (e) {
    if (e instanceof BoardError) return e.code;
    throw e;
  }
  return "ok";
}

describe("board checks", () => {
  test("a well-formed board passes with the checkpoint of every segment", () => {
    run(
      fc.property(boardArb, ({ entries, last }) => {
        expect(verdict(entries, checkpointsFor(entries, last), last)).toBe("ok");
      }),
    );
  });

  test("any change to one byte of an anchored board fails a check", () => {
    run(
      fc.property(
        boardArb,
        fc.nat(),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        ({ entries, last }, e, at, x) => {
          const checkpoints = checkpointsFor(entries, last);
          const changed = entries.map((b) => b.slice());
          const target = changed[e % changed.length] as Uint8Array;
          target[at % target.length] = (target[at % target.length] as number) ^ x;
          // Honest anchors: the copy is at fault, never the election (T-53).
          expect(verdict(changed, checkpoints, last)).toBe("copy-mismatch");
        },
      ),
    );
  });

  test("a checkpoint whose CIDs don't name its segment's bytes fails the election", () => {
    run(
      fc.property(
        boardArb,
        fc.nat(),
        fc.boolean(),
        fc.uint8Array({ minLength: 36, maxLength: 36 }),
        ({ entries, last }, k, wrongObject, bogus) => {
          const checkpoints = checkpointsFor(entries, last);
          const i = k % checkpoints.length;
          const a = checkpoints[i] as Anchor;
          const field = wrongObject ? "object_cid" : "hashes_cid";
          fc.pre(!a.checkpoint[field].every((b, j) => b === bogus[j]));
          const bad = { ...a, checkpoint: { ...a.checkpoint, [field]: bogus } };
          const anchors = checkpoints.map((x, j) => (j === i ? bad : x));
          // Its head and root match the copy, so the copy is the anchored
          // board and the CIDs are the anchoring authority's (T-24, T-49).
          expect(verdict(entries, anchors, last)).toMatch(
            /^(checkpoint-cid|checkpoint-inconsistent)$/,
          );
          // Only one counted checkpoint of its size: nothing on L1 contradicts it.
          if (checkpoints.filter((x) => x.checkpoint.size === a.checkpoint.size).length === 1)
            expect(verdict(entries, anchors, last)).toBe("checkpoint-cid");
        },
      ),
    );
  });

  test("a checkpoint names its segment's object and entry-hash list, carried over while nothing is added", () => {
    run(
      fc.property(boardArb, ({ entries, last }) => {
        const board = checkBoard(ELECTION, entries, 1);
        for (let s = 0; s <= last; s++) {
          const cp = checkpointOf(board, s);
          if (cp === undefined) continue;
          const size = Number(cp.size);
          const t = (board.entries[size - 1] as BoardEntry).segment;
          const run_ = board.entries.flatMap((e, i) => (e.segment === t ? [i] : []));
          const join = (parts: readonly Uint8Array[]) =>
            Uint8Array.from(parts.flatMap((p) => [...p]));
          expect(cp.object_cid).toEqual(objectCid(join(run_.map((i) => entries[i] as Uint8Array))));
          expect(cp.hashes_cid).toEqual(
            objectCid(join(run_.map((i) => board.entryHashes[i] as Uint8Array))),
          );
        }
      }),
    );
  });

  test("a checkpoint with only its head or only its root wrong fails the election", () => {
    run(
      fc.property(
        boardArb,
        fc.nat(),
        fc.boolean(),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        ({ entries, last }, k, wrongHead, bogus) => {
          const checkpoints = checkpointsFor(entries, last);
          const i = k % checkpoints.length;
          const a = checkpoints[i] as Anchor;
          const field = wrongHead ? "head" : "root";
          fc.pre(!a.checkpoint[field].every((b, j) => b === bogus[j]));
          const bad = { ...a, checkpoint: { ...a.checkpoint, [field]: bogus } };
          const anchors = checkpoints.map((x, j) => (j === i ? bad : x));
          // No board matches it, whatever copy is held (T-24, T-53).
          expect(verdict(entries, anchors, last)).toBe("checkpoint-inconsistent");
        },
      ),
    );
  });

  test("dropping, duplicating or swapping anchored entries fails a check", () => {
    run(
      fc.property(boardArb, fc.nat(), ({ entries, last }, a) => {
        const checkpoints = checkpointsFor(entries, last);
        const i = a % entries.length;
        const dropped = [...entries.slice(0, i), ...entries.slice(i + 1)];
        expect(verdict(dropped, checkpoints, last)).toMatch(/^(copy-mismatch|checkpoint-missing)$/);
        if (i + 1 < entries.length) {
          const duplicated = [...entries.slice(0, i + 1), ...entries.slice(i)];
          expect(verdict(duplicated, checkpoints, last)).toBe("copy-mismatch");
          const swapped = entries.slice();
          [swapped[i], swapped[i + 1]] = [swapped[i + 1] as Uint8Array, swapped[i] as Uint8Array];
          expect(verdict(swapped, checkpoints, last)).toBe("copy-mismatch");
        }
      }),
    );
  });

  test("entries past the sealed extent change nothing: no one can fail a closed election by appending", () => {
    run(
      fc.property(
        boardArb,
        fc.array(fc.uint8Array({ maxLength: 80 }), { minLength: 1, maxLength: 4 }),
        fc.nat(),
        ({ entries, last }, junk, seg) => {
          const checkpoints = checkpointsFor(entries, last);
          const forged = encodeBoardEntry(
            {
              election_id: ELECTION,
              index: BigInt(entries.length),
              segment: seg % (last + 3),
              payload: recordOf(RECORD_TYPES.ballot, new Uint8Array()),
            },
            1,
          );
          const tail = [forged, ...junk];
          const v = verifyBoard(
            ELECTION,
            [...entries, ...tail],
            1,
            checkpoints,
            clockFor(last),
            closedAt(last),
          );
          expect(v.board.entries.length).toBe(entries.length);
          expect(v.unauthenticated).toBe(tail.length);
        },
      ),
    );
  });

  test("a closed election needs its seal's checkpoint; a running one waits for each window", () => {
    run(
      fc.property(boardArb, ({ entries, last }) => {
        const checkpoints = checkpointsFor(entries, last);
        const withoutSeal = checkpoints.filter((a) => a.checkpoint.segment !== last);
        expect(verdict(entries, withoutSeal, last)).toBe("unsealed");
        // Before the seal's window has closed, the same anchors pass, over
        // the prefix they cover.
        const v = verifyBoard(ELECTION, entries, 1, withoutSeal, clockFor(last), end(last) + 1n);
        const covered = withoutSeal.reduce((n, a) => Math.max(n, Number(a.checkpoint.size)), 0);
        expect(v.board.entries.length).toBe(covered);
      }),
    );
  });

  test("checkpoints are re-read, so a mutable or malformed one can't pass", () => {
    const entries = [
      encodeBoardEntry(
        {
          election_id: ELECTION,
          index: 0n,
          segment: 0,
          payload: recordOf(2, new Uint8Array()),
        },
        1,
      ),
    ];
    const [a0] = checkpointsFor(entries, 0);
    if (a0 === undefined) throw new Error("unreachable");
    const cp = a0.checkpoint;
    const board = checkBoard(ELECTION, entries, 1);
    const verify = (a: Anchor) => verifyBoard(ELECTION, entries, 1, [a], clockFor(0), closedAt(0));
    expect(() => verify(anchorOf({ ...cp, root: cp.root.slice(1) }))).toThrow(EncodeError);
    expect(() => verify(anchorOf({ ...cp, size: -1n }))).toThrow(EncodeError);
    expect(checkpointOf(board, 0)).toEqual(cp);
    expect(() => checkpointOf(board, -1)).toThrow(RangeError);
    expect(() => checkBoard(ELECTION.slice(1), entries, 1)).toThrow(RangeError);
    // A malformed id is the caller's bug, never an election failure.
    expect(() =>
      verifyBoard(ELECTION.slice(1), entries, 1, [a0], clockFor(0), closedAt(0)),
    ).toThrow(RangeError);
  });

  test("only anchors within their period's window count, and never after the seal", () => {
    const CLOCK = clockFor(1000);
    expect(isTimely(CLOCK, 0, end(0))).toBe(true);
    expect(isTimely(CLOCK, 0, end(0) - 1n)).toBe(false);
    expect(isTimely(CLOCK, 0, end(0) + CLOCK.deadline)).toBe(true);
    expect(isTimely(CLOCK, 0, end(0) + CLOCK.deadline + 1n)).toBe(false);
    expect(isTimely(CLOCK, CLOCK.lastSegment + 1, end(CLOCK.lastSegment + 1))).toBe(false);
    expect(isTimely(CLOCK, 3, 7 as never)).toBe(false);
    expect(isTimely(CLOCK, -1, end(0))).toBe(false);
    expect(isTimely(CLOCK, 1.5, end(0))).toBe(false);
    expect(() => isTimely({ ...CLOCK, period: 0n }, 0, 0n)).toThrow(RangeError);
    run(
      fc.property(boardArb, fc.bigInt({ min: 1n, max: 10n ** 9n }), ({ entries, last }, lag) => {
        // Every anchor landing after its deadline: nothing is anchored.
        const late = checkpointsFor(entries, last).map((a) => ({
          ...a,
          anchoredAt: end(a.checkpoint.segment) + DEADLINE + lag,
        }));
        expect(verdict(entries, late, last)).toBe("unsealed");
      }),
    );
  });

  test("a version other than the pinned one is a decode failure", () => {
    const entry = encodeBoardEntry(
      {
        election_id: ELECTION,
        index: 0n,
        segment: 0,
        payload: recordOf(2, new Uint8Array()),
      },
      1,
    );
    // The entry's own version byte (after the 2-byte record type) claims 2.
    entry[2] = 2;
    expect(() => checkBoard(ELECTION, [entry], 1)).toThrow(BoardError);
  });
});

describe("checkpoints from a raw copy", () => {
  test("a well-formed board's copy gives the checkpoint of every segment", () => {
    run(
      fc.property(boardArb, ({ entries, last }) => {
        const board = checkBoard(ELECTION, entries, 1);
        const segments = Array.from({ length: last + 2 }, (_, s) => s);
        const got = copyCheckpoints(ELECTION, entries, segments);
        for (const s of segments) expect(got.get(s)).toEqual(checkpointOf(board, s));
      }),
    );
  });

  test("a changed copy gives a checkpoint with another hash, never the anchored one", () => {
    run(
      fc.property(
        boardArb,
        fc.nat(),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        ({ entries, last }, e, at, x) => {
          const changed = entries.map((b) => b.slice());
          const i = e % changed.length;
          const target = changed[i] as Uint8Array;
          target[at % target.length] = (target[at % target.length] as number) ^ x;
          const honest = copyCheckpoints(ELECTION, entries, [last]).get(last) as Checkpoint;
          const got = copyCheckpoints(ELECTION, changed, [last]).get(last);
          if (got !== undefined) expect(checkpointHash(got)).not.toEqual(checkpointHash(honest));
        },
      ),
    );
  });

  test("each size is the index of the first entry past the segment, for any copy and segment list", () => {
    run(
      fc.property(
        fc.array(fc.oneof(fc.integer({ min: 0, max: 0xffffffff }), fc.constant(-1)), {
          maxLength: 30,
        }),
        fc.array(fc.integer({ min: 0, max: 0xffffffff }), { maxLength: 10 }),
        fc.array(fc.integer({ min: 0, max: 40 }), { maxLength: 10 }),
        (fields, wide, small) => {
          // -1 is an entry too short to carry a segment field.
          const copy = fields.map((f, i) =>
            f === -1
              ? new Uint8Array(46)
              : encodeBoardEntry(
                  {
                    election_id: ELECTION,
                    index: BigInt(i),
                    segment: f,
                    payload: recordOf(allowedTypes[0] as number, Uint8Array.of(i)),
                  },
                  1,
                ),
          );
          const readable = fields.indexOf(-1) === -1 ? fields : fields.slice(0, fields.indexOf(-1));
          const segments = [...wide, ...small, ...small, ...readable.slice(0, 3)];
          const got = copyCheckpoints(ELECTION, copy, segments);
          for (const s of segments) {
            const first = readable.findIndex((f) => f > s);
            const size = first === -1 ? readable.length : first;
            expect(got.get(s)?.size).toBe(size === 0 ? undefined : BigInt(size));
          }
        },
      ),
    );
  });

  test("a copy is hashed into CIDs once however many segments name the same extent", () => {
    // A hostile mirror labels every entry with segment 0, so every word's
    // prefix is the whole copy: naming more segments must not hash it again
    // (T-53). Timed rather than counted, with a wide margin: without the
    // memo the 200-segment run takes about 200 times as long.
    const big = Array.from({ length: 16 }, (_, i) =>
      encodeBoardEntry(
        {
          election_id: ELECTION,
          index: BigInt(i),
          segment: 0,
          // Built in place: spreading 256 KiB into `recordOf` overflows the stack.
          payload: (() => {
            const p = new Uint8Array(3 + 256 * 1024).fill(i);
            p.set([0, 2, 1]);
            return p;
          })(),
        },
        1,
      ),
    );
    const time = (segments: number[]) => {
      const start = performance.now();
      const got = copyCheckpoints(ELECTION, big, segments);
      expect(new Set([...got.values()].map((c) => c.object_cid.join())).size).toBe(1);
      return performance.now() - start;
    };
    time([0]);
    const one = Math.max(time([0]), 1);
    const many = time(Array.from({ length: 200 }, (_, s) => s));
    expect(many).toBeLessThan(20 * one + 50);
  });

  test("the prefix ends at the first entry past the segment, and a short entry ends it", () => {
    const entry = (index: number, segment: number) =>
      encodeBoardEntry(
        {
          election_id: ELECTION,
          index: BigInt(index),
          segment,
          payload: recordOf(allowedTypes[0] as number, Uint8Array.of(index)),
        },
        1,
      );
    // Segments 0, 2, 1: a copy that isn't a board still gives prefixes.
    const copy = [entry(0, 0), entry(1, 2), entry(2, 1)];
    const got = copyCheckpoints(ELECTION, copy, [0, 1, 2, 3]);
    expect([0, 1, 2, 3].map((s) => got.get(s)?.size)).toEqual([1n, 1n, 3n, 3n]);
    const short = copyCheckpoints(ELECTION, [entry(0, 0), new Uint8Array(46), entry(2, 0)], [0]);
    expect(short.get(0)?.size).toBe(1n);
    expect(copyCheckpoints(ELECTION, [entry(0, 5)], [4]).has(4)).toBe(false);
    expect(copyCheckpoints(ELECTION, [], [0]).size).toBe(0);
    expect(() => copyCheckpoints(ELECTION, copy, [-1])).toThrow(RangeError);
    expect(() => copyCheckpoints(ELECTION, copy, [2 ** 32])).toThrow(RangeError);
    expect(() => copyCheckpoints(ELECTION.slice(1), copy, [0])).toThrow(RangeError);
  });

  test("decodeCheckpoint(encodeCheckpoint(c)) = c, and only 180 bytes decode", () => {
    const cid = fc.uint8Array({ minLength: 36, maxLength: 36 });
    run(
      fc.property(
        fc.record({
          election_id: hash32,
          segment: fc.integer({ min: 0, max: 0xffffffff }),
          size: fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
          head: hash32,
          root: hash32,
          object_cid: cid,
          hashes_cid: cid,
        }),
        fc.uint8Array({ maxLength: 200 }),
        (cp: Checkpoint, junk) => {
          const bytes = encodeCheckpoint(cp);
          expect(bytes.length).toBe(180);
          expect(decodeCheckpoint(bytes)).toEqual(cp);
          if (junk.length !== 180) expect(() => decodeCheckpoint(junk)).toThrow(DecodeError);
          else expect(encodeCheckpoint(decodeCheckpoint(junk))).toEqual(junk);
        },
      ),
    );
  });
});

// docs/spec/board.md, Segment objects: an object splits into its entries in
// exactly one way, so whoever fetches one by an anchored CID gets back the
// encodings the checkpoint was made from (T-24, T-49).
describe("segment objects", () => {
  const concat = (parts: readonly Uint8Array[]) =>
    Uint8Array.from(parts.flatMap((p) => Array.from(p)));
  const objectArb = fc
    .array(entryArb, { minLength: 1, maxLength: 8 })
    .map((es) => es.map((e) => encodeBoardEntry(e, 1)));

  test("splitSegmentObject(concat(entries)) = entries", () => {
    run(
      fc.property(objectArb, (encodings) => {
        expect(splitSegmentObject(concat(encodings))).toEqual(encodings);
      }),
    );
  });

  test("the object a checkpoint's CID names splits into the segment's entries", () => {
    run(
      fc.property(fc.array(payloadArb, { minLength: 1, maxLength: 6 }), fc.nat(5), (ps, cut) => {
        // Entries before `cut` are in segment 0, the rest in segment 1.
        const encodings = ps.map((payload, i) =>
          encodeBoardEntry(
            { election_id: ELECTION, index: BigInt(i), segment: i < cut ? 0 : 1, payload },
            1,
          ),
        );
        const tail = cut < encodings.length ? encodings.slice(cut) : encodings;
        const segment = cut < encodings.length ? 1 : 0;
        const cp = copyCheckpoints(ELECTION, encodings, [segment]).get(segment) as Checkpoint;
        expect(objectCid(concat(tail))).toEqual(cp.object_cid);
        expect(splitSegmentObject(concat(tail))).toEqual(tail);
      }),
    );
  });

  test("any accepted object re-joins to itself, and any other is a DecodeError", () => {
    run(
      fc.property(objectArb, fc.nat(), fc.integer({ min: 0, max: 255 }), (encodings, at, v) => {
        const b = concat(encodings);
        b[at % b.length] = v;
        let pieces: Uint8Array[];
        try {
          pieces = splitSegmentObject(b);
        } catch (e) {
          expect(e).toBeInstanceOf(DecodeError);
          return;
        }
        expect(concat(pieces)).toEqual(b);
      }),
    );
  });

  test("rejects an empty object, a truncated entry and a payload length over the maximum", () => {
    run(
      fc.property(objectArb, fc.nat(), (encodings, at) => {
        const b = concat(encodings);
        // Where each entry ends: a cut there leaves the entries before it.
        const ends: number[] = [];
        for (const e of encodings) ends.push((ends.at(-1) ?? 0) + e.length);
        const cut = 1 + (at % (b.length - 1));
        const whole = ends.indexOf(cut);
        if (whole >= 0) expect(splitSegmentObject(b.subarray(0, cut))).toHaveLength(whole + 1);
        else
          expect(() => splitSegmentObject(b.subarray(0, cut))).toThrow(
            expect.objectContaining({ code: "truncated" }),
          );
      }),
    );
    expect(() => splitSegmentObject(new Uint8Array(0))).toThrow(
      expect.objectContaining({ code: "truncated", offset: 0 }),
    );
    // A length one over the maximum is refused at its own offset, before the
    // payload it claims is looked for.
    const over = encodeBoardEntry(
      {
        election_id: ELECTION,
        index: 0n,
        segment: 0,
        payload: recordOf(allowedTypes[0] as number, new Uint8Array(0)),
      },
      1,
    );
    new DataView(over.buffer).setUint32(47, MAX_BOARD_PAYLOAD + 1);
    expect(() => splitSegmentObject(over)).toThrow(
      expect.objectContaining({ code: "length-over-max", offset: 47 }),
    );
    // At the maximum, a short object is truncated rather than over the limit.
    new DataView(over.buffer).setUint32(47, MAX_BOARD_PAYLOAD);
    expect(() => splitSegmentObject(over)).toThrow(
      expect.objectContaining({ code: "truncated", offset: 51 }),
    );
  });

  test("returns copies, so changing the object afterwards changes no entry", () => {
    const e = encodeBoardEntry(
      {
        election_id: ELECTION,
        index: 0n,
        segment: 0,
        payload: recordOf(allowedTypes[0] as number, Uint8Array.of(1)),
      },
      1,
    );
    const object = Uint8Array.from(e);
    const [piece] = splitSegmentObject(object);
    object.fill(0);
    expect(piece).toEqual(e);
  });
});

// docs/spec/board.md, A copy from L1's CIDs: the board read back from the
// CIDs its counted checkpoints name, from any sources, verifies as the board
// does, and a source can only leave it short, never fail it (T-24, T-49, T-53).
describe("a copy read by L1's CIDs", () => {
  const concat = (parts: readonly Uint8Array[]) =>
    Uint8Array.from(parts.flatMap((p) => Array.from(p)));
  const segmentOf = (e: Uint8Array) => new DataView(e.buffer, e.byteOffset + 43, 4).getUint32(0);
  const key = (b: Uint8Array) => Buffer.from(b).toString("hex");

  /** Every block of every segment object of `entries`, as an honest mirror holds them. */
  function blocksOf(entries: readonly Uint8Array[]) {
    const bySegment = new Map<number, Uint8Array[]>();
    for (const e of entries) {
      const s = segmentOf(e);
      bySegment.set(s, [...(bySegment.get(s) ?? []), e]);
    }
    const out = new Map<string, Uint8Array>();
    for (const run of bySegment.values())
      for (const b of contentDag(concat(run)).blocks) out.set(key(b.cid), b.bytes);
    return out;
  }

  /** A source over `blocks` that records what it was asked for. */
  const sourceOf =
    (blocks: ReadonlyMap<string, Uint8Array>, asked: string[] = []) =>
    async (cid: Uint8Array) => {
      asked.push(key(cid));
      const b = blocks.get(key(cid));
      return b === undefined ? [] : [b];
    };

  const copyOf = (
    anchors: readonly Anchor[],
    last: number,
    blocks: ReadonlyMap<string, Uint8Array>,
    asked?: string[],
  ) => readBoardCopy(ELECTION, anchors, clockFor(last), closedAt(last), sourceOf(blocks, asked));

  test("an honest board is read back whole, and verifies", async () => {
    await fc.assert(
      fc.asyncProperty(boardArb, async ({ entries, last }) => {
        const anchors = checkpointsFor(entries, last);
        const copy = await copyOf(anchors, last, blocksOf(entries));
        expect(copy.stopped).toBeUndefined();
        expect(copy.encodedEntries).toEqual(entries);
        expect(verdict(copy.encodedEntries, anchors, last)).toBe("ok");
      }),
      { numRuns },
    );
  });

  test("each segment object is read once, however many checkpoints carry its CIDs", async () => {
    await fc.assert(
      fc.asyncProperty(boardArb, async ({ entries, last }) => {
        // checkpointsFor anchors every period, so a gap re-anchors the last
        // segment's CIDs; each object is asked for block by block, once.
        const anchors = checkpointsFor(entries, last);
        const blocks = blocksOf(entries);
        const asked: string[] = [];
        await copyOf([...anchors, ...anchors], last, blocks, asked);
        expect(asked.length).toBe(new Set(asked).size);
        expect(new Set(asked)).toEqual(new Set(blocks.keys()));
      }),
      { numRuns },
    );
  });

  test("a withheld or altered block leaves the copy short at that segment: unverifiable, never failed", async () => {
    await fc.assert(
      fc.asyncProperty(boardArb, fc.nat(), fc.boolean(), async ({ entries, last }, which, drop) => {
        const anchors = checkpointsFor(entries, last);
        const blocks = new Map(blocksOf(entries));
        const target = [...blocks.keys()][which % blocks.size] as string;
        if (drop) blocks.delete(target);
        else {
          const b = Uint8Array.from(blocks.get(target) as Uint8Array);
          b[0] = (b[0] as number) ^ 1;
          blocks.set(target, b);
        }
        const copy = await copyOf(anchors, last, blocks);
        expect(copy.stopped?.reason).toBe("unavailable");
        // The copy is the runs before the withheld one, whole.
        expect(entries.slice(0, copy.encodedEntries.length)).toEqual(copy.encodedEntries);
        expect(verdict(copy.encodedEntries, anchors, last)).toBe("checkpoint-missing");
      }),
      { numRuns },
    );
  });

  test("a segment left unanchored stops the copy at the next run, which its object can't fill", async () => {
    await fc.assert(
      fc.asyncProperty(boardArb, fc.nat(), async ({ entries, last }, which) => {
        const segments = [...new Set(entries.map(segmentOf))];
        fc.pre(segments.length >= 2);
        // Skip every checkpoint of one segment with entries, not the seal's.
        const skipped = segments[which % (segments.length - 1)] as number;
        // With the periods after it that carry its size until the next one.
        const all = checkpointsFor(entries, last);
        const size = all.find((a) => a.checkpoint.segment === skipped)?.checkpoint.size;
        const anchors = all.filter((a) => a.checkpoint.size !== size);
        const copy = await copyOf(anchors, last, blocksOf(entries));
        expect(copy.stopped?.reason).toBe("not-run");
        expect(copy.encodedEntries).toEqual(entries.filter((e) => segmentOf(e) < skipped));
        // The whole board would show the operator's `unanchored`; the copy by
        // CID is short of it, which is unverifiable (docs/spec/board.md, Residuals).
        expect(verdict(entries, anchors, last)).toBe("unanchored");
        expect(verdict(copy.encodedEntries, anchors, last)).toBe("checkpoint-missing");
      }),
      { numRuns },
    );
  });

  test("a CID of bytes that aren't the run, or of an object over its bound, stops the copy", async () => {
    const entries = [0, 1].map((i) =>
      encodeBoardEntry(
        {
          election_id: ELECTION,
          index: BigInt(i),
          segment: 0,
          payload: recordOf(allowedTypes[0] as number, Uint8Array.of(i)),
        },
        1,
      ),
    );
    const [first] = checkpointsFor(entries, 0) as [Anchor];
    const withObject = (object: Uint8Array) => {
      const dag = contentDag(object);
      const blocks = new Map(dag.blocks.map((b) => [key(b.cid), b.bytes] as const));
      const anchor = { ...first, checkpoint: { ...first.checkpoint, object_cid: dag.root } };
      return { anchor, blocks, root: dag.root };
    };
    // One of the two entries, a truncated pair, and both entries twice.
    for (const object of [
      entries[0] as Uint8Array,
      concat(entries).subarray(1),
      concat([...entries, ...entries]),
    ]) {
      const { anchor, blocks } = withObject(object);
      const copy = await copyOf([anchor], 0, blocks);
      expect(copy).toEqual({ encodedEntries: [], stopped: { checkpoint: 0, reason: "not-run" } });
    }
    // Two entries encode in at most 2 × (51 + MAX_BOARD_PAYLOAD) bytes: an
    // object one byte longer is refused after its root alone.
    const over = withObject(new Uint8Array(2 * (51 + MAX_BOARD_PAYLOAD) + 1));
    const asked: string[] = [];
    const copy = await copyOf([over.anchor], 0, over.blocks, asked);
    expect(copy.stopped).toEqual({ checkpoint: 0, reason: "inconsistent" });
    expect(asked).toEqual([key(over.root)]);
  });

  test("a failure from L1 alone is thrown before anything is fetched", async () => {
    await fc.assert(
      fc.asyncProperty(boardArb, async ({ entries, last }) => {
        const anchors = checkpointsFor(entries, last);
        const [a] = anchors as [Anchor];
        const other = { ...a, checkpoint: { ...a.checkpoint, election_id: new Uint8Array(32) } };
        const asked: string[] = [];
        await expect(copyOf([other, ...anchors], last, blocksOf(entries), asked)).rejects.toThrow(
          expect.objectContaining({ code: "wrong-election" }),
        );
        expect(asked).toEqual([]);
      }),
      { numRuns },
    );
  });
});

// Board-entry versions 3 to 6 differ from version 1 only in the record
// types they allow (docs/spec/board.md, Allowed payloads), so the board checks
// must pass and fail on them exactly as on version 1 (T-23, T-31).
describe("board checks under board-entry versions 3 to 6", () => {
  const ADDED: Record<3 | 4 | 5 | 6, readonly number[]> = {
    3: [RECORD_TYPES.shareReceipt, RECORD_TYPES.shareComplaint],
    4: [RECORD_TYPES.shareReceipt, RECORD_TYPES.shareComplaint, RECORD_TYPES.destructionStatement],
    5: [
      RECORD_TYPES.shareReceipt,
      RECORD_TYPES.shareComplaint,
      RECORD_TYPES.destructionStatement,
      RECORD_TYPES.closeStatement,
    ],
    6: [
      RECORD_TYPES.shareReceipt,
      RECORD_TYPES.shareComplaint,
      RECORD_TYPES.destructionStatement,
      RECORD_TYPES.closeStatement,
      RECORD_TYPES.runningOpening,
    ],
  };
  const allowed = {
    3: BOARD_PAYLOAD_TYPES_V3,
    4: BOARD_PAYLOAD_TYPES_V4,
    5: BOARD_PAYLOAD_TYPES_V5,
    6: BOARD_PAYLOAD_TYPES_V6,
  } as const;

  /** A valid board under `version`, carrying at least one of the types it adds. */
  const boardUnder = (version: 3 | 4 | 5 | 6) =>
    fc
      .tuple(
        fc.array(
          fc.record({
            gap: fc.integer({ min: 0, max: 2 }),
            type: fc.constantFrom(
              ...allowed[version].filter((t) => t !== RECORD_TYPES.spoiledBallotOpening),
            ),
            body: fc.uint8Array({ maxLength: 6 }),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        fc.constantFrom(...ADDED[version]),
        fc.uint8Array({ maxLength: 6 }),
      )
      .map(([rows, added, body]) => {
        const entries: Uint8Array[] = [];
        let segment = 0;
        for (const r of [...rows, { gap: 0, type: added, body }]) {
          segment += r.gap;
          entries.push(
            encodeBoardEntry(
              {
                election_id: ELECTION,
                index: BigInt(entries.length),
                segment,
                payload: recordOf(r.type, r.body),
              },
              version,
            ),
          );
        }
        return { entries, last: segment, version };
      });

  const anchorsUnder = (entries: readonly Uint8Array[], last: number, version: 3 | 4 | 5 | 6) => {
    const board = checkBoard(ELECTION, entries, version);
    const out: Anchor[] = [];
    for (let s = 0; s <= last; s++) {
      const cp = checkpointOf(board, s);
      if (cp !== undefined) out.push(anchorOf(cp));
    }
    return out;
  };

  const verdictUnder = (
    entries: readonly Uint8Array[],
    anchors: readonly Anchor[],
    last: number,
    version: BoardEntryVersion,
  ) => {
    try {
      verifyBoard(ELECTION, entries, version, anchors, clockFor(last), closedAt(last));
    } catch (e) {
      if (e instanceof BoardError) return e.code;
      throw e;
    }
    return "ok";
  };

  const either = fc.oneof(boardUnder(3), boardUnder(4), boardUnder(5), boardUnder(6));

  test("boardPayloadTypes gives each version's allowed set", () => {
    expect(boardPayloadTypes(1)).toBe(BOARD_PAYLOAD_TYPES);
    expect(boardPayloadTypes(3)).toBe(BOARD_PAYLOAD_TYPES_V3);
    expect(boardPayloadTypes(4)).toBe(BOARD_PAYLOAD_TYPES_V4);
    expect(boardPayloadTypes(5)).toBe(BOARD_PAYLOAD_TYPES_V5);
    expect(boardPayloadTypes(6)).toBe(BOARD_PAYLOAD_TYPES_V6);
    for (const bad of [2, 8, "constructor", "toString"])
      expect(() => boardPayloadTypes(bad as never)).toThrow(RangeError);
  });

  test("a well-formed board passes under its version, with the checkpoint of every segment", () => {
    run(
      fc.property(either, ({ entries, last, version }) => {
        expect(verdictUnder(entries, anchorsUnder(entries, last, version), last, version)).toBe(
          "ok",
        );
      }),
    );
  });

  test("any change to one byte of an anchored board fails a check", () => {
    run(
      fc.property(
        either,
        fc.nat(),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        ({ entries, last, version }, e, at, x) => {
          const anchors = anchorsUnder(entries, last, version);
          const changed = entries.map((b) => b.slice());
          const target = changed[e % changed.length] as Uint8Array;
          target[at % target.length] = (target[at % target.length] as number) ^ x;
          expect(verdictUnder(changed, anchors, last, version)).toBe("copy-mismatch");
        },
      ),
    );
  });

  test("the same board under any other pinned version fails decoding at its first entry", () => {
    run(
      fc.property(either, ({ entries, last, version }) => {
        for (const other of [1, 3, 4, 5, 6] as const) {
          if (other === version) continue;
          let caught: unknown;
          try {
            checkBoard(ELECTION, entries, other);
          } catch (e) {
            caught = e;
          }
          expect(caught).toBeInstanceOf(BoardError);
          expect((caught as BoardError).code).toBe("decode");
          expect((caught as BoardError).at).toMatchObject({ entry: 0 });
          // verifyBoard too: honest anchors authenticate the bytes, which then
          // fail decoding under the wrong pin.
          expect(verdictUnder(entries, anchorsUnder(entries, last, version), last, other)).toBe(
            "decode",
          );
        }
      }),
    );
  });

  test.each([
    [4, 3, "destruction statement", RECORD_TYPES.destructionStatement],
    [5, 4, "close statement", RECORD_TYPES.closeStatement],
    [6, 5, "running opening", RECORD_TYPES.runningOpening],
  ] as const)(
    "relabelled down, a version-%i board is refused as version %i at its first %s",
    (version, lower, _name, added) => {
      // Only boards carrying the type the version adds, so the rule is always exercised.
      const carrying = boardUnder(version).filter(({ entries }) =>
        entries.some((b) => (((b[51] as number) << 8) | (b[52] as number)) === added),
      );
      run(
        fc.property(carrying, ({ entries, last }) => {
          const relabelled = entries.map((b) =>
            Uint8Array.of(b[0] as number, b[1] as number, lower, ...b.slice(3)),
          );
          const first = relabelled.findIndex(
            (b) => (((b[51] as number) << 8) | (b[52] as number)) === added,
          );
          let caught: unknown;
          try {
            checkBoard(ELECTION, relabelled, lower);
          } catch (e) {
            caught = e;
          }
          expect(first).not.toBe(-1);
          expect(caught).toBeInstanceOf(BoardError);
          expect((caught as BoardError).at).toEqual({
            entry: first,
            decodeError: "unexpected-record-type",
          });
          // Anchored as it is, the relabelled copy still fails verifyBoard
          // under the lower version, by its decoding, not its bytes.
          const segments = Array.from({ length: last + 1 }, (_, s) => s);
          const anchors = [...copyCheckpoints(ELECTION, relabelled, segments).values()].map(
            anchorOf,
          );
          expect(verdictUnder(relabelled, anchors, last, lower)).toBe("decode");
        }),
      );
    },
  );
});
