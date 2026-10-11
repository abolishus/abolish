import fc from "fast-check";
import { readFileSync } from "node:fs";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, test } from "vite-plus/test";
import {
  BN254_R,
  EncodeError,
  MEMBERSHIP_DEPTH,
  membershipScope,
  nullifierScope,
  semaphoreField,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/membership.json comes from an independent Python
// implementation with its own Keccak (scripts/membership-vectors.py), so these
// expected values never come from the code under test.

interface MembershipVectors {
  readonly format: string;
  readonly depth: number;
  readonly fieldMap: readonly {
    readonly id: string;
    readonly input: string;
    readonly keccak256: string;
    readonly output: string;
  }[];
  readonly scopes: readonly {
    readonly id: string;
    readonly definitionHash: string;
    readonly tier: number;
    readonly root: string;
    readonly scope?: string;
    readonly scopeField?: string;
    readonly error?: string;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("membership.json", SPEC_VECTORS), "utf8"),
) as MembershipVectors;

const decimal = (s: string | undefined) => {
  if (s === undefined || !/^(?:0|[1-9][0-9]*)$/.test(s)) throw new Error(`not a decimal: ${s}`);
  return BigInt(s);
};
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const bytes32 = fc.uint8Array({ minLength: 32, maxLength: 32 });
const root = fc.bigInt({ min: 1n, max: BN254_R - 1n });
const tier = fc.constantFrom(0, 1, 2);
const errors: Readonly<Record<string, new (...args: never[]) => Error>> = {
  "non-canonical": EncodeError,
  "zero-root": RangeError,
  "unknown-tier": RangeError,
};

describe("membership vectors (docs/spec/vectors/membership.json)", () => {
  test("uses the format this reader knows", () => {
    expect(vectors.format).toBe("abolish-membership-vectors/1");
  });

  test("every proof uses the one protocol-wide depth", () => {
    expect(MEMBERSHIP_DEPTH).toBe(vectors.depth);
  });

  test.each(vectors.fieldMap)("F matches Semaphore's hash: $id", (v) => {
    // The published Keccak-256 intermediate pins @noble's keccak to the
    // independent sponge, so a failure in the shift or byte order is localised.
    expect(toHex(keccak_256(hex(v.input)))).toBe(toHex(hex(v.keccak256)));
    expect(semaphoreField(hex(v.input))).toBe(decimal(v.output));
  });

  test.each(vectors.scopes)("nullifier scope: $id", (v) => {
    const r = BigInt(`0x${toHex(hex(v.root))}`);
    const d = hex(v.definitionHash);
    if (v.error !== undefined) {
      const expected = errors[v.error];
      if (expected === undefined) throw new Error(`unknown error code ${v.error}`);
      expect(() => nullifierScope(d, v.tier, r)).toThrow(expected);
      return;
    }
    if (v.scope === undefined) throw new Error(`${v.id}: a success vector needs scope`);
    expect(toHex(nullifierScope(d, v.tier, r))).toBe(toHex(hex(v.scope)));
    expect(membershipScope(d, v.tier, r)).toBe(decimal(v.scopeField));
  });
});

describe("membership properties", () => {
  test("F lands below 2^248, so inside the BN254 scalar field without reduction", () => {
    fc.assert(
      fc.property(bytes32, (x) => {
        const f = semaphoreField(x);
        expect(f >= 0n && f < 1n << 248n && f < BN254_R).toBe(true);
      }),
      { numRuns },
    );
  });

  test("each poll (T-12), tier (T-13) and tier root gets its own scope", () => {
    fc.assert(
      fc.property(bytes32, bytes32, tier, tier, root, root, (d1, d2, t1, t2, r1, r2) => {
        fc.pre(toHex(d1) !== toHex(d2) && t1 !== t2 && r1 !== r2);
        const s = toHex(nullifierScope(d1, t1, r1));
        expect(toHex(nullifierScope(d2, t1, r1))).not.toBe(s);
        // Equal roots in two tiers (identical rosters) still give two scopes.
        expect(toHex(nullifierScope(d1, t2, r1))).not.toBe(s);
        expect(toHex(nullifierScope(d1, t1, r2))).not.toBe(s);
      }),
      { numRuns },
    );
  });

  test("rejects bad lengths, unknown tiers, roots outside the field and root 0", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (x) => {
        fc.pre(x.length !== 32);
        expect(() => semaphoreField(x)).toThrow(TypeError);
        expect(() => nullifierScope(x, 0, 1n)).toThrow(TypeError);
      }),
      { numRuns },
    );
    const d = new Uint8Array(32);
    for (const bad of [-1n, BN254_R, 1n << 256n])
      expect(() => nullifierScope(d, 0, bad)).toThrow(EncodeError);
    for (const bad of [-1, 3, 255, 1.5, Number.NaN])
      expect(() => nullifierScope(d, bad, 1n)).toThrow(RangeError);
    // Root 0 is provable by anyone with any secret (docs/spec/membership.md, Statement).
    expect(() => nullifierScope(d, 0, 0n)).toThrow(RangeError);
    expect(() => membershipScope(d, 0, 0n)).toThrow(RangeError);
  });

  test("does not mutate or alias its inputs", () => {
    const d = new Uint8Array(32).fill(7);
    const before = toHex(d);
    const s = nullifierScope(d, 1, 5n);
    expect(toHex(d)).toBe(before);
    s.fill(0);
    expect(toHex(nullifierScope(d, 1, 5n))).not.toBe(toHex(s));
  });
});
