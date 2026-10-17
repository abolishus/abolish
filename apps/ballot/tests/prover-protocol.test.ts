// The prover worker's messages (src/prover/protocol.ts): exact keys, exact
// types and the current version only, so a stale or hijacked party's message
// is dropped rather than misread. The witness is checked to be what snarkjs
// takes, decimal strings only, and the ballot worker hears one of three
// answers.

import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import {
  parseAnswer,
  parseProgress,
  parseStart,
  parseWitness,
  PROVER_PROTOCOL_VERSION as v,
} from "../src/prover/protocol.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const witness = () => ({
  secret: "12",
  merkleProofLength: "32",
  merkleProofIndex: "0",
  merkleProofSiblings: Array.from({ length: 32 }, (_, i) => String(i)),
  scope: "34",
  message: "56",
});

describe("the page's start", () => {
  const { port1 } = new MessageChannel();
  port1.close();
  const start = () => ({
    v,
    kind: "start",
    zkey: new Uint8Array(3),
    wasm: new Uint8Array(2),
    ballot: port1,
  });

  test("accepts the artifacts and a port", () => {
    expect(parseStart(start())).toEqual(start());
  });

  test.each([
    ["another version", { v: 2 }],
    ["a key that isn't bytes", { zkey: [0, 0, 0] }],
    ["a calculator that isn't bytes", { wasm: new ArrayBuffer(2) }],
    ["a port that isn't one", { ballot: {} }],
    ["an extra key", { extra: 1 }],
  ])("refuses %s", (_, change) => {
    expect(parseStart({ ...start(), ...change })).toBeUndefined();
  });
});

describe("the prover's progress", () => {
  test("accepts any step from none to all", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1000 }), fc.nat(), (of, n) => {
        const done = n % (of + 1);
        expect(parseProgress({ v, kind: "progress", done, of })).toEqual({
          v,
          kind: "progress",
          done,
          of,
        });
      }),
      { numRuns },
    );
  });

  test.each([
    ["more done than there are", { done: 11, of: 10 }],
    ["a negative step", { done: -1, of: 10 }],
    ["no steps", { done: 0, of: 0 }],
    ["a fraction", { done: 0.5, of: 10 }],
    ["a time", { done: "3s", of: 10 }],
    ["an extra key", { done: 1, of: 10, elapsed: 3 }],
  ])("refuses %s", (_, change) => {
    expect(parseProgress({ v, kind: "progress", ...change })).toBeUndefined();
  });
});

describe("the witness", () => {
  test("accepts snarkjs's inputs as decimal strings", () => {
    expect(parseWitness({ v, kind: "witness", witness: witness() })).toEqual({
      v,
      kind: "witness",
      witness: witness(),
    });
  });

  test.each([
    ["a number", { secret: 12 }],
    ["a bigint", { scope: 34n }],
    ["a leading zero", { message: "056" }],
    ["hex", { secret: "0x0c" }],
    ["a negative", { merkleProofIndex: "-1" }],
    ["a sibling that isn't decimal", { merkleProofSiblings: ["1", "x"] }],
    ["siblings that aren't a list", { merkleProofSiblings: "1,2" }],
    ["a value past 78 digits", { secret: "1".repeat(79) }],
    ["an extra input", { extra: "1" }],
  ])("refuses %s", (_, change) => {
    expect(
      parseWitness({ v, kind: "witness", witness: { ...witness(), ...change } }),
    ).toBeUndefined();
  });

  test("refuses one with an input missing, or the envelope's version or kind off", () => {
    for (const key of Object.keys(witness())) {
      const w: Record<string, unknown> = witness();
      delete w[key];
      expect(parseWitness({ v, kind: "witness", witness: w })).toBeUndefined();
    }
    expect(parseWitness({ v: 2, kind: "witness", witness: witness() })).toBeUndefined();
    expect(parseWitness({ v, kind: "proof", witness: witness() })).toBeUndefined();
    expect(parseWitness({ v, kind: "witness", witness: witness(), extra: 1 })).toBeUndefined();
  });
});

describe("the prover's answer", () => {
  test("is a proof, a refused artifact or a bare failure", () => {
    const proof = new Uint8Array(256);
    expect(parseAnswer({ v, kind: "proof", proof })).toEqual({ v, kind: "proof", proof });
    expect(parseAnswer({ v, kind: "refused", problem: "zkey" })).toEqual({
      v,
      kind: "refused",
      problem: "zkey",
    });
    expect(parseAnswer({ v, kind: "refused", problem: "wasm" })).toEqual({
      v,
      kind: "refused",
      problem: "wasm",
    });
    expect(parseAnswer({ v, kind: "error" })).toEqual({ v, kind: "error" });
  });

  test.each([
    ["another refusal", { v, kind: "refused", problem: "proof" }],
    ["an error with a message", { v, kind: "error", message: "secret was 12" }],
    ["a proof that isn't bytes", { v, kind: "proof", proof: "00" }],
    ["a proof with signals", { v, kind: "proof", proof: new Uint8Array(256), signals: [] }],
    ["another version", { v: 2, kind: "error" }],
  ])("refuses %s", (_, answer) => {
    expect(parseAnswer(answer)).toBeUndefined();
  });

  test("refuses anything that isn't an answer", () => {
    fc.assert(
      fc.property(fc.anything(), (x) => {
        expect(parseAnswer(x)).toBeUndefined();
        expect(parseWitness(x)).toBeUndefined();
        expect(parseStart(x)).toBeUndefined();
        expect(parseProgress(x)).toBeUndefined();
      }),
      { numRuns },
    );
  });
});
