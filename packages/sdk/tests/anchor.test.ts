import {
  BoardError,
  checkpointHash,
  identityKey,
  RECORD_TYPES,
  receiptKeyJudgement,
  receiptKeyRecordFromWord,
  receiptKeysCastCheck,
  verifyBoard,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import {
  receiptKeyWord,
  SIMULATED_RECEIPT_KEY_LEAD,
  SimulatedAnchor,
} from "../src/simulation/anchor.ts";
import { endOf, SIMULATED_ANCHOR_DEADLINE, SimulatedBoard } from "../src/simulation/board.ts";
import { SimulatedL1 } from "../src/simulation/l1.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const VERSION = 4;
const electionId = new Uint8Array(32).fill(7);
// A receipt key's secret, from the operator's key service.
const secret = () => crypto.getRandomValues(new Uint8Array(32));

// A ballot record's header and any body: the board never decodes a payload's fields.
const payload = (body: readonly number[]) =>
  Uint8Array.from([RECORD_TYPES.ballot >> 8, RECORD_TYPES.ballot & 0xff, 1, ...body]);

// The first L1 block after the seal's window has closed: a verifier of the closed election.
const afterSeal = (l1: SimulatedL1, seal: number) =>
  l1.block(l1.firstAfter(endOf(seal) + SIMULATED_ANCHOR_DEADLINE)).timestamp;

const code = (f: () => unknown) => {
  try {
    f();
    return "ok";
  } catch (e) {
    if (e instanceof BoardError) return e.code;
    throw e;
  }
};

describe("SimulatedAnchor", { timeout: 120_000 }, () => {
  it("anchors every period that added entries, and the seal, so the closed board verifies", () => {
    fc.assert(
      fc.property(
        // Entries over some periods from 10, and the points at which the
        // authority anchors, each once every entry up to it is boarded.
        fc.array(fc.record({ step: fc.nat({ max: 3 }), body: fc.uint8Array({ maxLength: 8 }) }), {
          minLength: 1,
          maxLength: 30,
        }),
        fc.array(fc.nat({ max: 30 }), { maxLength: 4 }),
        fc.nat({ max: 3 }),
        (appends, cuts, tail) => {
          const l1 = new SimulatedL1();
          const board = new SimulatedBoard(electionId, VERSION, secret());
          let segment = 10;
          const segments = appends.map((a) => (segment += a.step));
          const seal = segment + tail;
          const anchor = new SimulatedAnchor(electionId, 10, seal, l1);
          const at = new Set(cuts.map((c) => Math.min(c, appends.length)));
          appends.forEach((a, i) => {
            // Anchoring through the period before the next entry's: every
            // entry of those periods is already on the board.
            if (at.has(i)) anchor.anchorThrough(board.entries, (segments[i] as number) - 1);
            board.board(segments[i] as number, payload([...a.body]));
          });
          anchor.anchorThrough(board.entries, seal);
          const verified = verifyBoard(
            electionId,
            board.entries,
            VERSION,
            anchor.anchors,
            anchor.clock,
            afterSeal(l1, seal),
          );
          expect(verified.unauthenticated).toBe(0);
          expect(verified.board.entries).toHaveLength(appends.length);
          // One anchor per period that added entries, then the seal's if it added none.
          const added = [...new Set(segments)];
          expect(anchor.anchors.map((a) => a.checkpoint.segment)).toEqual(
            added.at(-1) === seal ? added : [...added, seal],
          );
          for (const a of anchor.anchors) {
            const end = endOf(a.checkpoint.segment);
            // In a block after the period ends, within the deadline.
            expect(a.anchoredAt > end).toBe(true);
            expect(a.anchoredAt <= end + SIMULATED_ANCHOR_DEADLINE).toBe(true);
          }
          // The seal's checkpoint is the whole board.
          expect(anchor.anchors.at(-1)?.checkpoint.size).toBe(BigInt(appends.length));
        },
      ),
      { numRuns },
    );
  });

  it("counts for a reader only the anchors in blocks up to its L1 time", () => {
    const l1 = new SimulatedL1();
    const board = new SimulatedBoard(electionId, VERSION, secret());
    const anchor = new SimulatedAnchor(electionId, 10, 12, l1);
    board.board(10, payload([1]));
    board.board(11, payload([2]));
    anchor.anchorThrough(board.entries, 11);
    const second = anchor.anchors[1];
    if (second === undefined) throw new Error("two anchors expected");
    const read = (now: bigint) =>
      verifyBoard(electionId, board.entries, VERSION, anchor.anchors, anchor.clock, now);
    // Before period 11's anchor, its entry is past every counted anchor:
    // unauthenticated, never a failure.
    for (const now of [endOf(10) + SIMULATED_ANCHOR_DEADLINE, second.anchoredAt - 1n]) {
      expect(read(now).board.entries).toHaveLength(1);
      expect(read(now).unauthenticated).toBe(1);
    }
    expect(read(second.anchoredAt).unauthenticated).toBe(0);
  });

  it("repeats the board's state at the seal when nothing was added in it", () => {
    const l1 = new SimulatedL1();
    const board = new SimulatedBoard(electionId, VERSION, secret());
    const anchor = new SimulatedAnchor(electionId, 10, 20, l1);
    board.board(10, payload([1]));
    anchor.anchorThrough(board.entries, 20);
    const [first, seal] = anchor.anchors;
    if (first === undefined || seal === undefined) throw new Error("two anchors expected");
    expect(anchor.anchors).toHaveLength(2);
    expect(seal.checkpoint.segment).toBe(20);
    // The same size, head, root and CIDs: only the segment differs.
    expect({ ...seal.checkpoint, segment: 10 }).toEqual(first.checkpoint);
    expect(checkpointHash(seal.checkpoint)).not.toEqual(checkpointHash(first.checkpoint));
    // Asking again anchors nothing twice.
    anchor.anchorThrough(board.entries, 20);
    expect(anchor.anchors).toHaveLength(2);
  });

  it("refuses to anchor past the seal", () => {
    const anchor = new SimulatedAnchor(electionId, 10, 12, new SimulatedL1());
    expect(() => anchor.anchorThrough([], 13)).toThrow(/past the seal/);
    expect(anchor.anchors).toEqual([]);
  });

  it("refuses a first period outside 0 to the seal, and anchors nothing while the board is empty", () => {
    expect(() => new SimulatedAnchor(electionId, 13, 12, new SimulatedL1())).toThrow(RangeError);
    expect(() => new SimulatedAnchor(electionId, -1, 12, new SimulatedL1())).toThrow(RangeError);
    const anchor = new SimulatedAnchor(electionId, 5, 12, new SimulatedL1());
    anchor.anchorThrough([], 9);
    expect(anchor.anchors).toEqual([]);
  });

  // Controls: the closed board fails the verifier's board checks when the
  // authority's discipline is broken, so the run's pass isn't vacuous.
  it("fails the closed board when a period is anchored before its last entry, or a period skipped", () => {
    const l1 = new SimulatedL1();
    const seal = 13;
    const now = afterSeal(l1, seal);
    const early = new SimulatedAnchor(electionId, 10, seal, l1);
    const board = new SimulatedBoard(electionId, VERSION, secret());
    board.board(10, payload([1]));
    early.anchorThrough(board.entries, 10);
    board.board(10, payload([2]));
    early.anchorThrough(board.entries, seal);
    const check = (a: SimulatedAnchor) => () =>
      verifyBoard(electionId, board.entries, VERSION, a.anchors, a.clock, now);
    expect(code(check(early))).toBe("checkpoint-boundary");

    // Period 11's entry, boarded after the authority passed it over.
    const skipped = new SimulatedAnchor(electionId, 10, seal, l1);
    const other = new SimulatedBoard(electionId, VERSION, secret());
    other.board(10, payload([1]));
    skipped.anchorThrough(other.entries, 11);
    other.board(11, payload([2]));
    skipped.anchorThrough(other.entries, seal);
    const late = () =>
      verifyBoard(electionId, other.entries, VERSION, skipped.anchors, skipped.clock, now);
    expect(code(late)).toBe("unanchored");

    // Every entry anchored, but the seal never.
    const unsealed = new SimulatedAnchor(electionId, 10, seal, l1);
    unsealed.anchorThrough(other.entries, seal - 1);
    const open = () =>
      verifyBoard(electionId, other.entries, VERSION, unsealed.anchors, unsealed.clock, now);
    expect(code(open)).toBe("unsealed");
  });
});

describe("SimulatedAnchor's receipt-key record", () => {
  const opensAt = 1_000_000n;
  const key = identityKey(new Uint8Array(32).fill(3));

  it("writes each word as the contract does, which crypto reads back", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: (1n << 64n) - 1n }),
        fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
        (registeredAt, later) => {
          const retiredAt =
            later === 0n ? 0n : registeredAt + (later % ((1n << 64n) - registeredAt));
          const provenAt = retiredAt > registeredAt ? retiredAt : registeredAt;
          expect(
            receiptKeyRecordFromWord(receiptKeyWord(registeredAt, retiredAt), provenAt),
          ).toEqual({ registeredAt, retiredAt });
        },
      ),
      { numRuns },
    );
  });

  it("registers a key in the first L1 block after the time given, a day before opening, so it judges the election", () => {
    const l1 = new SimulatedL1();
    const anchor = new SimulatedAnchor(electionId, 0, 400, l1);
    anchor.registerReceiptKey(key, opensAt - SIMULATED_RECEIPT_KEY_LEAD);
    const registeredAt = l1.block(l1.firstAfter(opensAt - SIMULATED_RECEIPT_KEY_LEAD)).timestamp;
    expect(registeredAt).toBeGreaterThan(opensAt - SIMULATED_RECEIPT_KEY_LEAD);
    // Absent at any block before its own, then held from it on.
    expect(anchor.receiptKeysAt(registeredAt - 1n)).toEqual([]);
    expect(anchor.receiptKeyWordAt(key, registeredAt - 1n)).toEqual(new Uint8Array(32));
    expect(anchor.receiptKeysAt(registeredAt)).toEqual([
      { key, word: receiptKeyWord(registeredAt, 0n) },
    ]);
    const word = anchor.receiptKeyWordAt(key, opensAt);
    const record = receiptKeyRecordFromWord(word, opensAt);
    expect(record).toEqual({ registeredAt, retiredAt: 0n });
    expect(receiptKeyJudgement(record as NonNullable<typeof record>, opensAt, opensAt)).toBe(
      "judges",
    );
    // A client reading it before opening, or after, may cast.
    expect(
      receiptKeysCastCheck([anchor.receiptKeyWordAt(key, registeredAt)], opensAt, registeredAt),
    ).toEqual({
      castable: true,
    });
    expect(receiptKeysCastCheck([word], opensAt, opensAt + 600n)).toEqual({ castable: true });
  });

  // Controls: a key registered too late, or not at all, doesn't judge the
  // election, and the client's check refuses it, so the run's pass isn't vacuous.
  it("leaves a key registered at or after opening, or another key, unjudged", () => {
    const l1 = new SimulatedL1();
    const anchor = new SimulatedAnchor(electionId, 0, 400, l1);
    anchor.registerReceiptKey(key, opensAt);
    const late = anchor.receiptKeyWordAt(key, opensAt + 600n);
    const record = receiptKeyRecordFromWord(late, opensAt + 600n);
    expect(receiptKeyJudgement(record as NonNullable<typeof record>, opensAt, opensAt + 600n)).toBe(
      "unregistered",
    );
    expect(receiptKeysCastCheck([late], opensAt, opensAt + 600n)).toMatchObject({
      castable: false,
      key: 0,
    });
    const other = identityKey(new Uint8Array(32).fill(4));
    expect(anchor.receiptKeyWordAt(other, opensAt + 600n)).toEqual(new Uint8Array(32));
  });

  it("refuses a key registered twice, or its twin, and anything but a p256-key's 33 bytes", () => {
    const anchor = new SimulatedAnchor(electionId, 0, 400, new SimulatedL1());
    anchor.registerReceiptKey(key, opensAt);
    expect(() => anchor.registerReceiptKey(key, opensAt + 12n)).toThrow(/registered twice/);
    const twin = Uint8Array.from(key);
    twin[0] = key[0] === 0x02 ? 0x03 : 0x02;
    expect(() => anchor.registerReceiptKey(twin, opensAt + 12n)).toThrow(/registered twice/);
    expect(anchor.receiptKeyWordAt(twin, opensAt + 600n)).toEqual(new Uint8Array(32));
    const bad = Uint8Array.from(key);
    bad[0] = 0x04;
    expect(() => anchor.registerReceiptKey(bad, opensAt)).toThrow(RangeError);
    expect(() => anchor.registerReceiptKey(key.subarray(1), opensAt)).toThrow(RangeError);
  });
});
