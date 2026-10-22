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
  deploymentAcrossRule,
  deploymentHash,
  type DeploymentRecordV2,
  deploymentRecordRule,
  encodeDeploymentRecord,
  UNPINNED,
} from "../src/index.ts";
import { buildSchema, hex, SPEC_VECTORS, type Vector, type VectorFile } from "./spec-vectors.ts";

// This package's deployment record (src/deployment.ts, P2-30 part 3c-2a)
// against both vector files, docs/spec/vectors/deployment-record.json and
// deployment-record-v2.json, printed by their Python generators: each
// vector decodes to the value the file's own type descriptors read, re-encodes
// to its bytes under its deployment hash and breaks exactly the rule it
// names, where it names it; each rejected one is rejected with its code; and
// each succession breaks its rule across releases at its period (T-31, T-36,
// T-37, T-74).
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
    expect([...DEPLOYMENT_ACROSS_RULES]).toEqual(v2File.acrossRules);
  });

  for (const [name, file] of [
    ["version 1", v1File],
    ["version 2", v2File],
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
          expect(toHex(encodeDeploymentRecord(d))).toBe(v.encoding);
          expect(toHex(deploymentHash(bytes))).toBe(v.deploymentHash);
        },
      );

      test.each(decoded)("%s breaks exactly the rule it names, where it names it", (_id, v) => {
        const got = failureOf(decodeDeploymentRecord(hex(v.encoding)));
        expect(got.rule).toBe(v.illFormed);
        expect(got.at).toEqual(v.illFormedAt);
      });

      // The version-1 file was printed for a reader of version 1 alone, to
      // which version 2 is unknown. A reader of both reads that vector's
      // version-1 body under version 2's layout, which is `truncated`
      // (Record (version 2), Decoding).
      const asRead = (v: DeploymentVector) =>
        file === v1File && v.id === "unknown-version" ? "truncated" : v.error;

      test.each(rejected)("%s is rejected with its code", (_id, v) => {
        expect(decodeError(() => decodeDeploymentRecord(hex(v.encoding)))).toBe(asRead(v));
      });
    });
  }

  const v2 = (encoding: string): DeploymentRecordV2 => {
    const d = decodeDeploymentRecord(hex(encoding));
    if (d.version !== 2) throw new Error("expected a version-2 record");
    return d.value;
  };

  test.each((v2File.successions ?? []).map((s) => [s.id, s] as const))(
    "%s: across releases, the first rule broken and the lowest period it is broken at",
    (_id, s) => {
      const got = deploymentAcrossRule(v2(s.earlier), v2(s.later));
      expect(got?.rule).toBe(s.across);
      expect(got === undefined ? undefined : String(got.period)).toBe(s.acrossAt?.period);
    },
  );

  test("judges only well-formed records across releases", () => {
    const good = v2File.vectors.find((v) => v.id === "typical");
    const bad = v2File.vectors.find((v) => v.illFormed === "token-key-order");
    if (good === undefined || bad === undefined) throw new Error("missing vectors");
    expect(() => deploymentAcrossRule(v2(good.encoding), v2(bad.encoding))).toThrow(RangeError);
    expect(() => deploymentAcrossRule(v2(bad.encoding), v2(good.encoding))).toThrow(RangeError);
  });

  // Canonicity: every byte string the decoder accepts re-encodes to itself,
  // and none of a valid record's proper prefixes or extensions decodes.
  const encodings = [...v1File.vectors, ...v2File.vectors]
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
