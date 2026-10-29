import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  DecodeError,
  decodeReleaseRecord,
  type DeploymentRecordV2,
  deploymentRecordRule,
  ds,
  H,
  UNPINNED,
} from "../src/index.ts";
import { isOrigin } from "../src/release.ts";
import { buildSchema, hex, SPEC_VECTORS, type Vector, type VectorFile } from "./spec-vectors.ts";

// docs/spec/vectors/deployment-record-v3.json, printed by
// scripts/deployment-record-v3-vectors.py (P2-8 part
// 3c-1b-2b-2b-2d-2b-2e-2b). As for versions 1 and 2, the file's own type
// descriptors decode each vector, so the file is checked apart from this
// package's codec, which doesn't read version 3 yet (part 2e-3): every
// vector round-trips under its deployment hash, a reader of every version
// still reads versions 1 and 2, and the file's rules are the spec's. What
// this package already has is checked against it: each record's version-2
// fields break exactly the earlier rule the vector names under this
// package's rules, and version 3's own rules, restated over the decoded
// relays with this package's origin grammar, give each vector its code and
// entry (T-43, T-31).
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
};

interface Relay {
  readonly origin: Uint8Array;
  readonly path: Uint8Array;
}

interface SeatRelay {
  readonly key: Uint8Array;
  readonly relays: readonly Relay[];
}

type DecodedV3 = DeploymentRecordV2 & { readonly seat_relays: readonly SeatRelay[] };

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

const text = (b: Uint8Array) => Buffer.from(b).toString("latin1");
const compare = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b);
const ascending = (xs: readonly Uint8Array[]) =>
  xs.every((x, i) => i === 0 || compare(xs[i - 1] as Uint8Array, x) < 0);

// release.md's path grammar (Well-formedness, `path`), or empty for the root.
const SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;
function isRelayPath(p: Uint8Array): boolean {
  if (p.length === 0) return true;
  const segments = text(p).split("/");
  return segments.length <= 16 && segments.every((s) => SEGMENT.test(s) && s !== "." && s !== "..");
}

function hostOf(origin: Uint8Array): string {
  return (text(origin).slice("https://".length).split(":")[0] as string) ?? "";
}

// Version 3's rules (Well-formedness (version 3)), in the spec's order, over
// a record that breaks none of the earlier versions'.
function v3Rule(d: DecodedV3): { rule: string; at?: number } | undefined {
  const entries = d.seat_relays;
  if (entries.length === 0) return { rule: "seat-relays-empty" };
  const seats = new Set(d.panels.flatMap((p) => p.seats.map((s) => toHex(s.key))));
  for (const [i, e] of entries.entries()) {
    if (!seats.has(toHex(e.key))) return { rule: "relay-seat", at: i };
    if (e.relays.length === 0) return { rule: "relays-empty", at: i };
    for (const r of e.relays) {
      if (!isOrigin(r.origin)) return { rule: "relay-origin", at: i };
      if (!isRelayPath(r.path)) return { rule: "relay-path", at: i };
    }
    if (!ascending(e.relays.map((r) => r.origin))) return { rule: "relay-order", at: i };
  }
  if (!ascending(entries.map((e) => e.key))) return { rule: "seat-relay-order" };
  const relays = entries.flatMap((e) => e.relays.map((r) => r.origin));
  const endpoints = new Set([...d.api, ...d.l2_rpc, ...d.l1_rpc].map(toHex));
  if (relays.some((o) => endpoints.has(toHex(o)))) return { rule: "relay-endpoint" };
  const backup = text(d.backup_rp_id);
  if (relays.map(hostOf).some((h) => h === backup || h.endsWith(`.${backup}`)))
    return { rule: "relay-rp" };
  return undefined;
}

describe("deployment record version 3 (docs/spec/deployment.md)", () => {
  const { schema, type } = buildSchema(file as unknown as VectorFile);
  const v3 = type({ kind: "ref", name: "deployment_v3" });
  const v2 = type({ kind: "ref", name: "deployment_v2" });
  const decode = (encoding: string) =>
    schema.decode(v3.recordType, hex(encoding), UNPINNED) as { version: number; value: DecodedV3 };
  const ofType = (v: Vector) => (v.type.kind === "ref" ? v.type.name : "");

  const decoded = file.vectors.filter((v) => "value" in v).map((v) => [v.id, v] as const);
  const rejected = file.vectors.filter((v) => "error" in v).map((v) => [v.id, v] as const);
  const version3 = decoded.filter(([, v]) => ofType(v) === "deployment_v3");

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

  // The version-2 fields of each version-3 record, judged by this package's
  // rules of versions 1 and 2: a vector naming an earlier rule breaks it
  // there, and every other vector breaks none.
  const v3Rules = new Set(codes("Well-formedness (version 3)"));
  test.each(version3)(
    "%s breaks the earlier rule it names under this package's rules",
    (_id, v) => {
      const { seat_relays: _relays, ...fields } = decode(v.encoding).value;
      const earlier =
        v.illFormed !== undefined && !v3Rules.has(v.illFormed) ? v.illFormed : undefined;
      expect(deploymentRecordRule({ version: 2, value: fields })?.rule).toBe(earlier);
      // The earlier vectors' places are this package's too.
      if (earlier !== undefined)
        expect(deploymentRecordRule({ version: 2, value: fields })).toMatchObject(
          Object.fromEntries(
            Object.entries(v.illFormedAt ?? {}).map(([k, x]) => [
              k,
              k === "list" || k === "field" ? x : Number(x),
            ]),
          ),
        );
    },
  );

  test.each(version3)("%s breaks the first version-3 rule it names, at its entry", (_id, v) => {
    if (v.illFormed !== undefined && !v3Rules.has(v.illFormed)) return;
    const got = v3Rule(decode(v.encoding).value);
    expect(got?.rule).toBe(v.illFormed);
    expect(got?.at === undefined ? undefined : String(got.at)).toBe(v.illFormedAt?.["seat_relay"]);
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
    const [, typical] = version3[0] ?? [];
    if (typical === undefined) throw new Error("no version-3 vector");
    const { seat_relays: _relays, ...fields } = decode(typical.encoding).value;
    const asV2 = schema.encode(v2.recordType, 2, fields);
    expect(toHex(hex(typical.encoding).subarray(3, asV2.length))).toBe(toHex(asV2.subarray(3)));
  });
});
