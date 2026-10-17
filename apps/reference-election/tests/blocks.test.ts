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

test("each segment's object is the one its checkpoint's object_cid names", () => {
  const cids = new Set(
    segmentObjects(valid.entries.map((e) => hexToBytes(e))).map((o) =>
      Buffer.from(objectCid(o)).toString("hex"),
    ),
  );
  for (const c of valid.checkpoints) expect(cids.has(c["objectCid"] as string)).toBe(true);
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
      fc.array(fc.uint8Array({ minLength: 1, maxLength: 3000 }), { maxLength: 23 }),
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
          0x80 + dags.length,
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

test("an entry too short for its segment field, and a 24th object, are refused", () => {
  expect(() => segmentObjects([new Uint8Array(46)])).toThrow(RangeError);
  expect(() => blocksCar(Array.from({ length: 24 }, () => Uint8Array.of(1)))).toThrow(RangeError);
});
