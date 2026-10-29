import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  DecodeError,
  decodeReleaseRecord,
  decodeDeploymentRecord,
  type DeploymentRecordV3,
  ds,
  H,
  UNPINNED,
} from "../src/index.ts";
import { buildSchema, hex, SPEC_VECTORS, type Vector, type VectorFile } from "./spec-vectors.ts";

// docs/spec/vectors/deployment-record-v3.json, printed by
// scripts/deployment-record-v3-vectors.py (P2-8 part
// 3c-1b-2b-2b-2d-2b-2e-2b), checked apart from this package's codec: the
// file's own type descriptors decode each vector, so every vector
// round-trips under its deployment hash, a reader of every version still
// reads versions 1 and 2, the file's layout and rules are the spec's, and
// its pairs against a release break `deployment-hash` and `endpoint-site`
// as they say. deployment.test.ts judges the same vectors and successions
// with this package's codec and rules (T-43, T-31).
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

type DeploymentVector = Vector & {
  readonly deploymentHash?: string;
  readonly illFormedAt?: Readonly<Record<string, string>>;
};

interface Pair {
  readonly id: string;
  readonly release: string;
  readonly deployment: string;
  readonly inconsistent?: string;
}

type DeploymentFile = Omit<VectorFile, "vectors"> & {
  readonly tag: string;
  readonly largestEncoding: number;
  readonly rules: readonly string[];
  readonly pairRules: readonly string[];
  readonly vectors: readonly DeploymentVector[];
  readonly pairs: readonly Pair[];
  readonly acrossRules: readonly string[];
  readonly successions: readonly {
    readonly earlier: string;
    readonly later: string;
    readonly across?: string;
  }[];
};

const read = <T>(name: string) =>
  JSON.parse(readFileSync(new URL(name, SPEC_VECTORS), "utf8")) as T;
const file = read<DeploymentFile>("deployment-record-v3.json");
const v1File = read<{ readonly pairRules: readonly string[] }>("deployment-record.json");
const v2File = read<{ readonly rules: readonly string[] }>("deployment-record-v2.json");
const page = readFileSync(new URL("../deployment.md", SPEC_VECTORS), "utf8");

// The text of a `## ` section of docs/spec/deployment.md.
function section(name: string): string {
  const from = page.indexOf(`\n## ${name}\n`);
  if (from < 0) throw new Error(`no section ${name}`);
  const to = page.indexOf("\n## ", from + 1);
  return page.slice(from, to < 0 ? undefined : to);
}

// A section's table codes, top to bottom.
const codes = (name: string) =>
  [...section(name).matchAll(/^\| `([a-z0-9-]+)` +\|/gm)].map((m) => m[1] ?? "");

function decodeError(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof DecodeError) return e.code;
    throw e;
  }
  return undefined;
}

describe("deployment record version 3 (docs/spec/deployment.md)", () => {
  const { schema, type } = buildSchema(file as unknown as VectorFile);
  const v3 = type({ kind: "ref", name: "deployment_v3" });
  const v2 = type({ kind: "ref", name: "deployment_v2" });
  const decode = (encoding: string) =>
    schema.decode(v3.recordType, hex(encoding), UNPINNED) as {
      version: number;
      value: DeploymentRecordV3;
    };
  const ofType = (v: Vector) => (v.type.kind === "ref" ? v.type.name : "");

  const decoded = file.vectors.filter((v) => "value" in v).map((v) => [v.id, v] as const);
  const rejected = file.vectors.filter((v) => "error" in v).map((v) => [v.id, v] as const);
  const version3 = decoded.filter(([, v]) => ofType(v) === "deployment_v3");
  const typical = file.vectors.find((v) => v.id === "typical");
  if (typical === undefined) throw new Error("no typical vector");

  test("has its format, tag and bounds, and exactly one of value or error on each vector", () => {
    expect(file.format).toBe("abolish-deployment-record-vectors/3");
    expect(file.tag).toBe("abolish/v1/deployment");
    expect(new Set(file.vectors.map((v) => v.id)).size).toBe(file.vectors.length);
    expect(new Set(file.pairs.map((p) => p.id)).size).toBe(file.pairs.length);
    for (const v of file.vectors) expect("value" in v !== "error" in v, v.id).toBe(true);
    expect(page).toContain(
      `At its maximums a version-3 record is ${file.largestEncoding.toLocaleString("en")} bytes.`,
    );
    expect(Math.max(...decoded.map(([, v]) => hex(v.encoding).length))).toBe(file.largestEncoding);
  });

  test("has the spec's version-3 layout: version 2's fields, then the seat relays", () => {
    type Named = Readonly<
      Record<string, { readonly fields?: readonly { readonly name: string }[] }>
    >;
    const types = file.types as unknown as Named;
    const names = (t: string) => (types[t]?.fields ?? []).map((f) => f.name);
    expect(names("deployment_v3")).toEqual([...names("deployment_v2"), "seat_relays"]);
    const rows = [...section("Record (version 3)").matchAll(/^\| `([a-z0-9_]+)` +\| `([^`]+)`/gm)];
    expect(rows.map((m) => [m[1], m[2]])).toEqual([
      ["seat_relays", "list<seat_relay, 128>"],
      ["key", "bytes[33]"],
      ["relays", "list<relay, 4>"],
      ["origin", "bytes<267>"],
      ["path", "bytes<128>"],
    ]);
    expect(names("seat_relay")).toEqual(["key", "relays"]);
    expect(names("relay")).toEqual(["origin", "path"]);
  });

  test("lists version 2's rules, then the spec's version-3 rules, each with a vector that breaks it", () => {
    expect(file.rules).toEqual([...v2File.rules, ...codes("Well-formedness (version 3)")]);
    expect(file.pairRules).toEqual(v1File.pairRules);
    expect(
      new Set(file.vectors.flatMap((v) => (v.illFormed === undefined ? [] : [v.illFormed]))),
    ).toEqual(new Set(file.rules));
  });

  test.each(decoded)("%s decodes to its value and back, under its deployment hash", (_id, v) => {
    const bytes = hex(v.encoding);
    const t = type(v.type);
    const version = { deployment: 1, deployment_v2: 2, deployment_v3: 3 }[ofType(v)];
    if (version === undefined) throw new Error(`no version for ${ofType(v)}`);
    const expected = t.built.fromJson(v.value);
    expect(schema.decode(t.recordType, bytes, UNPINNED)).toEqual({ version, value: expected });
    expect(toHex(schema.encode(t.recordType, version, expected))).toBe(v.encoding);
    expect(toHex(H(ds("abolish/v1/deployment", bytes)))).toBe(v.deploymentHash);
  });

  test.each(rejected)("%s is rejected", (_id, v) => {
    expect(decodeError(() => decode(v.encoding))).toBe(v.error);
  });

  // The pairs' rules that version 3 changes: the release names the record's
  // own hash unless the pair says otherwise, and a relay at a site's origin
  // is `endpoint-site` (Against its release).
  test.each(file.pairs.map((p) => [p.id, p] as const))("%s: against its release", (_id, p) => {
    const release = decodeReleaseRecord(hex(p.release)).value;
    const record = decode(p.deployment);
    expect(record.version).toBe(3);
    const hash = H(ds("abolish/v1/deployment", hex(p.deployment)));
    expect(toHex(release.deployment_hash) !== toHex(hash)).toBe(
      p.inconsistent === "deployment-hash",
    );
    if (p.inconsistent === "deployment-hash") return;
    const sites = new Set(release.sites.flatMap((s) => s.origins.map(toHex)));
    const relays = record.value.seat_relays.flatMap((e) => e.relays.map((r) => toHex(r.origin)));
    expect(relays.some((o) => sites.has(o))).toBe(p.inconsistent === "endpoint-site");
  });

  test("version 2's layout is a prefix of version 3's", () => {
    const { seat_relays: _relays, ...fields } = decode(typical.encoding).value;
    const asV2 = schema.encode(v2.recordType, 2, fields);
    expect(toHex(hex(typical.encoding).subarray(3, asV2.length))).toBe(toHex(asV2.subarray(3)));
  });

  test("is unknown to a reader of versions 1 and 2, as the version-2 file's version-three vector is", () => {
    for (const [, v] of version3)
      expect(decodeError(() => decodeDeploymentRecord(hex(v.encoding), 2))).toBe("unknown-version");
    expect(decodeError(() => decodeDeploymentRecord(hex(typical.encoding), 1))).toBe(
      "unknown-version",
    );
  });

  test("lists the successions' rules, each broken by one with a version-3 record on either side", () => {
    expect(file.acrossRules).toEqual(codes("Across releases"));
    const versionOf = (e: string) => hex(e)[2];
    for (const rule of file.acrossRules) {
      const breaking = file.successions.filter((s) => s.across === rule);
      for (const [a, b] of [
        [3, 3],
        [2, 3],
        [3, 2],
      ])
        expect(
          breaking.some((s) => versionOf(s.earlier) === a && versionOf(s.later) === b),
          `${rule} ${a}-${b}`,
        ).toBe(true);
    }
  });
});
