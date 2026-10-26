import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  markOpened,
  type OptionPolynomials,
  proveValidityV3With,
  proveValidityV4With,
  shareVoteV4With,
  type ValidityNoncesV3,
} from "../src/ballot-validity.ts";
import {
  ballotHashV3,
  ballotHashV4,
  checkShares,
  checkValidityV3,
  checkValidityV4,
  checkValidityV5,
  COMMITTED_VOTE_V3,
  COMMITTED_VOTE_V4,
  coreHashV4,
  decode,
  DecodeError,
  encode,
  encryptShares,
  G,
  GENERATOR_H,
  GROUP_ORDER,
  IDENTITY,
  proveValidity,
  proveValidityV3,
  proveValidityV4,
  proveValidityV5,
  type QuestionRules,
  SHARES,
  shareVoteV3,
  shareVoteV4,
  statementHashV3,
  statementHashV4,
  type ValidityContextV4,
  type ValidityResultV3,
  voteCommitmentsV4,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// Ballot version 4 through the production code (P2-16 part 2b-1), against
// docs/spec/vectors/ballot-v4.json, printed by scripts/ballot-v4-vectors.py,
// an implementation of the spec that shares no code with this package: every
// byte, hash and verdict here comes from it, never from the code under test
// (T-14, T-30, T-31, T-36).

interface Nonces {
  readonly w: string;
  readonly simulated: readonly { readonly c: string; readonly z: string }[];
}

interface Polynomial {
  readonly f: readonly string[];
  readonly g: readonly string[];
}

interface Election {
  readonly definitionHash: string;
  readonly questions: readonly (QuestionRules & { readonly offset: number })[];
  readonly optionTotal: number;
  readonly threshold: number;
  readonly panelSize: number;
  readonly authorThreshold: number;
  readonly authorPanelSize: number;
}

interface BallotVector {
  readonly id: string;
  readonly election: string;
  readonly context: {
    readonly definitionHash: string;
    readonly cell: number;
    readonly nullifier: string;
  };
  readonly votes?: readonly (0 | 1)[];
  readonly randomness?: {
    readonly polynomials: readonly Polynomial[];
    readonly authorPolynomials: readonly Polynomial[];
    readonly options: readonly Nonces[];
    readonly questions: readonly Nonces[];
  };
  readonly shareHashes?: readonly string[];
  readonly authorShareHashes?: readonly string[];
  readonly statementHash?: string;
  readonly ballotHash?: string;
  readonly coreHash?: string;
  readonly encoding: string;
  readonly result:
    | "ok"
    | { readonly code: "validity-shape" }
    | { readonly code: "option-proof"; readonly option: number }
    | { readonly code: "sum-proof"; readonly question: number };
  readonly shares?: readonly string[];
  readonly authorShares?: readonly string[];
}

const vectors = JSON.parse(readFileSync(new URL("ballot-v4.json", SPEC_VECTORS), "utf8")) as {
  readonly format: string;
  readonly elections: Record<string, Election>;
  readonly ballots: readonly BallotVector[];
  readonly decode: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly error: string;
    readonly offset: number;
  }[];
  readonly crossPanelShares: readonly {
    readonly id: string;
    readonly ballot: string;
    readonly commitments: "default" | "author";
    readonly seat: number;
    readonly shares: string;
    readonly result: boolean;
  }[];
};

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const electionOf = (b: BallotVector): Election => {
  const e = vectors.elections[b.election];
  if (e === undefined) throw new Error(`${b.id} names no listed election`);
  return e;
};

const contextOf = (b: BallotVector): ValidityContextV4 => {
  const e = electionOf(b);
  return {
    definitionHash: hex(b.context.definitionHash),
    cell: b.context.cell,
    nullifier: BigInt(b.context.nullifier),
    questions: e.questions.map(({ optionCount, minSelections, maxSelections }) => ({
      optionCount,
      minSelections,
      maxSelections,
    })),
    threshold: e.threshold,
    panelSize: e.panelSize,
    authorThreshold: e.authorThreshold,
    authorPanelSize: e.authorPanelSize,
  };
};

const noncesOf = (n: Nonces) => ({
  w: BigInt(n.w),
  simulated: n.simulated.map((s) => ({ c: BigInt(s.c), z: BigInt(s.z) })),
});

const polynomialsOf = (ps: readonly Polynomial[]): OptionPolynomials[] =>
  ps.map((p) => ({ f: p.f.map(BigInt), g: p.g.map(BigInt) }));

const expected = (r: BallotVector["result"]): ValidityResultV3 =>
  r === "ok" ? { ok: true } : { ok: false, ...r };

const byId = (id: string): BallotVector => {
  const b = vectors.ballots.find((x) => x.id === id);
  if (b === undefined) throw new Error(`${id} isn't listed`);
  return b;
};

describe("ballot-v4.json through the production code", () => {
  test("is the file this suite reads", () => {
    expect(vectors.format).toBe("abolish-ballot-v4-vectors/1");
  });

  const valid = vectors.ballots.filter((b) => b.randomness !== undefined);
  test.each(valid.map((b) => [b.id, b] as const))(
    "reproduces %s byte for byte from its randomness",
    (_, b) => {
      const ctx = contextOf(b);
      const r = b.randomness!; // filtered above
      const sharing = shareVoteV4With(
        ctx,
        b.votes ?? [],
        polynomialsOf(r.polynomials),
        polynomialsOf(r.authorPolynomials),
      );
      const shareHashes = (b.shareHashes ?? []).map(hex);
      const authorShareHashes = (b.authorShareHashes ?? []).map(hex);
      const nonces: ValidityNoncesV3 = {
        options: r.options.map(noncesOf),
        questions: r.questions.map(noncesOf),
      };
      const vote = proveValidityV4With(ctx, sharing, shareHashes, authorShareHashes, nonces);
      expect(toHex(encode(COMMITTED_VOTE_V4, vote))).toBe(b.encoding);
      expect(toHex(statementHashV4(ctx, vote))).toBe(b.statementHash);
      expect(toHex(ballotHashV4(ctx, vote))).toBe(b.ballotHash);
      const core = {
        definitionHash: ctx.definitionHash,
        cell: ctx.cell,
        vss: vote.vss,
        shareHashes,
        authorVss: vote.author_vss,
        authorShareHashes,
      };
      expect(toHex(coreHashV4(core))).toBe(b.coreHash);
      expect(sharing.shares.map((s) => toHex(encode(SHARES, s)))).toEqual(b.shares);
      expect(sharing.authorShares.map((s) => toHex(encode(SHARES, s)))).toEqual(b.authorShares);
      // Each seat checks its shares against its own panel's commitments (Shares (version 4)).
      sharing.shares.forEach((s, i) => expect(checkShares(vote.vss, i + 1, s)).toBe(true));
      sharing.authorShares.forEach((s, i) =>
        expect(checkShares(vote.author_vss, i + 1, s)).toBe(true),
      );
      expect(checkValidityV4(ctx, vote)).toEqual({ ok: true });
    },
    // options-max and trustees-max prove many options or share to many seats.
    60_000,
  );

  test.each(vectors.ballots.map((b) => [b.id, b] as const))(
    "checks %s with the vector's verdict",
    (_, b) => {
      const vote = decode(COMMITTED_VOTE_V4, hex(b.encoding));
      expect(toHex(encode(COMMITTED_VOTE_V4, vote))).toBe(b.encoding);
      expect(checkValidityV4(contextOf(b), vote)).toEqual(expected(b.result));
    },
    60_000,
  );

  test("covers every check code", () => {
    const codes = new Set(vectors.ballots.map((b) => (b.result === "ok" ? "ok" : b.result.code)));
    expect([...codes].sort()).toEqual(["ok", "option-proof", "sum-proof", "validity-shape"]);
  });

  test.each(vectors.decode.map((d) => [d.id, d] as const))("refuses to decode %s", (_, d) => {
    let err: unknown;
    try {
      decode(COMMITTED_VOTE_V4, hex(d.encoding));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DecodeError);
    expect((err as DecodeError).code).toBe(d.error);
    expect((err as DecodeError).offset).toBe(d.offset);
  });

  test.each(vectors.crossPanelShares.map((c) => [c.id, c] as const))(
    "a share never crosses panels: %s",
    (_, c) => {
      const vote = decode(COMMITTED_VOTE_V4, hex(byId(c.ballot).encoding));
      const vss = c.commitments === "author" ? vote.author_vss : vote.vss;
      expect(checkShares(vss, c.seat, decode(SHARES, hex(c.shares)))).toBe(c.result);
    },
  );

  test("C_0 of identity-commitment is the identity, and the ballot passes", () => {
    const b = byId("identity-commitment");
    const vote = decode(COMMITTED_VOTE_V4, hex(b.encoding));
    const [c0] = voteCommitmentsV4(vote);
    expect(c0?.equals(IDENTITY)).toBe(true);
    expect(vote.vss[0]?.[0]?.equals(IDENTITY)).toBe(false);
    expect(checkValidityV4(contextOf(b), vote)).toEqual({ ok: true });
  });

  test("without an author panel, C_j is E^D_{j,0} and the bytes are version 3's layout with two zero counts", () => {
    const b = byId("no-author");
    const v4 = decode(COMMITTED_VOTE_V4, hex(b.encoding));
    expect(v4.author_vss).toEqual([]);
    expect(v4.author_share_hashes).toEqual([]);
    voteCommitmentsV4(v4).forEach((c, j) => expect(c.equals(v4.vss[j]![0]!)).toBe(true));
    const { author_vss: _a, author_share_hashes: _h, ...rest } = v4;
    const v3 = encode(COMMITTED_VOTE_V3, rest);
    const prefix = encode(COMMITTED_VOTE_V3, { ...rest, option_proofs: [], sum_proofs: [] });
    // vss and share_hashes, then the two zero counts, then version 3's proofs.
    const head = prefix.length - 8;
    const bytes = hex(b.encoding);
    expect(toHex(bytes.subarray(0, head))).toBe(toHex(v3.subarray(0, head)));
    expect(toHex(bytes.subarray(head, head + 8))).toBe("0000000000000000");
    expect(toHex(bytes.subarray(head + 8))).toBe(toHex(v3.subarray(head)));
  });
});

// Small polls for the properties: up to 2 questions of 2 to 4 options, k_D ≤ n_D ≤ 4,
// and no author panel or one of 1 ≤ k_A ≤ n_A ≤ 3.
const pollArb = fc
  .record({
    questions: fc.array(
      fc.integer({ min: 2, max: 4 }).chain((m) =>
        fc.tuple(fc.integer({ min: 0, max: m }), fc.integer({ min: 0, max: m })).map(([a, b]) => ({
          optionCount: m,
          minSelections: Math.min(a, b),
          maxSelections: Math.max(a, b),
        })),
      ),
      { minLength: 1, maxLength: 2 },
    ),
    n: fc.integer({ min: 2, max: 4 }),
    nA: fc.integer({ min: 0, max: 3 }),
  })
  .chain(({ questions, n, nA }) =>
    fc.record({
      questions: fc.constant(questions),
      threshold: fc.integer({ min: 2, max: n }),
      panelSize: fc.constant(n),
      authorThreshold: nA === 0 ? fc.constant(0) : fc.integer({ min: 1, max: nA }),
      authorPanelSize: fc.constant(nA),
      votes: fc
        .tuple(
          ...questions.map((q) =>
            fc.integer({ min: q.minSelections, max: q.maxSelections }).chain((count) =>
              fc
                .shuffledSubarray(
                  Array.from({ length: q.optionCount }, (_, j) => j),
                  { minLength: count, maxLength: count },
                )
                .map((chosen) =>
                  Array.from({ length: q.optionCount }, (_, j) =>
                    chosen.includes(j) ? (1 as const) : (0 as const),
                  ),
                ),
            ),
          ),
        )
        .map((parts) => parts.flat()),
      definitionHash: fc.uint8Array({ minLength: 32, maxLength: 32 }),
      cell: fc.integer({ min: 0, max: 255 }),
      nullifier: fc.bigInt({ min: 0n, max: 2n ** 253n }),
    }),
  );

type Poll = typeof pollArb extends fc.Arbitrary<infer T> ? T : never;

const hashes = (n: number, fill: number) =>
  Array.from({ length: n }, (_, i) => new Uint8Array(32).fill(fill + i));

function honest(p: Poll) {
  const { votes: _, ...ctx } = p;
  const sharing = shareVoteV4(ctx, p.votes);
  const vote = proveValidityV4(
    ctx,
    sharing,
    hashes(p.panelSize, 1),
    hashes(p.authorPanelSize, 100),
  );
  return { ctx, sharing, vote };
}

/** Lagrange interpolation at 0 from seats 1 … k's shares of one option. */
function atZero(shares: readonly (readonly { v: bigint; r: bigint }[])[], j: number) {
  const mod = (x: bigint) => ((x % GROUP_ORDER) + GROUP_ORDER) % GROUP_ORDER;
  const inv = (x: bigint) => {
    let [a, b, u] = [mod(x), GROUP_ORDER, 1n];
    let w = 0n;
    while (b !== 0n) {
      const q = a / b;
      [a, b] = [b, a - q * b];
      [u, w] = [w, u - q * w];
    }
    return mod(u);
  };
  const xs = shares.map((_, i) => BigInt(i + 1));
  let v = 0n;
  let r = 0n;
  xs.forEach((xi, i) => {
    let l = 1n;
    for (const xm of xs) if (xm !== xi) l = mod(l * xm * inv(xm - xi));
    const s = shares[i]![j]!;
    v = mod(v + l * s.v);
    r = mod(r + l * s.r);
  });
  return { v, r };
}

describe("ballot version 4 properties", () => {
  test("an honest ballot verifies, round-trips, and each panel's shares check", () => {
    fc.assert(
      fc.property(pollArb, (p) => {
        const { ctx, sharing, vote } = honest(p);
        expect(checkValidityV4(ctx, vote)).toEqual({ ok: true });
        const bytes = encode(COMMITTED_VOTE_V4, vote);
        expect(encode(COMMITTED_VOTE_V4, decode(COMMITTED_VOTE_V4, bytes))).toEqual(bytes);
        sharing.shares.forEach((s, i) => expect(checkShares(vote.vss, i + 1, s)).toBe(true));
        sharing.authorShares.forEach((s, i) =>
          expect(checkShares(vote.author_vss, i + 1, s)).toBe(true),
        );
        expect(vote.author_vss.length).toBe(p.authorPanelSize === 0 ? 0 : p.votes.length);
      }),
      { numRuns: Math.max(10, numRuns / 20) },
    );
  }, 120_000);

  test("k_D default seats and k_A author seats together open the vote", () => {
    fc.assert(
      fc.property(pollArb, (p) => {
        fc.pre(p.authorPanelSize > 0);
        const { sharing, vote } = honest(p);
        const commitments = voteCommitmentsV4(vote);
        p.votes.forEach((v, j) => {
          const d = atZero(sharing.shares.slice(0, p.threshold), j);
          const a = atZero(sharing.authorShares.slice(0, p.authorThreshold), j);
          const mod = (x: bigint) => x % GROUP_ORDER;
          expect(mod(d.v + a.v)).toBe(BigInt(v));
          // The two partial openings add to an opening of C_j (Binding).
          const r = mod(d.r + a.r);
          const opened = (v === 1 ? G : IDENTITY).add(
            r === 0n ? IDENTITY : GENERATOR_H.multiply(r),
          );
          expect(opened.equals(commitments[j]!)).toBe(true);
        });
      }),
      { numRuns: Math.max(10, numRuns / 20) },
    );
  }, 120_000);

  test("the proofs bind the cell, the nullifier, the election and the author half", () => {
    fc.assert(
      fc.property(pollArb, fc.integer({ min: 1, max: 255 }), (p, delta) => {
        const { ctx, vote } = honest(p);
        const fail = { ok: false, code: "option-proof", option: 0 };
        expect(checkValidityV4({ ...ctx, cell: (ctx.cell + delta) % 256 }, vote)).toEqual(fail);
        expect(checkValidityV4({ ...ctx, nullifier: ctx.nullifier + 1n }, vote)).toEqual(fail);
        const other = Uint8Array.from(ctx.definitionHash);
        other[0] = (other[0]! + delta) % 256; // 32 bytes
        expect(checkValidityV4({ ...ctx, definitionHash: other }, vote)).toEqual(fail);
        if (p.authorPanelSize > 0) {
          const author_share_hashes = vote.author_share_hashes.map((h, i) =>
            i === 0 ? new Uint8Array(32) : h,
          );
          expect(checkValidityV4(ctx, { ...vote, author_share_hashes })).toEqual(fail);
        }
      }),
      { numRuns: Math.max(10, numRuns / 50) },
    );
  }, 120_000);

  // Ballot version 5 (Hashes (version 5)): version 4's committed vote, its
  // proofs under version input 5, so a proof made for one version never
  // verifies in the other's ballot (T-31).
  test("proofs made for ballot version 5 verify under version 5 only, and version 4's under 4 only", () => {
    fc.assert(
      fc.property(pollArb, (p) => {
        const { votes: _, ...ctx } = p;
        const sharing = shareVoteV4(ctx, p.votes);
        const vote = proveValidityV5(
          ctx,
          sharing,
          hashes(p.panelSize, 1),
          hashes(p.authorPanelSize, 100),
        );
        const fail = { ok: false, code: "option-proof", option: 0 };
        expect(checkValidityV5(ctx, vote)).toEqual({ ok: true });
        expect(checkValidityV4(ctx, vote)).toEqual(fail);
        expect(checkValidityV5({ ...ctx, nullifier: ctx.nullifier + 1n }, vote)).toEqual(fail);
        expect(checkValidityV5(ctx, honest(p).vote)).toEqual(fail);
      }),
      { numRuns: Math.max(10, numRuns / 50) },
    );
  }, 120_000);

  test("a ballot proves only under its own author panel's shape", () => {
    fc.assert(
      fc.property(pollArb, (p) => {
        const { ctx, vote } = honest(p);
        const shape = { ok: false, code: "validity-shape" };
        const other =
          p.authorPanelSize === 0
            ? { ...ctx, authorThreshold: 1, authorPanelSize: 1 }
            : { ...ctx, authorThreshold: 0, authorPanelSize: 0 };
        expect(checkValidityV4(other, vote)).toEqual(shape);
      }),
      { numRuns: Math.max(10, numRuns / 50) },
    );
  }, 120_000);
});

describe("ballot version 4 sharing and proving", () => {
  const rules = {
    questions: [
      { optionCount: 3, minSelections: 0, maxSelections: 1 },
      { optionCount: 2, minSelections: 1, maxSelections: 2 },
    ],
    threshold: 2,
    panelSize: 3,
    authorThreshold: 2,
    authorPanelSize: 2,
  };
  const ctx: ValidityContextV4 = {
    ...rules,
    definitionHash: new Uint8Array(32),
    cell: 0,
    nullifier: 1n,
  };

  test("refuses an author panel outside 1 ≤ k_A ≤ n_A ≤ MAX_TRUSTEES, or a threshold without seats", () => {
    const votes = [1, 0, 0, 1, 0] as const;
    for (const [k, n] of [
      [0, 2],
      [3, 2],
      [1, 0],
      [17, 17],
    ])
      expect(() =>
        shareVoteV4({ ...rules, authorThreshold: k!, authorPanelSize: n! }, votes),
      ).toThrow(RangeError);
    expect(() =>
      shareVoteV4({ ...rules, authorThreshold: 0, authorPanelSize: 0 }, votes),
    ).not.toThrow();
    expect(() =>
      shareVoteV4({ ...rules, authorThreshold: 1, authorPanelSize: 1 }, votes),
    ).not.toThrow();
  });

  test("refuses halves whose constant terms don't add to the vote", () => {
    const p = (f0: bigint): OptionPolynomials => ({ f: [f0, 5n], g: [7n, 9n] });
    const author = [p(3n), p(3n), p(3n), p(3n), p(3n)];
    // Default constant terms v − 3: right for every option but the last.
    const def = [1n, 0n, 0n, 1n, 1n].map((v) => p((v - 3n + GROUP_ORDER) % GROUP_ORDER));
    expect(() => shareVoteV4With(rules, [1, 0, 0, 1, 0], def, author)).toThrow(RangeError);
    def[4] = p(GROUP_ORDER - 3n);
    expect(() => shareVoteV4With(rules, [1, 0, 0, 1, 0], def, author)).not.toThrow();
  });

  test("refuses author polynomials without an author panel, and a missing author half with one", () => {
    const p = (f0: bigint): OptionPolynomials => ({ f: [f0, 5n], g: [7n, 9n] });
    const votes = [1, 0, 0, 1, 0] as const;
    const plain = { ...rules, authorThreshold: 0, authorPanelSize: 0 };
    const def = votes.map((v) => p(BigInt(v)));
    expect(() => shareVoteV4With(plain, votes, def, def)).toThrow(RangeError);
    expect(() => shareVoteV4With(rules, votes, def, [])).toThrow(RangeError);
  });

  test("each prover proves only its own version's sharing", () => {
    const v3Rules = { questions: rules.questions, threshold: 2, panelSize: 3 };
    const v3Ctx = { ...v3Rules, definitionHash: new Uint8Array(32), cell: 0, nullifier: 1n };
    const v3 = shareVoteV3(v3Rules, [1, 0, 0, 1, 0]);
    // @ts-expect-error a version-3 sharing isn't a version-4 one
    expect(() => proveValidityV4(ctx, v3, hashes(3, 0), hashes(2, 9))).toThrow(TypeError);
    const v4 = shareVoteV4(rules, [1, 0, 0, 1, 0]);
    expect(() => proveValidityV3(v3Ctx, v4, hashes(3, 0))).toThrow(TypeError);
    const nonce = { w: 3n, simulated: [{ c: 4n, z: 5n }] };
    expect(() =>
      proveValidityV3With(v3Ctx, v4, hashes(3, 0), { options: [], questions: [nonce] }),
    ).toThrow(TypeError);
  });

  test("version 1's prover and share encryption refuse a version-4 sharing", () => {
    const v4 = shareVoteV4(rules, [1, 0, 0, 1, 0]);
    const v1Ctx = {
      optionCount: 5,
      minSelections: 0,
      maxSelections: 5,
      threshold: 2,
      panelSize: 3,
      definitionHash: new Uint8Array(32),
      tier: 0,
      nullifier: 1n,
    };
    expect(() => proveValidity(v1Ctx, v4, hashes(3, 0))).toThrow(TypeError);
    // Its halves never reach a seat as one sharing (share-encryption.md, Ballot version 4, in part 2b-3).
    expect(() => encryptShares({ definitionHash: new Uint8Array(32) }, v4, [])).toThrow(TypeError);
  });

  test("refuses share-hash lists of the wrong length for either panel", () => {
    const sharing = shareVoteV4(rules, [0, 1, 0, 1, 0]);
    expect(() => proveValidityV4(ctx, sharing, hashes(2, 0), hashes(2, 9))).toThrow(RangeError);
    expect(() => proveValidityV4(ctx, sharing, hashes(3, 0), hashes(3, 9))).toThrow(RangeError);
    expect(() => proveValidityV4(ctx, sharing, hashes(3, 0), [])).toThrow(RangeError);
  });

  test("refuses an election whose author panel differs from the sharing's", () => {
    const sharing = shareVoteV4(rules, [0, 1, 0, 1, 0]);
    const plain = { ...ctx, authorThreshold: 0, authorPanelSize: 0 };
    expect(() => proveValidityV4(plain, sharing, hashes(3, 0), [])).toThrow(RangeError);
    const wider = { ...ctx, authorThreshold: 3, authorPanelSize: 3 };
    expect(() => proveValidityV4(wider, sharing, hashes(3, 0), hashes(3, 9))).toThrow(RangeError);
    // The same thresholds over more seats: no seat may be named without its shares.
    const moreAuthors = { ...ctx, authorPanelSize: 3 };
    expect(() => proveValidityV4(moreAuthors, sharing, hashes(3, 0), hashes(3, 9))).toThrow(
      RangeError,
    );
    const moreDefaults = { ...ctx, panelSize: 4 };
    expect(() => proveValidityV4(moreDefaults, sharing, hashes(4, 0), hashes(2, 9))).toThrow(
      RangeError,
    );
  });

  test("a prover never proves a sharing a challenge opened", () => {
    const sharing = shareVoteV4(rules, [0, 1, 0, 1, 0]);
    markOpened(sharing);
    expect(() => proveValidityV4(ctx, sharing, hashes(3, 0), hashes(2, 9))).toThrow(TypeError);
  });

  test("version 3's checks and hashes never accept a version-4 ballot as theirs", () => {
    const sharing = shareVoteV4(
      { ...rules, authorThreshold: 0, authorPanelSize: 0 },
      [0, 1, 0, 1, 0],
    );
    const plain = { ...ctx, authorThreshold: 0, authorPanelSize: 0 };
    const vote = proveValidityV4(plain, sharing, hashes(3, 0), []);
    const { author_vss: _a, author_share_hashes: _h, ...v3 } = vote;
    const v3Ctx = { ...ctx, questions: rules.questions };
    // Without an author panel C_j is version 3's, but the statement's version input isn't.
    expect(checkValidityV3(v3Ctx, v3)).toEqual({ ok: false, code: "option-proof", option: 0 });
    expect(toHex(statementHashV3(v3Ctx, v3.vss, v3.share_hashes))).not.toBe(
      toHex(statementHashV4(plain, vote)),
    );
    expect(toHex(ballotHashV3(v3Ctx, v3))).not.toBe(toHex(ballotHashV4(plain, vote)));
  });

  test("voteCommitmentsV4 refuses an author list of another length than vss", () => {
    const sharing = shareVoteV4(rules, [0, 1, 0, 1, 0]);
    expect(() =>
      voteCommitmentsV4({ vss: sharing.vss, author_vss: sharing.authorVss.slice(1) }),
    ).toThrow(RangeError);
  });
});
