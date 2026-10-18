// Checks the vendored reference string (README, Reference string). The files
// are pinned by hash to what scripts/crs.ts writes from Ignition's first
// transcript, and their structure is checked independently of that source: the
// G1 points are [x^i]_1 for i = 0 to 2^15 − 1, from the generator, for the x of
// the G2 point [x]_2. A string that isn't one sequence of powers of x would let
// a prover open a commitment to two values, and with it prove a false
// statement (T-21, T-55); that the setup's x is unknown is Ignition's claim,
// which no test can check.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { pippenger } from "@noble/curves/abstract/curve.js";
import { bn254 } from "@noble/curves/bn254.js";
import { describe, expect, test } from "vite-plus/test";
import { BB } from "../scripts/toolchain.ts";

const CRS = new URL("../crs/", import.meta.url);
const read = (f: string) => new Uint8Array(readFileSync(new URL(f, CRS)));
const g1Bytes = read("bn254_g1.dat");
const g2Bytes = read("bn254_g2.dat");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const int = (b: Uint8Array) => BigInt(`0x${Buffer.from(b).toString("hex") || "0"}`);
const { G1, G2 } = bn254;
const Fp2 = bn254.fields.Fp2;

const POINTS = 32768;

describe("crs/", () => {
  test("holds the two files scripts/crs.ts writes, by hash", () => {
    // crs.lock is bb's, and ignored. A file bb downloaded because the circuits
    // outgrew the vendored points would show up here.
    expect(readdirSync(CRS).filter((f) => f !== "crs.lock")).toEqual([
      "bn254_g1.dat",
      "bn254_g2.dat",
    ]);
    expect(g1Bytes.length).toBe(POINTS * 64);
    expect(sha256(g1Bytes)).toBe(
      "50d2f4e9567be2b8e382cedfd078b96a3428a94597b7e88c4116e105d578ce77",
    );
    expect(sha256(g2Bytes)).toBe(
      "01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f",
    );
  });

  test("covers both circuits' dyadic size", () => {
    const gates = JSON.parse(
      readFileSync(new URL("../gates.json", import.meta.url), "utf8"),
    ) as Record<string, { circuit_size: number }>;
    for (const { circuit_size } of Object.values(gates)) {
      expect(2 ** Math.ceil(Math.log2(circuit_size))).toBeLessThanOrEqual(POINTS);
    }
  });

  test("[x]_2 is the one compiled into the pinned bb", () => {
    // bb's verifier uses its own copy of [x]_2, not bn254_g2.dat. That copy
    // equalling the file ties the vendored powers to bb's x, a second source
    // beside the S3 read: install-toolchain.sh pins bb's binary by sha256.
    expect(readFileSync(BB).includes(Buffer.from(g2Bytes))).toBe(true);
  });

  test("that bb is found outside node_modules, is a binary and has the catalog's version", () => {
    // What keeps bb.js's shim out is the path (scripts/toolchain.ts) and the
    // shim being a script. The version can't tell the pinned bb from the
    // native one inside bb.js's tarball, which reports the same; that the
    // binary is the pinned one rests on install-toolchain.sh's sha256.
    const pin = /"@aztec\/bb\.js": (\S+)/.exec(
      readFileSync(new URL("../../../pnpm-workspace.yaml", import.meta.url), "utf8"),
    )?.[1];
    expect(BB.split(/[\\/]/)).not.toContain("node_modules");
    expect(execFileSync(BB, ["--version"], { encoding: "utf8" }).trim()).toBe(pin);
    expect(readFileSync(BB).subarray(0, 2).toString()).not.toBe("#!");
  });

  test("is [x^i]_1 from the generator, for the x of [x]_2", () => {
    const g1 = Array.from({ length: POINTS }, (_, i) => {
      const p = g1Bytes.subarray(64 * i, 64 * i + 64);
      // fromAffine doesn't validate; assertValidity checks the curve (and,
      // BN254's G1 having cofactor 1, the group).
      const point = G1.Point.fromAffine({ x: int(p.subarray(0, 32)), y: int(p.subarray(32)) });
      point.assertValidity();
      return point;
    });
    const c = (i: number) => int(g2Bytes.subarray(32 * i, 32 * i + 32));
    const x2 = G2.Point.fromAffine({
      x: Fp2.fromBigTuple([c(0), c(1)]),
      y: Fp2.fromBigTuple([c(2), c(3)]),
    });
    // On the twist and in the order-r subgroup (G2's cofactor isn't 1).
    x2.assertValidity();
    expect(x2.is0()).toBe(false);
    expect(x2.multiplyUnsafe(bn254.fields.Fr.ORDER - 1n).equals(x2.negate())).toBe(true);

    expect(g1[0]?.equals(G1.Point.BASE)).toBe(true);
    // Every e(P_{i+1}, [1]_2) = e(P_i, [x]_2) at once, under random weights:
    // with D_i = P_{i+1} − x · P_i, the check is Σ ρ_i · D_i = 0, which a
    // nonzero D_i passes with probability 1/r over the ρ_i.
    const rho = Array.from(
      { length: POINTS - 1 },
      () => int(randomBytes(32)) % bn254.fields.Fr.ORDER,
    );
    const lower = pippenger(G1.Point, g1.slice(0, -1), rho);
    const upper = pippenger(G1.Point, g1.slice(1), rho);
    const gt = bn254.fields.Fp12;
    const lhs = bn254.pairing(upper, G2.Point.BASE);
    const rhs = bn254.pairing(lower, x2);
    expect(gt.eql(lhs, rhs)).toBe(true);
  }, 600_000);
});
