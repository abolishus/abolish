import { describe, expect, test } from "vite-plus/test";
import { membershipVkEncoding, poseidon2 } from "../../src/index.ts";
import { poseidon2Constants } from "../../src/poseidon.ts";
import { readVendored } from "./harness.ts";

// Published files behind membership proofs (docs/spec/membership.md): the
// depth-32 key pinned in membership-proof.ts must be Semaphore's own, and the
// Poseidon the tier tree uses must be circomlib's (T-05, T-07, T-03).

const decimal = (s: unknown) => {
  if (typeof s !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(s))
    throw new Error(`not a decimal: ${String(s)}`);
  return BigInt(s);
};
const word = (v: bigint) => v.toString(16).padStart(64, "0");

interface SemaphoreKeys {
  readonly protocol: string;
  readonly curve: string;
  readonly nPublic: number;
  readonly vk_alpha_1: readonly string[];
  readonly vk_beta_2: readonly (readonly string[])[];
  readonly vk_gamma_2: readonly (readonly string[])[];
  readonly vk_delta_2: readonly (readonly (readonly string[])[])[];
  readonly IC: readonly (readonly (readonly string[])[])[];
}

describe("Semaphore v4.14.3 verification keys (semaphore/verification-keys.json)", () => {
  const keys = JSON.parse(
    readVendored("semaphore/verification-keys.json").toString("utf8"),
  ) as SemaphoreKeys;

  test("are Groth16 keys over BN254 with four public signals, one per depth 1 to 32", () => {
    expect([keys.protocol, keys.curve, keys.nPublic]).toEqual(["groth16", "bn128", 4]);
    expect(keys.vk_delta_2).toHaveLength(32);
    expect(keys.IC).toHaveLength(32);
    for (const ic of keys.IC) expect(ic).toHaveLength(5);
  });

  test("the pinned key is the depth-32 entry, point for point", () => {
    // snarkjs's affine form: G1 [x, y, "1"], G2 [[x.c0, x.c1], [y.c0, y.c1], ["1", "0"]].
    const g1 = (p: readonly string[] | undefined) => {
      expect(p?.[2]).toBe("1");
      return word(decimal(p?.[0])) + word(decimal(p?.[1]));
    };
    const g2 = (p: readonly (readonly string[])[] | undefined) => {
      expect(p?.[2]).toEqual(["1", "0"]);
      const [x, y] = [p?.[0], p?.[1]];
      return [x?.[1], x?.[0], y?.[1], y?.[0]].map((c) => word(decimal(c))).join("");
    };
    const expected = [
      g1(keys.vk_alpha_1),
      g2(keys.vk_beta_2),
      g2(keys.vk_gamma_2),
      g2(keys.vk_delta_2[31]),
      ...(keys.IC[31] ?? []).map(g1),
    ].join("");
    expect(Buffer.from(membershipVkEncoding()).toString("hex")).toBe(expected);
  });
});

describe("circomlib's Poseidon at t = 3", () => {
  test("noble's Grain constants equal circomlibjs's published constants and MDS matrix", () => {
    const published = JSON.parse(
      readVendored("iden3/poseidon_constants.json").toString("utf8"),
    ) as {
      readonly C: readonly (readonly string[])[];
      readonly M: readonly (readonly (readonly string[])[])[];
    };
    const hexes = (v: readonly string[]) =>
      v.map((h) => {
        if (!/^0x[0-9a-f]{64}$/.test(h)) throw new Error(`not a constant: ${h}`);
        return BigInt(h);
      });
    const C = hexes(published.C[1] ?? []);
    const M = (published.M[1] ?? []).map(hexes);
    expect(C).toHaveLength(3 * (8 + 57));
    expect(M).toHaveLength(3);
    const ours = poseidon2Constants();
    expect(ours.roundConstants.flat()).toEqual(C);
    expect(ours.mds).toEqual(M);
  });

  test("reproduces circomlibjs's known answer (test/poseidon.js)", () => {
    const source = readVendored("iden3/poseidon.js").toString("utf8");
    const rows = [
      ...source.matchAll(
        /const res1 = poseidonReference\(\[([0-9, ]+)\]\);\s+assert\(poseidonReference\.F\.eq\(poseidonReference\.F\.e\("(0x[0-9a-f]+)"\), res1\)\);/g,
      ),
    ];
    expect(rows).toHaveLength(2);
    const pairs = rows.filter((r) => (r[1] ?? "").split(",").length === 2);
    expect(pairs).toHaveLength(1);
    for (const [, inputs = "", output = ""] of pairs) {
      const [a, b] = inputs.split(",").map((x) => decimal(x.trim()));
      expect(poseidon2(a as bigint, b as bigint)).toBe(BigInt(output));
    }
  });

  test("reproduces circomlib's circuit known answers (test/poseidoncircuit.js)", () => {
    const source = readVendored("iden3/poseidoncircuit.js").toString("utf8");
    const rows = [
      ...source.matchAll(
        /const res2 = poseidon\(\[([0-9, ]+)\]\);\s+assert\(F\.eq\(F\.e\("([0-9]+)"\), F\.e\(res2\)\)\);/g,
      ),
    ];
    expect(rows).toHaveLength(4);
    const pairs = rows.filter((r) => (r[1] ?? "").split(",").length === 2);
    expect(pairs).toHaveLength(2);
    for (const [, inputs = "", output = ""] of pairs) {
      const [a, b] = inputs.split(",").map((x) => decimal(x.trim()));
      expect(poseidon2(a as bigint, b as bigint)).toBe(decimal(output));
    }
  });
});
