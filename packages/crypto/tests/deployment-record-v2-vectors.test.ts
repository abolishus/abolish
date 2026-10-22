import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  DecodeError,
  ds,
  H,
  tier0TokenBlind,
  tier0TokenInfo,
  tier0TokenInput,
  tier0TokenKeyId,
  UNPINNED,
} from "../src/index.ts";
import { buildSchema, hex, SPEC_VECTORS, type Vector, type VectorFile } from "./spec-vectors.ts";

// docs/spec/vectors/deployment-record-v2.json, printed by
// scripts/deployment-record-v2-vectors.py (P2-30 part 3c-1). As for version 1
// (deployment-record-vectors.test.ts), the deployment record's codec and
// rules aren't in this package yet (P4-4 part 2c), so the file's own type
// descriptors decode each vector: every vector round-trips under its
// deployment hash, a reader of both versions still reads version 1, and the
// file's rules are the spec's. What this package already has is checked
// against it: each listed key's key_id is this package's, each well-formed
// key blinds under this package's Blind, and each key `token-key` refuses is
// one Blind refuses too (T-74, T-10, T-31).
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

type DeploymentVector = Vector & {
  readonly deploymentHash?: string;
  readonly keyIds?: readonly string[];
  readonly illFormedAt?: Readonly<Record<string, string>>;
};

interface Succession {
  readonly id: string;
  readonly earlier: string;
  readonly later: string;
  readonly across?: string;
  readonly acrossAt?: { readonly period: string };
}

type DeploymentFile = Omit<VectorFile, "vectors"> & {
  readonly tag: string;
  readonly tokenKeyPeriod: string;
  readonly largestEncoding: number;
  readonly rules: readonly string[];
  readonly acrossRules: readonly string[];
  readonly vectors: readonly DeploymentVector[];
  readonly successions: readonly Succession[];
};

interface TokenKey {
  readonly period: number;
  readonly key: Uint8Array;
  readonly retired: boolean;
}

interface DecodedDeployment {
  readonly l2_chain_id: bigint;
  readonly group_registry: Uint8Array;
  readonly groups: readonly { readonly group_id: bigint }[];
  readonly tier0_token_keys: readonly TokenKey[];
}

const file = JSON.parse(
  readFileSync(new URL("deployment-record-v2.json", SPEC_VECTORS), "utf8"),
) as DeploymentFile;
const v1File = JSON.parse(
  readFileSync(new URL("deployment-record.json", SPEC_VECTORS), "utf8"),
) as { readonly rules: readonly string[] };
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

// A commitment no rule forbids, and an input for it under `keyId`.
const C = new Uint8Array(32).fill(7);

describe("deployment record version 2 (docs/spec/deployment.md)", () => {
  const { schema, type } = buildSchema(file as unknown as VectorFile);
  const v2 = type({ kind: "ref", name: "deployment_v2" });
  const decode = (encoding: string) =>
    schema.decode(v2.recordType, hex(encoding), UNPINNED) as {
      version: number;
      value: DecodedDeployment;
    };

  const decoded = file.vectors.filter((v) => "value" in v).map((v) => [v.id, v] as const);
  const rejected = file.vectors.filter((v) => "error" in v).map((v) => [v.id, v] as const);
  const wellFormed = decoded.filter(
    ([, v]) => v.illFormed === undefined && v.type.kind === "ref" && v.type.name !== "deployment",
  );

  test("has its format, tag, period and bounds, and exactly one of value or error on each vector", () => {
    expect(file.format).toBe("abolish-deployment-record-vectors/2");
    expect(file.tag).toBe("abolish/v1/deployment");
    expect(file.tokenKeyPeriod).toBe("2592000");
    expect(new Set(file.vectors.map((v) => v.id)).size).toBe(file.vectors.length);
    expect(new Set(file.successions.map((s) => s.id)).size).toBe(file.successions.length);
    for (const v of file.vectors) expect("value" in v !== "error" in v, v.id).toBe(true);
    expect(page).toContain(
      `At its maximums a version-2 record is ${file.largestEncoding.toLocaleString("en")} bytes.`,
    );
    expect(Math.max(...decoded.map(([, v]) => hex(v.encoding).length))).toBe(file.largestEncoding);
  });

  test("has the spec's version-2 layout: version 1's fields, then the token keys", () => {
    type Named = Readonly<
      Record<string, { readonly fields?: readonly { readonly name: string }[] }>
    >;
    const types = file.types as unknown as Named;
    const names = (t: string) => (types[t]?.fields ?? []).map((f) => f.name);
    expect(names("deployment_v2")).toEqual([...names("deployment"), "tier0_token_keys"]);
    const rows = [...section("Record (version 2)").matchAll(/^\| `([a-z0-9_]+)` +\| `([^`]+)`/gm)];
    expect(rows.map((m) => [m[1], m[2]])).toEqual([
      ["tier0_token_keys", "list<token_key, 16>"],
      ["period", "u32"],
      ["key", "bytes[32]"],
      ["retired", "bool"],
    ]);
    expect(names("token_key")).toEqual(["period", "key", "retired"]);
  });

  test("lists version 1's rules, then the spec's version-2 rules, each with a vector that breaks it", () => {
    expect(file.rules).toEqual([...v1File.rules, ...codes("Well-formedness (version 2)")]);
    expect(codes("Across releases")).toEqual(file.acrossRules);
    expect(
      new Set(file.vectors.flatMap((v) => (v.illFormed === undefined ? [] : [v.illFormed]))),
    ).toEqual(new Set(file.rules));
    expect(
      new Set(file.successions.flatMap((s) => (s.across === undefined ? [] : [s.across]))),
    ).toEqual(new Set(file.acrossRules));
  });

  test.each(decoded)("%s decodes to its value and back, under its deployment hash", (_id, v) => {
    const bytes = hex(v.encoding);
    const t = type(v.type);
    const version = v.type.kind === "ref" && v.type.name === "deployment" ? 1 : 2;
    const expected = t.built.fromJson(v.value);
    expect(schema.decode(t.recordType, bytes, UNPINNED)).toEqual({ version, value: expected });
    expect(toHex(schema.encode(t.recordType, version, expected))).toBe(v.encoding);
    expect(toHex(H(ds("abolish/v1/deployment", bytes)))).toBe(v.deploymentHash);
  });

  test.each(rejected)("%s is rejected", (_id, v) => {
    expect(decodeError(() => decode(v.encoding))).toBe(v.error);
  });

  // The key identifiers a client derives from the record are this
  // package's, and every well-formed key is one its Blind accepts.
  test.each(wellFormed)("%s lists keys this package identifies and blinds under", (_id, v) => {
    const d = decode(v.encoding).value;
    if (v.keyIds !== undefined)
      expect(d.tier0_token_keys.map((k) => toHex(tier0TokenKeyId(k.period, k.key)))).toEqual(
        v.keyIds,
      );
    const info = tier0TokenInfo({
      chainId: d.l2_chain_id,
      groupRegistry: d.group_registry,
      groupId: d.groups[0]?.group_id ?? 0n,
    });
    for (const k of d.tier0_token_keys) {
      const input = tier0TokenInput(tier0TokenKeyId(k.period, k.key), C);
      expect(tier0TokenBlind(input, k.key, info).blindedElement).toHaveLength(32);
    }
  });

  test.each(decoded.filter(([, v]) => v.illFormed === "token-key"))(
    "%s lists a key this package's Blind refuses, after keys it accepts",
    (_id, v) => {
      const d = decode(v.encoding).value;
      const at = Number(v.illFormedAt?.["key"]);
      const info = tier0TokenInfo({ chainId: 1n, groupRegistry: new Uint8Array(20), groupId: 0n });
      const blind = (k: TokenKey) =>
        tier0TokenBlind(tier0TokenInput(tier0TokenKeyId(k.period, k.key), C), k.key, info);
      const bad = d.tier0_token_keys[at];
      if (bad === undefined) throw new Error(`no key ${at}`);
      expect(() => blind(bad)).toThrow(RangeError);
      for (const k of d.tier0_token_keys.slice(0, at)) expect(() => blind(k)).not.toThrow();
    },
  );

  // The rules across releases compare what two records list for each
  // period: this restates them over the decoded records, so each succession
  // is checked against its code, and its period is the first that breaks it.
  test.each(file.successions.map((s) => [s.id, s] as const))(
    "%s: across releases, the first rule broken and where",
    (_id, s) => {
      const earlier = decode(s.earlier).value.tier0_token_keys;
      const later = decode(s.later).value.tier0_token_keys;
      const before = new Map(earlier.map((k) => [k.period, k]));
      const changed = later.find((k) => {
        const e = before.get(k.period);
        return e !== undefined && toHex(e.key) !== toHex(k.key);
      });
      const unretired = later.find((k) => before.get(k.period)?.retired === true && !k.retired);
      const got =
        changed !== undefined
          ? { across: "token-key-changed", period: changed.period }
          : unretired !== undefined
            ? { across: "token-key-unretired", period: unretired.period }
            : undefined;
      expect(got?.across).toBe(s.across);
      expect(got === undefined ? undefined : String(got.period)).toBe(s.acrossAt?.period);
    },
  );
});
