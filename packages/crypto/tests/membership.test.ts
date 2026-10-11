import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  BN254_R,
  EncodeError,
  membershipDepth,
  membershipScope,
  nullifierScope,
  semaphoreField,
} from "../src/index.ts";
import { SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/membership.json comes from an independent Python
// implementation with its own Keccak (scripts/membership-vectors.py), so these
// expected values never come from the code under test.

interface MembershipVectors {
  readonly format: string;
  readonly fieldMap: readonly {
    readonly id: string;
    readonly input: string;
    readonly output: string;
  }[];
  readonly scopes: readonly {
    readonly id: string;
    readonly definitionHash: string;
    readonly root: string;
    readonly scope?: string;
    readonly scopeField?: string;
    readonly error?: string;
  }[];
  readonly depths: readonly {
    readonly groupSize: string;
    readonly depth?: number;
    readonly error?: string;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("membership.json", SPEC_VECTORS), "utf8"),
) as MembershipVectors;

const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const bytes32 = fc.uint8Array({ minLength: 32, maxLength: 32 });
const root = fc.bigInt({ min: 0n, max: BN254_R - 1n });

describe("membership vectors (docs/spec/vectors/membership.json)", () => {
  test("uses the format this reader knows", () => {
    expect(vectors.format).toBe("abolish-membership-vectors/1");
  });

  test.each(vectors.fieldMap)("F matches Semaphore's hash: $id", (v) => {
    expect(semaphoreField(hex(v.input))).toBe(BigInt(v.output));
  });

  test.each(vectors.scopes)("nullifier scope: $id", (v) => {
    const r = BigInt(`0x${v.root}`);
    if (v.error !== undefined) {
      expect(() => nullifierScope(hex(v.definitionHash), r)).toThrow(EncodeError);
      return;
    }
    expect(toHex(nullifierScope(hex(v.definitionHash), r))).toBe(v.scope);
    expect(membershipScope(hex(v.definitionHash), r)).toBe(BigInt(v.scopeField ?? ""));
  });

  test.each(vectors.depths)("tree depth for $groupSize members", (v) => {
    const n = BigInt(v.groupSize);
    if (v.error !== undefined) expect(() => membershipDepth(n)).toThrow(RangeError);
    else expect(membershipDepth(n)).toBe(v.depth);
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

  test("each tier group of a poll gets its own scope (T-13), and each poll its own (T-12)", () => {
    fc.assert(
      fc.property(bytes32, bytes32, root, root, (d1, d2, r1, r2) => {
        fc.pre(toHex(d1) !== toHex(d2) && r1 !== r2);
        const s = toHex(nullifierScope(d1, r1));
        expect(toHex(nullifierScope(d1, r2))).not.toBe(s);
        expect(toHex(nullifierScope(d2, r1))).not.toBe(s);
      }),
      { numRuns },
    );
  });

  test("rejects inputs that aren't exactly 32 bytes, and roots outside the field", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (x) => {
        fc.pre(x.length !== 32);
        expect(() => semaphoreField(x)).toThrow(TypeError);
        expect(() => nullifierScope(x, 0n)).toThrow(TypeError);
      }),
      { numRuns },
    );
    for (const bad of [-1n, BN254_R, 1n << 256n])
      expect(() => nullifierScope(new Uint8Array(32), bad)).toThrow(EncodeError);
  });

  test("the depth fits every member's path and is the smallest that does", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 1n << 32n }), (n) => {
        const d = membershipDepth(n);
        expect(d >= 1 && d <= 32).toBe(true);
        expect(n <= 1n << BigInt(d)).toBe(true);
        if (d > 1) expect(n > 1n << BigInt(d - 1)).toBe(true);
      }),
      { numRuns },
    );
  });

  test("does not mutate or alias its inputs", () => {
    const d = new Uint8Array(32).fill(7);
    const before = toHex(d);
    const s = nullifierScope(d, 5n);
    expect(toHex(d)).toBe(before);
    s.fill(0);
    expect(toHex(nullifierScope(d, 5n))).not.toBe(toHex(s));
  });
});
