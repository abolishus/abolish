import { sha256 } from "@noble/hashes/sha2.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { dagWith, encodeCar } from "../src/content-addressing.ts";
import { CHUNK_SIZE, cidText, contentDag, MAX_LINKS, objectCar, objectCid } from "../src/index.ts";
import { SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/content-addressing.json records each object's CID and CAR
// as two independent IPFS implementations made them, Kubo and
// ipfs-unixfs-importer with @ipld/car, which agreed byte for byte
// (scripts/content-addressing-vectors.mjs), so nothing expected comes from
// the code under test.

interface Vectors {
  readonly format: string;
  readonly profiles: Readonly<Record<string, { chunkSize: number; maxLinks: number }>>;
  readonly vectors: readonly {
    readonly id: string;
    readonly profile: string;
    readonly label: string;
    readonly length: number;
    readonly cid: string;
    readonly cidHex: string;
    readonly car?: string;
    readonly carLength: number;
    readonly carSha256: string;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("content-addressing.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// The vector file's object rule: SHA-256(label ‖ u32be(i)) concatenated, or zeros.
function object(label: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  if (label.startsWith("zeros")) return out;
  const prefix = new TextEncoder().encode(label);
  for (let i = 0, at = 0; at < length; i++, at += 32) {
    const input = new Uint8Array(prefix.length + 4);
    input.set(prefix);
    new DataView(input.buffer).setUint32(prefix.length, i);
    out.set(sha256(input).subarray(0, length - at), at);
  }
  return out;
}

describe("content-addressing.json", () => {
  test("is the file this suite reads, under the spec's parameters", () => {
    expect(vectors.format).toBe("abolish-content-addressing-vectors/1");
    expect(vectors.profiles["protocol"]).toEqual({ chunkSize: CHUNK_SIZE, maxLinks: MAX_LINKS });
  });

  for (const v of vectors.vectors) {
    test(`${v.id}: the CID and CAR Kubo and JavaScript made`, () => {
      const profile = vectors.profiles[v.profile] as { chunkSize: number; maxLinks: number };
      const bytes = object(v.label, v.length);
      const dag =
        v.profile === "protocol"
          ? contentDag(bytes)
          : dagWith(bytes, profile.chunkSize, profile.maxLinks);
      expect(hex(dag.root)).toBe(v.cidHex);
      expect(cidText(dag.root)).toBe(v.cid);
      const car = encodeCar(dag);
      expect(car.length).toBe(v.carLength);
      if (v.car !== undefined) expect(hex(car)).toBe(v.car);
      expect(hex(sha256(car))).toBe(v.carSha256);
      if (v.profile === "protocol") {
        expect(hex(objectCid(bytes))).toBe(v.cidHex);
        expect(hex(objectCar(bytes))).toBe(hex(car));
      }
    });
  }
});

describe("content addressing", () => {
  test("an object of at most one chunk is one raw block, whose CID hashes the object", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 600 }), (bytes) => {
        const dag = dagWith(bytes, 600, 4);
        expect(dag.blocks.length).toBe(1);
        expect(hex(dag.root)).toBe(`01551220${hex(sha256(bytes))}`);
      }),
      { numRuns },
    );
  });

  test("every block is listed once, the root first, and each CID hashes its block", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 3000 }),
        fc.integer({ min: 1, max: 64 }),
        fc.integer({ min: 2, max: 6 }),
        (bytes, chunkSize, maxLinks) => {
          const dag = dagWith(bytes, chunkSize, maxLinks);
          expect(hex(dag.blocks[0]?.cid as Uint8Array)).toBe(hex(dag.root));
          const cids = dag.blocks.map((b) => hex(b.cid));
          expect(new Set(cids).size).toBe(cids.length);
          for (const b of dag.blocks) expect(hex(b.cid).slice(8)).toBe(hex(sha256(b.bytes)));
        },
      ),
      { numRuns },
    );
  });

  test("any changed byte of an object changes its CID", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 2000 }),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (bytes, at, flip) => {
          const changed = Uint8Array.from(bytes);
          const i = at % bytes.length;
          changed[i] = (changed[i] as number) ^ flip;
          expect(hex(dagWith(changed, 64, 4).root)).not.toBe(hex(dagWith(bytes, 64, 4).root));
        },
      ),
      { numRuns },
    );
  });

  test("refuses an empty object and limits outside the layout", () => {
    expect(() => contentDag(new Uint8Array(0))).toThrow(RangeError);
    expect(() => dagWith(Uint8Array.of(1), 0, 4)).toThrow(RangeError);
    expect(() => dagWith(Uint8Array.of(1), 4, 1)).toThrow(RangeError);
  });
});
