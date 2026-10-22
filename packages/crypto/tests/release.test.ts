import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  DecodeError,
  type DecodedReleaseRecord,
  decodeReleaseRecord,
  encodeReleaseRecord,
  RELEASE_RULES,
  releaseHash,
  releaseRecordRule,
  type ReleaseSite,
  UNPINNED,
} from "../src/index.ts";
import { buildSchema, hex, SPEC_VECTORS, type Vector, type VectorFile } from "./spec-vectors.ts";

// This package's release record (src/release.ts, P2-30 part 3c-2c-2a)
// against docs/spec/vectors/release-record.json, printed by
// scripts/release-record-vectors.py: each vector decodes to the value the
// file's own type descriptors read, re-encodes to its bytes under its release
// hash and breaks exactly the rule it names, where it names it; each rejected
// one is rejected with its code (T-31, T-36, T-41, T-43, T-52).
const NUM_RUNS = Number(process.env["FC_NUM_RUNS"] ?? 100);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

type ReleaseVector = Vector & {
  readonly releaseHash?: string;
  readonly illFormedAt?: Readonly<Record<string, string>>;
};

type ReleaseFile = Omit<VectorFile, "vectors"> & {
  readonly rules: readonly string[];
  readonly vectors: readonly ReleaseVector[];
};

const file = JSON.parse(
  readFileSync(new URL("release-record.json", SPEC_VECTORS), "utf8"),
) as ReleaseFile;

function decodeError(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof DecodeError) return e.code;
    throw e;
  }
  return undefined;
}

// The rule and its place as the vector file writes them: `illFormedAt`'s
// values are decimal strings.
function failureOf(d: DecodedReleaseRecord): { rule?: string; at?: Record<string, string> } {
  const f = releaseRecordRule(d);
  if (f === undefined) return {};
  const { rule, ...at } = f;
  return Object.keys(at).length === 0
    ? { rule }
    : { rule, at: Object.fromEntries(Object.entries(at).map(([k, v]) => [k, String(v)])) };
}

const decoded = file.vectors.filter((v) => "value" in v).map((v) => [v.id, v] as const);
const rejected = file.vectors.filter((v) => "error" in v).map((v) => [v.id, v] as const);

function vector(id: string): DecodedReleaseRecord {
  const v = file.vectors.find((x) => x.id === id);
  if (v === undefined) throw new Error(`missing vector ${id}`);
  return decodeReleaseRecord(hex(v.encoding));
}

describe("release record codec and rules (docs/spec/release.md)", () => {
  test("has the file's rules, in its order", () => {
    expect([...RELEASE_RULES]).toEqual(file.rules);
  });

  const { schema, type } = buildSchema(file as unknown as VectorFile);

  test.each(decoded)(
    "%s decodes to the file's value and back, under its release hash",
    (_id, v) => {
      const bytes = hex(v.encoding);
      const d = decodeReleaseRecord(bytes);
      // The file's own descriptors are an independent reading of the bytes.
      expect(d).toEqual(schema.decode(type(v.type).recordType, bytes, UNPINNED));
      expect(toHex(encodeReleaseRecord(d))).toBe(v.encoding);
      expect(toHex(releaseHash(bytes))).toBe(v.releaseHash);
    },
  );

  test.each(decoded)("%s breaks exactly the rule it names, where it names it", (_id, v) => {
    const got = failureOf(decodeReleaseRecord(hex(v.encoding)));
    expect(got.rule).toBe(v.illFormed);
    expect(got.at).toEqual(v.illFormedAt);
  });

  test.each(rejected)("%s is rejected with its code", (_id, v) => {
    expect(decodeError(() => decodeReleaseRecord(hex(v.encoding)))).toBe(v.error);
  });

  test("refuses a deployment record as another type", () => {
    const deployment = JSON.parse(
      readFileSync(new URL("deployment-record-v2.json", SPEC_VECTORS), "utf8"),
    ) as { readonly vectors: readonly Vector[] };
    const typical = deployment.vectors.find((v) => v.id === "typical");
    if (typical === undefined) throw new Error("missing vector");
    expect(decodeError(() => decodeReleaseRecord(hex(typical.encoding)))).toBe(
      "unknown-record-type",
    );
  });

  // A well-formed record with one site changed, re-judged.
  const typical = vector("typical");
  const withSite = (i: number, change: Partial<ReleaseSite>): DecodedReleaseRecord => {
    const sites = typical.value.sites.slice();
    const s = sites[i];
    if (s === undefined) throw new Error(`no site ${i}`);
    sites[i] = { ...s, ...change };
    return { version: 1, value: { ...typical.value, sites } };
  };
  const ascii = (s: string) => new TextEncoder().encode(s);
  const asFiles = (paths: readonly string[]) =>
    paths.map((path, i) => ({
      path: ascii(path),
      length: 1n,
      sha256: new Uint8Array(32).fill(i),
      media_type: ascii("text/plain"),
    }));

  test("the typical vector has two sites and is well formed", () => {
    expect(typical.value.sites.map((s) => s.kind)).toEqual([1, 2]);
    expect(releaseRecordRule(typical)).toBeUndefined();
  });

  test("finds a path that is a directory of another anywhere in the list", () => {
    // `-` sorts between a path and its directory's entries, so a conflict
    // isn't always between neighbours.
    expect(
      releaseRecordRule(withSite(0, { files: asFiles(["a", "a-b", "a/c", "index.html"]) })),
    ).toEqual({ rule: "path-conflict", site: 0 });
    expect(
      releaseRecordRule(withSite(0, { files: asFiles(["a-b", "a.c", "ab/c", "index.html"]) })),
    ).toBeUndefined();
  });

  test("judges path conflicts as the pair rule does", () => {
    const segment = fc.constantFrom("a", "b", "a-", "a.b", "ab");
    const path = fc.array(segment, { minLength: 1, maxLength: 3 }).map((xs) => xs.join("/"));
    fc.assert(
      fc.property(fc.uniqueArray(path, { maxLength: 8 }), (raw) => {
        const paths = [...new Set([...raw, "index.html"])].sort((a, b) =>
          Buffer.compare(Buffer.from(a), Buffer.from(b)),
        );
        // The spec's statement: some q starts with another p followed by "/".
        const pair = paths.some((p) => paths.some((q) => q.startsWith(`${p}/`)));
        const got = releaseRecordRule(withSite(0, { files: asFiles(paths) }));
        expect(got?.rule === "path-conflict").toBe(pair);
        if (!pair) expect(got).toBeUndefined();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Canonicity: every byte string the decoder accepts re-encodes to itself,
  // and none of a valid record's proper prefixes or extensions decodes.
  const encodings = decoded.map(([, v]) => hex(v.encoding));
  const someEncoding = fc.constantFrom(...encodings);

  test("re-encodes every mutated record it accepts to the same bytes", () => {
    fc.assert(
      fc.property(
        someEncoding,
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), {
          minLength: 1,
          maxLength: 4,
        }),
        (bytes, edits) => {
          const b = bytes.slice();
          for (const [i, x] of edits) b[i % b.length] = x;
          let d: DecodedReleaseRecord;
          try {
            d = decodeReleaseRecord(b);
          } catch (e) {
            if (e instanceof DecodeError) return;
            throw e;
          }
          expect(toHex(encodeReleaseRecord(d))).toBe(toHex(b));
          // The rules judge any decoded record without throwing.
          releaseRecordRule(d);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("rejects every truncation and every extension of a valid record", () => {
    fc.assert(
      fc.property(
        someEncoding,
        fc.nat(),
        fc.uint8Array({ minLength: 1, maxLength: 8 }),
        (bytes, cut, tail) => {
          const at = cut % bytes.length;
          expect(decodeError(() => decodeReleaseRecord(bytes.subarray(0, at)))).toBe("truncated");
          const longer = new Uint8Array(bytes.length + tail.length);
          longer.set(bytes);
          longer.set(tail, bytes.length);
          expect(decodeError(() => decodeReleaseRecord(longer))).toBe("trailing-bytes");
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
