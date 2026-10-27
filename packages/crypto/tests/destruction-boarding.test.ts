import { p256 } from "@noble/curves/nist.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  checkDestruction,
  type DestructionBoarding,
  destructionBoarding,
  type DestructionElection,
  destructionStatementMessage,
  encodeDestructionStatement,
  signDestructionStatement,
} from "../src/index.ts";
import { dsSignature } from "../src/domain-separation.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// The board operator's Boarding rule for a destruction statement
// (docs/spec/tally.md, Destruction, Boarding), judged against
// docs/spec/vectors/destruction.json, which an independent Python
// implementation wrote (scripts/destruction-vectors.py): each board's report
// lists its rejected, stray, unattributed and duplicate statements and each
// seat's first, from which every statement's boarding verdict follows without
// the code under test.

interface Vectors {
  readonly election: {
    readonly definitionHash: string;
    readonly registered: readonly { readonly index: number; readonly signingKey: string }[];
  };
  readonly statements: readonly {
    readonly id: string;
    readonly signingSecret: string;
    readonly signer: number;
    readonly encoding: string;
  }[];
  readonly reports: readonly {
    readonly id: string;
    readonly entries: readonly { readonly segment: number; readonly payload: string }[];
    readonly result: {
      readonly seats: readonly { readonly seat: number; readonly at?: number }[];
      readonly duplicates: readonly { readonly at: number; readonly seat: number }[];
      readonly unattributed: readonly { readonly at: number }[];
      readonly stray: readonly { readonly at: number }[];
      readonly rejected: readonly { readonly at: number; readonly error: string }[];
    };
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("destruction.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const election: DestructionElection = {
  definitionHash: hex(vectors.election.definitionHash),
  registered: vectors.election.registered.map((k) => ({
    index: k.index,
    signingKey: hex(k.signingKey),
  })),
};

const statement = (id: string) => {
  const s = vectors.statements.find((x) => x.id === id);
  if (s === undefined) throw new Error(`destruction.json: no ${id} statement`);
  return s;
};

/** The verdict the vector's report gives entry `at`, with `of` its seat's first entry. */
function expected(report: Vectors["reports"][number], at: number) {
  const { result } = report;
  const rejected = result.rejected.find((r) => r.at === at);
  if (rejected !== undefined) return { ok: false, code: "decode", error: rejected.error };
  if (result.stray.some((r) => r.at === at)) return { ok: false, code: "destruction-stray" };
  if (result.unattributed.some((r) => r.at === at))
    return { ok: false, code: "destruction-unattributed" };
  const duplicate = result.duplicates.find((r) => r.at === at);
  if (duplicate !== undefined) {
    const first = result.seats.find((s) => s.seat === duplicate.seat)?.at;
    if (first === undefined) throw new Error(`${report.id}: a duplicate with no first statement`);
    return { ok: false, code: "destruction-repeat", of: first };
  }
  const seat = result.seats.find((s) => s.at === at)?.seat;
  if (seat === undefined) throw new Error(`${report.id}: entry ${at} has no verdict`);
  return { ok: true, signer: seat };
}

describe("destruction boarding over docs/spec/vectors/destruction.json", () => {
  for (const report of vectors.reports) {
    test(`${report.id}: every statement's verdict is the report's, against the whole board before it`, () => {
      const payloads = report.entries.map((e) => hex(e.payload));
      payloads.forEach((payload, at) => {
        expect(destructionBoarding(election, payloads.slice(0, at), payload, 1)).toEqual(
          expected(report, at),
        );
      });
    });

    test(`${report.id}: an operator boarding only what passes boards each seat's first statement, and the report then lists no breach`, () => {
      const boarded: Uint8Array[] = [];
      const positions: number[] = [];
      report.entries.forEach((e, at) => {
        const payload = hex(e.payload);
        const verdict: DestructionBoarding = destructionBoarding(election, boarded, payload, 1);
        const want = expected(report, at);
        if (want.code === "destruction-repeat")
          // The same seat's first statement, at its place among those boarded.
          expect(verdict).toEqual({ ...want, of: positions.indexOf(want.of as number) });
        else expect(verdict).toEqual(want);
        if (verdict.ok) {
          boarded.push(payload);
          positions.push(at);
        }
      });
      const r = checkDestruction(
        election,
        boarded.map((payload) => ({ segment: 20, payload })),
        { firstPassing: [10], windowSegment: 40 },
        1,
      );
      expect(r.duplicates).toEqual([]);
      expect(r.unattributed).toEqual([]);
      expect(r.stray).toEqual([]);
      expect(r.rejected).toEqual([]);
      expect(r.seats.filter((s) => s.code !== "destruction-missing").map((s) => s.seat)).toEqual(
        report.result.seats.filter((s) => s.at !== undefined).map((s) => s.seat),
      );
    });
  }

  test("refuses a definition hash that isn't 32 bytes", () => {
    expect(() =>
      destructionBoarding(
        { ...election, definitionHash: new Uint8Array(31) },
        [],
        hex(statement("seat-1").encoding),
        1,
      ),
    ).toThrow(RangeError);
  });
});

describe("destruction boarding's rules", () => {
  // Each test below fails if the rule it names is dropped from destructionBoarding.
  const seat1 = statement("seat-1");
  const secret1 = hex(seat1.signingSecret);
  const honest = hex(seat1.encoding);

  test("a second statement of the seat in other bytes is the same signed message: a repeat", () => {
    // Another nonce than RFC 6979's: the seat's message signed again.
    const signature = p256.sign(
      dsSignature(
        "abolish/v1/sig/destruction",
        destructionStatementMessage({
          definition_hash: election.definitionHash,
          signer: 1,
        }),
      ),
      secret1,
      { prehash: true, lowS: true, format: "compact", extraEntropy: true },
    );
    const again = Uint8Array.of(...honest.subarray(0, 36), ...signature);
    expect(again).not.toEqual(honest);
    expect(destructionBoarding(election, [honest], again, 1)).toEqual({
      ok: false,
      code: "destruction-repeat",
      of: 0,
    });
  });

  test("another seat's statement, or one for another definition, never blocks the seat's", () => {
    const seat2 = hex(statement("seat-2").encoding);
    const other = encodeDestructionStatement(
      signDestructionStatement(secret1, { definition_hash: new Uint8Array(32).fill(7), signer: 1 }),
    );
    expect(destructionBoarding(election, [seat2, other], honest, 1)).toEqual({
      ok: true,
      signer: 1,
    });
  });

  test("a forged statement naming the seat never blocks the seat's own", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 64, maxLength: 64 }), (signature) => {
        const forged = Uint8Array.of(...honest.subarray(0, 36), ...signature);
        if (forged.every((b, i) => b === honest[i])) return;
        expect(destructionBoarding(election, [forged], honest, 1)).toEqual({
          ok: true,
          signer: 1,
        });
      }),
      { numRuns },
    );
  }, 60_000);

  test("any changed byte of a statement is refused", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: honest.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, x) => {
          const b = Uint8Array.from(honest);
          b[at] = (b[at] as number) ^ x;
          expect(destructionBoarding(election, [], b, 1).ok).toBe(false);
        },
      ),
      { numRuns },
    );
  }, 60_000);
});
