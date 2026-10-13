import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  bytesFixed,
  challenge,
  checkShares,
  decode,
  DecodeError,
  ds,
  type Element,
  element,
  elementOrIdentity,
  encode,
  fieldBn254,
  G,
  GENERATOR_H,
  GROUP_ORDER,
  H,
  IDENTITY,
  list,
  scalar,
  SHARES,
  struct,
  u16,
  u8,
  Writer,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/ballot-v3.json, spoiled-opening-v2.json and
// tally-questions.json, printed by scripts/ballot-v3-vectors.py (P2-14 part
// 1b). These tests read the files with codecs built here from the production
// field codecs and check them with a second, test-only reading of the spec's
// checks over the production group and hash: the Python generator and this
// reading must agree on every byte, hash and verdict (T-31, T-36).
// ballot-v3.test.ts runs the committed votes through the production code
// (part 3a), spoiled-opening-v2.test.ts the openings (part 3c) and
// tally-questions.test.ts tally-question-range (part 4).

const MAX_TRUSTEES = 16;
const MAX_OPTIONS = 64;
const MAX_QUESTIONS = 32;
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const read = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(name, SPEC_VECTORS), "utf8")) as T;

// Ballot-validity.md, Committed vote (version 3), from the field codecs.
const VSS = list(list(element, MAX_TRUSTEES), MAX_OPTIONS);
const SHARE_HASHES = list(bytesFixed(32), MAX_TRUSTEES);
const BIT_PROOF = struct([
  ["c0", scalar],
  ["z0", scalar],
  ["c1", scalar],
  ["z1", scalar],
]);
const BRANCH = struct([
  ["c", scalar],
  ["z", scalar],
]);
const COMMITTED_VOTE_V3 = struct([
  ["vss", VSS],
  ["share_hashes", SHARE_HASHES],
  ["option_proofs", list(BIT_PROOF, MAX_OPTIONS)],
  ["sum_proofs", list(list(BRANCH, MAX_OPTIONS + 1), MAX_QUESTIONS)],
]);
type Vote = ReturnType<typeof COMMITTED_VOTE_V3.read>;

const mul = (p: Element, s: bigint) => {
  const e = ((s % GROUP_ORDER) + GROUP_ORDER) % GROUP_ORDER;
  return e === 0n ? IDENTITY : p.multiply(e);
};
const pedersen = (v: bigint, r: bigint) => mul(G, v).add(mul(GENERATOR_H, r));

interface Question {
  readonly optionCount: number;
  readonly minSelections: number;
  readonly maxSelections: number;
  readonly offset: number;
}
interface Election {
  readonly definition: string;
  readonly definitionHash: string;
  readonly ballotVersion: number;
  readonly questions: readonly Question[];
  readonly optionTotal: number;
  readonly threshold: number;
  readonly panelSize: number;
  readonly cells: number;
  readonly registered?: readonly number[];
}
interface Context {
  readonly definitionHash: Uint8Array;
  readonly cell: number;
  readonly nullifier: bigint;
}

function header(ctx: Context, version: number, nullifier: boolean): Writer {
  const w = new Writer();
  w.bytes(ctx.definitionHash);
  u16.write(w, 0x0002);
  u8.write(w, version);
  u8.write(w, ctx.cell);
  if (nullifier) fieldBn254.write(w, ctx.nullifier);
  return w;
}

function statementHash(ctx: Context, vote: Vote): Uint8Array {
  const w = header(ctx, 3, true);
  VSS.write(w, vote.vss);
  SHARE_HASHES.write(w, vote.share_hashes);
  return H(ds("abolish/v1/ballot-statement", w.finish()));
}

function coreHash(ctx: Context, version: number, vss: Vote["vss"], hashes: Vote["share_hashes"]) {
  const w = header(ctx, version, false);
  VSS.write(w, vss);
  SHARE_HASHES.write(w, hashes);
  return H(ds("abolish/v1/ballot-core", w.finish()));
}

/** Ballot-validity.md, Validity proofs: accepts iff the branch challenges sum to the challenge. */
function verifyOr(
  tag: "abolish/v1/fs/ballot-validity/option" | "abolish/v1/fs/ballot-validity/question-sum",
  prefix: Uint8Array,
  y: Element,
  values: readonly number[],
  branches: readonly { readonly c: bigint; readonly z: bigint }[],
): boolean {
  const w = new Writer();
  w.bytes(prefix);
  elementOrIdentity.write(w, y);
  let sum = 0n;
  values.forEach((s, b) => {
    const { c, z } = branches[b]!; // same length, checked by the shape check
    elementOrIdentity.write(w, mul(GENERATOR_H, z).subtract(mul(y.subtract(mul(G, BigInt(s))), c)));
    sum += c;
  });
  return sum % GROUP_ORDER === challenge(tag, w.finish());
}

const prefix = (statement: Uint8Array, ...xs: number[]) => {
  const w = new Writer();
  w.bytes(statement);
  for (const x of xs) u16.write(w, x);
  return w.finish();
};

const range = (lo: number, hi: number) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

/** Ballot-validity.md, Checks (version 3), in order. */
function checkValidity(e: Election, ctx: Context, vote: Vote): unknown {
  const qs = e.questions;
  if (
    vote.vss.length !== e.optionTotal ||
    vote.vss.some((row) => row.length !== e.threshold) ||
    vote.share_hashes.length !== e.panelSize ||
    vote.option_proofs.length !== e.optionTotal ||
    vote.sum_proofs.length !== qs.length ||
    vote.sum_proofs.some((b, q) => b.length !== qs[q]!.maxSelections - qs[q]!.minSelections + 1)
  )
    return { code: "validity-shape" };
  const st = statementHash(ctx, vote);
  for (const [j, p] of vote.option_proofs.entries()) {
    const branches = [
      { c: p.c0, z: p.z0 },
      { c: p.c1, z: p.z1 },
    ];
    if (
      !verifyOr(
        "abolish/v1/fs/ballot-validity/option",
        prefix(st, j),
        vote.vss[j]![0]!,
        [0, 1],
        branches,
      )
    )
      return { code: "option-proof", option: j };
  }
  for (const [q, question] of qs.entries()) {
    const { optionCount: m, minSelections: lo, maxSelections: hi, offset: o } = question;
    let y = IDENTITY;
    for (let j = o; j < o + m; j++) y = y.add(vote.vss[j]![0]!);
    const tag = "abolish/v1/fs/ballot-validity/question-sum";
    if (!verifyOr(tag, prefix(st, q, o, m, lo, hi), y, range(lo, hi), vote.sum_proofs[q]!))
      return { code: "sum-proof", question: q };
  }
  return "ok";
}

function decodeError(f: () => unknown): DecodeError | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof DecodeError) return e;
    throw e;
  }
  return undefined;
}

describe("ballot version 3 (docs/spec/ballot-validity.md, Ballot record (version 3))", () => {
  const file = read<{
    readonly elections: Record<string, Election>;
    readonly ballots: readonly {
      readonly id: string;
      readonly election: string;
      readonly context: {
        readonly definitionHash: string;
        readonly cell: number;
        readonly nullifier: string;
      };
      readonly encoding: string;
      readonly result: unknown;
      readonly statementHash?: string;
      readonly ballotHash?: string;
      readonly coreHash?: string;
      readonly shares?: readonly string[];
    }[];
    readonly decode: readonly {
      readonly id: string;
      readonly encoding: string;
      readonly error: string;
      readonly offset: number;
    }[];
  }>("ballot-v3.json");

  test("each election's definition hashes to its definitionHash, and its offsets are the flat indices", () => {
    for (const e of Object.values(file.elections)) {
      expect(toHex(H(ds("abolish/v1/election-definition", hex(e.definition))))).toBe(
        e.definitionHash,
      );
      let o = 0;
      for (const q of e.questions) {
        expect(q.offset).toBe(o);
        o += q.optionCount;
      }
      expect(e.optionTotal).toBe(o);
    }
  });

  test.each(file.ballots.map((b) => [b.id, b] as const))("%s", (_id, b) => {
    const e = file.elections[b.election]!; // every ballot names a listed election
    const bytes = hex(b.encoding);
    const vote = decode(COMMITTED_VOTE_V3, bytes);
    expect(toHex(encode(COMMITTED_VOTE_V3, vote))).toBe(b.encoding);
    const ctx = {
      definitionHash: hex(b.context.definitionHash),
      cell: b.context.cell,
      nullifier: BigInt(b.context.nullifier),
    };
    expect(checkValidity(e, ctx, vote)).toEqual(b.result);
    if (b.result !== "ok") return;
    expect(toHex(statementHash(ctx, vote))).toBe(b.statementHash);
    const w = header(ctx, 3, true);
    w.bytes(bytes);
    expect(toHex(H(ds("abolish/v1/ballot", w.finish())))).toBe(b.ballotHash);
    expect(toHex(coreHash(ctx, 3, vote.vss, vote.share_hashes))).toBe(b.coreHash);
    // The production share check, over the T flat options.
    for (const [i, s] of (b.shares ?? []).entries())
      expect(checkShares(vote.vss, i + 1, decode(SHARES, hex(s)))).toBe(true);
  });

  test.each(file.decode.map((d) => [d.id, d] as const))("decode: %s", (_id, d) => {
    const err = decodeError(() => decode(COMMITTED_VOTE_V3, hex(d.encoding)));
    expect(err?.code).toBe(d.error);
    expect(err?.offset).toBe(d.offset);
  });
});

describe("spoiled-ballot opening version 2 (docs/spec/challenge.md, Opening version 2)", () => {
  const OPENING_V2 = struct([
    ["definition_hash", bytesFixed(32)],
    ["cell", u8],
    ["vss", VSS],
    ["share_hashes", SHARE_HASHES],
    [
      "polynomials",
      list(
        struct([
          ["f", list(scalar, MAX_TRUSTEES)],
          ["g", list(scalar, MAX_TRUSTEES)],
        ]),
        MAX_OPTIONS,
      ),
    ],
    [
      "seats",
      list(
        struct([
          ["seat", u8],
          ["m", bytesFixed(32)],
          ["e", scalar],
          ["w", scalar],
        ]),
        MAX_TRUSTEES,
      ),
    ],
  ]);
  const file = read<{
    readonly elections: Record<string, Election>;
    readonly openings: readonly {
      readonly id: string;
      readonly election: string;
      readonly encoding: string;
      readonly coreHash: string;
      readonly result: string;
      readonly votes?: readonly string[];
      readonly voteOutside?: { readonly question: number };
      readonly option?: number;
    }[];
    readonly decode: readonly {
      readonly id: string;
      readonly encoding: string;
      readonly error: string;
    }[];
    readonly decodedCells: readonly { readonly encoding: string; readonly cell: number }[];
    readonly coreHashVersions: readonly {
      readonly opening: string;
      readonly coreHashVersion2: string;
      readonly coreHashVersion3: string;
    }[];
  }>("spoiled-opening-v2.json");

  const body = (encoding: string) => {
    const bytes = hex(encoding);
    expect(toHex(bytes.subarray(0, 3))).toBe("000302");
    return decode(OPENING_V2, bytes.subarray(3));
  };

  // The checks this reading can run without rebuilding ciphertexts: every one
  // before `opening-ciphertext`, in order.
  function check(e: Election, o: ReturnType<typeof body>): string {
    if (toHex(o.definition_hash) !== e.definitionHash) return "opening-stray";
    if (o.cell >= e.cells) return "opening-cell";
    const T = e.optionTotal;
    const k = e.threshold;
    const seats = o.seats.map((s) => s.seat);
    if (
      o.vss.length !== T ||
      o.vss.some((row) => row.length !== k) ||
      o.share_hashes.length !== e.panelSize ||
      o.polynomials.length !== T ||
      o.polynomials.some((p) => p.f.length !== k || p.g.length !== k) ||
      JSON.stringify(seats) !== JSON.stringify(e.registered)
    )
      return "opening-shape";
    for (let i = 1; i <= e.panelSize; i++)
      if (!e.registered!.includes(i) && o.share_hashes[i - 1]!.some((x) => x !== 0))
        return "opening-unqualified";
    for (const [j, p] of o.polynomials.entries())
      for (let t = 0; t < k; t++)
        if (!pedersen(p.f[t]!, p.g[t]!).equals(o.vss[j]![t]!)) return `opening-vss:${j}`;
    return "passes-vss";
  }

  test.each(file.openings.map((o) => [o.id, o] as const))("%s", (_id, v) => {
    const e = file.elections[v.election]!; // every opening names a listed election
    const o = body(v.encoding);
    const ctx = { definitionHash: o.definition_hash, cell: o.cell, nullifier: 0n };
    expect(toHex(coreHash(ctx, e.ballotVersion, o.vss, o.share_hashes))).toBe(v.coreHash);
    const got = check(e, o);
    if (v.result === "opening-vss") expect(got).toBe(`opening-vss:${v.option}`);
    else if (v.result === "ok" || v.result === "opening-ciphertext") expect(got).toBe("passes-vss");
    else expect(got).toBe(v.result);
    if (v.result !== "ok") return;
    const votes = o.polynomials.map((p) => p.f[0]!);
    expect(votes.map(String)).toEqual(v.votes);
    // Votes outside: the first question with a vote other than 0 or 1, or its count out of range.
    const outside = e.questions.findIndex((q) => {
      const part = votes.slice(q.offset, q.offset + q.optionCount);
      const count = part.reduce((a, x) => a + x, 0n);
      return (
        part.some((x) => x > 1n) ||
        count < BigInt(q.minSelections) ||
        count > BigInt(q.maxSelections)
      );
    });
    expect(outside === -1 ? undefined : { question: outside }).toEqual(v.voteOutside);
  });

  test.each(file.decode.map((d) => [d.id, d] as const))("decode: %s", (_id, d) => {
    const bytes = hex(d.encoding);
    if (d.error === "profile-mismatch") {
      // Version 1 under a profile pinning version 2: the header names another version.
      expect(bytes[2]).not.toBe(2);
      return;
    }
    expect(decodeError(() => body(d.encoding))?.code).toBe(d.error);
  });

  test("a cell outside the partition still decodes", () => {
    for (const c of file.decodedCells) expect(body(c.encoding).cell).toBe(c.cell);
  });

  test("a core's tracking code differs under ballot versions 2 and 3", () => {
    for (const c of file.coreHashVersions) {
      const v = file.openings.find((o) => o.id === c.opening)!; // listed above
      const o = body(v.encoding);
      const ctx = { definitionHash: o.definition_hash, cell: o.cell, nullifier: 0n };
      expect(toHex(coreHash(ctx, 2, o.vss, o.share_hashes))).toBe(c.coreHashVersion2);
      expect(toHex(coreHash(ctx, 3, o.vss, o.share_hashes))).toBe(c.coreHashVersion3);
      expect(c.coreHashVersion2).not.toBe(c.coreHashVersion3);
    }
  });
});

describe("tally-question-range (docs/spec/tally.md, Opening checks)", () => {
  const file = read<{
    readonly election: Election;
    readonly cells: readonly {
      readonly id: string;
      readonly ballots: readonly string[];
      readonly aggregate: readonly string[];
      readonly opening: readonly { readonly v: string; readonly r: string }[];
      readonly result: unknown;
    }[];
  }>("tally-questions.json");
  const e = file.election;

  test.each(file.cells.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const ballots = c.ballots.map((b) => decode(VSS, hex(b)));
    const agg = Array.from({ length: e.optionTotal }, (_, j) =>
      ballots.reduce((acc, vss) => acc.add(vss[j]![0]!), IDENTITY),
    );
    expect(agg.map((x) => toHex(x.toBytes()))).toEqual(c.aggregate);
    const opening = c.opening.map((x) => ({ v: BigInt(x.v), r: BigInt(x.r) }));
    const counted = BigInt(ballots.length);
    const verdict = (() => {
      if (opening.length !== e.optionTotal) return { code: "tally-missing" };
      for (const [j, { v, r }] of opening.entries())
        if (!pedersen(v, r).equals(agg[j]!)) return { code: "tally-opening", option: j };
      for (const [j, { v }] of opening.entries())
        if (v > counted) return { code: "tally-range", option: j };
      for (const [
        q,
        { offset, optionCount, minSelections, maxSelections },
      ] of e.questions.entries()) {
        const total = opening.slice(offset, offset + optionCount).reduce((a, x) => a + x.v, 0n);
        if (total < BigInt(minSelections) * counted || total > BigInt(maxSelections) * counted)
          return { code: "tally-question-range", question: q };
      }
      return "ok";
    })();
    expect(verdict).toEqual(c.result);
  });
});
