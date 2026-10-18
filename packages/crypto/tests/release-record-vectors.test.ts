import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { DecodeError, ds, H, UNPINNED } from "../src/index.ts";
import { buildSchema, hex, SPEC_VECTORS, type Vector, type VectorFile } from "./spec-vectors.ts";

// docs/spec/vectors/release-record.json, printed by
// scripts/release-record-vectors.py (P4-4 part 2b-1), and site-directory.json,
// printed by scripts/site-directory-vectors.mjs from Kubo and
// ipfs-unixfs-importer. Until the release record's codec and rules are in
// this package (part 2c), the file's own type descriptors decode each vector,
// so this checks the file against itself and the spec's framing: every
// vector round-trips, its release hash is the tagged SHA-256 of its encoding,
// and every well-formed record's sites are the directories Kubo built (T-31,
// T-36, T-41).
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

type ReleaseVector = Vector & {
  readonly releaseHash?: string;
  readonly sites?: readonly string[];
  readonly illFormedAt?: { readonly site: string };
};

type ReleaseFile = Omit<VectorFile, "vectors"> & {
  readonly tag: string;
  readonly maxReleaseFile: string;
  readonly rules: readonly string[];
  readonly vectors: readonly ReleaseVector[];
};

interface SiteVector {
  readonly id: string;
  readonly files: readonly {
    readonly path: string;
    readonly label: string;
    readonly length: number;
  }[];
  readonly cidHex: string;
}

const read = <T>(name: string) =>
  JSON.parse(readFileSync(new URL(name, SPEC_VECTORS), "utf8")) as T;

const file = read<ReleaseFile>("release-record.json");
const sites = read<{ format: string; vectors: readonly SiteVector[] }>("site-directory.json");

// site-directory.json's object rule: SHA-256(label ‖ u32be(i)), i = 0, 1, …,
// concatenated and cut to `length`.
function object(label: string, length: number): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0, at = 0; at < length; i++, at += 32) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(i);
    parts.push(createHash("sha256").update(label).update(counter).digest());
  }
  return Buffer.concat(parts).subarray(0, length);
}

function decodeError(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof DecodeError) return e.code;
    throw e;
  }
  return undefined;
}

interface DecodedSite {
  readonly files: readonly {
    readonly path: Uint8Array;
    readonly length: bigint;
    readonly sha256: Uint8Array;
  }[];
  readonly directory: Uint8Array;
}

describe("release record (docs/spec/release.md)", () => {
  const { schema, type } = buildSchema(file);
  const release = type(file.vectors[0]?.type ?? { kind: "ref", name: "release" });

  test("has its format, tag and cap, and exactly one of value or error on each vector", () => {
    expect(file.format).toBe("abolish-release-record-vectors/1");
    expect(sites.format).toBe("abolish-site-directory-vectors/1");
    expect(file.tag).toBe("abolish/v1/release");
    expect(file.maxReleaseFile).toBe(String(2 ** 28));
    expect(new Set(file.vectors.map((v) => v.id)).size).toBe(file.vectors.length);
    for (const v of file.vectors) {
      expect("value" in v !== "error" in v, v.id).toBe(true);
      expect("value" in v === "releaseHash" in v, v.id).toBe(true);
      // A well-formed record names its sites; an ill-formed one its rule.
      if ("value" in v) expect("sites" in v !== "illFormed" in v, v.id).toBe(true);
    }
  });

  test("lists the spec's well-formedness rules, in its order, each with an ill-formed vector", () => {
    // The codes of docs/spec/release.md's Well-formedness table, top to
    // bottom: the order the first broken rule is found in. A rule the
    // generator checks but the table lacks, or one out of place, fails here.
    const page = readFileSync(new URL("../release.md", SPEC_VECTORS), "utf8");
    const section = page.slice(
      page.indexOf("\n## Well-formedness\n"),
      page.indexOf("\n## Release hash\n"),
    );
    const codes = [...section.matchAll(/^\| `([a-z-]+)` +\|/gm)].map((m) => m[1]);
    expect(codes).toEqual(file.rules);
    expect(
      new Set(file.vectors.flatMap((v) => (v.illFormed === undefined ? [] : [v.illFormed]))),
    ).toEqual(new Set(file.rules));
  });

  const decoded = file.vectors.filter((v) => "value" in v).map((v) => [v.id, v] as const);
  const rejected = file.vectors.filter((v) => "error" in v).map((v) => [v.id, v] as const);

  test.each(decoded)("%s decodes to its value and back, under its release hash", (_id, v) => {
    const bytes = hex(v.encoding);
    const expected = release.built.fromJson(v.value);
    expect(schema.decode(release.recordType, bytes, UNPINNED)).toEqual({
      version: 1,
      value: expected,
    });
    expect(toHex(schema.encode(release.recordType, 1, expected))).toBe(v.encoding);
    expect(toHex(H(ds("abolish/v1/release", bytes)))).toBe(v.releaseHash);
  });

  test.each(rejected)("%s is rejected", (_id, v) => {
    expect(decodeError(() => schema.decode(release.recordType, hex(v.encoding), UNPINNED))).toBe(
      v.error,
    );
  });

  test.each(decoded.filter(([, v]) => v.sites !== undefined))(
    "%s lists the files and directory of the sites Kubo built",
    (_id, v) => {
      const value = schema.decode(release.recordType, hex(v.encoding), UNPINNED).value as {
        readonly sites: readonly DecodedSite[];
      };
      expect(value.sites.length).toBe(v.sites?.length);
      value.sites.forEach((site, i) => {
        const built = sites.vectors.find((s) => s.id === v.sites?.[i]);
        if (built === undefined) throw new Error(`no site ${v.sites?.[i]}`);
        expect(toHex(site.directory)).toBe(built.cidHex);
        const files = [...built.files].sort((a, b) =>
          Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
        );
        expect(site.files.map((f) => Buffer.from(f.path).toString("ascii"))).toEqual(
          files.map((f) => f.path),
        );
        site.files.forEach((f, j) => {
          const want = files[j];
          if (want === undefined) throw new Error("unreachable: lengths compared above");
          expect(f.length).toBe(BigInt(want.length));
          expect(toHex(f.sha256)).toBe(
            createHash("sha256").update(object(want.label, want.length)).digest("hex"),
          );
        });
      });
    },
  );
});
