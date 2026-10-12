// The public check of the membership proving key's reference string
// (docs/spec/membership.md, Security notes; P1-17b part 2; T-07, T-12).
//
// Groth16 is perfectly zero-knowledge when its reference string is well
// formed (Groth, EUROCRYPT 2016), and only then against a subverted setup
// (Fuchsbauer, PKC 2018; Abdolmaleki, Baghery, Lipmaa and Zając, ASIACRYPT
// 2017). This script checks that `semaphore-32.zkey`, with the circuit's R1CS
// and the powers of tau it was built from, is exactly an honest Groth16 key:
// that there are `α`, `β`, `γ ≠ 0`, `δ ≠ 0` and `τ` (with `τ^N ≠ 1`) such that
// every point equals its formula. Then for any witness of the circuit an
// honest proof's `A` and `B` are uniform and independent of it (through `r`
// and `s`), and `C` is fixed by `A`, `B` and the public signals through the
// verification equation, so a proof says nothing about the witness, whoever
// ran the ceremony.
//
// The powers of tau aren't trusted: they are checked here as consecutive
// powers of one `τ`, in G1 and G2. Each family of equations is checked as one
// random linear combination with fresh CSPRNG scalars, so a single wrong point
// passes with probability at most 1/r per family (small-exponent batching,
// Bellare, Garay and Rabin, EUROCRYPT 1998); every point is first decoded
// canonically and checked in its order-r group, which that argument needs.
// The polynomial arithmetic (Lagrange bases, by FFT over F_r) only computes
// the public scalars the combinations need; every group and pairing
// operation is @noble/curves'.
//
// Formats: snarkjs's zkey (version 1, Groth16), the iden3 R1CS (version 1) and
// snarkjs's ptau (version 1), little-endian, field elements in Montgomery
// form in the zkey and ptau. Run with
//
//   vp node packages/crypto/scripts/membership-crs-check.ts <zkey> <ptau> <r1cs>
//
// (docs/spec/membership.md, Reference-string check, has the inputs and
// their sources).

import { pippenger } from "@noble/curves/abstract/curve.js";
import { bn254 } from "@noble/curves/bn254.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { readFileSync } from "node:fs";
import { argv } from "node:process";
import { pathToFileURL } from "node:url";
import { MEMBERSHIP_ZKEY_SHA256, membershipVkEncoding } from "../src/membership-proof.ts";

type G1 = InstanceType<typeof bn254.G1.Point>;
type G2 = InstanceType<typeof bn254.G2.Point>;

const { Fp, Fp2, Fp12, Fr } = bn254.fields;
const P = Fp.ORDER;
const R = Fr.ORDER;
const G1Point = bn254.G1.Point;
const G2Point = bn254.G2.Point;

/** sha256 of `ppot_0080_14.ptau`, the prepared powers of tau Semaphore's key was built from. */
export const PTAU_SHA256 = "3ca1149e9349b22b0ee0649399cfb787677129b7b1189d1899fc0d615d9583db";
/** sha256 of `semaphore-32.r1cs`, compiled as docs/spec/membership.md describes. */
export const R1CS_SHA256 = "82ffde9b18278ae0881a6fcfcc7884ad97fd69db94534779a8923182e9f4780b";

export class CrsCheckError extends Error {}

function fail(message: string): never {
  throw new CrsCheckError(message);
}

// --- Binary files: iden3's sectioned format (zkey, ptau, r1cs). ---

class View {
  readonly bytes: Uint8Array;
  private readonly dv: DataView;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u32(at: number): number {
    if (at + 4 > this.bytes.length) fail("truncated");
    return this.dv.getUint32(at, true);
  }
  u64(at: number): number {
    if (at + 8 > this.bytes.length) fail("truncated");
    const v = this.dv.getBigUint64(at, true);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) fail("section too large");
    return Number(v);
  }
  /** An unsigned little-endian integer of `n` bytes. */
  le(at: number, n: number): bigint {
    if (at + n > this.bytes.length) fail("truncated");
    let v = 0n;
    for (let i = at + n - 1; i >= at; i--) v = (v << 8n) | BigInt(this.bytes[i] as number);
    return v;
  }
}

/**
 * The sections of a sectioned file, by type. Every section type appears at
 * most once, and the sections cover the file exactly, so no bytes are ignored
 * silently.
 */
function sections(bytes: Uint8Array, magic: string): Map<number, View> {
  const v = new View(bytes);
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== magic) fail(`${magic}: bad magic`);
  if (v.u32(4) !== 1) fail(`${magic}: unsupported version`);
  const count = v.u32(8);
  const out = new Map<number, View>();
  let at = 12;
  for (let i = 0; i < count; i++) {
    const type = v.u32(at);
    const size = v.u64(at + 4);
    at += 12;
    if (at + size > bytes.length) fail(`${magic}: section ${type} truncated`);
    if (out.has(type)) fail(`${magic}: section ${type} repeated`);
    out.set(type, new View(bytes.subarray(at, at + size)));
    at += size;
  }
  if (at !== bytes.length) fail(`${magic}: trailing bytes`);
  return out;
}

function section(s: Map<number, View>, type: number, size?: number): View {
  const v = s.get(type);
  if (v === undefined) fail(`section ${type} missing`);
  if (size !== undefined && v.bytes.length !== size) fail(`section ${type}: wrong size`);
  return v;
}

/** `2^256 mod p`'s inverse: Montgomery form stores `x·2^256 mod p`. */
const MONT_INV = Fp.inv(Fp.create(1n << 256n));

function montFp(v: View, at: number): bigint {
  const raw = v.le(at, 32);
  if (raw >= P) fail("non-canonical field element");
  return Fp.mul(raw, MONT_INV);
}

/** A G1 point in snarkjs's encoding: all zeros is the identity. */
function g1At(v: View, at: number): G1 {
  if (v.bytes.subarray(at, at + 64).every((b) => b === 0)) {
    if (at + 64 > v.bytes.length) fail("truncated");
    return G1Point.ZERO;
  }
  const x = montFp(v, at);
  const y = montFp(v, at + 32);
  try {
    const p = G1Point.fromAffine({ x, y });
    p.assertValidity(); // On the curve; G1's cofactor is 1.
    return p;
  } catch {
    return fail("G1 point not on the curve");
  }
}

/** A G2 point (`x.c0 ‖ x.c1 ‖ y.c0 ‖ y.c1`); all zeros is the identity. */
function g2At(v: View, at: number): G2 {
  if (v.bytes.subarray(at, at + 128).every((b) => b === 0)) {
    if (at + 128 > v.bytes.length) fail("truncated");
    return G2Point.ZERO;
  }
  const x = Fp2.create({ c0: montFp(v, at), c1: montFp(v, at + 32) });
  const y = Fp2.create({ c0: montFp(v, at + 64), c1: montFp(v, at + 96) });
  try {
    const p = G2Point.fromAffine({ x, y });
    // On the twist and in the order-r subgroup: batching (below) is sound
    // only in a group of prime order.
    p.assertValidity();
    return p;
  } catch {
    return fail("G2 point not on the twist or outside the order-r subgroup");
  }
}

const g1s = (v: View, at: number, n: number) =>
  Array.from({ length: n }, (_, i) => g1At(v, at + 64 * i));
const g2s = (v: View, at: number, n: number) =>
  Array.from({ length: n }, (_, i) => g2At(v, at + 128 * i));

/** One entry of a sparse matrix: `matrix[row][signal] = value`. */
export interface Coef {
  readonly row: number;
  readonly signal: number;
  readonly value: bigint;
}

/** The parts of a Groth16 zkey that the prover uses (sections 1 to 9). */
export interface Zkey {
  readonly nVars: number;
  readonly nPublic: number;
  readonly domainSize: number;
  readonly alpha1: G1;
  readonly beta1: G1;
  readonly beta2: G2;
  readonly gamma2: G2;
  readonly delta1: G1;
  readonly delta2: G2;
  /** `IC_i`, for the constant and the public signals. */
  readonly ic: readonly G1[];
  /** The prover's A and B matrices (snarkjs's coefficient section). */
  readonly a: readonly Coef[];
  readonly b: readonly Coef[];
  readonly aPoints: readonly G1[];
  readonly b1Points: readonly G1[];
  readonly b2Points: readonly G2[];
  /** The private signals' `L_i`. */
  readonly c: readonly G1[];
  readonly h: readonly G1[];
}

/** Checks the field moduli in a header: base `q` (and scalar `r` where given). */
function checkPrime(v: View, at: number, want: bigint, what: string): number {
  if (v.u32(at) !== 32) fail(`${what}: field size isn't 32 bytes`);
  if (v.le(at + 4, 32) !== want) fail(`${what}: not BN254`);
  return at + 36;
}

export function parseZkey(bytes: Uint8Array): Zkey {
  const s = sections(bytes, "zkey");
  for (const type of s.keys()) if (type < 1 || type > 10) fail(`zkey: unknown section ${type}`);
  if (section(s, 1, 4).u32(0) !== 1) fail("zkey: not Groth16");
  const h = section(s, 2, 660);
  let at = checkPrime(h, 0, P, "zkey");
  at = checkPrime(h, at, R, "zkey");
  const nVars = h.u32(at);
  const nPublic = h.u32(at + 4);
  const domainSize = h.u32(at + 8);
  at += 12;
  if (domainSize < 2 || (domainSize & (domainSize - 1)) !== 0)
    fail("zkey: domain isn't a power of 2");
  if (nPublic + 1 > nVars) fail("zkey: more public signals than signals");
  const alpha1 = g1At(h, at);
  const beta1 = g1At(h, at + 64);
  const beta2 = g2At(h, at + 128);
  const gamma2 = g2At(h, at + 256);
  const delta1 = g1At(h, at + 384);
  const delta2 = g2At(h, at + 448);
  const nPrivate = nVars - nPublic - 1;
  const coefSection = section(s, 4);
  const nCoef = coefSection.u32(0);
  if (coefSection.bytes.length !== 4 + 44 * nCoef) fail("zkey: coefficient section size");
  const a: Coef[] = [];
  const b: Coef[] = [];
  for (let i = 0; i < nCoef; i++) {
    const o = 4 + 44 * i;
    const matrix = coefSection.u32(o);
    const row = coefSection.u32(o + 4);
    const signal = coefSection.u32(o + 8);
    if (row >= domainSize || signal >= nVars) fail("zkey: coefficient out of range");
    // snarkjs stores each coefficient in Montgomery form times 2^256 again
    // (its prover multiplies in Montgomery form), so it divides out twice.
    const raw = coefSection.le(o + 12, 32);
    if (raw >= R) fail("zkey: non-canonical coefficient");
    const value = Fr.mul(Fr.mul(raw, FR_MONT_INV), FR_MONT_INV);
    if (matrix === 0) a.push({ row, signal, value });
    else if (matrix === 1) b.push({ row, signal, value });
    else fail("zkey: coefficient matrix isn't A or B");
  }
  return {
    nVars,
    nPublic,
    domainSize,
    alpha1,
    beta1,
    beta2,
    gamma2,
    delta1,
    delta2,
    ic: g1s(section(s, 3, 64 * (nPublic + 1)), 0, nPublic + 1),
    a,
    b,
    aPoints: g1s(section(s, 5, 64 * nVars), 0, nVars),
    b1Points: g1s(section(s, 6, 64 * nVars), 0, nVars),
    b2Points: g2s(section(s, 7, 128 * nVars), 0, nVars),
    c: g1s(section(s, 8, 64 * nPrivate), 0, nPrivate),
    h: g1s(section(s, 9, 64 * domainSize), 0, domainSize),
  };
}

const FR_MONT_INV = Fr.inv(Fr.create(1n << 256n));

/** `[τ^i]_1` for `i < count1` and `[τ^i]_2` for `i < count2`, from a ptau file. */
export interface Powers {
  readonly power: number;
  readonly g1: readonly G1[];
  readonly g2: readonly G2[];
}

export function parsePtau(bytes: Uint8Array, count1: number, count2: number): Powers {
  const s = sections(bytes, "ptau");
  const h = section(s, 1);
  const at = checkPrime(h, 0, P, "ptau");
  const power = h.u32(at);
  if (power > 28) fail("ptau: power above 28");
  const tauG1 = section(s, 2, 64 * (2 ** (power + 1) - 1));
  const tauG2 = section(s, 3, 128 * 2 ** power);
  if (count1 > 2 ** (power + 1) - 1 || count2 > 2 ** power) fail("ptau: too few powers");
  return { power, g1: g1s(tauG1, 0, count1), g2: g2s(tauG2, 0, count2) };
}

/** An R1CS: `nPublic` counts outputs and public inputs; constraint rows are `(A, B, C)`. */
export interface R1cs {
  readonly nWires: number;
  readonly nPublic: number;
  readonly nConstraints: number;
  readonly a: readonly Coef[];
  readonly b: readonly Coef[];
  readonly c: readonly Coef[];
}

export function parseR1cs(bytes: Uint8Array): R1cs {
  const s = sections(bytes, "r1cs");
  const h = section(s, 1, 64);
  const at = checkPrime(h, 0, R, "r1cs");
  const nWires = h.u32(at);
  const nPublic = h.u32(at + 4) + h.u32(at + 8);
  const nConstraints = h.u32(at + 24);
  const cs = section(s, 2);
  const out: [Coef[], Coef[], Coef[]] = [[], [], []];
  let o = 0;
  for (let row = 0; row < nConstraints; row++)
    for (const m of out) {
      const terms = cs.u32(o);
      o += 4;
      for (let t = 0; t < terms; t++) {
        const signal = cs.u32(o);
        const value = cs.le(o + 4, 32); // Plain form, not Montgomery.
        if (signal >= nWires || value >= R) fail("r1cs: bad term");
        m.push({ row, signal, value });
        o += 36;
      }
    }
  if (o !== cs.bytes.length) fail("r1cs: constraint section size");
  return { nWires, nPublic, nConstraints, a: out[0], b: out[1], c: out[2] };
}

// --- Polynomials over F_r. ---

/**
 * The primitive `n`-th root of unity snarkjs (ffjavascript) uses: `g^t` for
 * the smallest quadratic non-residue `g`, with `r − 1 = 2^s·t`, squared down to
 * order `n`. Constraint `j` sits at `ω^j`, so any other root fails the checks.
 */
export function rootOfUnity(n: number): bigint {
  let s = 0;
  let t = R - 1n;
  while ((t & 1n) === 0n) {
    s++;
    t >>= 1n;
  }
  let g = 2n;
  while (Fr.pow(g, (R - 1n) / 2n) !== R - 1n) g++;
  let w = Fr.pow(g, t);
  const log = Math.log2(n);
  if (!Number.isInteger(log) || log > s) fail("no root of unity of that order");
  for (let i = s; i > log; i--) w = Fr.sqr(w);
  return w;
}

/** The coefficients of the polynomial taking value `evals[j]` at `ω^j` (inverse FFT). */
export function interpolate(evals: readonly bigint[], omega: bigint): bigint[] {
  const n = evals.length;
  const a = [...evals];
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [a[i], a[j]] = [a[j] as bigint, a[i] as bigint];
  }
  const inv = Fr.inv(omega);
  for (let len = 2; len <= n; len <<= 1) {
    const step = Fr.pow(inv, BigInt(n / len));
    for (let i = 0; i < n; i += len) {
      let w = 1n;
      for (let k = 0; k < len / 2; k++) {
        const u = a[i + k] as bigint;
        const v = Fr.mul(a[i + k + len / 2] as bigint, w);
        a[i + k] = Fr.add(u, v);
        a[i + k + len / 2] = Fr.sub(u, v);
        w = Fr.mul(w, step);
      }
    }
  }
  const nInv = Fr.inv(BigInt(n));
  return a.map((x) => Fr.mul(x, nInv));
}

/** `Σ_i ρ_i·m_i(X)` evaluated on the domain: row `j` gets `Σ ρ_signal·value`. */
function combineRows(m: readonly Coef[], rho: readonly bigint[], n: number): bigint[] {
  const out = Array.from({ length: n }, () => 0n);
  for (const { row, signal, value } of m) {
    const r = rho[signal];
    if (r !== undefined) out[row] = Fr.add(out[row] as bigint, Fr.mul(r, value));
  }
  return out;
}

// --- Group helpers. ---

function scalar(): bigint {
  // 64 bytes reduced mod r: statistically uniform (bias below 2^-250).
  let v = 0n;
  for (const b of randomBytes(64)) v = (v << 8n) | BigInt(b);
  return v % R;
}
const scalars = (n: number) => Array.from({ length: n }, scalar);

const msm1 = (points: readonly G1[], k: readonly bigint[]) =>
  points.length === 0 ? G1Point.ZERO : pippenger(G1Point, [...points], [...k]);
const msm2 = (points: readonly G2[], k: readonly bigint[]) =>
  points.length === 0 ? G2Point.ZERO : pippenger(G2Point, [...points], [...k]);

/** Whether `Π e(g1_i, g2_i) = 1`; a term with the identity contributes 1. */
function pairingsCancel(terms: readonly (readonly [G1, G2])[]): boolean {
  const live = terms.filter(([a, b]) => !a.is0() && !b.is0()).map(([g1, g2]) => ({ g1, g2 }));
  return live.length === 0 || Fp12.eql(bn254.pairingBatch(live), Fp12.ONE);
}

/** EIP-197's encoding of the verification key, as membershipVkEncoding has it. */
function vkEncoding(z: Zkey): Uint8Array {
  const word = (v: bigint) => {
    const out = new Uint8Array(32);
    for (let i = 31; i >= 0; i--, v >>= 8n) out[i] = Number(v & 0xffn);
    return out;
  };
  const g1 = (p: G1) => {
    const { x, y } = p.toAffine();
    return [word(x), word(y)];
  };
  const g2 = (p: G2) => {
    const { x, y } = p.toAffine();
    return [word(x.c1), word(x.c0), word(y.c1), word(y.c0)];
  };
  const parts = [z.alpha1, z.beta2, z.gamma2, z.delta2].flatMap((p) =>
    p instanceof G1Point ? g1(p as G1) : g2(p as G2),
  );
  for (const p of z.ic) parts.push(...g1(p));
  const out = new Uint8Array(parts.length * 32);
  parts.forEach((w, i) => out.set(w, 32 * i));
  return out;
}

// --- The check. ---

/** Sums duplicate entries and drops zeros, so equal matrices compare equal. */
function canonical(m: readonly Coef[]): string[] {
  const sum = new Map<string, bigint>();
  for (const { row, signal, value } of m) {
    const key = `${row}:${signal}`;
    sum.set(key, Fr.add(sum.get(key) ?? 0n, value));
  }
  return [...sum]
    .filter(([, v]) => v !== 0n)
    .map(([k, v]) => `${k}:${v}`)
    .sort();
}

/**
 * Every check, in order; the first that fails throws `CrsCheckError` naming
 * it. Returns the names of the checks that passed.
 */
export function checkCrs(zkey: Zkey, ptau: Powers, r1cs: R1cs): string[] {
  const passed: string[] = [];
  const pass = (name: string, ok: boolean) => {
    if (!ok) fail(name);
    passed.push(name);
  };
  const n = zkey.domainSize;
  const { nVars, nPublic } = zkey;
  const T1 = ptau.g1;
  const T2 = ptau.g2;
  const g1 = G1Point.BASE;
  const g2 = G2Point.BASE;

  // The circuit: the zkey's A and B are the R1CS's, plus snarkjs's rows
  // `A[nConstraints + i][i] = 1` for the constant and each public signal,
  // which make the IC points independent. Its C is the R1CS's.
  pass(
    "R1CS shape matches the key",
    r1cs.nWires === nVars && r1cs.nPublic === nPublic && r1cs.nConstraints + nPublic + 1 <= n,
  );
  const extra = Array.from({ length: nPublic + 1 }, (_, i) => ({
    row: r1cs.nConstraints + i,
    signal: i,
    value: 1n,
  }));
  pass(
    "A matrix equals the R1CS's",
    canonical(zkey.a).join() === canonical([...r1cs.a, ...extra]).join(),
  );
  pass("B matrix equals the R1CS's", canonical(zkey.b).join() === canonical(r1cs.b).join());

  // The powers: [τ^0] are the generators, τ ≠ 0, and each power is τ times
  // the one before, in G1 (to 2N − 2) and G2 (to N − 1).
  pass("powers start at the generators", T1[0]?.equals(g1) === true && T2[0]?.equals(g2) === true);
  pass("τ ≠ 0", T1.length > 1 && !(T1[1] as G1).is0() && T2.length > 1 && !(T2[1] as G2).is0());
  pass(
    "[τ]_1 and [τ]_2 agree",
    pairingsCancel([
      [T1[1] as G1, g2],
      [g1.negate(), T2[1] as G2],
    ]),
  );
  {
    const k = scalars(T1.length - 1);
    pass(
      "G1 powers are consecutive",
      pairingsCancel([
        [msm1(T1.slice(1), k), g2.negate()],
        [msm1(T1.slice(0, -1), k), T2[1] as G2],
      ]),
    );
  }
  {
    const k = scalars(T2.length - 1);
    pass(
      "G2 powers are consecutive",
      pairingsCancel([
        [g1.negate(), msm2(T2.slice(1), k)],
        [T1[1] as G1, msm2(T2.slice(0, -1), k)],
      ]),
    );
  }
  // t(τ) = τ^N − 1 ≠ 0: an honest setup samples τ off the domain.
  pass("τ isn't on the domain", T1.length > n && !(T1[n] as G1).equals(g1));

  // The trapdoor's other elements: nonzero, and β and δ the same in G1 and G2.
  pass(
    "α, β, γ, δ are nonzero",
    [zkey.alpha1, zkey.beta1, zkey.delta1].every((p) => !p.is0()) &&
      [zkey.beta2, zkey.gamma2, zkey.delta2].every((p) => !p.is0()),
  );
  pass(
    "[β]_1 and [β]_2 agree",
    pairingsCancel([
      [zkey.beta1, g2],
      [g1.negate(), zkey.beta2],
    ]),
  );
  pass(
    "[δ]_1 and [δ]_2 agree",
    pairingsCancel([
      [zkey.delta1, g2],
      [g1.negate(), zkey.delta2],
    ]),
  );

  // [u_i(τ)]_1, [v_i(τ)]_1 and [v_i(τ)]_2: Σ ρ_i·P_i against the combined
  // polynomial's coefficients on the powers.
  const omega = rootOfUnity(n);
  const onPowers1 = (m: readonly Coef[], rho: readonly bigint[]) =>
    msm1(T1.slice(0, n), interpolate(combineRows(m, rho, n), omega));
  const onPowers2 = (m: readonly Coef[], rho: readonly bigint[]) =>
    msm2(T2.slice(0, n), interpolate(combineRows(m, rho, n), omega));
  {
    const k = scalars(nVars);
    pass("A points are [u_i(τ)]_1", msm1(zkey.aPoints, k).equals(onPowers1(zkey.a, k)));
  }
  {
    const k = scalars(nVars);
    pass("B points in G1 are [v_i(τ)]_1", msm1(zkey.b1Points, k).equals(onPowers1(zkey.b, k)));
  }
  {
    const k = scalars(nVars);
    pass("B points in G2 are [v_i(τ)]_2", msm2(zkey.b2Points, k).equals(onPowers2(zkey.b, k)));
  }

  // L_i·δ = β·u_i(τ) + α·v_i(τ) + w_i(τ) for private signals, and
  // IC_i·γ the same for public ones. A and B2 are the checked points above.
  const lCheck = (points: readonly G1[], first: number, by: G2) => {
    const k: bigint[] = Array.from({ length: nVars }, () => 0n);
    for (let i = 0; i < points.length; i++) k[first + i] = scalar();
    const ks = k.slice(first, first + points.length);
    return pairingsCancel([
      [msm1(points, ks), by],
      [msm1(zkey.aPoints.slice(first, first + points.length), ks).negate(), zkey.beta2],
      [zkey.alpha1.negate(), msm2(zkey.b2Points.slice(first, first + points.length), ks)],
      [onPowers1(r1cs.c, k).negate(), g2],
    ]);
  };
  pass("IC points are [(β·u_i + α·v_i + w_i)(τ)/γ]_1", lCheck(zkey.ic, 0, zkey.gamma2));
  pass("L points are [(β·u_i + α·v_i + w_i)(τ)/δ]_1", lCheck(zkey.c, nPublic + 1, zkey.delta2));

  // H_i = [L'_{2i+1}(τ)/δ]_1: the Lagrange basis on the 2N domain at its odd
  // points, which the prover weights by A·B − C there. ptau holds no τ^{2N−1},
  // so snarkjs's basis has some fixed point in its place: H_i may carry
  // κ_i·Z for κ_i = ω^{2i+1}/(2N), that coefficient of L_{2i+1}, and any Z.
  // A proof never uses Z, since A·B − C has degree at most 2N − 2 and so
  // Σ h_i·κ_i = 0, its coefficient of X^{2N−1}. The check therefore takes ρ
  // with Σ ρ_i·κ_i = 0, which tests H up to exactly that direction.
  {
    const omega2 = rootOfUnity(2 * n);
    const kappa = Array.from({ length: n }, (_, i) =>
      Fr.div(Fr.pow(omega2, BigInt(2 * i + 1)), BigInt(2 * n)),
    );
    const k = scalars(n);
    let tail = 0n;
    for (let i = 1; i < n; i++) tail = Fr.add(tail, Fr.mul(k[i] as bigint, kappa[i] as bigint));
    k[0] = Fr.neg(Fr.div(tail, kappa[0] as bigint));
    const evals: bigint[] = Array.from({ length: 2 * n }, () => 0n);
    for (let i = 0; i < n; i++) evals[2 * i + 1] = k[i] as bigint;
    const coeffs = interpolate(evals, omega2);
    if (coeffs[2 * n - 1] !== 0n) throw new Error("ρ doesn't annihilate the missing power");
    pass(
      "H points are [L_{2i+1}(τ)/δ]_1",
      pairingsCancel([
        [msm1(zkey.h, k), zkey.delta2],
        [msm1(T1.slice(0, 2 * n - 1), coeffs.slice(0, 2 * n - 1)).negate(), g2],
      ]),
    );
  }
  return passed;
}

/** Runs every check on the files, pinned by sha256, and returns the record. */
export function checkFiles(zkeyBytes: Uint8Array, ptauBytes: Uint8Array, r1csBytes: Uint8Array) {
  const hashes = {
    zkey: bytesToHex(sha256(zkeyBytes)),
    ptau: bytesToHex(sha256(ptauBytes)),
    r1cs: bytesToHex(sha256(r1csBytes)),
  };
  if (hashes.zkey !== MEMBERSHIP_ZKEY_SHA256) fail("zkey isn't the pinned semaphore-32.zkey");
  if (hashes.ptau !== PTAU_SHA256) fail("ptau isn't the pinned ppot_0080_14.ptau");
  if (hashes.r1cs !== R1CS_SHA256) fail("r1cs isn't the pinned semaphore-32.r1cs");
  const zkey = parseZkey(zkeyBytes);
  if (bytesToHex(vkEncoding(zkey)) !== bytesToHex(membershipVkEncoding()))
    fail("zkey's verification key isn't the pinned one");
  const n = zkey.domainSize;
  const ptau = parsePtau(ptauBytes, 2 * n - 1, n);
  const checks = checkCrs(zkey, ptau, parseR1cs(r1csBytes));
  return { sha256: hashes, domainSize: n, nVars: zkey.nVars, nPublic: zkey.nPublic, checks };
}

if (import.meta.url === pathToFileURL(argv[1] ?? "").href) {
  const files = argv.slice(2);
  if (files.length !== 3) throw new Error("usage: membership-crs-check.ts <zkey> <ptau> <r1cs>");
  const [zkey, ptau, r1cs] = files.map((f) => readFileSync(f)) as [Buffer, Buffer, Buffer];
  const record = checkFiles(zkey, ptau, r1cs);
  console.log(JSON.stringify({ result: "well formed", ...record }, null, 2));
}
