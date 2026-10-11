import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  type OptionPolynomials,
  proveValidityWith,
  shareVoteWith,
  type ValidityNonces,
} from "../src/ballot-validity.ts";
import {
  checkShares,
  checkValidity,
  COMMITTED_VOTE,
  type CommittedVote,
  decode,
  DecodeError,
  encode,
  G,
  GENERATOR_H,
  GROUP_ORDER,
  proveValidity,
  type Share,
  SHARES,
  shareVote,
  statementHash,
  type ValidityCode,
  type ValidityContext,
  type ValidityResult,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/ballot-validity.json comes from an independent Python
// implementation of docs/spec/ballot-validity.md
// (scripts/ballot-validity-vectors.py), so these expected bytes and verdicts
// never come from the code under test.

interface Nonces {
  readonly w: string;
  readonly simulated: readonly { readonly c: string; readonly z: string }[];
}

interface BallotVector {
  readonly id: string;
  readonly context: {
    readonly definitionHash: string;
    readonly optionCount: number;
    readonly minSelections: number;
    readonly maxSelections: number;
    readonly threshold: number;
    readonly panelSize: number;
    readonly tier: number;
    readonly nullifier: string;
  };
  readonly votes?: readonly (0 | 1)[];
  readonly randomness?: {
    readonly polynomials: readonly {
      readonly f: readonly string[];
      readonly g: readonly string[];
    }[];
    readonly options: readonly Nonces[];
    readonly sum: Nonces;
  };
  readonly shareHashes?: readonly string[];
  readonly statementHash?: string;
  readonly encoding: string;
  readonly result: "ok" | { readonly code: ValidityCode; readonly option?: number };
  readonly shares?: readonly string[];
}

interface Vectors {
  readonly format: string;
  readonly tags: { readonly statement: string; readonly option: string; readonly sum: string };
  readonly generatorH: string;
  readonly ballots: readonly BallotVector[];
  readonly shareChecks: readonly {
    readonly id: string;
    readonly ballot: string;
    readonly index: number;
    readonly shares: string;
    readonly valid: boolean;
  }[];
  readonly decode: readonly {
    readonly id: string;
    readonly type: "committed-vote" | "shares";
    readonly encoding: string;
    readonly error: string;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("ballot-validity.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const contextOf = (c: BallotVector["context"]): ValidityContext => ({
  definitionHash: hex(c.definitionHash),
  optionCount: c.optionCount,
  minSelections: c.minSelections,
  maxSelections: c.maxSelections,
  threshold: c.threshold,
  panelSize: c.panelSize,
  tier: c.tier,
  nullifier: BigInt(c.nullifier),
});

const noncesOf = (n: Nonces) => ({
  w: BigInt(n.w),
  simulated: n.simulated.map((s) => ({ c: BigInt(s.c), z: BigInt(s.z) })),
});

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const expectedResult = (r: BallotVector["result"]): ValidityResult =>
  r === "ok" ? { ok: true } : { ok: false, ...r };

describe("ballot-validity.json", () => {
  test("is the file this suite reads", () => {
    expect(vectors.format).toBe("abolish-ballot-validity-vectors/1");
    expect(vectors.tags).toEqual({
      statement: "abolish/v1/ballot-statement",
      option: "abolish/v1/fs/ballot-validity/option",
      sum: "abolish/v1/fs/ballot-validity/sum",
    });
    expect(toHex(GENERATOR_H.toBytes())).toBe(vectors.generatorH);
  });

  const valid = vectors.ballots.filter((b) => b.result === "ok");
  test.each(valid.map((b) => [b.id, b] as const))(
    "reproduces %s byte for byte from its randomness",
    (_, b) => {
      const ctx = contextOf(b.context);
      const r = b.randomness as NonNullable<BallotVector["randomness"]>;
      const polynomials: OptionPolynomials[] = r.polynomials.map((p) => ({
        f: p.f.map(BigInt),
        g: p.g.map(BigInt),
      }));
      const sharing = shareVoteWith(ctx, b.votes ?? [], polynomials);
      const shareHashes = (b.shareHashes ?? []).map(hex);
      const nonces: ValidityNonces = { options: r.options.map(noncesOf), sum: noncesOf(r.sum) };
      const vote = proveValidityWith(ctx, sharing, shareHashes, nonces);
      expect(toHex(encode(COMMITTED_VOTE, vote))).toBe(b.encoding);
      expect(toHex(statementHash(ctx, vote.vss, shareHashes))).toBe(b.statementHash);
      expect(sharing.shares.map((s) => toHex(encode(SHARES, s)))).toEqual(b.shares);
      expect(checkValidity(ctx, vote)).toEqual({ ok: true });
    },
  );

  test.each(vectors.ballots.map((b) => [b.id, b] as const))(
    "checks %s with the vector's verdict",
    (_, b) => {
      const vote = decode(COMMITTED_VOTE, hex(b.encoding));
      expect(toHex(encode(COMMITTED_VOTE, vote))).toBe(b.encoding);
      expect(checkValidity(contextOf(b.context), vote)).toEqual(expectedResult(b.result));
    },
  );

  test("covers every check code", () => {
    const codes = new Set(vectors.ballots.map((b) => (b.result === "ok" ? "ok" : b.result.code)));
    expect([...codes].sort()).toEqual(["ok", "option-proof", "sum-proof", "validity-shape"]);
  });

  test.each(vectors.shareChecks.map((s) => [s.id, s] as const))("share check %s", (_, s) => {
    const ballot = vectors.ballots.find((b) => b.id === s.ballot) as BallotVector;
    const vss = decode(COMMITTED_VOTE, hex(ballot.encoding)).vss;
    const shares = decode(SHARES, hex(s.shares));
    expect(checkShares(vss, s.index, shares)).toBe(s.valid);
  });

  test.each(vectors.decode.map((d) => [d.id, d] as const))("rejects %s", (_, d) => {
    const codec = d.type === "committed-vote" ? COMMITTED_VOTE : SHARES;
    const run = () => decode(codec as typeof SHARES, hex(d.encoding));
    expect(run).toThrow(DecodeError);
    try {
      run();
    } catch (e) {
      expect((e as DecodeError).code).toBe(d.error);
    }
  });
});

// --- Properties --------------------------------------------------------------

/** Rules and a vote they allow: 1 to 6 options, 2 ≤ k ≤ n ≤ 5. */
const rulesAndVotes = fc
  .record({
    m: fc.integer({ min: 1, max: 6 }),
    n: fc.integer({ min: 2, max: 5 }),
    approval: fc.boolean(),
    kSeed: fc.nat(),
    bits: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
    minSeed: fc.nat(),
  })
  .map(({ m, n, approval, kSeed, bits, minSeed }) => {
    const k = 2 + (kSeed % (n - 1));
    let votes = bits.slice(0, m).map((b) => (b ? 1 : 0) as 0 | 1);
    let min = 0;
    let max = 1;
    if (approval) {
      const total = votes.reduce<number>((a, v) => a + v, 0);
      min = minSeed % (total + 1);
      max = Math.max(1, total + (minSeed % (m - total + 1)));
    } else {
      // Plurality: keep at most the first selected option.
      const first = votes.indexOf(1);
      votes = votes.map((_, j) => (j === first ? 1 : 0));
    }
    return {
      optionCount: m,
      minSelections: min,
      maxSelections: max,
      threshold: k,
      panelSize: n,
      votes,
    };
  });

const contextArb = fc.record({
  definitionHash: fc.uint8Array({ minLength: 32, maxLength: 32 }),
  tier: fc.constantFrom(0, 1, 2),
  nullifier: fc.bigInt({ min: 0n, max: 2n ** 253n }),
});

function honestBallot(
  rules: Omit<ValidityContext, "definitionHash" | "tier" | "nullifier">,
  votes: readonly (0 | 1)[],
  c: { definitionHash: Uint8Array; tier: number; nullifier: bigint },
) {
  const ctx: ValidityContext = { ...rules, ...c };
  const sharing = shareVote(ctx, votes);
  const shareHashes = Array.from({ length: ctx.panelSize }, (_, i) => new Uint8Array(32).fill(i));
  return { ctx, sharing, vote: proveValidity(ctx, sharing, shareHashes) };
}

const mod = (x: bigint) => ((x % GROUP_ORDER) + GROUP_ORDER) % GROUP_ORDER;

/** Lagrange interpolation at 0 over the given trustees' shares, for one option. */
function interpolate(points: readonly { x: bigint; y: bigint }[]): bigint {
  let acc = 0n;
  for (const { x: xi, y } of points) {
    let num = 1n;
    let den = 1n;
    for (const { x: xj } of points)
      if (xj !== xi) {
        num = mod(num * xj);
        den = mod(den * (xj - xi));
      }
    // Fermat inverse: GROUP_ORDER is prime.
    let inv = 1n;
    let base = den;
    for (let e = GROUP_ORDER - 2n; e > 0n; e >>= 1n) {
      if (e & 1n) inv = mod(inv * base);
      base = mod(base * base);
    }
    acc = mod(acc + y * num * inv);
  }
  return acc;
}

const pedersen = (v: bigint, r: bigint) =>
  (v === 0n ? G.subtract(G) : G.multiply(v)).add(
    r === 0n ? G.subtract(G) : GENERATOR_H.multiply(r),
  );

describe("properties", () => {
  test("an honest ballot verifies, and every trustee's shares pass (completeness)", () => {
    fc.assert(
      fc.property(rulesAndVotes, contextArb, ({ votes, ...rules }, c) => {
        const { ctx, sharing, vote } = honestBallot(rules, votes, c);
        expect(checkValidity(ctx, vote)).toEqual({ ok: true });
        sharing.shares.forEach((s, i) => expect(checkShares(vote.vss, i + 1, s)).toBe(true));
        const bytes = encode(COMMITTED_VOTE, vote);
        expect(encode(COMMITTED_VOTE, decode(COMMITTED_VOTE, bytes))).toEqual(bytes);
      }),
      { numRuns: Math.max(10, numRuns / 20) },
    );
  });

  test("any k trustees' shares open each commitment to the vote", () => {
    fc.assert(
      fc.property(rulesAndVotes, contextArb, fc.nat(), ({ votes, ...rules }, c, pick) => {
        const { sharing, vote } = honestBallot(rules, votes, c);
        // A k-subset of the trustees, chosen by `pick`.
        const seats = Array.from({ length: rules.panelSize }, (_, i) => i + 1);
        const chosen: number[] = [];
        let p = pick;
        while (chosen.length < rules.threshold) {
          const at = p % seats.length;
          chosen.push(seats.splice(at, 1)[0] as number);
          p = Math.floor(p / 7) + 1;
        }
        vote.vss.forEach((e, j) => {
          const pts = (f: (s: Share) => bigint) =>
            chosen.map((x) => ({
              x: BigInt(x),
              y: f((sharing.shares[x - 1] as Share[])[j] as Share),
            }));
          const v = interpolate(pts((s) => s.v));
          const r = interpolate(pts((s) => s.r));
          expect(v).toBe(BigInt(votes[j] as number));
          expect(pedersen(v, r).equals(e[0] as never)).toBe(true);
        });
      }),
      { numRuns: Math.max(10, numRuns / 20) },
    );
  });

  test("summed shares of several ballots pass against the summed VSS commitments (homomorphic)", () => {
    fc.assert(
      fc.property(
        rulesAndVotes,
        contextArb,
        fc.integer({ min: 2, max: 3 }),
        ({ votes, ...rules }, c, count) => {
          const ballots = Array.from({ length: count }, () => honestBallot(rules, votes, c));
          const vss = ballots[0]!.vote.vss.map((e, j) =>
            e.map((_, t) =>
              ballots.reduce(
                (acc, b) => acc.add((b.vote.vss[j] as never[])[t] as never),
                G.subtract(G),
              ),
            ),
          );
          for (let i = 0; i < rules.panelSize; i++) {
            const summed = votes.map((_, j) => ({
              v: mod(
                ballots.reduce((a, b) => a + ((b.sharing.shares[i] as Share[])[j] as Share).v, 0n),
              ),
              r: mod(
                ballots.reduce((a, b) => a + ((b.sharing.shares[i] as Share[])[j] as Share).r, 0n),
              ),
            }));
            expect(checkShares(vss, i + 1, summed)).toBe(true);
          }
        },
      ),
      { numRuns: Math.max(10, numRuns / 50) },
    );
  });

  test("a ballot fails under any other nullifier, election or tier (T-30, T-32)", () => {
    fc.assert(
      fc.property(
        rulesAndVotes,
        contextArb,
        fc.integer({ min: 0, max: 2 }),
        ({ votes, ...rules }, c, which) => {
          const { ctx, vote } = honestBallot(rules, votes, c);
          const other: ValidityContext =
            which === 0
              ? { ...ctx, nullifier: ctx.nullifier + 1n }
              : which === 1
                ? {
                    ...ctx,
                    definitionHash: ctx.definitionHash.map((b, i) => (i === 0 ? b ^ 1 : b)),
                  }
                : { ...ctx, tier: (ctx.tier + 1) % 3 };
          expect(checkValidity(other, vote)).toEqual({
            ok: false,
            code: "option-proof",
            option: 0,
          });
        },
      ),
      { numRuns: Math.max(10, numRuns / 20) },
    );
  });

  test("changing any byte of a committed vote makes it undecodable or invalid (soundness)", () => {
    fc.assert(
      fc.property(
        rulesAndVotes,
        contextArb,
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        ({ votes, ...rules }, c, at, x) => {
          const { ctx, vote } = honestBallot(rules, votes, c);
          const bytes = encode(COMMITTED_VOTE, vote);
          const i = at % bytes.length;
          bytes[i] = (bytes[i] as number) ^ x;
          let changed: CommittedVote;
          try {
            changed = decode(COMMITTED_VOTE, bytes);
          } catch (e) {
            expect(e).toBeInstanceOf(DecodeError);
            return;
          }
          expect(checkValidity(ctx, changed).ok).toBe(false);
        },
      ),
      { numRuns: Math.max(10, numRuns / 10) },
    );
  });

  test("random bytes are rejected or re-encode to themselves", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 600 }), (b) => {
        for (const codec of [COMMITTED_VOTE, SHARES] as const) {
          let v: unknown;
          try {
            v = decode(codec as typeof SHARES, b);
          } catch (e) {
            expect(e).toBeInstanceOf(DecodeError);
            continue;
          }
          expect(encode(codec as typeof SHARES, v as readonly Share[])).toEqual(b);
        }
      }),
      { numRuns },
    );
  });
});

describe("prover inputs", () => {
  const rules = { optionCount: 3, minSelections: 0, maxSelections: 1, threshold: 2, panelSize: 3 };

  test("refuses a vote the election doesn't allow", () => {
    expect(() => shareVote(rules, [1, 1, 0])).toThrow(RangeError);
    expect(() => shareVote(rules, [1, 0])).toThrow(RangeError);
    expect(() => shareVote(rules, [2 as 1, 0, 0])).toThrow(RangeError);
    expect(() => shareVote({ ...rules, minSelections: 1 }, [0, 0, 0])).toThrow(RangeError);
  });

  test("refuses rules outside the protocol's limits", () => {
    expect(() => shareVote({ ...rules, threshold: 1 }, [1, 0, 0])).toThrow(RangeError);
    expect(() => shareVote({ ...rules, threshold: 4 }, [1, 0, 0])).toThrow(RangeError);
    expect(() => shareVote({ ...rules, optionCount: 65 }, [])).toThrow(RangeError);
  });

  test("refuses a polynomial whose constant term isn't the vote", () => {
    const p = (f0: bigint) => ({ f: [f0, 5n], g: [7n, 9n] });
    expect(() => shareVoteWith(rules, [1, 0, 0], [p(0n), p(0n), p(0n)])).toThrow(RangeError);
  });

  test("checkShares refuses a seat outside 1 to MAX_TRUSTEES", () => {
    const { vote } = honestBallot(rules, [1, 0, 0], {
      definitionHash: new Uint8Array(32),
      tier: 0,
      nullifier: 1n,
    });
    expect(() => checkShares(vote.vss, 0, [])).toThrow(RangeError);
    expect(() => checkShares(vote.vss, 17, [])).toThrow(RangeError);
  });

  test("proves only a sharing shareVote made, unchanged (T-15)", () => {
    const ctx: ValidityContext = {
      ...rules,
      definitionHash: new Uint8Array(32),
      tier: 0,
      nullifier: 1n,
    };
    const hashes = [new Uint8Array(32), new Uint8Array(32), new Uint8Array(32)];
    const sharing = shareVote(rules, [1, 0, 0]);
    expect(checkValidity(ctx, proveValidity(ctx, sharing, hashes))).toEqual({ ok: true });
    // A copy, or a sharing built by hand with r_0 = 0 so that C_0 = g: a
    // commitment anyone could open. Both verify if proved, so neither may be.
    expect(() => proveValidity(ctx, { ...sharing }, hashes)).toThrow(TypeError);
    const p = (f: bigint[], g: bigint[]) => ({ f, g });
    const polynomials = [p([1n, 1n], [0n, 1n]), p([0n, 1n], [5n, 1n]), p([0n, 1n], [6n, 1n])];
    const shares = sharing.shares;
    const handBuilt = { votes: [1, 0, 0] as const, polynomials, vss: sharing.vss, shares };
    expect(() => proveValidity(ctx, handBuilt, hashes)).toThrow(TypeError);
    // And a registered sharing can't be changed in place.
    const g0 = (sharing.polynomials[0] as OptionPolynomials).g as bigint[];
    expect(Object.isFrozen(g0)).toBe(true);
    expect(() => {
      g0[0] = 0n;
    }).toThrow(TypeError);
  });

  test("the package entry point exports no way to choose the randomness", async () => {
    const api: Record<string, unknown> = await import("../src/index.ts");
    expect(api["shareVoteWith"]).toBeUndefined();
    expect(api["proveValidityWith"]).toBeUndefined();
  });
});
