import { readFileSync } from "node:fs";
import { contentDag, objectCar, readObjectAsync, readObjectWithinAsync } from "@abolishus/crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { BundleError, readBlockStore } from "../src/index.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const CHUNK = 1 << 20;

// docs/spec/vectors/content-addressing.json: CARs from Kubo's `dag export`
// (never from the code under test), whole where they are small.
const vectors = JSON.parse(
  readFileSync(
    new URL("../../../docs/spec/vectors/content-addressing.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly vectors: readonly {
    readonly id: string;
    readonly profile: string;
    readonly label: string;
    readonly length: string;
    readonly cidHex: string;
    readonly car?: string;
  }[];
};

// The vector file's object rule: SHA-256(label ‖ u32be(i)) concatenated, or zeros.
function object(label: string, length: number): Uint8Array {
  if (label.startsWith("zeros")) return new Uint8Array(length);
  const parts: Uint8Array[] = [];
  for (let i = 0; 32 * i < length; i++) {
    const n = new Uint8Array(4);
    new DataView(n.buffer).setUint32(0, i);
    parts.push(sha256(concatBytes(new TextEncoder().encode(label), n)));
  }
  return concatBytes(...parts).slice(0, length);
}

function varint(n: number): Uint8Array {
  const out: number[] = [];
  do {
    out.push((n & 0x7f) | (n >= 0x80 ? 0x80 : 0));
    n = Math.floor(n / 0x80);
  } while (n > 0);
  return Uint8Array.from(out);
}

// A CARv1 header with one root, written here from the CAR and dag-cbor specs.
function header(root: Uint8Array): Uint8Array {
  const ascii = (s: string) => new TextEncoder().encode(s);
  const h = concatBytes(
    Uint8Array.of(0xa2, 0x65),
    ascii("roots"),
    Uint8Array.of(0x81, 0xd8, 0x2a, 0x58, root.length + 1, 0x00),
    root,
    Uint8Array.of(0x67),
    ascii("version"),
    Uint8Array.of(0x01),
  );
  return concatBytes(varint(h.length), h);
}

const section = (cid: Uint8Array, bytes: Uint8Array) =>
  concatBytes(varint(cid.length + bytes.length), cid, bytes);

function car(blocks: readonly { cid: Uint8Array; bytes: Uint8Array }[]): Uint8Array {
  const root = blocks[0]?.cid ?? new Uint8Array(36);
  return concatBytes(header(root), ...blocks.map((b) => section(b.cid, b.bytes)));
}

describe("a block store from Kubo's CARs (content-addressing.json)", () => {
  const whole = vectors.vectors.filter((v) => v.car !== undefined);

  test("the file holds whole CARs to read", () => {
    expect(whole.length).toBeGreaterThan(3);
  });

  for (const v of whole)
    test(`${v.id}: every section is read, and each block is the one its CID names`, async () => {
      const bytes = hexToBytes(v.car as string);
      const store = readBlockStore(bytes);
      expect(store.unreadableBytes).toBe(0);
      expect(store.blocks).toBeGreaterThan(0);
      const root = hexToBytes(v.cidHex);
      const [served] = await store.source(root, CHUNK);
      expect(bytesToHex(sha256(served as Uint8Array))).toBe(bytesToHex(root.subarray(4)));
      // Under the protocol's parameters the object reads back whole.
      if (v.profile === "protocol")
        expect(await readObjectAsync(root, Number(v.length), store.source)).toEqual({
          ok: true,
          bytes: object(v.label, Number(v.length)),
        });
    });
});

describe("a block store", () => {
  test("serves every block of a DAG, and the object reads back by its CID", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 2 * CHUNK + 7 }), async (length) => {
        const bytes = object(`store ${length}`, length);
        const store = readBlockStore(objectCar(bytes));
        expect(store).toMatchObject({
          blocks: contentDag(bytes).blocks.length,
          unreadableBytes: 0,
        });
        expect(await readObjectWithinAsync(contentDag(bytes).root, length, store.source)).toEqual({
          ok: true,
          bytes,
        });
      }),
      { numRuns: Math.min(numRuns, 10) },
    );
  }, 120_000);

  test("keeps the blocks before a cut, and counts the bytes from it", async () => {
    const a = contentDag(object("a", 100));
    const b = contentDag(object("b", 200));
    const blocks = [...a.blocks, ...b.blocks];
    const full = car(blocks);
    const last = section(b.root, b.blocks[0]?.bytes as Uint8Array).length;
    fc.assert(
      fc.property(fc.integer({ min: 1, max: last - 1 }), (cut) => {
        const store = readBlockStore(full.slice(0, full.length - cut));
        expect(store.blocks).toBe(1);
        expect(store.unreadableBytes).toBe(last - cut);
      }),
      { numRuns },
    );
    const store = readBlockStore(full.slice(0, full.length - 1));
    expect(await store.source(a.root, CHUNK)).toHaveLength(1);
    expect(await store.source(b.root, CHUNK)).toEqual([]);
  });

  test("stops at a section whose length isn't minimal or overruns, or that starts with no CID", () => {
    const d = contentDag(object("x", 10));
    const good = section(d.root, d.blocks[0]?.bytes as Uint8Array);
    const len = d.root.length + 10;
    const bad = [
      // The section length with a redundant continuation byte.
      concatBytes(Uint8Array.of(len | 0x80, 0x00), d.root, d.blocks[0]?.bytes as Uint8Array),
      // A CIDv2.
      concatBytes(varint(len), Uint8Array.of(0x02), d.root.subarray(1), new Uint8Array(10)),
      // A digest longer than the section.
      concatBytes(varint(5), Uint8Array.of(0x01, 0x55, 0x12, 0x20, 0x00)),
    ];
    for (const b of bad) {
      const store = readBlockStore(concatBytes(header(d.root), good, b, good));
      expect(store).toMatchObject({ blocks: 1, unreadableBytes: b.length + good.length });
    }
    // A length past the end of the file.
    const overrun = concatBytes(varint(len + 1), d.root, d.blocks[0]?.bytes as Uint8Array);
    expect(readBlockStore(concatBytes(header(d.root), good, overrun))).toMatchObject({
      blocks: 1,
      unreadableBytes: overrun.length,
    });
  });

  test("serves only the first block that hashes to its CID, once, and none over the limit", async () => {
    const block = object("r", 10);
    const cid = contentDag(block).root;
    const store = readBlockStore(
      car([
        { cid, bytes: Uint8Array.of(1) },
        { cid, bytes: block },
        { cid, bytes: Uint8Array.of(3) },
        { cid, bytes: block },
      ]),
    );
    expect(store.blocks).toBe(4);
    expect(await store.source(cid, CHUNK)).toEqual([block]);
    expect(await store.source(cid, 9)).toEqual([]);
  });

  test("serves at most one answer per CID however many bogus sections precede it (T-52)", async () => {
    const block = object("amp", 10);
    const cid = contentDag(block).root;
    const bogus = Array.from({ length: 2000 }, (_, i) => ({ cid, bytes: Uint8Array.of(i & 0xff) }));
    const store = readBlockStore(car([...bogus, { cid, bytes: block }]));
    expect(store.blocks).toBe(2001);
    expect(await store.source(cid, CHUNK)).toEqual([block]);
    expect(await store.source(contentDag(object("other", 10)).root, CHUNK)).toEqual([]);
  });

  test("keeps no block a read can't use: another CID form, a wrong hash, over a chunk", async () => {
    const block = object("forms", 10);
    const cid = contentDag(block).root;
    const v0 = concatBytes(Uint8Array.of(0x12, 0x20), cid.subarray(4));
    // dag-cbor over the same digest: not a codec of the layout.
    const cbor = concatBytes(Uint8Array.of(0x01, 0x71), cid.subarray(2));
    const big = new Uint8Array(CHUNK + 1);
    const bigCid = concatBytes(Uint8Array.of(0x01, 0x55, 0x12, 0x20), sha256(big));
    const store = readBlockStore(
      car([
        { cid: v0, bytes: block },
        { cid: cbor, bytes: block },
        { cid: bigCid, bytes: big },
      ]),
    );
    expect(store).toMatchObject({ blocks: 3, unreadableBytes: 0 });
    for (const c of [v0, cbor, cid]) expect(await store.source(c, CHUNK)).toEqual([]);
    expect(await store.source(bigCid, 2 * CHUNK)).toEqual([]);
  });

  test("stops at a CID whose varints aren't minimal", () => {
    const block = object("v", 10);
    const cid = contentDag(block).root;
    const good = section(cid, block);
    // The codec 0x55 written in two bytes.
    const padded = concatBytes(Uint8Array.of(0x01, 0xd5, 0x00), cid.subarray(2));
    const bad = section(padded, block);
    expect(readBlockStore(concatBytes(header(cid), good, bad, good))).toMatchObject({
      blocks: 1,
      unreadableBytes: bad.length + good.length,
    });
  });

  test("rejects a file that doesn't start with a CARv1 header, a CARv2 included", () => {
    const d = contentDag(object("h", 10));
    const body = section(d.root, d.blocks[0]?.bytes as Uint8Array);
    // CARv2's pragma: {version: 2} in dag-cbor.
    const v2 = Uint8Array.of(0x0a, 0xa1, 0x67, ...new TextEncoder().encode("version"), 0x02);
    const h = header(d.root);
    for (const bytes of [
      new Uint8Array(),
      Uint8Array.of(0x00),
      concatBytes(v2, body),
      // The header's length written in two bytes.
      concatBytes(Uint8Array.of((h[0] as number) | 0x80, 0x00), h.subarray(1), body),
      // A header whose length runs past the file.
      h.subarray(0, h.length - 1),
      // A version other than 1 at the header's end.
      concatBytes(h.subarray(0, h.length - 1), Uint8Array.of(0x02), body),
    ])
      expect(() => readBlockStore(bytes)).toThrow(BundleError);
  });
});
