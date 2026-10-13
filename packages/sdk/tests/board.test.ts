import {
  BOARD_TREE,
  checkBoard,
  checkReceiptAtCast,
  encodeReceipt,
  identityKey,
  inclusionProof,
  merkleRoot,
  RECORD_TYPES,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { SimulatedBoard, segmentAt } from "../src/simulation/board.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const VERSION = 4;
const electionId = new Uint8Array(32).fill(7);

// A payload the envelope carries: a ballot record's header and any body. The
// board never decodes a payload's fields, so any body serves.
const payload = fc
  .uint8Array({ maxLength: 64 })
  .map((body) =>
    Uint8Array.from([RECORD_TYPES.ballot >> 8, RECORD_TYPES.ballot & 0xff, 1, ...body]),
  );

const expectation = (board: SimulatedBoard, p: Uint8Array, segment: number) => ({
  electionId,
  payload: p,
  boardEntryVersion: VERSION as 4,
  receiptKeys: [board.receiptKey],
  segments: { min: segment, max: segment },
});

// The first property rechecks the whole board after every append, so its
// FC_NUM_RUNS=1000 runs take several seconds in CI, past the 5 s default.
describe("SimulatedBoard", { timeout: 120_000 }, () => {
  it("gives receipts that pass the checks at cast, over the board the verifier checks", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ payload, direct: fc.boolean(), step: fc.nat({ max: 2 }) }), {
          minLength: 1,
          maxLength: 40,
        }),
        (appends) => {
          const board = new SimulatedBoard(electionId, VERSION);
          const hashes: Uint8Array[] = [];
          let segment = 10;
          for (const a of appends) {
            segment += a.step;
            if (a.direct) {
              expect(board.board(segment, a.payload)).toBe(hashes.length);
              const checked = checkBoard(electionId, board.entries, VERSION);
              hashes.push(checked.entryHashes.at(-1) as Uint8Array);
              continue;
            }
            const receipt = board.submit(segment, a.payload);
            const check = checkReceiptAtCast(
              encodeReceipt(receipt),
              expectation(board, a.payload, segment),
            );
            expect(check.ok).toBe(true);
            hashes.push(receipt.entry_hash);
            // What the receipt states is the board's state at its own size,
            // by crypto's from-scratch tree and chain.
            const checked = checkBoard(electionId, board.entries, VERSION);
            expect(receipt.index).toBe(BigInt(hashes.length - 1));
            expect(receipt.link).toEqual(checked.links.at(-1));
            expect(receipt.root).toEqual(merkleRoot(BOARD_TREE, hashes));
            expect(receipt.inclusion).toEqual(
              inclusionProof(BOARD_TREE, hashes, hashes.length - 1),
            );
          }
          const checked = checkBoard(electionId, board.entries, VERSION);
          expect(checked.entryHashes).toEqual(hashes);
          expect(board.head).toEqual(checked.links.at(-1));
        },
      ),
      { numRuns },
    );
  });

  it("gives receipts the client refuses for another payload, key, election or segment", () => {
    const board = new SimulatedBoard(electionId, VERSION);
    const p = Uint8Array.from([0, RECORD_TYPES.ballot, 1, 9, 9]);
    board.board(5, Uint8Array.from([0, RECORD_TYPES.ballot, 1]));
    const bytes = encodeReceipt(board.submit(5, p));
    const want = expectation(board, p, 5);
    expect(checkReceiptAtCast(bytes, want).ok).toBe(true);
    const code = (e: typeof want) => {
      const c = checkReceiptAtCast(bytes, e);
      return c.ok ? "ok" : c.code;
    };
    expect(code({ ...want, payload: Uint8Array.from([0, RECORD_TYPES.ballot, 1, 9]) })).toBe(
      "receipt-entry",
    );
    expect(code({ ...want, receiptKeys: [identityKey(new Uint8Array(32).fill(1))] })).toBe(
      "receipt-key",
    );
    expect(code({ ...want, electionId: new Uint8Array(32) })).toBe("receipt-election");
    expect(code({ ...want, segments: { min: 6, max: 7 } })).toBe("receipt-segment");
  });

  it("uses one fresh receipt key per board", () => {
    expect(new SimulatedBoard(electionId, VERSION).receiptKey).not.toEqual(
      new SimulatedBoard(electionId, VERSION).receiptKey,
    );
  });

  it("labels entries with hourly periods", () => {
    expect(segmentAt(0n)).toBe(0);
    expect(segmentAt(3599n)).toBe(0);
    expect(segmentAt(3600n)).toBe(1);
    expect(segmentAt(1_000_000n)).toBe(277);
  });
});
