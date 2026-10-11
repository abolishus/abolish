import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  BOARD_PAYLOAD_TYPES,
  BOARD_TREE,
  type BoardEntry,
  BoardError,
  checkBoard,
  checkCheckpoints,
  type Checkpoint,
  checkpointOf,
  consistencyProof,
  DecodeError,
  decodeBoardEntry,
  EncodeError,
  encodeBoardEntry,
  inclusionProof,
  MAX_BOARD_PAYLOAD,
  merkleRoot,
  merkleRoots,
  RECORD_TYPES,
  UNPINNED,
  verifyConsistency,
  verifyInclusion,
} from "../src/index.ts";

// Properties of docs/spec/board.md: strict, canonical envelopes (T-31), a
// tree whose proofs are complete and sound (T-23, T-24), and board checks
// that catch any change to an anchored board (T-23).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const run = <T>(p: fc.IPropertyWithHooks<T> | fc.IProperty<T>) => fc.assert(p, { numRuns });

const ELECTION = new Uint8Array(32).fill(0xe1);
const allowedTypes = [...BOARD_PAYLOAD_TYPES];
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
        expect(decodeBoardEntry(encodeBoardEntry(e), 1)).toEqual(e);
      }),
    );
  });

  test("any input is rejected or re-encodes to itself", () => {
    const mutated = fc
      .tuple(entryArb, fc.nat(), fc.integer({ min: 0, max: 255 }))
      .map(([e, at, byte]) => {
        const b = encodeBoardEntry(e);
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
        expect(encodeBoardEntry(e)).toEqual(b);
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
      expect(() => encodeBoardEntry({ ...base, payload: recordOf(t, Uint8Array.of(0)) })).toThrow(
        EncodeError,
      );
    expect(() => encodeBoardEntry({ ...base, payload: Uint8Array.of(0, 2) })).toThrow(EncodeError);
    const big = new Uint8Array(MAX_BOARD_PAYLOAD + 1);
    big[1] = RECORD_TYPES.ballot;
    expect(() => encodeBoardEntry({ ...base, payload: big })).toThrow(EncodeError);
    const max = big.slice(0, MAX_BOARD_PAYLOAD);
    expect(decodeBoardEntry(encodeBoardEntry({ ...base, payload: max }), 1).payload.length).toBe(
      MAX_BOARD_PAYLOAD,
    );
  });

  test("payload header errors are reported at the payload's first byte", () => {
    const base = { election_id: ELECTION, index: 0n, segment: 0 };
    const good = encodeBoardEntry({ ...base, payload: recordOf(2, Uint8Array.of(7)) });
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
    const b = encodeBoardEntry({
      election_id: ELECTION,
      index: 0n,
      segment: 0,
      payload: recordOf(2, new Uint8Array()),
    });
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
          encodeBoardEntry({
            election_id: ELECTION,
            index: BigInt(entries.length),
            segment,
            payload,
          }),
        );
    }
    return { entries, last: segment };
  })
  .filter(({ entries }) => entries.length > 0);

function checkpointsFor(entries: readonly Uint8Array[], last: number): Checkpoint[] {
  const board = checkBoard(ELECTION, entries, 1);
  const out: Checkpoint[] = [];
  for (let s = 0; s <= last; s++) {
    const cp = checkpointOf(board, s);
    if (cp !== undefined) out.push(cp);
  }
  return out;
}

function verdict(entries: readonly Uint8Array[], checkpoints: readonly Checkpoint[]): string {
  try {
    checkCheckpoints(checkBoard(ELECTION, entries, 1), checkpoints);
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
        expect(verdict(entries, checkpointsFor(entries, last))).toBe("ok");
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
          expect(verdict(changed, checkpoints)).not.toBe("ok");
        },
      ),
    );
  });

  test("dropping, duplicating or swapping entries fails a check", () => {
    run(
      fc.property(boardArb, fc.nat(), ({ entries, last }, a) => {
        const checkpoints = checkpointsFor(entries, last);
        const i = a % entries.length;
        expect(verdict([...entries.slice(0, i), ...entries.slice(i + 1)], checkpoints)).not.toBe(
          "ok",
        );
        expect(verdict([...entries.slice(0, i + 1), ...entries.slice(i)], checkpoints)).not.toBe(
          "ok",
        );
        if (i + 1 < entries.length) {
          const swapped = entries.slice();
          [swapped[i], swapped[i + 1]] = [swapped[i + 1] as Uint8Array, swapped[i] as Uint8Array];
          expect(verdict(swapped, checkpoints)).not.toBe("ok");
        }
      }),
    );
  });

  test("entries after the last checkpoint are unanchored", () => {
    run(
      fc.property(boardArb, ({ entries, last }) => {
        const checkpoints = checkpointsFor(entries, last);
        const extra = encodeBoardEntry({
          election_id: ELECTION,
          index: BigInt(entries.length),
          segment: last + 1,
          payload: recordOf(RECORD_TYPES.ballot, new Uint8Array()),
        });
        expect(verdict([...entries, extra], checkpoints)).toBe("unanchored");
      }),
    );
  });

  test("checkpoints are re-read, so a mutable or malformed one can't pass", () => {
    const entries = [
      encodeBoardEntry({
        election_id: ELECTION,
        index: 0n,
        segment: 0,
        payload: recordOf(2, new Uint8Array()),
      }),
    ];
    const [cp] = checkpointsFor(entries, 0);
    if (cp === undefined) throw new Error("unreachable");
    const board = checkBoard(ELECTION, entries, 1);
    expect(() => checkCheckpoints(board, [{ ...cp, root: cp.root.slice(1) }])).toThrow(EncodeError);
    expect(() => checkCheckpoints(board, [{ ...cp, size: -1n }])).toThrow(EncodeError);
    expect(checkpointOf(board, 0)).toEqual(cp);
    expect(() => checkpointOf(board, -1)).toThrow(RangeError);
    expect(() => checkBoard(ELECTION.slice(1), entries, 1)).toThrow(RangeError);
  });

  test("a version other than the pinned one is a decode failure", () => {
    const entries = [
      encodeBoardEntry({
        election_id: ELECTION,
        index: 0n,
        segment: 0,
        payload: recordOf(2, new Uint8Array()),
      }),
    ];
    expect(() => checkBoard(ELECTION, entries, 2 as never)).toThrow(BoardError);
  });
});
