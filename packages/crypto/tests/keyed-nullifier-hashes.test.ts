import { babyjubjub } from "@noble/curves/misc.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  BJJ_FIELD_ORDER,
  circuitTagField,
  EncodeError,
  nullifierScopeField,
  TAG_REGISTRY,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/keyed-nullifier-hashes.json comes from an independent
// Python implementation (scripts/keyed-nullifier-hashes-vectors.py). H1 and H2
// are computed only inside circuits (docs/spec/keyed-nullifier-hashes.md), so
// packages/crypto takes from them only what it computes off-circuit: the scope
// field and the tags' field elements. The points are checked here with
// @noble/curves as the group the rest of the protocol uses; packages/circuits
// runs the hashes themselves.

interface Point {
  readonly x: string;
  readonly y: string;
}

interface Vectors {
  readonly format: string;
  readonly tags: Readonly<Record<"h1" | "h2", { readonly tag: string; readonly field: string }>>;
  readonly map: {
    readonly cases: readonly { readonly exceptional: boolean; readonly edwards: Point }[];
  };
  readonly scopes: readonly {
    readonly l2ChainId: string;
    readonly groupRegistry: string;
    readonly field: string;
  }[];
  readonly hashes: readonly {
    readonly name: string;
    readonly map0: { readonly edwards: Point };
    readonly map1: { readonly edwards: Point };
    readonly sum: Point;
    readonly h1: Point;
    readonly sk: string;
    readonly u: Point;
    readonly n: string;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("keyed-nullifier-hashes.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const Point = babyjubjub.Point;
const point = (p: Point) => Point.fromAffine({ x: BigInt(p.x), y: BigInt(p.y) });

describe("keyed-nullifier hashes", () => {
  test("the file has the expected format", () => {
    expect(vectors.format).toBe("abolish-keyed-nullifier-hashes-vectors/1");
  });

  test("H1 and H2 take their tags as In-circuit field elements", () => {
    for (const { tag, field } of Object.values(vectors.tags))
      expect(circuitTagField(tag)).toBe(BigInt(field));
    const inCircuit = TAG_REGISTRY.filter((e) => (e.primitive as string) === "in-circuit");
    expect(inCircuit.map((e) => e.tag)).toEqual([vectors.tags.h1.tag, vectors.tags.h2.tag]);
  });

  test.each(vectors.scopes)("σ for chain $l2ChainId", ({ l2ChainId, groupRegistry, field }) => {
    expect(nullifierScopeField(BigInt(l2ChainId), hex(groupRegistry))).toBe(BigInt(field));
  });

  test("σ is below 2^248 and refuses what u64 and an address can't encode", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }),
        fc.uint8Array({ minLength: 20, maxLength: 20 }),
        (c, r) => {
          const s = nullifierScopeField(c, r);
          return s >= 0n && s < 1n << 248n && s < BJJ_FIELD_ORDER;
        },
      ),
      { numRuns },
    );
    expect(() => nullifierScopeField(1n << 64n, new Uint8Array(20))).toThrow(EncodeError);
    expect(() => nullifierScopeField(-1n, new Uint8Array(20))).toThrow(EncodeError);
    expect(() => nullifierScopeField(1n, new Uint8Array(19))).toThrow(EncodeError);
  });

  test("every mapped point is on Baby Jubjub, and only the exceptional case is the identity", () => {
    for (const c of vectors.map.cases) {
      const p = point(c.edwards);
      expect(p.is0()).toBe(c.exceptional);
      if (!c.exceptional) expect(() => p.assertValidity()).not.toThrow();
    }
  });

  test.each(vectors.hashes)("H1 and U for $name", (h) => {
    const sum = point(h.map0.edwards).add(point(h.map1.edwards));
    expect(sum.equals(point(h.sum))).toBe(true);
    const h1 = point(h.h1);
    // The cofactor clears into the prime-order subgroup.
    expect(sum.multiplyUnsafe(8n).equals(h1)).toBe(true);
    expect(h1.isTorsionFree() && !h1.is0()).toBe(true);
    expect(h1.multiply(BigInt(h.sk)).equals(point(h.u))).toBe(true);
    expect(BigInt(h.n) < BJJ_FIELD_ORDER).toBe(true);
  });
});
