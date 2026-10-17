import { sha256 } from "@noble/hashes/sha2.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  type Block,
  dagWith,
  encodeCar,
  readWith,
  readWithinWith,
} from "../src/content-addressing.ts";
import {
  CHUNK_SIZE,
  cidText,
  contentDag,
  MAX_LINKS,
  objectCar,
  objectCid,
  readObject,
  readObjectAsync,
  readObjectWithin,
  readObjectWithinAsync,
} from "../src/index.ts";
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

// The blocks of a CARv1 (header, then each block as varint length, CID,
// bytes), so the reader can be fed what Kubo exported rather than this
// package's own DAG.
function carBlocks(car: Uint8Array): Block[] {
  const varint = (at: number) => {
    let value = 0;
    for (let scale = 1; ; scale *= 0x80, at++) {
      const x = car[at] as number;
      value += (x & 0x7f) * scale;
      if (x < 0x80) return { value, next: at + 1 };
    }
  };
  const header = varint(0);
  const out: Block[] = [];
  for (let at = header.next + header.value; at < car.length;) {
    const len = varint(at);
    out.push({
      cid: car.slice(len.next, len.next + 36),
      bytes: car.slice(len.next + 36, len.next + len.value),
    });
    at = len.next + len.value;
  }
  return out;
}

// A source holding these blocks, recording each request.
function source(blocks: readonly Block[], requests: string[] = []) {
  return (cid: Uint8Array) => {
    requests.push(hex(cid));
    return blocks.filter((b) => hex(b.cid) === hex(cid)).map((b) => b.bytes);
  };
}

const unavailable = { ok: false, reason: "unavailable" };
const inconsistent = { ok: false, reason: "inconsistent" };

describe("reading an object by its CID (content-addressing.json)", () => {
  for (const v of vectors.vectors) {
    test(`${v.id}: read back under its own profile, and canonical only if it is the protocol's`, () => {
      const profile = vectors.profiles[v.profile] as { chunkSize: number; maxLinks: number };
      const bytes = object(v.label, v.length);
      const blocks =
        v.car === undefined
          ? dagWith(bytes, profile.chunkSize, profile.maxLinks).blocks
          : carBlocks(Buffer.from(v.car, "hex"));
      const cid = Buffer.from(v.cidHex, "hex");
      const own = readWith(
        cid,
        v.length,
        source(blocks),
        profile.chunkSize,
        profile.maxLinks,
        Math.max(profile.chunkSize, 4096),
      );
      expect(own.ok && hex(own.bytes)).toBe(hex(bytes));
      // Under the protocol's limits only the canonical DAG reads: a layout
      // profile's tree of the same bytes is another DAG, whoever built it.
      const read = readObject(cid, v.length, source(blocks));
      if (hex(objectCid(bytes)) === v.cidHex) expect(read.ok && hex(read.bytes)).toBe(hex(bytes));
      else expect(read).toEqual(inconsistent);
    });
  }
});

describe("reading an object by its CID", () => {
  const profile = { chunkSize: 64, maxLinks: 4 };
  const read = (
    cid: Uint8Array,
    length: number,
    blocks: (cid: Uint8Array, limit: number) => readonly Uint8Array[],
  ) => readWith(cid, length, blocks, profile.chunkSize, profile.maxLinks, 4096);
  const dagOf = (bytes: Uint8Array) => dagWith(bytes, profile.chunkSize, profile.maxLinks);
  const objects = fc.uint8Array({ minLength: 1, maxLength: 3000 });

  test("reads back any object from its blocks, in any order", () => {
    fc.assert(
      fc.property(objects, fc.boolean(), (bytes, reversed) => {
        const dag = dagOf(bytes);
        const blocks = reversed ? [...dag.blocks].reverse() : dag.blocks;
        const r = read(dag.root, bytes.length, source(blocks));
        expect(r.ok && hex(r.bytes)).toBe(hex(bytes));
      }),
      { numRuns },
    );
  });

  test("a block no source serves is unavailable, never inconsistent", () => {
    fc.assert(
      fc.property(objects, fc.nat(), (bytes, which) => {
        const dag = dagOf(bytes);
        const missing = hex((dag.blocks[which % dag.blocks.length] as Block).cid);
        const blocks = dag.blocks.filter((b) => hex(b.cid) !== missing);
        expect(read(dag.root, bytes.length, source(blocks))).toEqual(unavailable);
      }),
      { numRuns },
    );
  });

  test("any answer that doesn't hash is a failed fetch: a later good one is read, and with none it is unavailable", () => {
    fc.assert(
      fc.property(
        objects,
        fc.array(fc.uint8Array({ maxLength: 200 }), { maxLength: 3 }),
        (bytes, anyJunk) => {
          const dag = dagOf(bytes);
          const good = source(dag.blocks);
          const r = read(dag.root, bytes.length, (cid) => [...anyJunk, ...good(cid)]);
          expect(r.ok && hex(r.bytes)).toBe(hex(bytes));
          // Junk byte-equal to a real block isn't junk: served for its own CID it hashes
          // (seed 989343742: the one-byte object [0] with junk [[0]]).
          const real = new Set(dag.blocks.map((b) => hex(b.bytes)));
          const junk = anyJunk.filter((j) => !real.has(hex(j)));
          expect(read(dag.root, bytes.length, () => junk)).toEqual(unavailable);
          // A flipped byte in a served block is that block's failed fetch.
          const flipped = dag.blocks.map((b) => {
            const c = Uint8Array.from(b.bytes);
            c[0] = (c[0] as number) ^ 1;
            return { cid: b.cid, bytes: c };
          });
          expect(read(dag.root, bytes.length, source(flipped))).toEqual(unavailable);
        },
      ),
      { numRuns },
    );
  });

  test("another length is inconsistent", () => {
    fc.assert(
      fc.property(objects, fc.integer({ min: 1, max: 4000 }), (bytes, length) => {
        fc.pre(length !== bytes.length);
        const dag = dagOf(bytes);
        const r = read(dag.root, length, source(dag.blocks));
        // A wrong length can also need a block the source doesn't hold (a
        // longer object has more chunks); never does it read.
        expect(r.ok).toBe(false);
        if (Math.ceil(length / 64) === Math.ceil(bytes.length / 64))
          expect(r).toEqual(inconsistent);
      }),
      { numRuns },
    );
  });

  test("the same bytes under other limits read only where the DAG is the same", () => {
    fc.assert(
      fc.property(
        objects,
        fc.integer({ min: 1, max: 128 }),
        fc.integer({ min: 2, max: 8 }),
        (bytes, chunkSize, maxLinks) => {
          const other = dagWith(bytes, chunkSize, maxLinks);
          const r = read(other.root, bytes.length, source(other.blocks));
          if (hex(other.root) === hex(dagOf(bytes).root))
            expect(r.ok && hex(r.bytes)).toBe(hex(bytes));
          else expect(r).toEqual(inconsistent);
        },
      ),
      { numRuns },
    );
  });

  test("a root node changed in any way and hashed again never reads, and with an extra byte is inconsistent", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 65, maxLength: 3000 }),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        fc.boolean(),
        (bytes, at, flip, append) => {
          const dag = dagOf(bytes);
          const node = (dag.blocks[0] as Block).bytes;
          let changed: Uint8Array;
          if (append) changed = Uint8Array.from([...node, flip]);
          else {
            changed = Uint8Array.from(node);
            changed[at % node.length] = (changed[at % node.length] as number) ^ flip;
          }
          const cid = Uint8Array.from([...dag.root.subarray(0, 4), ...sha256(changed)]);
          const r = read(cid, bytes.length, source([...dag.blocks, { cid, bytes: changed }]));
          // A flip inside a link's CID names a block no source holds instead.
          expect(r.ok).toBe(false);
          if (append) expect(r).toEqual(inconsistent);
        },
      ),
      { numRuns },
    );
  });

  test("a CID of another form is inconsistent before anything is fetched", () => {
    const bytes = object("small", 100);
    const cid = objectCid(bytes);
    const requests: string[] = [];
    const blocks = source(contentDag(bytes).blocks, requests);
    for (const other of [
      // dag-pb, another hash function, another digest length, CIDv0's 0x12 0x20, too long.
      [0x01, 0x70, 0x12, 0x20],
      [0x01, 0x55, 0x13, 0x20],
      [0x01, 0x55, 0x12, 0x1f],
      [0x12, 0x20],
    ]) {
      const c = Uint8Array.from([...other, ...cid.subarray(4)]);
      expect(readObject(c, 100, blocks), hex(c)).toEqual(inconsistent);
    }
    expect(readObject(Uint8Array.from([...cid, 0]), 100, blocks)).toEqual(inconsistent);
    expect(requests).toEqual([]);
    expect(readObject(cid, 100, blocks)).toEqual({ ok: true, bytes });
  });

  test("no CID makes it request more blocks than the canonical DAG of its length has", () => {
    fc.assert(
      fc.property(
        objects,
        fc.integer({ min: 1, max: 16 }),
        fc.integer({ min: 2, max: 4 }),
        (bytes, chunkSize, maxLinks) => {
          // A deeper, finer DAG of the bytes, against the canonical DAG of an
          // object of that length whose chunks all differ, so none is shared.
          const other = dagWith(bytes, chunkSize, maxLinks);
          const requests: string[] = [];
          read(other.root, bytes.length, source(other.blocks, requests));
          const canonical = dagOf(Uint8Array.from({ length: bytes.length }, (_, i) => i % 251));
          expect(requests.length).toBeLessThanOrEqual(canonical.blocks.length);
        },
      ),
      { numRuns },
    );
  });

  // A two-level DAG of 16 leaves under the small layout, with its root node.
  const deep = () => {
    const bytes = Uint8Array.from({ length: 16 * 64 }, (_, i) => i % 251);
    const dag = dagOf(bytes);
    return { bytes, dag, node: (dag.blocks[0] as Block).bytes };
  };
  const rehashed = (node: Uint8Array) => Uint8Array.from([0x01, 0x70, 0x12, 0x20, ...sha256(node)]);

  test("a node is checked when it arrives, before any child is asked for", () => {
    const { bytes, node } = deep();
    // The last byte is the root's last blocksizes entry: another value
    // there, with the root hashed again and no child served, is the root's.
    const changed = Uint8Array.from(node);
    changed[changed.length - 1] = (changed[changed.length - 1] as number) ^ 1;
    const cid = rehashed(changed);
    const requests: string[] = [];
    expect(read(cid, bytes.length, source([{ cid, bytes: changed }], requests))).toEqual(
      inconsistent,
    );
    expect(requests).toEqual([hex(cid)]);
  });

  test("a link whose CID has the codec of another place is inconsistent, and never asked for", () => {
    const { bytes, dag, node } = deep();
    // The root's children are dag-pb nodes; its first link's codec byte
    // follows the PBLink's tag and length, the Hash's tag and length, and
    // the CID's version byte.
    const at = 2 + 2 + 1;
    expect(node[at]).toBe(0x70);
    const changed = Uint8Array.from(node);
    changed[at] = 0x55;
    const cid = rehashed(changed);
    const requests: string[] = [];
    const r = read(cid, bytes.length, source([...dag.blocks, { cid, bytes: changed }], requests));
    expect(r).toEqual(inconsistent);
    expect(requests).toEqual([hex(cid)]);
  });

  test("an answer over the limit is a failed fetch, and every request carries the limit", () => {
    const { bytes, dag } = deep();
    const limits = new Set<number>();
    const r = read(dag.root, bytes.length, (cid, limit) => {
      limits.add(limit);
      return [new Uint8Array(limit + 1), ...source(dag.blocks)(cid)];
    });
    expect(r.ok && hex(r.bytes)).toBe(hex(bytes));
    expect([...limits]).toEqual([4096]);
    const protocol = new Set<number>();
    readObject(objectCid(bytes), bytes.length, (_cid, limit) => {
      protocol.add(limit);
      return [];
    });
    expect([...protocol]).toEqual([CHUNK_SIZE]);
  });

  test("refuses a length or limits outside the layout", () => {
    const cid = objectCid(Uint8Array.of(1));
    const none = () => [];
    expect(() => readObject(cid, 0, none)).toThrow(RangeError);
    expect(() => readObject(cid, 1.5, none)).toThrow(RangeError);
    expect(() => readWith(cid, 1, none, 0, 4, 4)).toThrow(RangeError);
    expect(() => readWith(cid, 1, none, 4, 1, 4)).toThrow(RangeError);
    expect(() => readWith(cid, 1, none, 4, 4, 3)).toThrow(RangeError);
  });
});

describe("reading an object within a bound (content-addressing.json)", () => {
  for (const v of vectors.vectors) {
    test(`${v.id}: read back by its CID alone, and refused under a bound below its length`, () => {
      const profile = vectors.profiles[v.profile] as { chunkSize: number; maxLinks: number };
      const bytes = object(v.label, v.length);
      const blocks =
        v.car === undefined
          ? dagWith(bytes, profile.chunkSize, profile.maxLinks).blocks
          : carBlocks(Buffer.from(v.car, "hex"));
      const cid = Buffer.from(v.cidHex, "hex");
      const limit = Math.max(profile.chunkSize, 4096);
      const within = (max: number, requests?: string[]) =>
        readWithinWith(
          cid,
          max,
          source(blocks, requests),
          profile.chunkSize,
          profile.maxLinks,
          limit,
        );
      const own = within(v.length);
      expect(own.ok && hex(own.bytes)).toBe(hex(bytes));
      if (v.length > 1) {
        const requests: string[] = [];
        expect(within(v.length - 1, requests)).toEqual({
          ok: false,
          reason: "over-bound",
          length: v.length,
        });
        // Only the root is asked for: its claim is refused before any child.
        expect(requests).toEqual([v.cidHex]);
      }
      const read = readObjectWithin(cid, v.length, source(blocks));
      if (hex(objectCid(bytes)) === v.cidHex) expect(read.ok && hex(read.bytes)).toBe(hex(bytes));
      else expect(read.ok).toBe(false);
    });
  }
});

describe("reading an object within a bound", () => {
  const profile = { chunkSize: 64, maxLinks: 4 };
  const within = (
    cid: Uint8Array,
    max: number,
    blocks: (cid: Uint8Array, limit: number) => readonly Uint8Array[],
  ) => readWithinWith(cid, max, blocks, profile.chunkSize, profile.maxLinks, 4096);
  const exactly = (
    cid: Uint8Array,
    length: number,
    blocks: (cid: Uint8Array, limit: number) => readonly Uint8Array[],
  ) => readWith(cid, length, blocks, profile.chunkSize, profile.maxLinks, 4096);
  const dagOf = (bytes: Uint8Array) => dagWith(bytes, profile.chunkSize, profile.maxLinks);
  const objects = fc.uint8Array({ minLength: 1, maxLength: 3000 });

  test("under any bound at least its length, reads what the exact read does, asking for each block once", () => {
    fc.assert(
      fc.property(objects, fc.nat(5000), (bytes, extra) => {
        const dag = dagOf(bytes);
        const asked: string[] = [];
        const r = within(dag.root, bytes.length + extra, source(dag.blocks, asked));
        expect(r.ok && hex(r.bytes)).toBe(hex(bytes));
        const exact: string[] = [];
        exactly(dag.root, bytes.length, source(dag.blocks, exact));
        // The root the length was learnt from isn't asked for again.
        expect(asked).toEqual(exact);
      }),
      { numRuns },
    );
  });

  test("under a bound below its length, is over-bound with its length after asking only for the root", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 2, maxLength: 3000 }), fc.nat(), (bytes, cut) => {
        const dag = dagOf(bytes);
        const asked: string[] = [];
        const max = 1 + (cut % (bytes.length - 1));
        expect(within(dag.root, max, source(dag.blocks, asked))).toEqual({
          ok: false,
          reason: "over-bound",
          length: bytes.length,
        });
        expect(asked).toEqual([hex(dag.root)]);
      }),
      { numRuns },
    );
  });

  test("a withheld or altered block is unavailable, as in the exact read", () => {
    fc.assert(
      fc.property(objects, fc.nat(), fc.boolean(), (bytes, which, drop) => {
        const dag = dagOf(bytes);
        const target = hex((dag.blocks[which % dag.blocks.length] as Block).cid);
        // Withhold one block, or serve it with a byte flipped: either way no
        // answer for it hashes.
        const blocks = dag.blocks.flatMap((b) => {
          if (hex(b.cid) !== target) return [b];
          if (drop) return [];
          const c = Uint8Array.from(b.bytes);
          c[0] = (c[0] as number) ^ 1;
          return [{ cid: b.cid, bytes: c }];
        });
        expect(within(dag.root, 4000, source(blocks))).toEqual(unavailable);
        expect(exactly(dag.root, bytes.length, source(blocks))).toEqual(unavailable);
      }),
      { numRuns },
    );
  });

  test("a root claiming another filesize, hashed again, is inconsistent", () => {
    // Two levels of the small layout: 16 leaves of 64 bytes.
    const bytes = Uint8Array.from({ length: 16 * 64 }, (_, i) => i % 251);
    const dag = dagOf(bytes);
    const node = (dag.blocks[0] as Block).bytes;
    // The root's filesize is the varint after its Data field's Type; 1,024
    // is 0x80 0x08. Change it to 1,023 (0xff 0x07) and to 1,025 (0x81 0x08).
    const at = node.indexOf(0x18, node.lastIndexOf(0x0a)) + 1;
    expect([node[at], node[at + 1]]).toEqual([0x80, 0x08]);
    for (const claim of [
      [0xff, 0x07],
      [0x81, 0x08],
    ]) {
      const changed = Uint8Array.from(node);
      changed.set(claim, at);
      const cid = Uint8Array.from([0x01, 0x70, 0x12, 0x20, ...sha256(changed)]);
      expect(within(cid, 4000, source([...dag.blocks, { cid, bytes: changed }]))).toEqual(
        inconsistent,
      );
    }
  });

  test("a dag-pb root over one chunk or less, an empty raw block and a CID of another form are inconsistent", () => {
    const small = Uint8Array.from({ length: 64 }, (_, i) => i);
    // A dag-pb root of one raw leaf: a valid UnixFS file, not the canonical DAG.
    const wrapped = dagWith(small, 32, 4);
    const leaf = dagWith(small, 64, 4);
    expect(wrapped.root[1]).toBe(0x70);
    expect(within(wrapped.root, 4000, source(wrapped.blocks))).toEqual(inconsistent);
    expect(within(leaf.root, 4000, source(leaf.blocks))).toEqual({ ok: true, bytes: small });
    const empty = Uint8Array.from([0x01, 0x55, 0x12, 0x20, ...sha256(new Uint8Array(0))]);
    expect(within(empty, 4000, source([{ cid: empty, bytes: new Uint8Array(0) }]))).toEqual(
      inconsistent,
    );
    const asked: string[] = [];
    const other = Uint8Array.from([0x01, 0x71, 0x12, 0x20, ...sha256(small)]);
    expect(within(other, 4000, source([], asked))).toEqual(inconsistent);
    expect(asked).toEqual([]);
  });

  test("a raw root over one chunk is never hashed: an unavailable fetch", () => {
    const big = new Uint8Array(CHUNK_SIZE + 1);
    const cid = Uint8Array.from([0x01, 0x55, 0x12, 0x20, ...sha256(big)]);
    expect(readObjectWithin(cid, 2 * CHUNK_SIZE, () => [big])).toEqual(unavailable);
  });

  // A canonical dag-pb node over children of these sizes and Tsizes, with any
  // CIDs, encoded as docs/spec/content-addressing.md writes it, so a root
  // claiming any length can be built by hand without the data under it.
  const pbVarint = (n: number): number[] => {
    const out: number[] = [];
    for (let v = n; ; v = Math.floor(v / 0x80)) {
      if (v < 0x80) return [...out, v];
      out.push((v % 0x80) | 0x80);
    }
  };
  type Shaped = { cid: Uint8Array; size: number; tsize: number; bytes: Uint8Array };
  const node = (children: readonly Omit<Shaped, "bytes">[]): Shaped => {
    const size = children.reduce((n, c) => n + c.size, 0);
    const data = [
      0x08,
      2,
      0x18,
      ...pbVarint(size),
      ...children.flatMap((c) => [0x20, ...pbVarint(c.size)]),
    ];
    const links = children.flatMap((c) => {
      const link = [0x0a, 36, ...c.cid, 0x12, 0, 0x18, ...pbVarint(c.tsize)];
      return [0x12, ...pbVarint(link.length), ...link];
    });
    const bytes = Uint8Array.from([...links, 0x0a, ...pbVarint(data.length), ...data]);
    return {
      cid: Uint8Array.from([0x01, 0x70, 0x12, 0x20, ...sha256(bytes)]),
      size,
      tsize: bytes.length + children.reduce((n, c) => n + c.tsize, 0),
      bytes,
    };
  };
  // A full subtree of height `h` under `links` per node and `chunk`-byte
  // leaves. Full subtrees of one height are identical, so each level is built once.
  const full = (h: number, links: number, chunk: number): Omit<Shaped, "bytes"> => {
    let level: Omit<Shaped, "bytes"> = { cid: new Uint8Array(36), size: chunk, tsize: chunk };
    for (let k = 0; k < h; k++) level = node(Array.from({ length: links }, () => level));
    return level;
  };

  test("the hand-built node is the canonical one", () => {
    const bytes = Uint8Array.from({ length: 16 * 64 }, (_, i) => i % 251);
    const dag = dagOf(bytes);
    const leaves = dag.blocks.filter((b) => b.cid[1] === 0x55);
    // 16 distinct leaves: the root is four nodes of four leaves each.
    const groups = [0, 1, 2, 3].map((g) =>
      node(leaves.slice(4 * g, 4 * g + 4).map((l) => ({ cid: l.cid, size: 64, tsize: 64 }))),
    );
    expect(hex(node(groups).cid)).toBe(hex(dag.root));
  });

  test("a lone root claiming a huge length is checked and refused at no cost that grows with the claim", () => {
    // Under the small layout: 4^22 chunks of 64 bytes, 2^50 bytes.
    const small = node(Array.from({ length: 4 }, () => full(21, 4, 64)));
    expect(small.size).toBe(2 ** 50);
    const asked: string[] = [];
    const start = performance.now();
    expect(
      within(
        small.cid,
        Number.MAX_SAFE_INTEGER,
        source([{ cid: small.cid, bytes: small.bytes }], asked),
      ),
    ).toEqual(unavailable);
    // The root, then its first child, which no source holds.
    expect(asked).toHaveLength(2);
    // Under the protocol's: seven subtrees of 1,024^3 chunks, 7 · 2^50 bytes.
    const big = node(Array.from({ length: 7 }, () => full(3, MAX_LINKS, CHUNK_SIZE)));
    expect(big.size).toBe(7 * 2 ** 50);
    expect(
      readObjectWithin(
        big.cid,
        Number.MAX_SAFE_INTEGER,
        source([{ cid: big.cid, bytes: big.bytes }]),
      ),
    ).toEqual(unavailable);
    expect(readObject(big.cid, big.size, source([{ cid: big.cid, bytes: big.bytes }]))).toEqual(
      unavailable,
    );
    // Shapes are memoised per level, so this is milliseconds, never the
    // claimed tree's billions of nodes.
    expect(performance.now() - start).toBeLessThan(5_000);
  });

  test("refuses a bound that isn't a positive integer", () => {
    const cid = objectCid(Uint8Array.of(1));
    const none = () => [];
    expect(() => readObjectWithin(cid, 0, none)).toThrow(RangeError);
    expect(() => readObjectWithin(cid, 2.5, none)).toThrow(RangeError);
  });
});

describe("reading over a source that waits", () => {
  const objects = fc.uint8Array({ minLength: 1, maxLength: 3000 });

  test("gives what the synchronous read gives, asking in the same order", async () => {
    await fc.assert(
      fc.asyncProperty(objects, fc.boolean(), fc.nat(), async (bytes, drop, which) => {
        const dag = contentDag(bytes);
        const target = hex((dag.blocks[which % dag.blocks.length] as Block).cid);
        const blocks = drop ? dag.blocks.filter((b) => hex(b.cid) !== target) : dag.blocks;
        const syncAsked: string[] = [];
        const asyncAsked: string[] = [];
        const held = source(blocks, asyncAsked);
        const waiting = async (cid: Uint8Array) => {
          await Promise.resolve();
          return held(cid);
        };
        expect(await readObjectAsync(dag.root, bytes.length, waiting)).toEqual(
          readObject(dag.root, bytes.length, source(blocks, syncAsked)),
        );
        expect(asyncAsked).toEqual(syncAsked);
        expect(await readObjectWithinAsync(dag.root, 4000, waiting)).toEqual(
          readObjectWithin(dag.root, 4000, source(blocks)),
        );
      }),
      { numRuns },
    );
  });

  test("rejects rather than throws on bad arguments", async () => {
    const cid = objectCid(Uint8Array.of(1));
    const none = async () => [];
    await expect(readObjectAsync(cid, 0, none)).rejects.toThrow(RangeError);
    await expect(readObjectWithinAsync(cid, 0, none)).rejects.toThrow(RangeError);
  });

  test("a source that throws ends the read with its error", async () => {
    const cid = objectCid(Uint8Array.of(1));
    await expect(
      readObjectAsync(cid, 1, async () => {
        throw new Error("network down");
      }),
    ).rejects.toThrow("network down");
  });
});
