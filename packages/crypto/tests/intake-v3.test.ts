import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { checkedKeySetForTests } from "../src/ceremony.ts";
import { kemKeyPairWith } from "../src/share-encryption.ts";
import { checkReceiptStatement } from "../src/share-receipt.ts";
import {
  ballotHashV3,
  decodeBallot,
  decodeElectionDefinitionV5,
  intakeBallot,
  type IntakeCode,
  type IntakeResult,
  type QuestionBallotElection,
  questionBallotElection,
  type RegisteredKeys,
  shareReceiptStatement,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/intake-v3.json comes from an independent Python
// implementation of intake on whole version-3 ballot records
// (scripts/ballot-v3-records-vectors.py, reusing the ballot, share-encryption
// and share-receipt generators), with membership proofs from snarkjs over
// Semaphore's own circuit, so the expected verdicts and receipt bytes never
// come from the code under test.

interface Vectors {
  readonly format: string;
  readonly elections: Readonly<
    Record<
      string,
      { readonly version: 3; readonly definition: string; readonly definitionHash: string }
    >
  >;
  readonly panel: readonly {
    readonly seat: number;
    readonly kem: { readonly seed: string; readonly x: string };
    readonly signingSecret: string;
    readonly signingKey: string;
  }[];
  readonly cases: readonly {
    readonly id: string;
    readonly election: string;
    readonly registered: readonly number[];
    readonly seat: number;
    readonly record: string;
    readonly ciphertext: string;
    readonly result: "ok" | IntakeCode;
    readonly option?: number;
    readonly question?: number;
    readonly ballotHash?: string;
    readonly shareHash?: string;
    readonly statement?: string;
    readonly receipt?: string;
    readonly tier?: number;
    readonly nullifier?: string;
    readonly message?: string;
    readonly l1RefNumber?: string;
    readonly l1RefHash?: string;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("intake-v3.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

type Seat = Vectors["panel"][number];
const kem = vectors.panel.map((s) => kemKeyPairWith(hex(s.kem.seed), BigInt(s.kem.x)));
const signers = (seats: readonly number[]) =>
  seats.map((index) => ({
    index,
    signingKey: hex((vectors.panel[index - 1] as Seat).signingKey),
  }));

const keySet = (seats: readonly number[], transcript: Uint8Array): readonly RegisteredKeys[] =>
  checkedKeySetForTests(
    signers(seats).map((s) => ({
      ...s,
      kemKey: kem[s.index - 1]?.publicKey as RegisteredKeys["kemKey"],
    })),
    transcript,
  );

function electionOf(name: string, seats: readonly number[]): QuestionBallotElection {
  const e = vectors.elections[name];
  if (e === undefined) throw new Error(`no election ${name}`);
  const d = decodeElectionDefinitionV5(hex(e.definition));
  return questionBallotElection(d, keySet(seats, d.ceremony_transcript_hash));
}

const keysOf = (seat: number) => ({
  seat,
  kemSecret: (kem[seat - 1] as ReturnType<typeof kemKeyPairWith>).secretKey,
  signingSecret: hex((vectors.panel[seat - 1] as Seat).signingSecret),
});

const codeOf = (r: IntakeResult) => (r.ok ? "ok" : r.code);

const okCase = vectors.cases.find((c) => c.id === "intake-ok-seat-1") as Vectors["cases"][number];

describe("intake-v3.json", () => {
  test("is the file this suite reads", () => {
    expect(vectors.format).toBe("abolish-intake-vectors/1");
    expect(Object.values(vectors.elections).map((e) => e.version)).toEqual([3]);
  });

  for (const c of vectors.cases) {
    test(`${c.id}: ${c.result}`, () => {
      const election = electionOf(c.election, c.registered);
      const r = intakeBallot(election, keysOf(c.seat), hex(c.record), hex(c.ciphertext));
      expect(codeOf(r)).toBe(c.result);
      if (!r.ok) {
        expect(r.option).toBe(c.option);
        expect(r.question).toBe(c.question);
        return;
      }
      expect(toHex(r.ballotHash)).toBe(c.ballotHash);
      expect(toHex(r.shareHash)).toBe(c.shareHash);
      expect(toHex(r.receipt)).toBe(c.receipt);
      expect(r.tier).toBe(c.tier);
      expect(String(r.nullifier)).toBe(c.nullifier);
      expect(toHex(r.message)).toBe(c.message);
      expect(String(r.l1RefNumber)).toBe(c.l1RefNumber);
      expect(toHex(r.l1RefHash)).toBe(c.l1RefHash);
      const statement = {
        definition_hash: hex(vectors.elections[c.election]?.definitionHash as string),
        ballot_hash: r.ballotHash,
        seat: c.seat,
        share_hash: r.shareHash,
      };
      expect(toHex(shareReceiptStatement(statement))).toBe(c.statement);
      // The receipt passes the public check against the version-3 ballot
      // hash recomputed from the record.
      const ballot = decodeBallot(hex(c.record), 3);
      const hash = ballotHashV3(
        { definitionHash: ballot.definition_hash, cell: ballot.cell, nullifier: ballot.nullifier },
        ballot.committed_vote,
      );
      expect(toHex(hash)).toBe(c.ballotHash);
      expect(checkReceiptStatement(signers(c.registered), statement, r.receipt)).toBe(true);
    });
  }
});

describe("intakeBallot under ballot version 3", () => {
  test("covers every refusal code it can return, beside acceptance", () => {
    const codes = new Set(vectors.cases.map((c) => c.result));
    for (const code of [
      "ok",
      "delivery-malformed",
      "ballot-stray",
      "ballot-cell",
      "validity-shape",
      "share-hash-unqualified",
      "share-hash",
      "membership-proof",
      "option-proof",
      "sum-proof",
      "share-proof",
      "share-check",
    ])
      expect(codes.has(code as IntakeCode)).toBe(true);
  });

  test("refuses every single-byte change to an accepted record", () => {
    const election = electionOf(okCase.election, okCase.registered);
    const record = hex(okCase.record);
    const ct = hex(okCase.ciphertext);
    fc.assert(
      fc.property(
        fc.nat({ max: record.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, flip) => {
          const changed = Uint8Array.from(record);
          changed[at] = (changed[at] as number) ^ flip;
          expect(intakeBallot(election, keysOf(okCase.seat), changed, ct).ok).toBe(false);
        },
      ),
      { numRuns: Math.min(numRuns, 200) },
    );
  }, 120_000);

  test("throws for a seat outside the registered key set, and for a hand-built context", () => {
    const election = electionOf("questions", [1, 2]);
    expect(() =>
      intakeBallot(election, keysOf(3), hex(okCase.record), hex(okCase.ciphertext)),
    ).toThrow(RangeError);
    expect(() =>
      intakeBallot({ ...election }, keysOf(1), hex(okCase.record), hex(okCase.ciphertext)),
    ).toThrow(TypeError);
  });
});
