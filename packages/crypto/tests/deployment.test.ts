import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  DecodeError,
  type DecodedDeploymentRecord,
  decodeDeploymentRecord,
  DEPLOYMENT_ACROSS_RULES,
  DEPLOYMENT_RULES,
  DEPLOYMENT_V2_RULES,
  DEPLOYMENT_V3_RULES,
  deploymentAcrossRule,
  deploymentHash,
  type DeploymentRecordV2,
  deploymentRecordRule,
  encodeDeploymentRecord,
  UNPINNED,
} from "../src/index.ts";
import { buildSchema, hex, SPEC_VECTORS, type Vector, type VectorFile } from "./spec-vectors.ts";

// This package's deployment record (src/deployment.ts, P2-30 part 3c-2a and
// P2-8 part 3c-1b-2b-2b-2d-2b-2e-3a) against the three vector files,
// docs/spec/vectors/deployment-record.json, deployment-record-v2.json and
// deployment-record-v3.json, printed by their Python generators: each vector
// decodes to the value the file's own type descriptors read, re-encodes to
// its bytes under its deployment hash and breaks exactly the rule it names,
// where it names it; each rejected one is rejected with its code by a reader
// of the file's versions; and each succession breaks its rule across
// releases at its period (T-31, T-36, T-37, T-43, T-74).
const NUM_RUNS = Number(process.env["FC_NUM_RUNS"] ?? 100);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

type DeploymentVector = Vector & {
  readonly deploymentHash?: string;
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
  readonly rules: readonly string[];
  readonly acrossRules?: readonly string[];
  readonly vectors: readonly DeploymentVector[];
  readonly successions?: readonly Succession[];
};

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(name, SPEC_VECTORS), "utf8")) as DeploymentFile;
const v1File = read("deployment-record.json");
const v2File = read("deployment-record-v2.json");
const v3File = read("deployment-record-v3.json");

function decodeError(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof DecodeError) return e.code;
    throw e;
  }
  return undefined;
}

// The rule and its place as the vector files write them: `illFormedAt`'s
// values are decimal strings.
function failureOf(d: DecodedDeploymentRecord): { rule?: string; at?: Record<string, string> } {
  const f = deploymentRecordRule(d);
  if (f === undefined) return {};
  const { rule, ...at } = f;
  return Object.keys(at).length === 0
    ? { rule }
    : { rule, at: Object.fromEntries(Object.entries(at).map(([k, v]) => [k, String(v)])) };
}

describe("deployment record codec and rules (docs/spec/deployment.md)", () => {
  test("has the files' rules, in their order", () => {
    expect([...DEPLOYMENT_RULES]).toEqual(v1File.rules);
    expect([...DEPLOYMENT_RULES, ...DEPLOYMENT_V2_RULES]).toEqual(v2File.rules);
    expect([...DEPLOYMENT_RULES, ...DEPLOYMENT_V2_RULES, ...DEPLOYMENT_V3_RULES]).toEqual(
      v3File.rules,
    );
    expect([...DEPLOYMENT_ACROSS_RULES]).toEqual(v2File.acrossRules);
    expect([...DEPLOYMENT_ACROSS_RULES]).toEqual(v3File.acrossRules);
  });

  for (const [name, file, version] of [
    ["version 1", v1File, 1],
    ["version 2", v2File, 2],
    ["version 3", v3File, 3],
  ] as const) {
    describe(name, () => {
      const { schema, type } = buildSchema(file as unknown as VectorFile);
      const decoded = file.vectors.filter((v) => "value" in v).map((v) => [v.id, v] as const);
      const rejected = file.vectors.filter((v) => "error" in v).map((v) => [v.id, v] as const);

      test.each(decoded)(
        "%s decodes to the file's value and back, under its deployment hash",
        (_id, v) => {
          const bytes = hex(v.encoding);
          const t = type(v.type);
          const d = decodeDeploymentRecord(bytes);
          // The file's own descriptors are an independent reading of the bytes.
          expect(d).toEqual(schema.decode(t.recordType, bytes, UNPINNED));
          // A reader of the file's versions alone reads it the same.
          expect(decodeDeploymentRecord(bytes, version)).toEqual(d);
          expect(toHex(encodeDeploymentRecord(d))).toBe(v.encoding);
          expect(toHex(deploymentHash(bytes))).toBe(v.deploymentHash);
        },
      );

      test.each(decoded)("%s breaks exactly the rule it names, where it names it", (_id, v) => {
        const got = failureOf(decodeDeploymentRecord(hex(v.encoding)));
        expect(got.rule).toBe(v.illFormed);
        expect(got.at).toEqual(v.illFormedAt);
      });

      // Each file was printed for a reader of its versions alone, to which a
      // later version is unknown. A reader of every version reads such a
      // vector's earlier body under the later layout, which is `truncated`
      // (Record (version 2) and Record (version 3), Decoding).
      const later = new Set(["v1:unknown-version", "v2:version-three"]);
      const asRead = (v: DeploymentVector) =>
        later.has(`v${version}:${v.id}`) ? "truncated" : v.error;

      test.each(rejected)("%s is rejected with its code", (_id, v) => {
        expect(decodeError(() => decodeDeploymentRecord(hex(v.encoding), version))).toBe(v.error);
        expect(decodeError(() => decodeDeploymentRecord(hex(v.encoding)))).toBe(asRead(v));
      });
    });
  }

  // A version-3 record is a version-2 record to the rules across releases.
  const v2 = (encoding: string): DeploymentRecordV2 => {
    const d = decodeDeploymentRecord(hex(encoding));
    if (d.version === 1) throw new Error("expected a version-2 or version-3 record");
    return d.value;
  };

  test.each(
    [v2File, v3File].flatMap((f) =>
      (f.successions ?? []).map((s) => [`${f === v2File ? "v2" : "v3"} ${s.id}`, s] as const),
    ),
  )(
    "%s: across releases, the first rule broken and the lowest period it is broken at",
    (_id, s) => {
      const got = deploymentAcrossRule(v2(s.earlier), v2(s.later));
      expect(got?.rule).toBe(s.across);
      expect(got === undefined ? undefined : String(got.period)).toBe(s.acrossAt?.period);
    },
  );

  test("reports a rule broken at two periods at the lower one", () => {
    const typical = v2File.vectors.find((v) => v.id === "typical");
    if (typical === undefined) throw new Error("missing vector");
    const earlier = v2(typical.encoding);
    const keys = earlier.tier0_token_keys.slice();
    const [a, b] = [keys[2], keys[5]];
    if (a === undefined || b === undefined) throw new Error("too few keys");
    // Swapped keys: still well formed, and another key at both periods.
    keys[2] = { ...a, key: b.key };
    keys[5] = { ...b, key: a.key };
    const later = { ...earlier, tier0_token_keys: keys };
    expect(deploymentAcrossRule(earlier, later)).toEqual({
      rule: "token-key-changed",
      period: a.period,
    });
  });

  // The origin grammar is release.md's: every origin a well-formed release
  // vector lists passes `origin` as an endpoint, and each one only an
  // `origin`-breaking release vector lists (port 0, a leading zero, a port
  // over 65535, a 64-byte label, a 254-byte host, a hex or digit-led last
  // label, userinfo, …) fails it (T-31, T-43).
  const releaseFile = JSON.parse(
    readFileSync(new URL("release-record.json", SPEC_VECTORS), "utf8"),
  ) as {
    readonly vectors: readonly (Vector & {
      readonly value?: { readonly sites: readonly { readonly origins: readonly string[] }[] };
    })[];
  };
  const originsOf = (v: (typeof releaseFile.vectors)[number]) =>
    (v.value?.sites ?? []).flatMap((site) => site.origins);
  const goodOrigins = new Set(
    releaseFile.vectors.filter((v) => v.illFormed === undefined).flatMap(originsOf),
  );
  const badOrigins = releaseFile.vectors
    .filter((v) => v.illFormed === "origin")
    .map((v) => [v.id, originsOf(v).filter((o) => !goodOrigins.has(o))] as const);
  const withApi = (origin: string): DecodedDeploymentRecord => {
    const typical = v1File.vectors.find((v) => v.id === "typical");
    if (typical === undefined) throw new Error("missing vector");
    const d = decodeDeploymentRecord(hex(typical.encoding));
    if (d.version !== 1) throw new Error("expected a version-1 record");
    return { version: 1, value: { ...d.value, api: [hex(origin)] } };
  };

  test.each(badOrigins)("%s: its origin is refused as an endpoint", (_id, origins) => {
    expect(origins.length).toBeGreaterThan(0);
    for (const o of origins)
      expect(deploymentRecordRule(withApi(o))).toEqual({ rule: "origin", list: "api" });
  });

  test("passes every origin a well-formed release lists", () => {
    expect(goodOrigins.size).toBeGreaterThan(0);
    for (const o of goodOrigins)
      expect(deploymentRecordRule(withApi(o))?.rule, Buffer.from(hex(o)).toString()).not.toBe(
        "origin",
      );
  });

  test("judges only well-formed records across releases", () => {
    const good = v2File.vectors.find((v) => v.id === "typical");
    const bad = v2File.vectors.find((v) => v.illFormed === "token-key-order");
    if (good === undefined || bad === undefined) throw new Error("missing vectors");
    expect(() => deploymentAcrossRule(v2(good.encoding), v2(bad.encoding))).toThrow(RangeError);
    expect(() => deploymentAcrossRule(v2(bad.encoding), v2(good.encoding))).toThrow(RangeError);
  });

  // Canonicity: every byte string the decoder accepts re-encodes to itself,
  // and none of a valid record's proper prefixes or extensions decodes.
  const encodings = [...v1File.vectors, ...v2File.vectors, ...v3File.vectors]
    .filter((v) => "value" in v)
    .map((v) => hex(v.encoding));
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
          let d: DecodedDeploymentRecord;
          try {
            d = decodeDeploymentRecord(b);
          } catch (e) {
            if (e instanceof DecodeError) return;
            throw e;
          }
          expect(toHex(encodeDeploymentRecord(d))).toBe(toHex(b));
          // The rules judge any decoded record without throwing.
          deploymentRecordRule(d);
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
          expect(decodeError(() => decodeDeploymentRecord(bytes.subarray(0, at)))).toBe(
            "truncated",
          );
          const longer = new Uint8Array(bytes.length + tail.length);
          longer.set(bytes);
          longer.set(tail, bytes.length);
          expect(decodeError(() => decodeDeploymentRecord(longer))).toBe("trailing-bytes");
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
