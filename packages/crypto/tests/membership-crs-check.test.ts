import { bn254 } from "@noble/curves/bn254.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { MEMBERSHIP_ZKEY_SHA256 } from "../src/index.ts";
import {
  checkCrs,
  checkFiles,
  type Coef,
  CrsCheckError,
  interpolate,
  parsePtau,
  parseR1cs,
  parseZkey,
  type Powers,
  PTAU_SHA256,
  R1CS_SHA256,
  type R1cs,
  rootOfUnity,
  type Zkey,
} from "../scripts/membership-crs-check.ts";

// The reference-string check (docs/spec/membership.md, Reference-string
// check; T-07, T-12). An honest Groth16 key for a toy circuit, built here from
// a known trapdoor with Lagrange polynomials by their closed form (not the
// script's FFT), passes; breaking any one relation the check claims fails
// exactly the check that names it, so no check can be dropped unnoticed.

type G1 = InstanceType<typeof bn254.G1.Point>;
type G2 = InstanceType<typeof bn254.G2.Point>;
const { Fp, Fr } = bn254.fields;
const G = bn254.G1.Point.BASE;
const H = bn254.G2.Point.BASE;
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

// Wires: 0 the constant, 1 the public output y, 2 and 3 private x and z.
// Constraints: x·x = z and z·x = y (y = x³).
const R1CS: R1cs = {
  nWires: 4,
  nPublic: 1,
  nConstraints: 2,
  a: [
    { row: 0, signal: 2, value: 1n },
    { row: 1, signal: 3, value: 1n },
  ],
  b: [
    { row: 0, signal: 2, value: 1n },
    { row: 1, signal: 2, value: 1n },
  ],
  c: [
    { row: 0, signal: 3, value: 1n },
    { row: 1, signal: 1, value: 1n },
  ],
};
const N = 4;

const T = { tau: 0x1234567n, alpha: 0x2345n, beta: 0x3456n, gamma: 0x4567n, delta: 0x5678n };

/** L_j(τ) on the n-point domain, by the closed form ω^j·(τ^n − 1)/(n·(τ − ω^j)). */
function lagrange(n: number, j: number, tau: bigint): bigint {
  const w = Fr.pow(rootOfUnity(n), BigInt(j));
  return Fr.div(Fr.mul(w, Fr.sub(Fr.pow(tau, BigInt(n)), 1n)), Fr.mul(BigInt(n), Fr.sub(tau, w)));
}

/** `Σ_j m[j][signal]·L_j(τ)` for each signal. */
function atTau(m: readonly Coef[], tau: bigint, nVars: number): bigint[] {
  const out = Array.from({ length: nVars }, () => 0n);
  for (const { row, signal, value } of m)
    out[signal] = Fr.add(out[signal] as bigint, Fr.mul(value, lagrange(N, row, tau)));
  return out;
}

const mul1 = (k: bigint) => (k === 0n ? bn254.G1.Point.ZERO : G.multiply(k));
const mul2 = (k: bigint) => (k === 0n ? bn254.G2.Point.ZERO : H.multiply(k));

/** `[τ^i]_1` to 2N − 2 and `[τ^i]_2` to N − 1, as a power-log₂N ptau has them. */
function powers(tau: bigint): Powers {
  const pow = (i: number) => Fr.pow(tau, BigInt(i));
  return {
    power: Math.log2(N),
    g1: Array.from({ length: 2 * N - 1 }, (_, i) => mul1(pow(i))),
    g2: Array.from({ length: N }, (_, i) => mul2(pow(i))),
  };
}

function honest(t = T): { zkey: Zkey; ptau: Powers } {
  const nVars = R1CS.nWires;
  const nPublic = R1CS.nPublic;
  const a: Coef[] = [
    ...R1CS.a,
    ...Array.from({ length: nPublic + 1 }, (_, i) => ({
      row: R1CS.nConstraints + i,
      signal: i,
      value: 1n,
    })),
  ];
  const u = atTau(a, t.tau, nVars);
  const v = atTau(R1CS.b, t.tau, nVars);
  const w = atTau(R1CS.c, t.tau, nVars);
  const q = (i: number) =>
    Fr.add(Fr.add(Fr.mul(t.beta, u[i] as bigint), Fr.mul(t.alpha, v[i] as bigint)), w[i] as bigint);
  const ic = Array.from({ length: nPublic + 1 }, (_, i) => mul1(Fr.div(q(i), t.gamma)));
  const c = Array.from({ length: nVars - nPublic - 1 }, (_, i) =>
    mul1(Fr.div(q(nPublic + 1 + i), t.delta)),
  );
  const h = Array.from({ length: N }, (_, i) =>
    mul1(Fr.div(lagrange(2 * N, 2 * i + 1, t.tau), t.delta)),
  );
  return {
    zkey: {
      nVars,
      nPublic,
      domainSize: N,
      alpha1: mul1(t.alpha),
      beta1: mul1(t.beta),
      beta2: mul2(t.beta),
      gamma2: mul2(t.gamma),
      delta1: mul1(t.delta),
      delta2: mul2(t.delta),
      ic,
      a,
      b: R1CS.b,
      aPoints: u.map(mul1),
      b1Points: v.map(mul1),
      b2Points: v.map(mul2),
      c,
      h,
    },
    ptau: powers(t.tau),
  };
}

const HONEST = honest();
const ALL_CHECKS = checkCrs(HONEST.zkey, HONEST.ptau, R1CS);

function failure(zkey: Zkey, ptau: Powers = HONEST.ptau, r1cs: R1cs = R1CS): string {
  try {
    checkCrs(zkey, ptau, r1cs);
  } catch (e) {
    if (e instanceof CrsCheckError) return e.message;
    throw e;
  }
  return "passed";
}

const bump1 = (points: readonly G1[], i: number) => points.map((p, j) => (j === i ? p.add(G) : p));
const bump2 = (points: readonly G2[], i: number) => points.map((p, j) => (j === i ? p.add(H) : p));

describe("the reference-string check on an honest key", () => {
  test("passes every check", () => {
    expect(ALL_CHECKS).toHaveLength(18);
  });

  test("tolerates any point standing in for the missing power τ^{2N−1} in H", () => {
    // snarkjs's H basis comes from ptau's Lagrange basis on 2N points, which
    // lacks τ^{2N−1}; whatever replaced it adds κ_i·Z to H_i, never used by a
    // proof (A·B − C has degree at most 2N − 2).
    const w2 = rootOfUnity(2 * N);
    const z = G.multiply(0xabcdefn);
    const h = HONEST.zkey.h.map((p, i) => {
      const kappa = Fr.div(Fr.pow(w2, BigInt(2 * i + 1)), BigInt(2 * N));
      return p.add(z.multiply(kappa));
    });
    expect(failure({ ...HONEST.zkey, h })).toBe("passed");
  });
});

describe("the reference-string check rejects", () => {
  const z = HONEST.zkey;
  const cases: [string, Zkey, (Powers | undefined)?, R1cs?][] = [
    ["R1CS shape matches the key", { ...z, nPublic: 2, ic: [...z.ic, G] }],
    [
      "A matrix equals the R1CS's",
      { ...z, a: z.a.map((c, i) => (i === 0 ? { ...c, value: 2n } : c)) },
    ],
    ["B matrix equals the R1CS's", { ...z, b: z.b.slice(1) }],
    ["powers start at the generators", z, { ...HONEST.ptau, g2: bump2(HONEST.ptau.g2, 0) }],
    ["τ ≠ 0", z, powers(0n)],
    ["[τ]_1 and [τ]_2 agree", z, { ...HONEST.ptau, g2: bump2(HONEST.ptau.g2, 1) }],
    ["G1 powers are consecutive", z, { ...HONEST.ptau, g1: bump1(HONEST.ptau.g1, 5) }],
    ["G2 powers are consecutive", z, { ...HONEST.ptau, g2: bump2(HONEST.ptau.g2, 3) }],
    ["τ isn't on the domain", z, powers(1n)],
    ["α, β, γ, δ are nonzero", { ...z, gamma2: bn254.G2.Point.ZERO }],
    ["α, β, γ, δ are nonzero", { ...z, delta1: bn254.G1.Point.ZERO }],
    ["[β]_1 and [β]_2 agree", { ...z, beta1: z.beta1.add(G) }],
    ["[δ]_1 and [δ]_2 agree", { ...z, delta2: z.delta2.add(H) }],
    ["A points are [u_i(τ)]_1", { ...z, aPoints: bump1(z.aPoints, 2) }],
    ["B points in G1 are [v_i(τ)]_1", { ...z, b1Points: bump1(z.b1Points, 3) }],
    ["B points in G2 are [v_i(τ)]_2", { ...z, b2Points: bump2(z.b2Points, 2) }],
    ["IC points are [(β·u_i + α·v_i + w_i)(τ)/γ]_1", { ...z, ic: bump1(z.ic, 1) }],
    ["IC points are [(β·u_i + α·v_i + w_i)(τ)/γ]_1", { ...z, gamma2: z.gamma2.add(H) }],
    ["L points are [(β·u_i + α·v_i + w_i)(τ)/δ]_1", { ...z, c: bump1(z.c, 0) }],
    ["H points are [L_{2i+1}(τ)/δ]_1", { ...z, h: bump1(z.h, 2) }],
    // A key built for another C matrix: the L points carry it.
    [
      "L points are [(β·u_i + α·v_i + w_i)(τ)/δ]_1",
      z,
      undefined,
      { ...R1CS, c: R1CS.c.map((c) => (c.signal === 3 ? { ...c, value: 2n } : c)) },
    ],
    // The same through a public signal.
    [
      "IC points are [(β·u_i + α·v_i + w_i)(τ)/γ]_1",
      z,
      undefined,
      { ...R1CS, c: R1CS.c.map((c) => (c.signal === 1 ? { ...c, value: 2n } : c)) },
    ],
    // A key for another τ than the powers'.
    ["A points are [u_i(τ)]_1", honest({ ...T, tau: 0x7654321n }).zkey],
  ];
  test.each(cases)("%s fails when broken", (name, zkey, ptau, r1cs) => {
    expect(ALL_CHECKS).toContain(name);
    expect(failure(zkey, ptau, r1cs)).toBe(name);
  });

  test("an H error outside the tolerated direction", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: N - 1 }),
        fc.bigInt({ min: 1n, max: Fr.ORDER - 1n }),
        (i, k) => {
          const h = HONEST.zkey.h.map((p, j) => (j === i ? p.add(G.multiply(k)) : p));
          expect(failure({ ...HONEST.zkey, h })).toBe("H points are [L_{2i+1}(τ)/δ]_1");
        },
      ),
      // Each run is a whole check, so fewer runs than elsewhere.
      { numRuns: Math.min(numRuns, 8) },
    );
  }, 120_000);
});

describe("polynomials over F_r", () => {
  test("the 2^28-th root of unity is ffjavascript's bn128 Fr.w[28]", () => {
    expect(rootOfUnity(2 ** 28)).toBe(
      0x2a3c09f0a58a7e8500e0a7eb8ef62abc402d111e41112ed49bd61b6e725b19f0n,
    );
    for (const n of [2, 4, 1024, 2 ** 28]) {
      const w = rootOfUnity(n);
      expect(Fr.pow(w, BigInt(n))).toBe(1n);
      expect(Fr.pow(w, BigInt(n / 2))).toBe(Fr.neg(1n));
    }
  });

  test("interpolate gives the polynomial through its values at ω^j", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5 }).chain((log) =>
          fc.array(fc.bigInt({ min: 0n, max: Fr.ORDER - 1n }), {
            minLength: 2 ** log,
            maxLength: 2 ** log,
          }),
        ),
        (evals) => {
          const w = rootOfUnity(evals.length);
          const coeffs = interpolate(evals, w);
          evals.forEach((e, j) => {
            const x = Fr.pow(w, BigInt(j));
            const at = coeffs.reduceRight((acc, c) => Fr.add(Fr.mul(acc, x), c), 0n);
            expect(at).toBe(e);
          });
        },
      ),
      { numRuns },
    );
  });
});

// --- The file formats, with encoders written from the format descriptions. ---

const MONT = (1n << 256n) % Fp.ORDER;
function le(v: bigint, n = 32): number[] {
  return Array.from({ length: n }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn));
}
const u32 = (v: number) => le(BigInt(v), 4);
const mont = (v: bigint) => le(Fp.mul(v, MONT));
function g1(p: G1): number[] {
  if (p.is0()) return Array(64).fill(0);
  const { x, y } = p.toAffine();
  return [...mont(x), ...mont(y)];
}
function g2(p: G2): number[] {
  if (p.is0()) return Array(128).fill(0);
  const { x, y } = p.toAffine();
  return [...mont(x.c0), ...mont(x.c1), ...mont(y.c0), ...mont(y.c1)];
}
function file(magic: string, parts: [number, number[]][]): Uint8Array {
  const out = [...new TextEncoder().encode(magic), ...u32(1), ...u32(parts.length)];
  for (const [type, data] of parts) out.push(...u32(type), ...le(BigInt(data.length), 8), ...data);
  return Uint8Array.from(out);
}
const prime = (v: bigint) => [...u32(32), ...le(v)];

function zkeyBytes(z: Zkey): Uint8Array {
  const rr = (1n << 512n) % Fr.ORDER;
  const coefs = [...z.a.map((c) => [0, c] as const), ...z.b.map((c) => [1, c] as const)];
  return file("zkey", [
    [1, u32(1)],
    [
      2,
      [
        ...prime(Fp.ORDER),
        ...prime(Fr.ORDER),
        ...u32(z.nVars),
        ...u32(z.nPublic),
        ...u32(z.domainSize),
        ...g1(z.alpha1),
        ...g1(z.beta1),
        ...g2(z.beta2),
        ...g2(z.gamma2),
        ...g1(z.delta1),
        ...g2(z.delta2),
      ],
    ],
    [3, z.ic.flatMap(g1)],
    [
      4,
      [
        ...u32(coefs.length),
        ...coefs.flatMap(([m, c]) => [
          ...u32(m),
          ...u32(c.row),
          ...u32(c.signal),
          ...le(Fr.mul(c.value, rr)),
        ]),
      ],
    ],
    [5, z.aPoints.flatMap(g1)],
    [6, z.b1Points.flatMap(g1)],
    [7, z.b2Points.flatMap(g2)],
    [8, z.c.flatMap(g1)],
    [9, z.h.flatMap(g1)],
    [10, u32(0)],
  ]);
}

function ptauBytes(p: Powers): Uint8Array {
  return file("ptau", [
    [1, [...prime(Fp.ORDER), ...u32(p.power), ...u32(28)]],
    [2, p.g1.flatMap(g1)],
    [3, p.g2.flatMap(g2)],
  ]);
}

function r1csBytes(r: R1cs): Uint8Array {
  const lc = (m: readonly Coef[], row: number) => {
    const terms = m.filter((c) => c.row === row);
    return [...u32(terms.length), ...terms.flatMap((c) => [...u32(c.signal), ...le(c.value)])];
  };
  const rows = Array.from({ length: r.nConstraints }, (_, row) => [
    ...lc(r.a, row),
    ...lc(r.b, row),
    ...lc(r.c, row),
  ]).flat();
  return file("r1cs", [
    [
      1,
      [
        ...prime(Fr.ORDER),
        ...u32(r.nWires),
        ...u32(r.nPublic),
        ...u32(0),
        ...u32(1),
        ...le(BigInt(r.nWires), 8),
        ...u32(r.nConstraints),
      ],
    ],
    [2, rows],
  ]);
}

describe("the file parsers", () => {
  const zb = zkeyBytes(HONEST.zkey);
  const pb = ptauBytes(HONEST.ptau);
  const rb = r1csBytes(R1CS);

  test("read back the honest key, powers and circuit, which pass", () => {
    const zkey = parseZkey(zb);
    const ptau = parsePtau(pb, 2 * N - 1, N);
    const r1cs = parseR1cs(rb);
    expect(zkey.nVars).toBe(4);
    expect(zkey.a).toEqual(HONEST.zkey.a);
    expect(zkey.h.every((p, i) => p.equals(HONEST.zkey.h[i] as G1))).toBe(true);
    expect(r1cs).toEqual(R1CS);
    expect(checkCrs(zkey, ptau, r1cs)).toEqual(ALL_CHECKS);
  });

  const at = (bytes: Uint8Array, offset: number, patch: number[]) => {
    const out = Uint8Array.from(bytes);
    out.set(patch, offset);
    return out;
  };
  // Section 2 of the zkey starts after the 12-byte file header, section 1
  // (12 + 4 bytes) and its own 12-byte header; alpha1 follows the two primes
  // and three counts.
  const alphaAt = 12 + 16 + 12 + 36 + 36 + 12;
  // The first coefficient: after section 2 (660 bytes), section 3 (two IC
  // points) and section 4's header and count.
  const coefAt = 12 + 16 + 12 + 660 + 12 + 128 + 12 + 4;

  test.each([
    ["a wrong magic", () => parseZkey(at(zb, 0, [0x78]))],
    ["trailing bytes", () => parseZkey(Uint8Array.from([...zb, 0]))],
    ["a truncated file", () => parseZkey(zb.subarray(0, zb.length - 1))],
    ["a coordinate at or above p", () => parseZkey(at(zb, alphaAt, le(Fp.ORDER)))],
    ["a point off the curve", () => parseZkey(at(zb, alphaAt + 32, mont(5n)))],
    ["a field other than BN254's", () => parseZkey(at(zb, 12 + 16 + 12 + 4, [0]))],
    [
      "a repeated section",
      () => parseZkey(at(Uint8Array.from([...zb, ...zb.subarray(12, 28)]), 8, u32(11))),
    ],
    ["too few powers", () => parsePtau(pb, 2 * N, N)],
    ["a non-canonical R1CS coefficient", () => parseR1cs(at(rb, rb.length - 32, le(Fr.ORDER)))],
    ["a coefficient matrix other than A or B", () => parseZkey(at(zb, coefAt, u32(2)))],
    ["a coefficient row outside the domain", () => parseZkey(at(zb, coefAt + 4, u32(N)))],
    ["a non-canonical zkey coefficient", () => parseZkey(at(zb, coefAt + 12, le(Fr.ORDER)))],
    ["an unknown zkey section", () => parseZkey(at(zb, zb.length - 16, u32(11)))],
  ])("reject %s", (_, run) => {
    expect(run).toThrow(CrsCheckError);
  });

  test("reject a G2 point outside the order-r subgroup", () => {
    // A point on the twist of order dividing the cofactor times r: x = 1 + i
    // generates one; search the first x with a square y² = x³ + b'.
    const { Fp2 } = bn254.fields;
    const b2 = Fp2.div(Fp2.create({ c0: 3n, c1: 0n }), Fp2.create({ c0: 9n, c1: 1n }));
    let x = Fp2.create({ c0: 1n, c1: 0n });
    let y: ReturnType<typeof Fp2.sqrt> | undefined;
    for (;;) {
      try {
        y = Fp2.sqrt(Fp2.add(Fp2.mul(Fp2.sqr(x), x), b2));
        break;
      } catch {
        x = Fp2.add(x, Fp2.ONE);
      }
    }
    const offset = alphaAt + 64 + 64; // beta2
    const bad = at(zb, offset, [...mont(x.c0), ...mont(x.c1), ...mont(y.c0), ...mont(y.c1)]);
    expect(() => parseZkey(bad)).toThrow("outside the order-r subgroup");
  });
});

// The real check: Semaphore's depth-32 key against ppot_0080_14.ptau and the
// R1CS compiled from Semaphore 4.13.0's circuit (docs/spec/membership.md,
// Reference-string check). It needs those three files, about 25 MB that
// aren't in the repository, and runs only when MEMBERSHIP_CRS_DIR names a
// directory holding them.
describe("Semaphore's depth-32 key", () => {
  const dir = process.env["MEMBERSHIP_CRS_DIR"];

  test("the spec records the pinned inputs", () => {
    const spec = readFileSync(new URL("../../../docs/spec/membership.md", import.meta.url), "utf8");
    for (const hash of [MEMBERSHIP_ZKEY_SHA256, PTAU_SHA256, R1CS_SHA256])
      expect(spec).toContain(hash);
    for (const name of ALL_CHECKS) expect(spec).toContain(name);
  });

  test.skipIf(dir === undefined)(
    "is well formed",
    () => {
      const read = (name: string) => readFileSync(join(dir as string, name));
      const record = checkFiles(
        read("semaphore-32.zkey"),
        read("ppot_0080_14.ptau"),
        read("semaphore-32.r1cs"),
      );
      expect(record.checks).toEqual(ALL_CHECKS);
    },
    20 * 60_000,
  );
});
