import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  markOpened,
  type OptionPolynomials,
  VSS,
  proveValidityV3With,
  proveValidityWith,
  shareVoteV3With,
  shareVoteWith,
  type ValidityNoncesV3,
} from "../src/ballot-validity.ts";
import {
  ballotHashV3,
  bytesFixed,
  cellCoreHash,
  checkShares,
  checkValidityV3,
  COMMITTED_VOTE_V3,
  decode,
  DecodeError,
  encode,
  GROUP_ORDER,
  list,
  proveValidity,
  proveValidityV3,
  type QuestionRules,
  Reader,
  SHARES,
  shareVote,
  shareVoteV3,
  statementHashV3,
  struct,
  u8,
  type ValidityContextV3,
  type ValidityResultV3,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// Ballot version 3 through the production code (P2-14 part 3), against
// docs/spec/vectors/ballot-v3.json and spoiled-opening-v2.json, printed by
// scripts/ballot-v3-vectors.py, an implementation of the spec that shares no
// code with this package: every byte, hash and verdict here comes from it,
// never from the code under test (T-31, T-36).

interface Nonces {
  readonly w: string;
  readonly simulated: readonly { readonly c: string; readonly z: string }[];
}

interface Election {
  readonly definitionHash: string;
  readonly questions: readonly (QuestionRules & { readonly offset: number })[];
  readonly optionTotal: number;
  readonly threshold: number;
  readonly panelSize: number;
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
    readonly polynomials: readonly {
      readonly f: readonly string[];
      readonly g: readonly string[];
    }[];
    readonly options: readonly Nonces[];
    readonly questions: readonly Nonces[];
  };
  readonly shareHashes?: readonly string[];
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
}

const read = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(name, SPEC_VECTORS), "utf8")) as T;

const vectors = read<{
  readonly format: string;
  readonly elections: Record<string, Election>;
  readonly ballots: readonly BallotVector[];
  readonly decode: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly error: string;
    readonly offset: number;
  }[];
}>("ballot-v3.json");

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const electionOf = (b: BallotVector): Election => {
  const e = vectors.elections[b.election];
  if (e === undefined) throw new Error(`${b.id} names no listed election`);
  return e;
};

const contextOf = (b: BallotVector): ValidityContextV3 => {
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
  };
};

const noncesOf = (n: Nonces) => ({
  w: BigInt(n.w),
  simulated: n.simulated.map((s) => ({ c: BigInt(s.c), z: BigInt(s.z) })),
});

const expected = (r: BallotVector["result"]): ValidityResultV3 =>
  r === "ok" ? { ok: true } : { ok: false, ...r };

describe("ballot-v3.json through the production code", () => {
  test("is the file this suite reads", () => {
    expect(vectors.format).toBe("abolish-ballot-v3-vectors/1");
  });

  const valid = vectors.ballots.filter((b) => b.randomness !== undefined);
  test.each(valid.map((b) => [b.id, b] as const))(
    "reproduces %s byte for byte from its randomness",
    (_, b) => {
      const ctx = contextOf(b);
      const r = b.randomness!; // filtered above
      const polynomials: OptionPolynomials[] = r.polynomials.map((p) => ({
        f: p.f.map(BigInt),
        g: p.g.map(BigInt),
      }));
      const sharing = shareVoteV3With(ctx, b.votes ?? [], polynomials);
      const shareHashes = (b.shareHashes ?? []).map(hex);
      const nonces: ValidityNoncesV3 = {
        options: r.options.map(noncesOf),
        questions: r.questions.map(noncesOf),
      };
      const vote = proveValidityV3With(ctx, sharing, shareHashes, nonces);
      expect(toHex(encode(COMMITTED_VOTE_V3, vote))).toBe(b.encoding);
      expect(toHex(statementHashV3(ctx, vote.vss, shareHashes))).toBe(b.statementHash);
      expect(toHex(ballotHashV3(ctx, vote))).toBe(b.ballotHash);
      const core = {
        definitionHash: ctx.definitionHash,
        ballotVersion: 3 as const,
        cell: ctx.cell,
      };
      expect(toHex(cellCoreHash({ ...core, vss: vote.vss, shareHashes }))).toBe(b.coreHash);
      if (b.shares !== undefined)
        expect(sharing.shares.map((s) => toHex(encode(SHARES, s)))).toEqual(b.shares);
      sharing.shares.forEach((s, i) => expect(checkShares(vote.vss, i + 1, s)).toBe(true));
      expect(checkValidityV3(ctx, vote)).toEqual({ ok: true });
    },
    // range-max and questions-max prove 64 options: seconds on a shared runner.
    60_000,
  );

  test.each(vectors.ballots.map((b) => [b.id, b] as const))(
    "checks %s with the vector's verdict",
    (_, b) => {
      const vote = decode(COMMITTED_VOTE_V3, hex(b.encoding));
      expect(toHex(encode(COMMITTED_VOTE_V3, vote))).toBe(b.encoding);
      expect(checkValidityV3(contextOf(b), vote)).toEqual(expected(b.result));
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
      decode(COMMITTED_VOTE_V3, hex(d.encoding));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DecodeError);
    expect((err as DecodeError).code).toBe(d.error);
    expect((err as DecodeError).offset).toBe(d.offset);
  });
});

describe("cellCoreHash against spoiled-opening-v2.json", () => {
  const file = read<{
    readonly openings: readonly { readonly id: string; readonly encoding: string }[];
    readonly coreHashVersions: readonly {
      readonly opening: string;
      readonly coreHashVersion2: string;
      readonly coreHashVersion3: string;
    }[];
  }>("spoiled-opening-v2.json");

  // The opening's core, its first four fields in the core hash's order
  // (docs/spec/challenge.md, Opening version 2), after the record header.
  const CORE = struct([
    ["definition_hash", bytesFixed(32)],
    ["cell", u8],
    ["vss", VSS],
    ["share_hashes", list(bytesFixed(32), 16)],
  ]);
  const coreOf = (encoding: string) => {
    const c = CORE.read(new Reader(hex(encoding).subarray(3)));
    return {
      definitionHash: c.definition_hash,
      cell: c.cell,
      vss: c.vss,
      shareHashes: c.share_hashes,
    };
  };

  test.each(file.coreHashVersions.map((c) => [c.opening, c] as const))(
    "the core of %s has each version's tracking code",
    (_, c) => {
      const o = file.openings.find((x) => x.id === c.opening);
      if (o === undefined) throw new Error(`${c.opening} isn't listed`);
      const core = coreOf(o.encoding);
      expect(toHex(cellCoreHash({ ...core, ballotVersion: 2 }))).toBe(c.coreHashVersion2);
      expect(toHex(cellCoreHash({ ...core, ballotVersion: 3 }))).toBe(c.coreHashVersion3);
    },
  );
});

// Small polls for the properties: up to 3 questions of 2 to 4 options, k ≤ n ≤ 4.
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
      { minLength: 1, maxLength: 3 },
    ),
    n: fc.integer({ min: 2, max: 4 }),
  })
  .chain(({ questions, n }) =>
    fc.record({
      questions: fc.constant(questions),
      threshold: fc.integer({ min: 2, max: n }),
      panelSize: fc.constant(n),
      // One valid count per question, then which options carry it.
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

function honest(p: Poll) {
  const ctx: ValidityContextV3 = {
    questions: p.questions,
    threshold: p.threshold,
    panelSize: p.panelSize,
    definitionHash: p.definitionHash,
    cell: p.cell,
    nullifier: p.nullifier,
  };
  const sharing = shareVoteV3(ctx, p.votes);
  const shareHashes = Array.from({ length: p.panelSize }, (_, i) => new Uint8Array(32).fill(i));
  return { ctx, sharing, vote: proveValidityV3(ctx, sharing, shareHashes) };
}

describe("ballot version 3 properties", () => {
  test("an honest ballot verifies, round-trips and its shares check", () => {
    fc.assert(
      fc.property(pollArb, (p) => {
        const { ctx, sharing, vote } = honest(p);
        expect(checkValidityV3(ctx, vote)).toEqual({ ok: true });
        const bytes = encode(COMMITTED_VOTE_V3, vote);
        expect(encode(COMMITTED_VOTE_V3, decode(COMMITTED_VOTE_V3, bytes))).toEqual(bytes);
        sharing.shares.forEach((s, i) => expect(checkShares(vote.vss, i + 1, s)).toBe(true));
      }),
      { numRuns: Math.max(10, numRuns / 20) },
    );
  }, 120_000);

  test("a changed range-proof scalar fails sum-proof at that question", () => {
    fc.assert(
      fc.property(pollArb, fc.nat(), fc.nat(), fc.boolean(), (p, qi, bi, which) => {
        const { ctx, vote } = honest(p);
        const q = qi % vote.sum_proofs.length;
        const proof = vote.sum_proofs[q]!; // q is in range
        const b = bi % proof.length;
        const br = proof[b]!; // b is in range
        const changed = which
          ? { c: (br.c + 1n) % GROUP_ORDER, z: br.z }
          : { c: br.c, z: (br.z + 1n) % GROUP_ORDER };
        const sum_proofs = vote.sum_proofs.map((x, i) =>
          i === q ? x.map((y, j) => (j === b ? changed : y)) : x,
        );
        expect(checkValidityV3(ctx, { ...vote, sum_proofs })).toEqual({
          ok: false,
          code: "sum-proof",
          question: q,
        });
      }),
      { numRuns: Math.max(10, numRuns / 20) },
    );
  }, 120_000);

  test("the proofs bind the cell, the nullifier and the election", () => {
    fc.assert(
      fc.property(pollArb, fc.integer({ min: 1, max: 255 }), (p, delta) => {
        const { ctx, vote } = honest(p);
        const fail = { ok: false, code: "option-proof", option: 0 };
        expect(checkValidityV3({ ...ctx, cell: (ctx.cell + delta) % 256 }, vote)).toEqual(fail);
        expect(checkValidityV3({ ...ctx, nullifier: ctx.nullifier + 1n }, vote)).toEqual(fail);
        const other = Uint8Array.from(ctx.definitionHash);
        other[0] = (other[0]! + delta) % 256; // 32 bytes
        expect(checkValidityV3({ ...ctx, definitionHash: other }, vote)).toEqual(fail);
      }),
      { numRuns: Math.max(10, numRuns / 50) },
    );
  }, 120_000);

  test("a range proof holds only under its question's own limits", () => {
    fc.assert(
      fc.property(pollArb, (p) => {
        const { ctx, vote } = honest(p);
        // Narrow question 0's range to exclude the voter's count.
        const q0 = ctx.questions[0]!; // at least one question
        const count = p.votes.slice(0, q0.optionCount).reduce<number>((a, v) => a + v, 0);
        const other =
          count < q0.maxSelections
            ? { ...q0, minSelections: count + 1 }
            : count > q0.minSelections
              ? { ...q0, maxSelections: count - 1 }
              : undefined;
        fc.pre(other !== undefined);
        const narrowed = { ...ctx, questions: [other!, ...ctx.questions.slice(1)] };
        expect(checkValidityV3(narrowed, vote).ok).toBe(false);
      }),
      { numRuns: Math.max(10, numRuns / 50) },
    );
  }, 120_000);
});

describe("ballot version 3 sharing and proving", () => {
  const rules = {
    questions: [
      { optionCount: 3, minSelections: 0, maxSelections: 1 },
      { optionCount: 2, minSelections: 1, maxSelections: 2 },
    ],
    threshold: 2,
    panelSize: 3,
  };
  const ctx: ValidityContextV3 = {
    ...rules,
    definitionHash: new Uint8Array(32),
    cell: 0,
    nullifier: 1n,
  };
  const hashes = [new Uint8Array(32), new Uint8Array(32), new Uint8Array(32)];

  test("refuses votes outside a question's limits, even when the total fits another split", () => {
    // Two in question 0 (at most 1) and none in question 1 (at least 1).
    expect(() => shareVoteV3(rules, [1, 1, 0, 0, 0])).toThrow(RangeError);
    expect(() => shareVoteV3(rules, [1, 0, 0, 0, 0])).toThrow(RangeError);
    expect(() => shareVoteV3(rules, [1, 0, 0, 1])).toThrow(RangeError);
  });

  test("each prover proves only its own version's sharing", () => {
    const v1Rules = {
      optionCount: 5,
      minSelections: 0,
      maxSelections: 5,
      threshold: 2,
      panelSize: 3,
    };
    const v1 = shareVote(v1Rules, [1, 0, 0, 1, 0]);
    expect(() => proveValidityV3(ctx, v1, hashes)).toThrow(TypeError);
    const v3 = shareVoteV3(rules, [1, 0, 0, 1, 0]);
    const v1Ctx = { ...v1Rules, definitionHash: new Uint8Array(32), tier: 0, nullifier: 1n };
    expect(() => proveValidity(v1Ctx, v3, hashes)).toThrow(TypeError);
  });

  test("refuses rules whose limits the sharing's votes break", () => {
    const sharing = shareVoteV3(rules, [0, 0, 0, 1, 1]);
    const strict = {
      ...ctx,
      questions: [rules.questions[0]!, { optionCount: 2, minSelections: 1, maxSelections: 1 }],
    };
    expect(() => proveValidityV3(strict, sharing, hashes)).toThrow(RangeError);
  });

  test("refuses a polynomial whose constant term isn't the vote", () => {
    const p = (f0: bigint): OptionPolynomials => ({ f: [f0, 5n], g: [7n, 9n] });
    expect(() =>
      shareVoteV3With(rules, [1, 0, 0, 1, 0], [p(0n), p(0n), p(0n), p(1n), p(0n)]),
    ).toThrow(RangeError);
  });

  test("refuses rules over MAX_QUESTIONS or MAX_OPTIONS", () => {
    const q = { optionCount: 2, minSelections: 0, maxSelections: 1 };
    const many = { ...rules, questions: Array.from({ length: 33 }, () => q) };
    expect(() =>
      shareVoteV3(
        many,
        Array.from({ length: 66 }, () => 0),
      ),
    ).toThrow(RangeError);
    const wide = {
      ...rules,
      questions: Array.from({ length: 3 }, () => ({ ...q, optionCount: 22 })),
    };
    expect(() =>
      shareVoteV3(
        wide,
        Array.from({ length: 66 }, () => 0),
      ),
    ).toThrow(RangeError);
    expect(() => shareVoteV3({ ...rules, questions: [] }, [])).toThrow(RangeError);
  });

  test("a prover never proves a sharing a challenge opened", () => {
    const sharing = shareVoteV3(rules, [0, 1, 0, 1, 0]);
    markOpened(sharing);
    expect(() => proveValidityV3(ctx, sharing, hashes)).toThrow(TypeError);
  });

  test("a version-1 sharing proves under version 1 only", () => {
    const v1Rules = {
      optionCount: 2,
      minSelections: 0,
      maxSelections: 1,
      threshold: 2,
      panelSize: 3,
    };
    const p = (f0: bigint): OptionPolynomials => ({ f: [f0, 5n], g: [7n, 9n] });
    const s = shareVoteWith(v1Rules, [1, 0], [p(1n), p(0n)]);
    const v1Ctx = { ...v1Rules, definitionHash: new Uint8Array(32), tier: 0, nullifier: 1n };
    const nonces = { w: 3n, simulated: [{ c: 4n, z: 5n }] };
    expect(() =>
      proveValidityV3With(ctx, s, hashes, { options: [nonces, nonces], questions: [nonces] }),
    ).toThrow(TypeError);
    expect(() =>
      proveValidityWith(v1Ctx, s, hashes, {
        options: [nonces, nonces],
        sum: nonces,
      }),
    ).not.toThrow();
  });
});
