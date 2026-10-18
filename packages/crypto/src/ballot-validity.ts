// Ballot commitments, Pedersen VSS and validity proofs
// (docs/spec/ballot-validity.md; ADR 0002 option B, ADR 0003 option C):
// perfectly hiding commitments to each option's vote, shared among the
// trustees with Pedersen VSS (Pedersen 1991; CFSY 1996), and disjunctive
// Schnorr proofs (CDS 1994) that each option holds 0 or 1 and the sum lies in
// the election's range, under Fiat–Shamir challenges that bind the whole
// statement (T-15, T-28, T-30, T-32). Group operations and hashes are
// @noble's; this module only composes them.

import { randomBytes } from "@noble/hashes/utils.js";
import {
  bytesFixed,
  type Codec,
  encode,
  fieldBn254,
  list,
  type CodecValue,
  struct,
  u16,
  u8,
  Writer,
} from "./codec.ts";
import { ds, type SpecifiedTagOf } from "./domain-separation.ts";
import {
  challenge,
  type Element,
  element,
  elementOrIdentity,
  G,
  GENERATOR_H,
  GROUP_ORDER,
  H,
  IDENTITY,
  scalar,
} from "./group.ts";
import { PARAMETERS } from "./parameters.ts";

const { MAX_OPTIONS, MAX_TRUSTEES } = PARAMETERS;

/** The ballot record type, and the version whose share ciphertexts this module's shares use. */
export const BALLOT_RECORD_TYPE = 0x0002;
export const BALLOT_VERSION = 1;

/** The ballot versions whose proof rules this module implements: 1 names a tier, 2 a cell. */
export type BallotVersion = 1 | 2;

const bitProof = struct([
  ["c0", scalar],
  ["z0", scalar],
  ["c1", scalar],
  ["z1", scalar],
]);
const branch = struct([
  ["c", scalar],
  ["z", scalar],
]);

/** `bit_proof`: the two branches of an option proof, value 0 then value 1. */
export type BitProof = CodecValue<typeof bitProof>;
/** `branch`: one branch of the sum proof. */
export type Branch = { readonly c: bigint; readonly z: bigint };

/**
 * The committed vote a ballot carries (docs/spec/ballot-validity.md,
 * Committed vote). Counts are bounded here by the protocol maxima and checked
 * against the election by `checkValidity` (`validity-shape`). `VSS` is
 * exported internally for share encryption's associated data.
 */
export const VSS = list(list(element, MAX_TRUSTEES), MAX_OPTIONS);
const SHARE_HASHES = list(bytesFixed(32), MAX_TRUSTEES);

export const COMMITTED_VOTE = struct([
  ["vss", VSS],
  ["share_hashes", SHARE_HASHES],
  ["option_proofs", list(bitProof, MAX_OPTIONS)],
  ["sum_proof", list(branch, MAX_OPTIONS + 1)],
]);

export type CommittedVote = CodecValue<typeof COMMITTED_VOTE>;

const share = struct([
  ["v", scalar],
  ["r", scalar],
]);

/** One option's share for one trustee: `(f_j(i), g_j(i))`. */
export type Share = { readonly v: bigint; readonly r: bigint };

/** The shares one trustee receives for one ballot, one per option. */
export const SHARES: Codec<readonly Share[]> = list(share, MAX_OPTIONS);

/** The election's rules a ballot is shared and proved under, from its registered definition. */
export interface ValidityRules {
  readonly optionCount: number;
  readonly minSelections: number;
  readonly maxSelections: number;
  /** `k`: the polynomials' degree is `k − 1`. */
  readonly threshold: number;
  /** `n`: shares go to trustees 1 to `n`. */
  readonly panelSize: number;
}

/**
 * Everything a ballot's proofs are checked against, taken from context the
 * verifier has already checked, never from the ballot's committed vote
 * (docs/spec/ballot-validity.md, Context).
 */
export type ValidityContext = ValidityRules & BallotHashContext;

/**
 * What a ballot names beside its nullifier: under version 1 its tier, under
 * version 2 its cell's position in the partition (docs/spec/ballot-validity.md,
 * Ballot record (version 2); 0019-regional-cells). Either is the `u8` after
 * the version in the statement and ballot hashes.
 */
export type BallotLabel =
  | { readonly ballotVersion?: 1; readonly tier: number }
  | { readonly ballotVersion: 2; readonly cell: number };

export type ValidityCode = "validity-shape" | "option-proof" | "sum-proof";

export type ValidityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ValidityCode; readonly option?: number };

const mod = (x: bigint) => ((x % GROUP_ORDER) + GROUP_ORDER) % GROUP_ORDER;

// @noble rejects a multiplier of 0, which proofs legitimately use.
function mul(p: Element, s: bigint): Element {
  const e = mod(s);
  return e === 0n ? IDENTITY : p.multiply(e);
}

/** `g^v · h^r`. */
function pedersen(v: bigint, r: bigint): Element {
  return mul(G, v).add(mul(GENERATOR_H, r));
}

/**
 * `g^v · h^r` for a vote `v` of 0 or 1, computed as `g^{v+1} · g^{−1}` so the
 * same full scalar multiplication runs whatever the vote: `mul` would skip
 * one exactly when `v = 0` (docs/spec/ballot-validity.md, Residuals).
 */
function commitVote(v: bigint, r: bigint): Element {
  return G.multiply(v + 1n)
    .subtract(G)
    .add(mul(GENERATOR_H, r));
}

function checkRules(rules: ValidityRules): void {
  const { optionCount: m, minSelections: min, maxSelections: max, threshold: k } = rules;
  const n = rules.panelSize;
  const int = (x: unknown) => Number.isSafeInteger(x);
  if (![m, min, max, k, n].every(int)) throw new TypeError("rules: expected integers");
  if (m < 1 || m > MAX_OPTIONS) throw new RangeError("rules: optionCount out of range");
  if (min < 0 || min > max || max > m) throw new RangeError("rules: selections out of range");
  if (k < 2 || k > n || n > MAX_TRUSTEES) throw new RangeError("rules: panel out of range");
}

function checkContext(ctx: ValidityContext): void {
  checkRules(ctx);
  checkBallotContext(ctx);
}

function checkBallotContext(ctx: BallotHashContext): void {
  const d = ctx.definitionHash;
  if (!(d instanceof Uint8Array) || !ArrayBuffer.isView(d) || new Uint8Array(d).length !== 32)
    throw new TypeError("context: definitionHash must be 32 bytes");
  labelOf(ctx);
}

/**
 * The ballot version and the `u8` it names, read once. A context naming both
 * a tier and a cell is refused, so no caller can mean one and hash the other.
 */
export function labelOf(ctx: BallotLabel): {
  readonly version: BallotVersion;
  readonly label: number;
} {
  const version = ctx.ballotVersion ?? 1;
  let label: unknown;
  if (version === 1 && !("cell" in ctx)) label = (ctx as { readonly tier: unknown }).tier;
  else if (version === 2 && !("tier" in ctx)) label = (ctx as { readonly cell: unknown }).cell;
  else throw new RangeError("context: expected ballot version 1 with a tier or 2 with a cell");
  if (!Number.isSafeInteger(label) || (label as number) < 0 || (label as number) > 0xff)
    throw new RangeError("context: the tier or cell must be a u8");
  return { version, label: label as number };
}

/**
 * `statement_hash`: the digest every validity proof of the ballot binds
 * (docs/spec/ballot-validity.md, Statement hash). It covers the election, the
 * ballot version, the tier (version 2: the cell), the nullifier (T-32), every
 * commitment and every share ciphertext's hash (T-30).
 */
export function statementHash(
  ctx: ValidityContext,
  vss: CommittedVote["vss"],
  shareHashes: CommittedVote["share_hashes"],
): Uint8Array {
  checkContext(ctx);
  const { version, label } = labelOf(ctx);
  const w = new Writer();
  w.bytes(new Uint8Array(ctx.definitionHash));
  u16.write(w, BALLOT_RECORD_TYPE);
  u8.write(w, version);
  u8.write(w, label);
  fieldBn254.write(w, ctx.nullifier);
  // Encoded by the ballot's own field codecs, so exactly as the ballot carries them.
  VSS.write(w, vss);
  SHARE_HASHES.write(w, shareHashes);
  return H(ds("abolish/v1/ballot-statement", w.finish()));
}

/** What names a ballot beside its committed vote: the election, its tier or cell, and its nullifier. */
export type BallotHashContext = BallotLabel & {
  readonly definitionHash: Uint8Array;
  readonly nullifier: bigint;
};

/**
 * `ballot_hash`: the hash of the ballot's public part, the statement hash's
 * inputs followed by the validity proofs (docs/spec/ballot-validity.md,
 * Ballot hash). The membership proof's message and every share receipt bind
 * it (T-38, T-41); it leaves out the membership proof, which anyone can
 * re-randomise, and the L1 reference, which `M` binds itself.
 */
export function ballotHash(ctx: BallotHashContext, vote: CommittedVote): Uint8Array {
  checkBallotContext(ctx);
  const { version, label } = labelOf(ctx);
  const w = new Writer();
  w.bytes(new Uint8Array(ctx.definitionHash));
  u16.write(w, BALLOT_RECORD_TYPE);
  u8.write(w, version);
  u8.write(w, label);
  fieldBn254.write(w, ctx.nullifier);
  // vss ‖ share_hashes ‖ option_proofs ‖ sum_proof, exactly as the ballot carries them.
  COMMITTED_VOTE.write(w, vote);
  return H(ds("abolish/v1/ballot", w.finish()));
}

type FsTag = SpecifiedTagOf<"fiat-shamir">;

/** `Y_s = Y · g^{−s}`. */
const shifted = (y: Element, s: number) => y.subtract(mul(G, BigInt(s)));

/** `A_b = h^{z_b} · Y_{s_b}^{−c_b}`, from `Y_{s_b}`: the prover commitment a branch implies. */
const announcement = (yShifted: Element, c: bigint, z: bigint) =>
  mul(GENERATOR_H, z).subtract(mul(yShifted, c));

/** `HashToScalar(prefix ‖ encode(Y) ‖ encode(A_0) ‖ …)` under the proof's tag. */
function orChallenge(tag: FsTag, prefix: Uint8Array, y: Element, a: readonly Element[]): bigint {
  const w = new Writer();
  w.bytes(prefix);
  elementOrIdentity.write(w, y);
  for (const x of a) elementOrIdentity.write(w, x);
  return challenge(tag, w.finish());
}

/** Checks a disjunctive proof that `y` commits to one of `values`, branch `b` for `values[b]`. */
function verifyOr(
  tag: FsTag,
  prefix: Uint8Array,
  y: Element,
  values: readonly number[],
  branches: readonly Branch[],
): boolean {
  if (branches.length !== values.length) return false;
  const a = branches.map((br, b) => announcement(shifted(y, values[b] as number), br.c, br.z));
  const sum = branches.reduce((acc, br) => acc + br.c, 0n);
  return mod(sum) === orChallenge(tag, prefix, y, a);
}

/** The randomness of one disjunctive proof: the real branch's `w`, and `(c, z)` for every other branch in order. */
export interface OrNonces {
  readonly w: bigint;
  readonly simulated: readonly Branch[];
}

/** Proves `y = g^{values[real]} · h^ρ` as one of `values` (docs/spec/ballot-validity.md, Proving). */
function proveOr(
  tag: FsTag,
  prefix: Uint8Array,
  y: Element,
  values: readonly number[],
  real: number,
  rho: bigint,
  nonces: OrNonces,
): Branch[] {
  // Every Y_s first, whatever the real branch: the values are public, so the
  // work here doesn't depend on the vote.
  const ys = values.map((s) => shifted(y, s));
  if (!(ys[real] as Element).equals(mul(GENERATOR_H, rho)))
    throw new RangeError("prove: the commitment doesn't open to the claimed value");
  const { w, simulated } = nonces;
  if (w < 0n || w >= GROUP_ORDER) throw new RangeError("prove: w must be a scalar");
  if (simulated.length !== values.length - 1)
    throw new RangeError("prove: one simulated branch per false value");
  for (const s of simulated)
    if (s.c < 0n || s.c >= GROUP_ORDER || s.z < 0n || s.z >= GROUP_ORDER)
      throw new RangeError("prove: simulated values must be scalars");
  // Branch b's simulated values: the false branches take `simulated` in order.
  const fake = (b: number) => simulated[b < real ? b : b - 1] as Branch;
  const a = values.map((_, b) => {
    if (b === real) return mul(GENERATOR_H, w);
    const { c, z } = fake(b);
    return announcement(ys[b] as Element, c, z);
  });
  const c = orChallenge(tag, prefix, y, a);
  const cReal = mod(c - simulated.reduce((acc, s) => acc + s.c, 0n));
  return values.map((_, b) => (b === real ? { c: cReal, z: mod(w + cReal * rho) } : fake(b)));
}

function optionPrefix(statement: Uint8Array, j: number): Uint8Array {
  const w = new Writer();
  w.bytes(statement);
  u16.write(w, j);
  return w.finish();
}

function sumPrefix(statement: Uint8Array, min: number, max: number): Uint8Array {
  const w = new Writer();
  w.bytes(statement);
  u16.write(w, min);
  u16.write(w, max);
  return w.finish();
}

const range = (min: number, max: number) =>
  Array.from({ length: max - min + 1 }, (_, i) => min + i);

/** `C_Σ`: the product of the options' commitments `E_{j,0}`. */
function commitmentSum(vss: CommittedVote["vss"]): Element {
  return vss.reduce((acc, e) => acc.add(e[0] as Element), IDENTITY);
}

/**
 * `validity-shape` alone: the counts the election fixes. Exported internally
 * so trustee intake can check a ciphertext's hash between the shape and the
 * proofs, which are the costly part (docs/spec/share-encryption.md, Intake).
 */
export function shapeOk(ctx: ValidityContext, vote: CommittedVote): boolean {
  checkContext(ctx);
  const { optionCount: m, minSelections: min, maxSelections: max, threshold: k } = ctx;
  return (
    vote.vss.length === m &&
    vote.vss.every((e) => e.length === k) &&
    vote.share_hashes.length === ctx.panelSize &&
    vote.option_proofs.length === m &&
    vote.sum_proof.length === max - min + 1
  );
}

/**
 * The admission check of docs/spec/ballot-validity.md (Checks; verifier 5.4):
 * shape against the election, then each option proof in order, then the sum
 * proof. The first failure is the result.
 */
export function checkValidity(ctx: ValidityContext, vote: CommittedVote): ValidityResult {
  checkContext(ctx);
  const { optionCount: m, minSelections: min, maxSelections: max } = ctx;
  const { vss, share_hashes, option_proofs, sum_proof } = vote;
  if (!shapeOk(ctx, vote)) return { ok: false, code: "validity-shape" };
  const statement = statementHash(ctx, vss, share_hashes);
  for (let j = 0; j < m; j++) {
    const p = option_proofs[j] as BitProof;
    const branches = [
      { c: p.c0, z: p.z0 },
      { c: p.c1, z: p.z1 },
    ];
    const tag = "abolish/v1/fs/ballot-validity/option";
    if (
      !verifyOr(
        tag,
        optionPrefix(statement, j),
        (vss[j] as readonly Element[])[0] as Element,
        [0, 1],
        branches,
      )
    )
      return { ok: false, code: "option-proof", option: j };
  }
  const tag = "abolish/v1/fs/ballot-validity/sum";
  if (
    !verifyOr(tag, sumPrefix(statement, min, max), commitmentSum(vss), range(min, max), sum_proof)
  )
    return { ok: false, code: "sum-proof" };
  return { ok: true };
}

/**
 * Trustee `index`'s check of its shares against the public VSS commitments
 * (Pedersen 1991, Section 4): one share per option, and for each,
 * `g^v · h^r = Π_t E_{j,t}^{index^t}`. A trustee receipts a ballot only if
 * this holds (ADR 0002, Delivery).
 */
export function checkShares(
  vss: CommittedVote["vss"],
  index: number,
  shares: readonly Share[],
): boolean {
  if (!Number.isSafeInteger(index) || index < 1 || index > MAX_TRUSTEES)
    throw new RangeError("checkShares: index must be a trustee seat from 1");
  if (shares.length !== vss.length) return false;
  const x = BigInt(index);
  return vss.every((e, j) => shareHolds(e, x, pedersen, shares[j] as Share));
}

/**
 * `checkShares` over every option, never stopping at the first that fails,
 * and with each share's scalars blinded, so the curve work it does doesn't
 * tell which option failed, whether one did, or whether a scalar was zero:
 * for a check whose timing the sender of the shares can see
 * (docs/spec/tally.md, Summed-share message, Notes; T-39).
 */
export function checkEveryShare(
  vss: CommittedVote["vss"],
  index: number,
  shares: readonly Share[],
): boolean {
  if (!Number.isSafeInteger(index) || index < 1 || index > MAX_TRUSTEES)
    throw new RangeError("checkEveryShare: index must be a trustee seat from 1");
  if (shares.length !== vss.length) return false;
  const x = BigInt(index);
  let ok = true;
  for (const [j, e] of vss.entries())
    ok = shareHolds(e, x, blindedPedersen, shares[j] as Share) && ok;
  return ok;
}

/** One option's check: `g^v · h^r = Π_t E_t^{x^t}`, by Horner's rule: `((E_{k−1})^x · E_{k−2})^x · … · E_0`. */
function shareHolds(
  e: CommittedVote["vss"][number],
  x: bigint,
  commit: (v: bigint, r: bigint) => Element,
  s: Share,
): boolean {
  let acc = IDENTITY;
  for (let t = e.length - 1; t >= 0; t--) acc = mul(acc, x).add(e[t] as Element);
  return acc.equals(commit(s.v, s.r));
}

/**
 * `g^v · h^r` as `g^{v+c} · g^{−c} · h^{r+d} · h^{−d}`, with `c` and `d`
 * fresh from the CSPRNG: `mul` skips a zero scalar, which a sender choosing
 * the shares could otherwise pick to time, and it can't predict `v + c`.
 */
function blindedPedersen(v: bigint, r: bigint): Element {
  const c = randomScalar();
  const d = randomScalar();
  return mul(G, mod(v + c))
    .subtract(mul(G, c))
    .add(mul(GENERATOR_H, mod(r + d)))
    .subtract(mul(GENERATOR_H, d));
}

/** One option's sharing polynomials: `f` holds the vote then `a_1 … a_{k−1}`, `g` holds `r` then `b_1 … b_{k−1}`. */
export interface OptionPolynomials {
  readonly f: readonly bigint[];
  readonly g: readonly bigint[];
}

/**
 * The client's secret state between sharing and proving: the vote, its
 * polynomials, the public VSS commitments and every trustee's shares. Only
 * `shareVote` makes one, frozen, and `proveValidity` refuses any other. The
 * caller drops every reference once the voter casts: JavaScript can't zeroise
 * a `bigint` (ADR 0002; T-18, T-45).
 */
export interface VoteSharing {
  readonly votes: readonly (0 | 1)[];
  readonly polynomials: readonly OptionPolynomials[];
  readonly vss: CommittedVote["vss"];
  /** `shares[i − 1]` is trustee `i`'s list. */
  readonly shares: readonly (readonly Share[])[];
}

/**
 * Every sharing `shareVoteWith` or `shareVoteV3With` made, with the ballot
 * version whose rules its votes were checked against: the only sharings the
 * provers and share encryption accept, and each prover only its own
 * version's, so a version-3 sharing is never proved under one sum's limits.
 */
const SHARINGS = new WeakMap<VoteSharing, 1 | 3>();

/** Internal: whether `shareVote` or `shareVoteV3` made this sharing (unchanged, since it is frozen). */
export function isRegisteredSharing(sharing: VoteSharing): boolean {
  return SHARINGS.has(sharing);
}

/** Internal: the ballot version whose rules this sharing's votes were checked against, if it is registered. */
export function sharingVersion(sharing: VoteSharing): 1 | 3 | undefined {
  return SHARINGS.get(sharing);
}

// What each sharing has been used for: proved (the voter chose to cast it) or
// opened (the voter challenged it). One sharing is never both: an opened core
// is never cast, and a cast core's randomness is never revealed
// (docs/spec/challenge.md, Client rules; T-42, T-45).
const SPENT = new WeakMap<VoteSharing | VoteSharingV4, "proved" | "opened">();

/**
 * Internal: marks a sharing as opened by a challenge, or throws if it was
 * proved. Only `openChallenge` calls this; the package entry point doesn't
 * export it.
 */
export function markOpened(sharing: VoteSharing | VoteSharingV4): void {
  if (SPENT.get(sharing) === "proved")
    throw new TypeError("open: this sharing was proved for casting; it is never opened");
  SPENT.set(sharing, "opened");
}

function deepFreeze<T>(value: T): T {
  // Freezes points too (@noble/curves doesn't freeze every point it returns);
  // bigints are immutable.
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function evaluate(coefficients: readonly bigint[], x: bigint): bigint {
  let acc = 0n;
  for (let t = coefficients.length - 1; t >= 0; t--)
    acc = mod(acc * x + (coefficients[t] as bigint));
  return acc;
}

function checkVotes(rules: ValidityRules, votes: readonly number[]): void {
  if (!Array.isArray(votes) || votes.length !== rules.optionCount)
    throw new RangeError("votes: one entry per option");
  if (!votes.every((v) => v === 0 || v === 1)) throw new RangeError("votes: each must be 0 or 1");
  const total = votes.reduce((a, v) => a + v, 0);
  if (total < rules.minSelections || total > rules.maxSelections)
    throw new RangeError("votes: selection count outside the election's range");
}

/**
 * Internal: shares a vote with the given polynomials. Production code calls
 * `shareVote`, which draws them from the CSPRNG; the package entry point
 * doesn't export this, so only tests reproducing vectors can choose them.
 */
export function shareVoteWith(
  rules: ValidityRules,
  votes: readonly (0 | 1)[],
  polynomials: readonly OptionPolynomials[],
): VoteSharing {
  checkRules(rules);
  checkVotes(rules, votes);
  return makeSharing(rules, votes, polynomials, 1);
}

// The sharing of Committed vote over `votes.length` options, which the
// caller has checked against its version's rules.
function makeSharing(
  rules: { readonly threshold: number; readonly panelSize: number },
  votes: readonly (0 | 1)[],
  polynomials: readonly OptionPolynomials[],
  version: 1 | 3,
): VoteSharing {
  const k = rules.threshold;
  if (polynomials.length !== votes.length) throw new RangeError("polynomials: one per option");
  polynomials.forEach((p, j) => {
    if (p.f.length !== k || p.g.length !== k) throw new RangeError("polynomials: k coefficients");
    if (p.f[0] !== BigInt(votes[j] as number))
      throw new RangeError("polynomials: f's constant term is the vote");
    for (const c of [...p.f, ...p.g])
      if (typeof c !== "bigint" || c < 0n || c >= GROUP_ORDER)
        throw new RangeError("polynomials: coefficients must be scalars");
  });
  const vss = polynomials.map((p) =>
    p.f.map((a, t) => {
      const e = t === 0 ? commitVote(a, p.g[0] as bigint) : pedersen(a, p.g[t] as bigint);
      // About 2⁻²⁵² for random coefficients; the codec rejects it, so the
      // caller draws again (docs/spec/ballot-validity.md, Notes).
      if (e.is0()) throw new RangeError("polynomials: a VSS commitment is the identity");
      return e;
    }),
  );
  const shares = Array.from({ length: rules.panelSize }, (_, i) =>
    polynomials.map((p) => ({ v: evaluate(p.f, BigInt(i + 1)), r: evaluate(p.g, BigInt(i + 1)) })),
  );
  // Frozen and registered, so `proveValidity` proves only a sharing made here,
  // never one a caller built or changed: a caller choosing r_j could publish a
  // commitment anyone can open (T-15).
  const sharing: VoteSharing = deepFreeze({
    votes: [...votes],
    polynomials: polynomials.map((p) => ({ f: [...p.f], g: [...p.g] })),
    vss,
    shares,
  });
  SHARINGS.set(sharing, version);
  return sharing;
}

/** Internal: a uniform scalar from the CSPRNG, 64 bytes reduced mod ℓ, within about 2⁻²⁶² of uniform. */
export function randomScalar(): bigint {
  const b = randomBytes(64);
  let v = 0n;
  for (let i = 63; i >= 0; i--) v = (v << 8n) | BigInt(b[i] as number);
  return v % GROUP_ORDER;
}

/** Shares a vote among the trustees, with every coefficient from the CSPRNG (docs/spec/ballot-validity.md, Committed vote). */
export function shareVote(rules: ValidityRules, votes: readonly (0 | 1)[]): VoteSharing {
  checkRules(rules);
  checkVotes(rules, votes);
  return drawSharing(rules.threshold, votes, (p) => shareVoteWith(rules, votes, p));
}

// Draws every coefficient from the CSPRNG and shares, drawing again only
// after an identity VSS commitment (Committed vote, Notes).
function drawSharing(
  k: number,
  votes: readonly (0 | 1)[],
  shareWith: (polynomials: readonly OptionPolynomials[]) => VoteSharing,
): VoteSharing {
  for (;;) {
    const polynomials = votes.map((v) => ({
      f: [BigInt(v), ...Array.from({ length: k - 1 }, randomScalar)],
      g: Array.from({ length: k }, randomScalar),
    }));
    try {
      return shareWith(polynomials);
    } catch (e) {
      // Only an identity VSS commitment is retried; anything else is a bug.
      if (!(e instanceof RangeError && e.message.includes("identity"))) throw e;
    }
  }
}

/** The randomness of a ballot's proofs: one set per option proof, one for the sum proof. */
export interface ValidityNonces {
  readonly options: readonly OrNonces[];
  readonly sum: OrNonces;
}

/**
 * Internal: proves a shared vote valid with the given randomness. Production
 * code calls `proveValidity`; the package entry point doesn't export this.
 */
export function proveValidityWith(
  ctx: ValidityContext,
  sharing: VoteSharing,
  shareHashes: CommittedVote["share_hashes"],
  nonces: ValidityNonces,
): CommittedVote {
  checkContext(ctx);
  if (SHARINGS.get(sharing) !== 1)
    throw new TypeError("prove: the sharing must come from shareVote, unchanged");
  if (SPENT.get(sharing) === "opened")
    throw new TypeError("prove: this sharing was opened by a challenge; it is never cast");
  const { optionCount: m, minSelections: min, maxSelections: max } = ctx;
  if (sharing.vss.length !== m || sharing.vss.some((e) => e.length !== ctx.threshold))
    throw new RangeError("prove: the sharing doesn't match the election");
  if (shareHashes.length !== ctx.panelSize)
    throw new RangeError("prove: one share hash per trustee");
  if (nonces.options.length !== m) throw new RangeError("prove: one nonce set per option");
  const statement = statementHash(ctx, sharing.vss, shareHashes);
  const option_proofs = sharing.vss.map((e, j) => {
    const v = sharing.votes[j] as 0 | 1;
    const r = (sharing.polynomials[j] as OptionPolynomials).g[0] as bigint;
    const tag = "abolish/v1/fs/ballot-validity/option";
    const branches = proveOr(
      tag,
      optionPrefix(statement, j),
      e[0] as Element,
      [0, 1],
      v,
      r,
      nonces.options[j] as OrNonces,
    );
    // proveOr returns one branch per value, here two.
    const [b0, b1] = branches as [Branch, Branch];
    return { c0: b0.c, z0: b0.z, c1: b1.c, z1: b1.z };
  });
  const total = sharing.votes.reduce<number>((a, v) => a + v, 0);
  const rho = mod(sharing.polynomials.reduce((a, p) => a + (p.g[0] as bigint), 0n));
  const values = range(min, max);
  const sum_proof = proveOr(
    "abolish/v1/fs/ballot-validity/sum",
    sumPrefix(statement, min, max),
    commitmentSum(sharing.vss),
    values,
    total - min,
    rho,
    nonces.sum,
  );
  const vote = { vss: sharing.vss, share_hashes: shareHashes, option_proofs, sum_proof };
  // Round-trips the result through the codec, so a ballot this returns always encodes.
  encode(COMMITTED_VOTE, vote);
  SPENT.set(sharing, "proved");
  return vote;
}

function randomOrNonces(branches: number): OrNonces {
  return {
    w: randomScalar(),
    simulated: Array.from({ length: branches - 1 }, () => ({
      c: randomScalar(),
      z: randomScalar(),
    })),
  };
}

/**
 * Proves a shared vote valid: an option proof per option and the sum proof,
 * with all randomness from the CSPRNG (docs/spec/ballot-validity.md, Proving).
 * `shareHashes` are the hashes of the share ciphertexts, in seat order.
 */
export function proveValidity(
  ctx: ValidityContext,
  sharing: VoteSharing,
  shareHashes: CommittedVote["share_hashes"],
): CommittedVote {
  checkContext(ctx);
  return proveValidityWith(ctx, sharing, shareHashes, {
    options: sharing.vss.map(() => randomOrNonces(2)),
    sum: randomOrNonces(ctx.maxSelections - ctx.minSelections + 1),
  });
}

// Ballot version 3 (docs/spec/ballot-validity.md, Ballot record (version 3);
// ADR 0026): the committed vote of a poll of several questions, shared and
// proved over the flat options, with one range proof per question in place of
// version 1's one sum proof, so no count moves from one question to another
// and each question's limits hold (T-28, T-30, T-31, T-32).

const { MAX_QUESTIONS } = PARAMETERS;

/** The committed vote of ballot version 3: `sum_proofs` holds one range proof per question. */
export const COMMITTED_VOTE_V3 = struct([
  ["vss", VSS],
  ["share_hashes", SHARE_HASHES],
  ["option_proofs", list(bitProof, MAX_OPTIONS)],
  ["sum_proofs", list(list(branch, MAX_OPTIONS + 1), MAX_QUESTIONS)],
]);

export type CommittedVoteV3 = CodecValue<typeof COMMITTED_VOTE_V3>;

/** One question's option count and limits, from the registered version-5 definition. */
export interface QuestionRules {
  readonly optionCount: number;
  readonly minSelections: number;
  readonly maxSelections: number;
}

/** The rules a version-3 ballot is shared and proved under (Context (version 3)). */
export interface ValidityRulesV3 {
  readonly questions: readonly QuestionRules[];
  readonly threshold: number;
  readonly panelSize: number;
}

/** What names a version-3 ballot beside its committed vote: the election, its cell and its nullifier. */
export interface BallotHashContextV3 {
  readonly definitionHash: Uint8Array;
  readonly cell: number;
  readonly nullifier: bigint;
}

export type ValidityContextV3 = ValidityRulesV3 & BallotHashContextV3;

export type ValidityResultV3 =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "validity-shape" }
  | { readonly ok: false; readonly code: "option-proof"; readonly option: number }
  | { readonly ok: false; readonly code: "sum-proof"; readonly question: number };

const BALLOT_VERSION_3 = 3;

/** `o_q` for every question, and `T`: the flat index of each question's first option, and the poll's option count. */
function offsetsOf(questions: readonly QuestionRules[]): {
  readonly offsets: readonly number[];
  readonly total: number;
} {
  const offsets: number[] = [];
  let total = 0;
  for (const q of questions) {
    offsets.push(total);
    total += q.optionCount;
  }
  return { offsets, total };
}

function checkRulesV3(rules: ValidityRulesV3): void {
  const { questions, threshold: k, panelSize: n } = rules;
  const int = (x: unknown) => Number.isSafeInteger(x);
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > MAX_QUESTIONS)
    throw new RangeError("rules: from 1 to MAX_QUESTIONS questions");
  for (const q of questions as readonly QuestionRules[]) {
    const { optionCount: m, minSelections: min, maxSelections: max } = q;
    if (![m, min, max].every(int)) throw new TypeError("rules: expected integers");
    if (m < 1) throw new RangeError("rules: optionCount out of range");
    if (min < 0 || min > max || max > m) throw new RangeError("rules: selections out of range");
  }
  if (offsetsOf(questions).total > MAX_OPTIONS)
    throw new RangeError("rules: more than MAX_OPTIONS options over the poll");
  if (![k, n].every(int)) throw new TypeError("rules: expected integers");
  if (k < 2 || k > n || n > MAX_TRUSTEES) throw new RangeError("rules: panel out of range");
}

function checkContextV3(ctx: ValidityContextV3): void {
  checkRulesV3(ctx);
  checkBallotContextV3(ctx);
}

function checkBallotContextV3(ctx: BallotHashContextV3): void {
  const d = ctx.definitionHash;
  if (!(d instanceof Uint8Array) || !ArrayBuffer.isView(d) || new Uint8Array(d).length !== 32)
    throw new TypeError("context: definitionHash must be 32 bytes");
  if (!Number.isSafeInteger(ctx.cell) || ctx.cell < 0 || ctx.cell > 0xff)
    throw new RangeError("context: the cell must be a u8");
}

// definition_hash ‖ u16(0x0002) ‖ u8(version) ‖ u8(cell) ‖ encode(nullifier):
// the inputs before the committed vote's own encoding, at version 2's offsets.
function headerV3(ctx: BallotHashContextV3, version = BALLOT_VERSION_3): Writer {
  const w = new Writer();
  w.bytes(new Uint8Array(ctx.definitionHash));
  u16.write(w, BALLOT_RECORD_TYPE);
  u8.write(w, version);
  u8.write(w, ctx.cell);
  fieldBn254.write(w, ctx.nullifier);
  return w;
}

/**
 * `statement_hash` under ballot version 3 (Hashes (version 3)): version 2's
 * with version input 3, so no proof made under another version verifies
 * here (T-31).
 */
export function statementHashV3(
  ctx: ValidityContextV3,
  vss: CommittedVoteV3["vss"],
  shareHashes: CommittedVoteV3["share_hashes"],
): Uint8Array {
  checkContextV3(ctx);
  const w = headerV3(ctx);
  VSS.write(w, vss);
  SHARE_HASHES.write(w, shareHashes);
  return H(ds("abolish/v1/ballot-statement", w.finish()));
}

/**
 * `ballot_hash` under ballot version 3 (Hashes (version 3)): the statement
 * hash's inputs followed by the proofs, `encode(sum_proofs)` last, which is
 * the committed vote's own encoding (T-38, T-41).
 */
export function ballotHashV3(ctx: BallotHashContextV3, vote: CommittedVoteV3): Uint8Array {
  checkBallotContextV3(ctx);
  const w = headerV3(ctx);
  COMMITTED_VOTE_V3.write(w, vote);
  return H(ds("abolish/v1/ballot", w.finish()));
}

// statement_hash ‖ u16(q) ‖ u16(o_q) ‖ u16(m_q) ‖ u16(min_q) ‖ u16(max_q): the
// question, which commitments Y_q multiplies, and its allowed values, so a
// range proof can't move to another question or range (Question range proof).
function questionPrefix(statement: Uint8Array, q: number, o: number, rules: QuestionRules) {
  const w = new Writer();
  w.bytes(statement);
  for (const x of [q, o, rules.optionCount, rules.minSelections, rules.maxSelections])
    u16.write(w, x);
  return w.finish();
}

/** `Y_q`: the product of question `q`'s commitments `E_{j,0}`, flat options `o` to `o + m − 1`. */
function questionSum(vss: CommittedVoteV3["vss"], o: number, m: number): Element {
  return vss.slice(o, o + m).reduce((acc, e) => acc.add(e[0] as Element), IDENTITY);
}

const QUESTION_SUM_TAG = "abolish/v1/fs/ballot-validity/question-sum";
const OPTION_TAG = "abolish/v1/fs/ballot-validity/option";

/**
 * `validity-shape` under version 3 alone (Checks (version 3)): `T` flat
 * options of `k` commitments, `n` share hashes, `T` option proofs, and one
 * range proof per question of exactly `max_q − min_q + 1` branches.
 */
export function shapeOkV3(ctx: ValidityContextV3, vote: CommittedVoteV3): boolean {
  checkContextV3(ctx);
  const { questions, threshold: k } = ctx;
  const { total } = offsetsOf(questions);
  return (
    vote.vss.length === total &&
    vote.vss.every((e) => e.length === k) &&
    vote.share_hashes.length === ctx.panelSize &&
    vote.option_proofs.length === total &&
    vote.sum_proofs.length === questions.length &&
    vote.sum_proofs.every(
      (b, q) =>
        b.length ===
        (questions[q] as QuestionRules).maxSelections -
          (questions[q] as QuestionRules).minSelections +
          1,
    )
  );
}

/**
 * The validity check of a version-3 committed vote (Checks (version 3);
 * verifier 5.4): the shape, each option proof in flat order, then each
 * question's range proof in question order. The first failure is the
 * result, naming the flat option or the question.
 */
export function checkValidityV3(ctx: ValidityContextV3, vote: CommittedVoteV3): ValidityResultV3 {
  checkContextV3(ctx);
  if (!shapeOkV3(ctx, vote)) return { ok: false, code: "validity-shape" };
  const { vss, share_hashes, option_proofs, sum_proofs } = vote;
  const statement = statementHashV3(ctx, vss, share_hashes);
  for (const [j, p] of option_proofs.entries()) {
    const branches = [
      { c: p.c0, z: p.z0 },
      { c: p.c1, z: p.z1 },
    ];
    const y = (vss[j] as readonly Element[])[0] as Element;
    if (!verifyOr(OPTION_TAG, optionPrefix(statement, j), y, [0, 1], branches))
      return { ok: false, code: "option-proof", option: j };
  }
  const { offsets } = offsetsOf(ctx.questions);
  for (const [q, rules] of ctx.questions.entries()) {
    const o = offsets[q] as number;
    const { optionCount: m, minSelections: min, maxSelections: max } = rules;
    if (
      !verifyOr(
        QUESTION_SUM_TAG,
        questionPrefix(statement, q, o, rules),
        questionSum(vss, o, m),
        range(min, max),
        sum_proofs[q] as readonly Branch[],
      )
    )
      return { ok: false, code: "sum-proof", question: q };
  }
  return { ok: true };
}

function checkVotesV3(rules: ValidityRulesV3, votes: readonly number[]): void {
  const { offsets, total } = offsetsOf(rules.questions);
  if (!Array.isArray(votes) || votes.length !== total)
    throw new RangeError("votes: one entry per flat option");
  if (!votes.every((v) => v === 0 || v === 1)) throw new RangeError("votes: each must be 0 or 1");
  rules.questions.forEach((q, i) => {
    const o = offsets[i] as number;
    const count = votes.slice(o, o + q.optionCount).reduce((a, v) => a + v, 0);
    if (count < q.minSelections || count > q.maxSelections)
      throw new RangeError("votes: a question's selection count is outside its limits");
  });
}

/**
 * Internal: shares a version-3 vote, flat options in question order, with the
 * given polynomials. Production code calls `shareVoteV3`; the package entry
 * point doesn't export this.
 */
export function shareVoteV3With(
  rules: ValidityRulesV3,
  votes: readonly (0 | 1)[],
  polynomials: readonly OptionPolynomials[],
): VoteSharing {
  checkRulesV3(rules);
  checkVotesV3(rules, votes);
  return makeSharing(rules, votes, polynomials, 3);
}

/**
 * Shares a version-3 vote among the trustees, one flat option per entry in
 * question order, every coefficient from the CSPRNG; each question's count
 * must be within its limits (Context (version 3)).
 */
export function shareVoteV3(rules: ValidityRulesV3, votes: readonly (0 | 1)[]): VoteSharing {
  checkRulesV3(rules);
  checkVotesV3(rules, votes);
  return drawSharing(rules.threshold, votes, (p) => shareVoteV3With(rules, votes, p));
}

/** The randomness of a version-3 ballot's proofs: one set per flat option, one per question. */
export interface ValidityNoncesV3 {
  readonly options: readonly OrNonces[];
  readonly questions: readonly OrNonces[];
}

/**
 * Internal: proves a version-3 sharing valid with the given randomness.
 * Production code calls `proveValidityV3`; the package entry point doesn't
 * export this.
 */
export function proveValidityV3With(
  ctx: ValidityContextV3,
  sharing: VoteSharing,
  shareHashes: CommittedVoteV3["share_hashes"],
  nonces: ValidityNoncesV3,
): CommittedVoteV3 {
  checkContextV3(ctx);
  if (SHARINGS.get(sharing) !== 3)
    throw new TypeError("prove: the sharing must come from shareVoteV3, unchanged");
  if (SPENT.get(sharing) === "opened")
    throw new TypeError("prove: this sharing was opened by a challenge; it is never cast");
  const { offsets, total } = offsetsOf(ctx.questions);
  if (sharing.vss.length !== total || sharing.vss.some((e) => e.length !== ctx.threshold))
    throw new RangeError("prove: the sharing doesn't match the election");
  if (shareHashes.length !== ctx.panelSize)
    throw new RangeError("prove: one share hash per trustee");
  if (nonces.options.length !== total) throw new RangeError("prove: one nonce set per option");
  if (nonces.questions.length !== ctx.questions.length)
    throw new RangeError("prove: one nonce set per question");
  // The sharing's votes were checked against rules when it was made; these
  // rules may differ, so each question's count is checked again before proving.
  checkVotesV3(ctx, sharing.votes);
  const statement = statementHashV3(ctx, sharing.vss, shareHashes);
  const option_proofs = sharing.vss.map((e, j) => {
    const v = sharing.votes[j] as 0 | 1;
    const r = (sharing.polynomials[j] as OptionPolynomials).g[0] as bigint;
    const branches = proveOr(
      OPTION_TAG,
      optionPrefix(statement, j),
      e[0] as Element,
      [0, 1],
      v,
      r,
      nonces.options[j] as OrNonces,
    );
    // proveOr returns one branch per value, here two.
    const [b0, b1] = branches as [Branch, Branch];
    return { c0: b0.c, z0: b0.z, c1: b1.c, z1: b1.z };
  });
  // After every option proof, in question order (Question range proof, Proving).
  const sum_proofs = ctx.questions.map((rules, q) => {
    const o = offsets[q] as number;
    const { optionCount: m, minSelections: min, maxSelections: max } = rules;
    const count = sharing.votes.slice(o, o + m).reduce<number>((a, v) => a + v, 0);
    const rho = mod(
      sharing.polynomials.slice(o, o + m).reduce((a, p) => a + (p.g[0] as bigint), 0n),
    );
    return proveOr(
      QUESTION_SUM_TAG,
      questionPrefix(statement, q, o, rules),
      questionSum(sharing.vss, o, m),
      range(min, max),
      count - min,
      rho,
      nonces.questions[q] as OrNonces,
    );
  });
  const vote = { vss: sharing.vss, share_hashes: shareHashes, option_proofs, sum_proofs };
  // Round-trips the result through the codec, so a ballot this returns always encodes.
  encode(COMMITTED_VOTE_V3, vote);
  SPENT.set(sharing, "proved");
  return vote;
}

/**
 * Proves a version-3 sharing valid: an option proof per flat option, then a
 * range proof per question, all randomness from the CSPRNG (Question range
 * proof, Proving). `shareHashes` are the share ciphertexts' hashes in seat
 * order.
 */
export function proveValidityV3(
  ctx: ValidityContextV3,
  sharing: VoteSharing,
  shareHashes: CommittedVoteV3["share_hashes"],
): CommittedVoteV3 {
  checkContextV3(ctx);
  return proveValidityV3With(ctx, sharing, shareHashes, {
    options: sharing.vss.map(() => randomOrNonces(2)),
    questions: ctx.questions.map((q) => randomOrNonces(q.maxSelections - q.minSelections + 1)),
  });
}

// Ballot version 4 (docs/spec/ballot-validity.md, Ballot record (version 4);
// ADR 0027, Part 1, option A): version 3's committed vote with each option's
// opening split additively in two, the default half Pedersen-shared to the
// default panel and, when the definition has an author panel, the author half
// to the author panel, so a vote opens only with both thresholds (T-14). The
// vote commitment `C_j = E^D_{j,0} · E^A_{j,0}` is computed, never carried,
// and the proofs are version 3's over it (T-17, T-30, T-31, T-32).

/** The committed vote of ballot version 4: version 3's, with the author half after the default half. */
export const COMMITTED_VOTE_V4 = struct([
  ["vss", VSS],
  ["share_hashes", SHARE_HASHES],
  ["author_vss", VSS],
  ["author_share_hashes", SHARE_HASHES],
  ["option_proofs", list(bitProof, MAX_OPTIONS)],
  ["sum_proofs", list(list(branch, MAX_OPTIONS + 1), MAX_QUESTIONS)],
]);

export type CommittedVoteV4 = CodecValue<typeof COMMITTED_VOTE_V4>;

/** What the statement and core hashes bind of a version-4 committed vote: both halves and both share-hash lists. */
export type VoteHalvesV4 = Pick<
  CommittedVoteV4,
  "vss" | "share_hashes" | "author_vss" | "author_share_hashes"
>;

/**
 * The rules a version-4 ballot is shared and proved under (Context (version
 * 4)): version 3's, with the author panel's `k_A` and `n_A`, both 0 when the
 * definition has none.
 */
export interface ValidityRulesV4 extends ValidityRulesV3 {
  readonly authorThreshold: number;
  readonly authorPanelSize: number;
}

export type ValidityContextV4 = ValidityRulesV4 & BallotHashContextV3;

const BALLOT_VERSION_4 = 4;

function checkRulesV4(rules: ValidityRulesV4): void {
  checkRulesV3(rules);
  const { authorThreshold: k, authorPanelSize: n } = rules;
  if (![k, n].every((x) => Number.isSafeInteger(x)))
    throw new TypeError("rules: expected integers");
  // No author panel, or one of 1 ≤ k_A ≤ n_A ≤ MAX_TRUSTEES (trustee-identity.md, Author panel identifier).
  if (!(k === 0 && n === 0) && !(k >= 1 && k <= n && n <= MAX_TRUSTEES))
    throw new RangeError("rules: author panel out of range");
}

function checkContextV4(ctx: ValidityContextV4): void {
  checkRulesV4(ctx);
  checkBallotContextV3(ctx);
}

/**
 * `statement_hash` under ballot version 4 (Hashes (version 4)): version 3's
 * with version input 4 and the author half after the default half, so the
 * proved statement fixes the shares of both panels (T-30, T-31, T-32).
 */
export function statementHashV4(ctx: ValidityContextV4, halves: VoteHalvesV4): Uint8Array {
  checkContextV4(ctx);
  const w = headerV3(ctx, BALLOT_VERSION_4);
  VSS.write(w, halves.vss);
  SHARE_HASHES.write(w, halves.share_hashes);
  VSS.write(w, halves.author_vss);
  SHARE_HASHES.write(w, halves.author_share_hashes);
  return H(ds("abolish/v1/ballot-statement", w.finish()));
}

/** `ballot_hash` under ballot version 4 (Hashes (version 4)): the header, then the committed vote's own encoding. */
export function ballotHashV4(ctx: BallotHashContextV3, vote: CommittedVoteV4): Uint8Array {
  checkBallotContextV3(ctx);
  const w = headerV3(ctx, BALLOT_VERSION_4);
  COMMITTED_VOTE_V4.write(w, vote);
  return H(ds("abolish/v1/ballot", w.finish()));
}

/**
 * Each flat option's vote commitment `C_j = E^D_{j,0} · E^A_{j,0}`, with
 * `E^A_{j,0}` the identity when the ballot has no author half (Committed vote
 * (version 4)). A product may be the identity; the proofs allow it.
 */
export function voteCommitmentsV4(halves: Pick<VoteHalvesV4, "vss" | "author_vss">): Element[] {
  const { vss, author_vss } = halves;
  if (author_vss.length !== 0 && author_vss.length !== vss.length)
    throw new RangeError("voteCommitmentsV4: one author entry per option, or none");
  return vss.map((e, j) => {
    const d = e[0];
    const a = author_vss.length === 0 ? IDENTITY : (author_vss[j] as readonly Element[])[0];
    if (d === undefined || a === undefined)
      throw new RangeError("voteCommitmentsV4: an option without its constant term");
    return d.add(a);
  });
}

/**
 * `validity-shape` under version 4 alone (Checks (version 4)): version 3's
 * counts for the default half, and the author half's against the author
 * panel, both of its lists empty when the definition has none, so a ballot of
 * a poll without one has exactly one encoding.
 */
export function shapeOkV4(ctx: ValidityContextV4, vote: CommittedVoteV4): boolean {
  checkContextV4(ctx);
  const { authorThreshold: kA, authorPanelSize: nA } = ctx;
  const { total } = offsetsOf(ctx.questions);
  const author =
    nA === 0
      ? vote.author_vss.length === 0 && vote.author_share_hashes.length === 0
      : vote.author_vss.length === total &&
        vote.author_vss.every((e) => e.length === kA) &&
        vote.author_share_hashes.length === nA;
  return author && shapeOkV3(ctx, vote);
}

/**
 * The validity check of a version-4 committed vote (Checks (version 4);
 * verifier 5.4): the shape, then version 3's option and range proofs over the
 * computed `C_j`, under the version-4 statement. The first failure is the
 * result, naming the flat option or the question.
 */
export function checkValidityV4(ctx: ValidityContextV4, vote: CommittedVoteV4): ValidityResultV3 {
  checkContextV4(ctx);
  if (!shapeOkV4(ctx, vote)) return { ok: false, code: "validity-shape" };
  const statement = statementHashV4(ctx, vote);
  const commitments = voteCommitmentsV4(vote);
  for (const [j, p] of vote.option_proofs.entries()) {
    const branches = [
      { c: p.c0, z: p.z0 },
      { c: p.c1, z: p.z1 },
    ];
    const y = commitments[j] as Element;
    if (!verifyOr(OPTION_TAG, optionPrefix(statement, j), y, [0, 1], branches))
      return { ok: false, code: "option-proof", option: j };
  }
  const { offsets } = offsetsOf(ctx.questions);
  for (const [q, rules] of ctx.questions.entries()) {
    const o = offsets[q] as number;
    const { optionCount: m, minSelections: min, maxSelections: max } = rules;
    const y = commitments.slice(o, o + m).reduce((acc, c) => acc.add(c), IDENTITY);
    if (
      !verifyOr(
        QUESTION_SUM_TAG,
        questionPrefix(statement, q, o, rules),
        y,
        range(min, max),
        vote.sum_proofs[q] as readonly Branch[],
      )
    )
      return { ok: false, code: "sum-proof", question: q };
  }
  return { ok: true };
}

/**
 * The client's secret state of a version-4 ballot between sharing and
 * proving: the votes, each half's polynomials, VSS commitments and seat
 * shares. The author lists are empty when the definition has no author
 * panel. Only `shareVoteV4` makes one, frozen, and only `proveValidityV4`
 * proves it; version 1 and 3's provers and share encryption refuse it, so its
 * halves never reach a seat as one sharing. The caller drops every reference
 * once the voter casts (T-18, T-45).
 */
export interface VoteSharingV4 {
  readonly votes: readonly (0 | 1)[];
  /** The default half: `f^D_j` holds `v_j − a_j` then its higher coefficients, `g^D_j` holds `r_j − s_j` then its. */
  readonly polynomials: readonly OptionPolynomials[];
  readonly vss: CommittedVoteV4["vss"];
  /** `shares[i − 1]` is default seat `i`'s list. */
  readonly shares: readonly (readonly Share[])[];
  /** The author half: `f^A_j` holds `a_j`, `g^A_j` holds `s_j`, then their higher coefficients. */
  readonly authorPolynomials: readonly OptionPolynomials[];
  readonly authorVss: CommittedVoteV4["author_vss"];
  /** `authorShares[i − 1]` is author seat `i`'s list. */
  readonly authorShares: readonly (readonly Share[])[];
}

const SHARINGS_V4 = new WeakSet<VoteSharingV4>();

/** Internal: whether `shareVoteV4` made this sharing (unchanged, since it is frozen). */
export function isRegisteredSharingV4(sharing: VoteSharingV4): boolean {
  return SHARINGS_V4.has(sharing);
}

function checkPolynomials(polynomials: readonly OptionPolynomials[], count: number, k: number) {
  if (polynomials.length !== count) throw new RangeError("polynomials: one per option");
  for (const p of polynomials) {
    if (p.f.length !== k || p.g.length !== k) throw new RangeError("polynomials: k coefficients");
    for (const c of [...p.f, ...p.g])
      if (typeof c !== "bigint" || c < 0n || c >= GROUP_ORDER)
        throw new RangeError("polynomials: coefficients must be scalars");
  }
}

function commitAll(polynomials: readonly OptionPolynomials[], first: (j: number) => Element) {
  return polynomials.map((p, j) =>
    p.f.map((a, t) => {
      const e = t === 0 ? first(j) : pedersen(a, p.g[t] as bigint);
      // About 2⁻²⁵² for random coefficients; the codec rejects it, so the
      // caller draws again (Committed vote (version 4)).
      if (e.is0()) throw new RangeError("polynomials: a VSS commitment is the identity");
      return e;
    }),
  );
}

const sharesOf = (polynomials: readonly OptionPolynomials[], n: number) =>
  Array.from({ length: n }, (_, i) =>
    polynomials.map((p) => ({ v: evaluate(p.f, BigInt(i + 1)), r: evaluate(p.g, BigInt(i + 1)) })),
  );

/**
 * Internal: shares a version-4 vote with the given polynomials, the default
 * half's and the author half's (none without an author panel). Production
 * code calls `shareVoteV4`; the package entry point doesn't export this.
 */
export function shareVoteV4With(
  rules: ValidityRulesV4,
  votes: readonly (0 | 1)[],
  polynomials: readonly OptionPolynomials[],
  authorPolynomials: readonly OptionPolynomials[],
): VoteSharingV4 {
  checkRulesV4(rules);
  checkVotesV3(rules, votes);
  const T = votes.length;
  const nA = rules.authorPanelSize;
  checkPolynomials(polynomials, T, rules.threshold);
  checkPolynomials(authorPolynomials, nA === 0 ? 0 : T, rules.authorThreshold);
  const authorConstant = (j: number, c: "f" | "g") =>
    nA === 0 ? 0n : ((authorPolynomials[j] as OptionPolynomials)[c][0] as bigint);
  polynomials.forEach((p, j) => {
    if (mod((p.f[0] as bigint) + authorConstant(j, "f")) !== BigInt(votes[j] as number))
      throw new RangeError("polynomials: the halves' constant terms don't add to the vote");
  });
  const vss = commitAll(polynomials, (j) => {
    const p = polynomials[j] as OptionPolynomials;
    // Without an author half the constant term is the vote itself, committed
    // with the same multiplications whatever it is (Residuals).
    return nA === 0
      ? commitVote(p.f[0] as bigint, p.g[0] as bigint)
      : pedersen(p.f[0] as bigint, p.g[0] as bigint);
  });
  const authorVss = commitAll(authorPolynomials, (j) => {
    const p = authorPolynomials[j] as OptionPolynomials;
    return pedersen(p.f[0] as bigint, p.g[0] as bigint);
  });
  // Frozen and registered, so `proveValidityV4` proves only a sharing made
  // here: a caller choosing r_j or a half could publish a commitment anyone
  // can open (T-15).
  const sharing: VoteSharingV4 = deepFreeze({
    votes: [...votes],
    polynomials: polynomials.map((p) => ({ f: [...p.f], g: [...p.g] })),
    vss,
    shares: sharesOf(polynomials, rules.panelSize),
    authorPolynomials: authorPolynomials.map((p) => ({ f: [...p.f], g: [...p.g] })),
    authorVss,
    authorShares: sharesOf(authorPolynomials, nA),
  });
  SHARINGS_V4.add(sharing);
  return sharing;
}

/**
 * Shares a version-4 vote between the default panel and, when the definition
 * has one, the author panel, every value from the CSPRNG, uniformly and
 * independently (Committed vote (version 4)): `r_j`, the default half's
 * higher coefficients, then the author half `(a_j, s_j)` and its higher
 * coefficients. The author panel's protection rests on this draw (T-14, T-41).
 */
export function shareVoteV4(rules: ValidityRulesV4, votes: readonly (0 | 1)[]): VoteSharingV4 {
  checkRulesV4(rules);
  checkVotesV3(rules, votes);
  const { threshold: kD, authorThreshold: kA, authorPanelSize: nA } = rules;
  const draw = (n: number) => Array.from({ length: n }, randomScalar);
  for (;;) {
    const polynomials: OptionPolynomials[] = [];
    const authorPolynomials: OptionPolynomials[] = [];
    for (const v of votes) {
      const r = randomScalar();
      const [aD, bD] = [draw(kD - 1), draw(kD - 1)];
      const [a, s] = nA === 0 ? [0n, 0n] : [randomScalar(), randomScalar()];
      polynomials.push({ f: [mod(BigInt(v) - a), ...aD], g: [mod(r - s), ...bD] });
      if (nA !== 0) authorPolynomials.push({ f: [a, ...draw(kA - 1)], g: [s, ...draw(kA - 1)] });
    }
    try {
      return shareVoteV4With(rules, votes, polynomials, authorPolynomials);
    } catch (e) {
      // Only an identity VSS commitment is retried; anything else is a bug.
      if (!(e instanceof RangeError && e.message.includes("identity"))) throw e;
    }
  }
}

/**
 * Internal: proves a version-4 sharing valid with the given randomness.
 * Production code calls `proveValidityV4`; the package entry point doesn't
 * export this.
 */
export function proveValidityV4With(
  ctx: ValidityContextV4,
  sharing: VoteSharingV4,
  shareHashes: CommittedVoteV4["share_hashes"],
  authorShareHashes: CommittedVoteV4["author_share_hashes"],
  nonces: ValidityNoncesV3,
): CommittedVoteV4 {
  checkContextV4(ctx);
  if (!SHARINGS_V4.has(sharing))
    throw new TypeError("prove: the sharing must come from shareVoteV4, unchanged");
  if (SPENT.get(sharing) === "opened")
    throw new TypeError("prove: this sharing was opened by a challenge; it is never cast");
  const { offsets, total } = offsetsOf(ctx.questions);
  const nA = ctx.authorPanelSize;
  if (
    sharing.vss.length !== total ||
    sharing.vss.some((e) => e.length !== ctx.threshold) ||
    sharing.authorVss.length !== (nA === 0 ? 0 : total) ||
    sharing.authorVss.some((e) => e.length !== ctx.authorThreshold) ||
    sharing.shares.length !== ctx.panelSize ||
    sharing.authorShares.length !== nA
  )
    throw new RangeError("prove: the sharing doesn't match the election");
  if (shareHashes.length !== ctx.panelSize)
    throw new RangeError("prove: one share hash per default seat");
  if (authorShareHashes.length !== nA)
    throw new RangeError("prove: one share hash per author seat");
  if (nonces.options.length !== total) throw new RangeError("prove: one nonce set per option");
  if (nonces.questions.length !== ctx.questions.length)
    throw new RangeError("prove: one nonce set per question");
  // The sharing's votes were checked against rules when it was made; these
  // rules may differ, so each question's count is checked again before proving.
  checkVotesV3(ctx, sharing.votes);
  const halves = {
    vss: sharing.vss,
    share_hashes: shareHashes,
    author_vss: sharing.authorVss,
    author_share_hashes: authorShareHashes,
  };
  const statement = statementHashV4(ctx, halves);
  const commitments = voteCommitmentsV4(halves);
  // The client knows the whole r_j, never only a half (Validity proofs (version 4)).
  const rs = sharing.polynomials.map((p, j) =>
    mod(
      (p.g[0] as bigint) +
        (nA === 0 ? 0n : ((sharing.authorPolynomials[j] as OptionPolynomials).g[0] as bigint)),
    ),
  );
  const option_proofs = commitments.map((y, j) => {
    const branches = proveOr(
      OPTION_TAG,
      optionPrefix(statement, j),
      y,
      [0, 1],
      sharing.votes[j] as 0 | 1,
      rs[j] as bigint,
      nonces.options[j] as OrNonces,
    );
    // proveOr returns one branch per value, here two.
    const [b0, b1] = branches as [Branch, Branch];
    return { c0: b0.c, z0: b0.z, c1: b1.c, z1: b1.z };
  });
  // After every option proof, in question order (Question range proof, Proving).
  const sum_proofs = ctx.questions.map((rules, q) => {
    const o = offsets[q] as number;
    const { optionCount: m, minSelections: min, maxSelections: max } = rules;
    const count = sharing.votes.slice(o, o + m).reduce<number>((a, v) => a + v, 0);
    const rho = mod(rs.slice(o, o + m).reduce((a, r) => a + r, 0n));
    const y = commitments.slice(o, o + m).reduce((acc, c) => acc.add(c), IDENTITY);
    return proveOr(
      QUESTION_SUM_TAG,
      questionPrefix(statement, q, o, rules),
      y,
      range(min, max),
      count - min,
      rho,
      nonces.questions[q] as OrNonces,
    );
  });
  const vote = { ...halves, option_proofs, sum_proofs };
  // Round-trips the result through the codec, so a ballot this returns always encodes.
  encode(COMMITTED_VOTE_V4, vote);
  SPENT.set(sharing, "proved");
  return vote;
}

/**
 * Proves a version-4 sharing valid: an option proof per flat option over its
 * computed `C_j`, then a range proof per question, all randomness from the
 * CSPRNG (Validity proofs (version 4)). The share-hash lists are the
 * ciphertexts' hashes in seat order, the author list empty without an author
 * panel.
 */
export function proveValidityV4(
  ctx: ValidityContextV4,
  sharing: VoteSharingV4,
  shareHashes: CommittedVoteV4["share_hashes"],
  authorShareHashes: CommittedVoteV4["author_share_hashes"],
): CommittedVoteV4 {
  checkContextV4(ctx);
  return proveValidityV4With(ctx, sharing, shareHashes, authorShareHashes, {
    options: sharing.vss.map(() => randomOrNonces(2)),
    questions: ctx.questions.map((q) => randomOrNonces(q.maxSelections - q.minSelections + 1)),
  });
}
