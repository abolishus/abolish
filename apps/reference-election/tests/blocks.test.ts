import { readFileSync } from "node:fs";
import fc from "fast-check";
import { contentDag, objectCid } from "@abolishus/crypto";
import { hexToBytes } from "@noble/hashes/utils.js";
import { expect, test } from "vite-plus/test";
import { blocksCar, segmentObjects } from "../src/blocks.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

// docs/spec/vectors/board.json, from the independent Python implementation:
// the `valid` board, whose checkpoints name its segment objects' CIDs.
const board = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/board.json", import.meta.url), "utf8"),
) as {
  readonly boards: readonly {
    readonly id: string;
    readonly entries: readonly string[];
    readonly checkpoints: readonly Readonly<Record<string, string>>[];
  }[];
};
const valid = board.boards.find((b) => b.id === "valid");
if (valid === undefined) throw new Error("board.json has no valid board");

test("each segment's object and entry-hash list are the ones its checkpoint's CIDs name", () => {
  const hex = (b: Uint8Array) => Buffer.from(objectCid(b)).toString("hex");
  const segments = segmentObjects(valid.entries.map((e) => hexToBytes(e)));
  const bySegment = new Map(segments.map((s) => [s.segment, s]));
  // A checkpoint names the objects of the last segment at or before its own that has entries.
  for (const c of valid.checkpoints) {
    const at = Math.max(...segments.map((s) => s.segment).filter((s) => s <= Number(c["segment"])));
    const s = bySegment.get(at);
    expect(s && hex(s.object)).toBe(c["objectCid"]);
    expect(s && hex(s.hashes)).toBe(c["hashesCid"]);
  }
});

test("a segment that decreases is refused", () => {
  const segmentOf = (e: Uint8Array) => new DataView(e.buffer, e.byteOffset + 43, 4).getUint32(0);
  const [first, ...rest] = valid.entries.map((e) => hexToBytes(e));
  const later = rest.find((e) => first !== undefined && segmentOf(e) > segmentOf(first));
  if (first === undefined || later === undefined)
    throw new Error("the valid board has one segment");
  expect(() => segmentObjects([later, first])).toThrow(RangeError);
});

// Unsigned LEB128, as CAR frames it.
function varint(b: Uint8Array, at: number): [value: number, next: number] {
  let value = 0;
  for (let shift = 1, i = at; ; shift *= 128, i++) {
    const x = b[i] as number;
    value += (x & 0x7f) * shift;
    if (x < 0x80) return [value, i + 1];
  }
}

test("the CAR's header names every object's root, and its sections are every block in order", () => {
  fc.assert(
    fc.property(
      fc.array(fc.uint8Array({ minLength: 1, maxLength: 3000 }), { maxLength: 30 }),
      (objects) => {
        const car = blocksCar(objects);
        const dags = objects.map(contentDag);
        const [length, start] = varint(car, 0);
        const header = car.slice(start, start + length);
        const ascii = (s: string) => [...new TextEncoder().encode(s)];
        // {roots: [CID…], version: 1} in dag-cbor, each CID tag 42 over 0x00 ‖ CID.
        expect([...header]).toEqual([
          0xa2,
          0x65,
          ...ascii("roots"),
          ...(dags.length < 24 ? [0x80 + dags.length] : [0x98, dags.length]),
          ...dags.flatMap((d) => [0xd8, 0x2a, 0x58, 37, 0x00, ...d.root]),
          0x67,
          ...ascii("version"),
          0x01,
        ]);
        const sections: string[] = [];
        for (let at = start + length; at < car.length;) {
          const [n, body] = varint(car, at);
          sections.push(Buffer.from(car.slice(body, body + n)).toString("hex"));
          at = body + n;
        }
        expect(sections).toEqual(
          dags.flatMap((d) =>
            d.blocks.map((b) => Buffer.from([...b.cid, ...b.bytes]).toString("hex")),
          ),
        );
      },
    ),
    { numRuns },
  );
});

test("an entry too short for its segment field is refused", () => {
  expect(() => segmentObjects([new Uint8Array(46)])).toThrow(RangeError);
});

test("the header's roots array has its length in dag-cbor's shortest form", () => {
  // RFC 8949, 3.1: below 24 in the initial byte, else in the 1 or 2 bytes after 0x98 or 0x99.
  const at = (n: number) => {
    const car = blocksCar(Array.from({ length: n }, (_, i) => Uint8Array.of(i & 0xff, i >> 8)));
    const [, start] = varint(car, 0);
    return Array.from(car.slice(start + 7, start + 10));
  };
  expect(at(23)[0]).toBe(0x97);
  expect(at(24).slice(0, 2)).toEqual([0x98, 24]);
  expect(at(255).slice(0, 2)).toEqual([0x98, 255]);
  expect(at(256)).toEqual([0x99, 1, 0]);
});
