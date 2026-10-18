import fc from "fast-check";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  type ArchiveManifest,
  arweaveId,
  CHUNK_SIZE,
  DecodeError,
  decodeArchiveLocator,
  decodeArchiveManifest,
  encodeArchiveLocator,
  encodeArchiveManifest,
  EncodeError,
  LOCATOR_V1_LENGTH,
  MANIFEST_BOUND,
  MAX_MANIFEST_LINKS,
  MAX_MANIFEST_OBJECTS,
  objectCar,
  objectCid,
  RECORD_TYPES,
  readArchivedObject,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/archive.json comes from an independent Python
// implementation of docs/spec/archive.md (scripts/archive-vectors.py, with its
// own strict decoder, locator reader and CAR reader), and content-addressing
// .json's CARs from Kubo, so no expected value here comes from the code under
// test (T-31, T-24, T-52).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

interface ManifestJson {
  readonly l1ChainId: string;
  readonly anchor: string;
  readonly sequence: string;
  readonly objects: readonly { readonly cid: string; readonly transaction: string }[];
  readonly links: readonly {
    readonly sequence: string;
    readonly cid: string;
    readonly transaction: string;
  }[];
}

type ReadResult =
  | { readonly ok: true; readonly length: number }
  | { readonly ok: false; readonly reason: "inconsistent" }
  | { readonly ok: false; readonly reason: "over-bound"; readonly length: number };

interface Vectors {
  readonly format: string;
  readonly recordType: string;
  readonly version: number;
  readonly maxObjects: number;
  readonly maxLinks: number;
  readonly locatorLength: number;
  readonly manifests: readonly {
    readonly id: string;
    readonly length: number;
    readonly cid: string;
    readonly fields?: ManifestJson;
    readonly encoding?: string;
    readonly recipe?: "full";
    readonly sha256?: string;
  }[];
  readonly decode: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly code: string;
    readonly offset: number;
  }[];
  readonly locators: readonly {
    readonly id: string;
    readonly locator: string;
    readonly result: Readonly<Record<string, string | number>>;
  }[];
  readonly reads: readonly {
    readonly id: string;
    readonly cid: string;
    readonly maxLength: number;
    readonly result: ReadResult;
    readonly data?: string;
    readonly recipe?: { readonly object: "big"; readonly mutation: string };
    readonly sha256?: string;
  }[];
}

const file = JSON.parse(readFileSync(new URL("archive.json", SPEC_VECTORS), "utf8")) as Vectors;

function manifest(j: ManifestJson): ArchiveManifest {
  return {
    l1_chain_id: BigInt(j.l1ChainId),
    anchor: hex(j.anchor),
    sequence: BigInt(j.sequence),
    objects: j.objects.map((o) => ({ cid: hex(o.cid), transaction: hex(o.transaction) })),
    links: j.links.map((l) => ({
      sequence: BigInt(l.sequence),
      cid: hex(l.cid),
      transaction: hex(l.transaction),
    })),
  };
}

const label32 = (label: string) =>
  new Uint8Array(createHash("sha256").update(`archive/${label}`).digest());
const prefixed = (codec: number, digest: Uint8Array) =>
  Uint8Array.from([0x01, codec, 0x12, 0x20, ...digest]);

// archive.json's rules: "full".
function fullManifest(): ArchiveManifest {
  const objects = Array.from({ length: MAX_MANIFEST_OBJECTS }, (_, i) => ({
    cid: prefixed(i % 2 ? 0x70 : 0x55, label32(`object/full-${i}`)),
    transaction: label32(`tx/full-${i}`),
  })).sort((a, b) => Buffer.compare(a.cid, b.cid));
  const links = Array.from({ length: MAX_MANIFEST_LINKS }, (_, s) => ({
    sequence: BigInt(s),
    cid: prefixed(0x55, label32(`manifest/${s}`)),
    transaction: label32(`tx/manifest/${s}`),
  }));
  return {
    l1_chain_id: 11155111n,
    anchor: hex("5fbdb2315678afecb367f032d93f642f64180aa3"),
    sequence: BigInt(MAX_MANIFEST_LINKS),
    objects,
    links,
  };
}

// The object rule of site-directory.json and content-addressing.json.
function labelled(label: string, length: number): Uint8Array {
  if (label.startsWith("zeros")) return new Uint8Array(length);
  const out = new Uint8Array(length);
  for (let i = 0, at = 0; at < length; i++, at += 32) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(i);
    out.set(
      createHash("sha256")
        .update(label)
        .update(counter)
        .digest()
        .subarray(0, length - at),
      at,
    );
  }
  return out;
}

function decodeError(f: () => unknown): { code: string; offset: number } | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof DecodeError) return { code: e.code, offset: e.offset };
    throw e;
  }
  return undefined;
}

describe("archive.json", () => {
  test("format, record type and limits match the code", () => {
    expect(file.format).toBe("abolish-archive-vectors/1");
    expect(Number(file.recordType)).toBe(RECORD_TYPES.archiveManifest);
    expect(file.version).toBe(1);
    expect(file.maxObjects).toBe(MAX_MANIFEST_OBJECTS);
    expect(file.maxLinks).toBe(MAX_MANIFEST_LINKS);
    expect(file.locatorLength).toBe(LOCATOR_V1_LENGTH);
  });

  test.each(file.manifests)("manifest $id encodes, decodes and has its CID", (v) => {
    const m = v.recipe === "full" ? fullManifest() : manifest(v.fields as ManifestJson);
    const encoding = encodeArchiveManifest(m);
    expect(encoding.length).toBe(v.length);
    if (v.encoding !== undefined) expect(toHex(encoding)).toBe(v.encoding);
    else expect(sha256(encoding)).toBe(v.sha256);
    expect(decodeArchiveManifest(encoding, 1)).toEqual(m);
    expect(toHex(objectCid(encoding))).toBe(v.cid);
    // Every manifest is one raw block, so its CID is the raw CID of its encoding.
    expect(encoding.length).toBeLessThanOrEqual(MANIFEST_BOUND);
  });

  test.each(file.decode)("rejects $id with its code at its offset", (v) => {
    expect(decodeError(() => decodeArchiveManifest(hex(v.encoding), 1))).toEqual({
      code: v.code,
      offset: v.offset,
    });
  });

  test.each(file.locators)("locator $id reads as the spec says", (v) => {
    const read = decodeArchiveLocator(hex(v.locator));
    const json =
      read.kind === "manifest"
        ? { ...read, manifest: toHex(read.manifest), transaction: toHex(read.transaction) }
        : read;
    expect(json).toEqual(v.result);
    if (read.kind === "manifest")
      expect(toHex(encodeArchiveLocator(read.manifest, read.transaction))).toBe(v.locator);
  });

  const big = labelled("archive/big", CHUNK_SIZE + 1);

  function recipe(r: NonNullable<Vectors["reads"][number]["recipe"]>): Uint8Array {
    const car = objectCar(big);
    // The CAR is a header then three length-prefixed blocks: a root and two leaves.
    const parts: Uint8Array[] = [];
    let at = 0;
    for (let i = 0; i < 4; i++) {
      let n = 0;
      let next = at;
      for (let scale = 1; ; scale *= 0x80) {
        const x = car[next++] as number;
        n += (x & 0x7f) * scale;
        if (x < 0x80) break;
      }
      parts.push(car.subarray(at, next + n));
      at = next + n;
    }
    const [header, root, leaf1, leaf2] = parts as [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
    if (r.mutation === "none") return car;
    if (r.mutation === "leaves-swapped") return Buffer.concat([header, root, leaf2, leaf1]);
    if (r.mutation === "leaf-missing") return Buffer.concat([header, root, leaf1]);
    throw new Error(`unknown mutation ${r.mutation}`);
  }

  test.each(file.reads)("read $id", (v) => {
    let data: Uint8Array;
    if (v.data !== undefined) data = hex(v.data);
    else {
      data = recipe(v.recipe as NonNullable<typeof v.recipe>);
      expect(sha256(data)).toBe(v.sha256);
    }
    const read = readArchivedObject(data, hex(v.cid), v.maxLength);
    if (v.result.ok) {
      expect(read.ok).toBe(true);
      if (read.ok) {
        expect(read.bytes.length).toBe(v.result.length);
        expect(toHex(objectCid(read.bytes))).toBe(v.cid);
      }
    } else expect(read).toEqual(v.result);
  });
});

describe("content-addressing.json's CARs read as archived objects", () => {
  interface CaVector {
    readonly id: string;
    readonly profile: string;
    readonly label: string;
    readonly length: string;
    readonly cidHex: string;
    readonly car?: string;
    readonly carSha256: string;
  }
  const ca = JSON.parse(readFileSync(new URL("content-addressing.json", SPEC_VECTORS), "utf8")) as {
    readonly vectors: readonly CaVector[];
  };
  const protocol = ca.vectors.filter((v) => v.profile === "protocol");

  test.each(protocol)("$id: Kubo's CAR is the object, and over-bound one byte short", (v) => {
    const length = Number(v.length);
    const object = labelled(v.label, length);
    const car = v.car === undefined ? objectCar(object) : hex(v.car);
    expect(sha256(car)).toBe(v.carSha256);
    const read = readArchivedObject(car, hex(v.cidHex), length);
    expect(read.ok && Buffer.from(read.bytes).equals(object)).toBe(true);
    if (length > 1)
      expect(readArchivedObject(car, hex(v.cidHex), length - 1)).toEqual({
        ok: false,
        reason: "over-bound",
        length,
      });
  });
});

const bytes = (n: number) => fc.uint8Array({ minLength: n, maxLength: n });
const cidArb = fc
  .tuple(fc.constantFrom(0x55, 0x70), bytes(32))
  .map(([codec, d]) => prefixed(codec, d));
const rawCid = bytes(32).map((d) => prefixed(0x55, d));

const manifestArb: fc.Arbitrary<ArchiveManifest> = fc
  .record({
    l1_chain_id: fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
    anchor: bytes(20),
    sequence: fc.bigInt({ min: 1n, max: (1n << 64n) - 1n }),
    objects: fc.uniqueArray(fc.record({ cid: cidArb, transaction: bytes(32) }), {
      maxLength: 8,
      selector: (o) => toHex(o.cid),
    }),
    linkSeeds: fc.uniqueArray(fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), { maxLength: 6 }),
    linkCids: fc.array(fc.record({ cid: rawCid, transaction: bytes(32) }), {
      minLength: 6,
      maxLength: 6,
    }),
  })
  .map(({ linkSeeds, linkCids, ...m }) => {
    const links = [...new Set(linkSeeds.map((s) => s % m.sequence))]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((sequence, i) => ({ sequence, ...(linkCids[i] as (typeof linkCids)[number]) }));
    const objects = [...m.objects].sort((a, b) => Buffer.compare(a.cid, b.cid));
    return { ...m, objects, links };
  })
  .filter((m) => m.objects.length + m.links.length > 0);

describe("archive manifest properties", () => {
  test("decode(encode(m)) = m and encode(decode(b)) = b", () => {
    fc.assert(
      fc.property(manifestArb, (m) => {
        const b = encodeArchiveManifest(m);
        const back = decodeArchiveManifest(b, 1);
        expect(back).toEqual(m);
        expect(encodeArchiveManifest(back)).toEqual(b);
      }),
      { numRuns },
    );
  });

  test("any changed byte either fails to decode or re-encodes to exactly itself", () => {
    fc.assert(
      fc.property(manifestArb, fc.nat(), fc.integer({ min: 1, max: 255 }), (m, i, x) => {
        const b = encodeArchiveManifest(m);
        const at = i % b.length;
        const changed = Uint8Array.from(b);
        changed[at] = (changed[at] as number) ^ x;
        let back: ArchiveManifest | undefined;
        try {
          back = decodeArchiveManifest(changed, 1);
        } catch (e) {
          expect(e).toBeInstanceOf(DecodeError);
          return;
        }
        expect(encodeArchiveManifest(back)).toEqual(changed);
      }),
      { numRuns },
    );
  });

  test("the encoder refuses what the decoder would reject", () => {
    const m = manifest(file.manifests.find((v) => v.id === "period")?.fields as ManifestJson);
    const refuse = (value: ArchiveManifest) =>
      expect(() => encodeArchiveManifest(value)).toThrow(EncodeError);
    refuse({ ...m, objects: [], links: [] });
    refuse({ ...m, objects: [...m.objects].reverse() });
    refuse({ ...m, objects: [m.objects[0], ...m.objects] as ArchiveManifest["objects"] });
    refuse({
      ...m,
      objects: [
        { ...(m.objects[0] as ArchiveManifest["objects"][number]), cid: new Uint8Array(36) },
      ],
    });
    refuse({ ...m, links: [...m.links].reverse() });
    refuse({
      ...m,
      links: [{ ...(m.links[0] as ArchiveManifest["links"][number]), sequence: m.sequence }],
    });
    refuse({
      ...m,
      links: [
        {
          ...(m.links[0] as ArchiveManifest["links"][number]),
          cid: prefixed(0x70, new Uint8Array(32)),
        },
      ],
    });
    expect(() =>
      encodeArchiveLocator(prefixed(0x70, new Uint8Array(32)), new Uint8Array(32)),
    ).toThrow(EncodeError);
  });

  test("an object's CAR reads back from itself under any bound at or over its length", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 2048 }), fc.nat(64), (object, extra) => {
        const read = readArchivedObject(
          objectCar(object),
          objectCid(object),
          object.length + extra,
        );
        expect(read.ok && Buffer.from(read.bytes).equals(object)).toBe(true);
      }),
      { numRuns },
    );
  });

  test("a CAR with any byte changed is never read as the object", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 512 }),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (object, i, x) => {
          const car = Uint8Array.from(objectCar(object));
          const at = i % car.length;
          car[at] = (car[at] as number) ^ x;
          const read = readArchivedObject(car, objectCid(object), CHUNK_SIZE);
          expect(read.ok).toBe(false);
        },
      ),
      { numRuns },
    );
  });
});

describe("transaction IDs", () => {
  test("arweaveId is 43 characters of unpadded base64url", () => {
    expect(arweaveId(new Uint8Array(32))).toBe("A".repeat(43));
    expect(arweaveId(new Uint8Array(32).fill(0xff))).toBe(`${"_".repeat(42)}8`);
    fc.assert(
      fc.property(bytes(32), (id) => {
        expect(arweaveId(id)).toBe(Buffer.from(id).toString("base64url"));
      }),
      { numRuns },
    );
    expect(() => arweaveId(new Uint8Array(31))).toThrow(RangeError);
  });
});
