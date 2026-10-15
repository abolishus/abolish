import {
  boardEntryHash,
  copyCheckpoints,
  objectCid,
  RECORD_TYPES,
  splitSegmentObject,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { SegmentPublisher, SimulatedIpfs } from "../src/simulation/archive.ts";
import { SimulatedBoard } from "../src/simulation/board.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const VERSION = 5;
const electionId = new Uint8Array(32).fill(7);
const secret = () => crypto.getRandomValues(new Uint8Array(32));

const payload = fc
  .uint8Array({ maxLength: 64 })
  .map((body) =>
    Uint8Array.from([RECORD_TYPES.ballot >> 8, RECORD_TYPES.ballot & 0xff, 1, ...body]),
  );

const concat = (parts: readonly Uint8Array[]) =>
  Uint8Array.from(parts.flatMap((p) => Array.from(p)));

describe("SimulatedIpfs", () => {
  it("serves an object under crypto's objectCid of its bytes, as a copy", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 200 }), (object) => {
        const ipfs = new SimulatedIpfs();
        const cid = ipfs.put(object);
        expect(cid).toEqual(objectCid(object));
        const got = ipfs.get(cid) as Uint8Array;
        expect(got).toEqual(object);
        got.fill(1);
        expect(ipfs.get(cid)).toEqual(object);
      }),
      { numRuns },
    );
  });

  it("serves nothing under a CID it wasn't given, or holding other bytes under it", () => {
    const ipfs = new SimulatedIpfs();
    const cid = ipfs.put(Uint8Array.of(1, 2, 3));
    expect(ipfs.get(objectCid(Uint8Array.of(1, 2)))).toBeUndefined();
    // A mirror that alters an object serves nothing a client accepts.
    ipfs.replace(cid, Uint8Array.of(1, 2, 4));
    expect(ipfs.get(cid)).toBeUndefined();
    ipfs.replace(cid, Uint8Array.of(1, 2, 3));
    expect(ipfs.get(cid)).toEqual(Uint8Array.of(1, 2, 3));
    ipfs.replace(cid, undefined);
    expect(ipfs.get(cid)).toBeUndefined();
  });
});

describe("SegmentPublisher", () => {
  it("publishes exactly the objects and entry-hash lists every checkpoint's CIDs name", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ payload, step: fc.nat({ max: 2 }) }), {
          minLength: 1,
          maxLength: 30,
        }),
        fc.array(fc.nat({ max: 3 }), { minLength: 1, maxLength: 6 }),
        (appends, steps) => {
          const board = new SimulatedBoard(electionId, VERSION, secret());
          const ipfs = new SimulatedIpfs();
          const publisher = new SegmentPublisher(ipfs, VERSION);
          let segment = 10;
          const segments = appends.map((a) => {
            segment += a.step;
            board.board(segment, a.payload);
            return segment;
          });
          // Publish through a rising run of periods, ending past the last.
          let through = 9;
          for (const s of steps) publisher.publishThrough(board.entries, (through += s));
          publisher.publishThrough(board.entries, segment);
          const distinct = [...new Set(segments)];
          // One object and one list per period with entries, nothing else
          // (an object and a list never coincide: a list's length is 32·n).
          expect(ipfs.size).toBe(2 * distinct.length);
          const checkpoints = copyCheckpoints(electionId, board.entries, distinct);
          for (const s of distinct) {
            const cp = checkpoints.get(s);
            if (cp === undefined) throw new Error("no checkpoint for a period with entries");
            const own = board.entries.filter((_, i) => segments[i] === s);
            const object = ipfs.get(cp.object_cid) as Uint8Array;
            expect(splitSegmentObject(object)).toEqual(own);
            expect(ipfs.get(cp.hashes_cid)).toEqual(concat(own.map(boardEntryHash)));
          }
        },
      ),
      { numRuns },
    );
  });

  it("publishes nothing past the period it is given, and refuses an entry in a published period", () => {
    const board = new SimulatedBoard(electionId, VERSION, secret());
    const ipfs = new SimulatedIpfs();
    const publisher = new SegmentPublisher(ipfs, VERSION);
    board.board(3, Uint8Array.of(0, RECORD_TYPES.ballot, 1));
    board.board(5, Uint8Array.of(0, RECORD_TYPES.ballot, 1, 9));
    publisher.publishThrough(board.entries, 4);
    expect(ipfs.size).toBe(2);
    // Asking again for a period already handled changes nothing.
    publisher.publishThrough(board.entries, 2);
    expect(ipfs.size).toBe(2);
    board.board(5, Uint8Array.of(0, RECORD_TYPES.ballot, 1, 8));
    publisher.publishThrough(board.entries, 5);
    expect(ipfs.size).toBe(4);
    expect(
      splitSegmentObject(ipfs.get(objectCid(concat(board.entries.slice(1)))) as Uint8Array),
    ).toHaveLength(2);
    board.board(5, Uint8Array.of(0, RECORD_TYPES.ballot, 1, 7));
    expect(() => publisher.publishThrough(board.entries, 6)).toThrow(/already published/);
  });
});
