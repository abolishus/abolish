import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  BN254_R,
  decodeMembershipProof,
  type MembershipProofCheck,
  type MembershipSignals,
  verifyDecodedMembershipProofs,
  verifyMembershipProof,
} from "../src/index.ts";
import { SPEC_VECTORS } from "./spec-vectors.ts";

// Batched verification (docs/spec/vouching.md, Batched verification) must give
// every proof the verdict checking it alone gives. The proofs and their
// verdicts are docs/spec/vectors/membership-proof.json's, made by Semaphore's
// prover and judged by snarkjs outside the workspace.

interface Signals {
  readonly root: string;
  readonly nullifier: string;
  readonly message: string;
  readonly scope: string;
}

interface Vectors {
  readonly proofs: readonly {
    readonly name: string;
    readonly proof: string;
    readonly signals: Signals;
    readonly valid: boolean;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("membership-proof.json", SPEC_VECTORS), "utf8"),
) as Vectors;
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const signals = (s: Signals): MembershipSignals => ({
  root: BigInt(s.root),
  nullifier: BigInt(s.nullifier),
  message: BigInt(s.message),
  scope: BigInt(s.scope),
});

// Every vector whose proof decodes, with the verdict the spec gives it.
const cases = vectors.proofs.flatMap((p) => {
  try {
    const proof = decodeMembershipProof(Uint8Array.from(Buffer.from(p.proof, "hex")));
    return [{ name: p.name, valid: p.valid, check: { proof, signals: signals(p.signals) } }];
  } catch {
    return [];
  }
});
const byName = (name: string) => {
  const found = cases.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no decodable proof ${name}`);
  return found;
};
const valid = cases.filter((c) => c.valid);
const invalid = cases.filter((c) => !c.valid);

describe("verifyDecodedMembershipProofs", () => {
  test("the vectors hold valid and invalid proofs that decode", () => {
    expect(valid.length).toBeGreaterThanOrEqual(3);
    expect(invalid.length).toBeGreaterThanOrEqual(5);
  });

  test("gives every vector the verdict it has alone, together and in reverse", () => {
    const alone = cases.map((c) =>
      verifyMembershipProof(
        Uint8Array.from(
          Buffer.from(vectors.proofs.find((p) => p.name === c.name)?.proof ?? "", "hex"),
        ),
        c.check.signals,
      ),
    );
    expect(alone).toEqual(cases.map((c) => c.valid));
    expect(verifyDecodedMembershipProofs(cases.map((c) => c.check))).toEqual(alone);
    expect(verifyDecodedMembershipProofs(cases.map((c) => c.check).reverse())).toEqual(
      alone.slice().reverse(),
    );
  });

  test("accepts a batch of valid proofs, and finds the one invalid proof hidden in it", () => {
    const many = Array.from(
      { length: 16 },
      (_, i) => (valid[i % valid.length] as (typeof valid)[number]).check,
    );
    expect(verifyDecodedMembershipProofs(many)).toEqual(many.map(() => true));
    for (const at of [0, 7, 15]) {
      const mixed = many.slice();
      mixed[at] = byName("wrong-nullifier").check;
      expect(verifyDecodedMembershipProofs(mixed)).toEqual(many.map((_, i) => i !== at));
    }
  });

  test("any multiset of the vectors, in any order, gets each proof's own verdict", () => {
    fc.assert(
      fc.property(
        fc.array(fc.nat({ max: cases.length - 1 }), { minLength: 0, maxLength: 24 }),
        (picks) => {
          const chosen = picks.map((i) => cases[i] as (typeof cases)[number]);
          expect(verifyDecodedMembershipProofs(chosen.map((c) => c.check))).toEqual(
            chosen.map((c) => c.valid),
          );
        },
      ),
      { numRuns: Math.min(numRuns, 20) },
    );
  });

  test("a valid proof under any changed signal fails, alone or among valid proofs", () => {
    const honest = byName("honest").check;
    fc.assert(
      fc.property(
        fc.constantFrom("root", "nullifier", "message", "scope" as const),
        fc.bigInt({ min: 1n, max: BN254_R - 1n }),
        (field, delta) => {
          const changed: MembershipProofCheck = {
            proof: honest.proof,
            signals: { ...honest.signals, [field]: (honest.signals[field] + delta) % BN254_R },
          };
          const batch = [...valid.map((c) => c.check), changed, ...valid.map((c) => c.check)];
          expect(verifyDecodedMembershipProofs(batch)).toEqual(batch.map((c) => c !== changed));
        },
      ),
      { numRuns: Math.min(numRuns, 10) },
    );
  });

  test("refuses signals out of range or a root of 0 without a pairing, and never reduces them", () => {
    const honest = byName("honest").check;
    const out = [
      { ...honest.signals, nullifier: honest.signals.nullifier + BN254_R },
      { ...honest.signals, scope: -1n },
      { ...honest.signals, root: 0n },
    ].map((s) => ({ proof: honest.proof, signals: s }));
    const batch = [honest, ...out, honest, honest, honest, honest];
    expect(verifyDecodedMembershipProofs(batch)).toEqual([
      true,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
    ]);
  });

  test("takes only proofs the strict decoder made", () => {
    const honest = byName("honest").check;
    const copy = { a: honest.proof.a, b: honest.proof.b, c: honest.proof.c };
    expect(() => verifyDecodedMembershipProofs([{ proof: copy, signals: honest.signals }])).toThrow(
      TypeError,
    );
    expect(verifyDecodedMembershipProofs([])).toEqual([]);
  });
});
