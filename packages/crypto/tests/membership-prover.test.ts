import { bn254 } from "@noble/curves/bn254.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  BABYJUBJUB_ORDER,
  BN254_R,
  checkMembershipWasm,
  checkMembershipZkey,
  decodeMembershipProof,
  finishMembershipProof,
  MEMBERSHIP_PROOF_LENGTH,
  membershipNullifier,
  membershipProverInput,
  MembershipProverError,
  type MembershipProverErrorCode,
  membershipScope,
  type MembershipStatement,
  membershipVkEncoding,
  poseidon2,
  semaphoreField,
  tierTreePath,
  tierTreeRoot,
  verifyMembershipProof,
} from "../src/index.ts";
import { rerandomiseMembershipProof } from "../src/membership-proof.ts";
import { finishMembershipProofWith } from "../src/membership-prover.ts";
import { SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/membership-prover.json holds Semaphore v4.14.3's own
// identities (secret scalars and commitments), the circuit inputs its
// generateProof hands snarkjs for Abolish tier-tree paths, and real proofs
// for them, made outside the workspace by scripts/membership-prover-vectors.mjs
// (docs/spec/membership.md; P2-21 part 2; T-05, T-07, T-12). No expected value
// comes from the code under test.

interface Signals {
  readonly root: string;
  readonly nullifier: string;
  readonly message: string;
  readonly scope: string;
}

interface ProverVectors {
  readonly format: string;
  readonly definitionHash: string;
  readonly members: readonly {
    readonly seed: string;
    readonly secret: string;
    readonly commitment: string;
  }[];
  readonly trees: readonly {
    readonly id: string;
    readonly tier: number;
    readonly leaves: readonly string[];
    readonly root: string;
  }[];
  readonly cases: readonly {
    readonly name: string;
    readonly member: number;
    readonly tree: string;
    readonly message: string;
    readonly input: {
      readonly secret: string;
      readonly merkleProofLength: string;
      readonly merkleProofIndex: string;
      readonly merkleProofSiblings: readonly string[];
      readonly scope: string;
      readonly message: string;
    };
    readonly signals: Signals;
    readonly proof: string;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("membership-prover.json", SPEC_VECTORS), "utf8"),
) as ProverVectors;

const decimal = (s: string | undefined) => {
  if (s === undefined || !/^(?:0|[1-9][0-9]*)$/.test(s)) throw new Error(`not a decimal: ${s}`);
  return BigInt(s);
};
const bytes = (hex: string) => {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error(`not hex: ${hex}`);
  return Uint8Array.from(Buffer.from(hex, "hex"));
};
const word = (v: bigint) => bytes(v.toString(16).padStart(64, "0"));
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const definitionHash = bytes(vectors.definitionHash);

const tree = (id: string) => {
  const found = vectors.trees.find((t) => t.id === id);
  if (found === undefined) throw new Error(`no tree ${id}`);
  return { ...found, leaves: found.leaves.map(decimal), root: decimal(found.root) };
};
const member = (i: number) => {
  const found = vectors.members[i];
  if (found === undefined) throw new Error(`no member ${i}`);
  return found;
};
const statementOf = (c: ProverVectors["cases"][number]): MembershipStatement => {
  const t = tree(c.tree);
  return { definitionHash, tier: t.tier, root: t.root, message: bytes(c.message) };
};
const inputOf = (c: ProverVectors["cases"][number]) =>
  membershipProverInput(bytes(member(c.member).secret), tree(c.tree).leaves, statementOf(c));
const first = vectors.cases[0];
if (first === undefined) throw new Error("no cases");

function refusal(f: () => unknown): MembershipProverErrorCode {
  try {
    f();
  } catch (e) {
    if (e instanceof MembershipProverError) return e.code;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("membership-prover vectors (docs/spec/vectors/membership-prover.json)", () => {
  test("uses the format this reader knows", () => {
    expect(vectors.format).toBe("abolish-membership-prover-vectors/1");
  });

  test("the trees rebuild to the roots Semaphore proved against", () => {
    expect(vectors.trees.map((t) => t.id)).toEqual(["tier-0", "tier-2", "repeated"]);
    for (const t of vectors.trees)
      expect(tierTreeRoot(tree(t.id).leaves), t.id).toBe(tree(t.id).root);
  });

  test("builds exactly the circuit inputs Semaphore's generateProof hands snarkjs", () => {
    expect(vectors.cases.map((c) => c.name)).toEqual([
      "first-tier",
      "sparse",
      "leaf-zero",
      "repeated",
    ]);
    for (const c of vectors.cases) {
      const input = inputOf(c);
      expect(
        { ...input.witness, merkleProofSiblings: [...input.witness.merkleProofSiblings] },
        c.name,
      ).toEqual(c.input);
      expect(input.signals, c.name).toEqual({
        root: decimal(c.signals.root),
        nullifier: decimal(c.signals.nullifier),
        message: decimal(c.signals.message),
        scope: decimal(c.signals.scope),
      });
    }
  });

  test("each member's commitment is Semaphore's: its secret proves at its leaf", () => {
    // A one-leaf tier of the vector's commitment: only the secret whose
    // commitment it is finds a leaf there.
    for (const [i, m] of vectors.members.entries()) {
      const leaves = [decimal(m.commitment)];
      const root = tierTreeRoot(leaves);
      const statement = { definitionHash, tier: 0, root, message: new Uint8Array(32) };
      expect(membershipProverInput(bytes(m.secret), leaves, statement).witness.secret, m.seed).toBe(
        String(BigInt(`0x${m.secret}`)),
      );
      const other = member((i + 1) % vectors.members.length);
      expect(refusal(() => membershipProverInput(bytes(other.secret), leaves, statement))).toBe(
        "not-a-member",
      );
    }
  });

  test("the nullifier alone is Semaphore's, before any message exists", () => {
    for (const c of vectors.cases) {
      const { message: _, ...scope } = statementOf(c);
      expect(membershipNullifier(bytes(member(c.member).secret), scope), c.name).toBe(
        decimal(c.signals.nullifier),
      );
    }
  });

  test("finishes every Semaphore proof: verified, re-randomised into other bytes, verified again", () => {
    for (const c of vectors.cases) {
      const input = inputOf(c);
      const proof = bytes(c.proof);
      expect(verifyMembershipProof(proof, input.signals), c.name).toBe(true);
      const out = finishMembershipProof(input, proof);
      expect(out, c.name).toHaveLength(MEMBERSHIP_PROOF_LENGTH);
      expect(Buffer.from(out).equals(Buffer.from(proof)), c.name).toBe(false);
      expect(verifyMembershipProof(out, input.signals), c.name).toBe(true);
      expect(Buffer.from(finishMembershipProof(input, proof)).equals(Buffer.from(out))).toBe(false);
    }
  });
});

describe("refusals before any proving", () => {
  const t0 = tree("tier-0");
  const statement = statementOf(first);
  const secret = bytes(member(first.member).secret);

  test("a secret that isn't an identity secret's encoding", () => {
    for (const bad of [
      new Uint8Array(32),
      word(BABYJUBJUB_ORDER),
      word(BABYJUBJUB_ORDER + 1n),
      secret.subarray(1),
      new Uint8Array(33),
    ])
      expect(refusal(() => membershipProverInput(bad, t0.leaves, statement))).toBe("secret");
  });

  test("no nullifier for a secret that isn't an identity secret's encoding", () => {
    const { message: _, ...scope } = statement;
    for (const bad of [new Uint8Array(32), word(BABYJUBJUB_ORDER), secret.subarray(1)])
      expect(refusal(() => membershipNullifier(bad, scope))).toBe("secret");
  });

  test("a voter whose commitment isn't a leaf", () => {
    expect(
      refusal(() => membershipProverInput(bytes(member(7).secret), t0.leaves, statement)),
    ).toBe("not-a-member");
    expect(refusal(() => membershipProverInput(secret, [], statement))).toBe("not-a-member");
  });

  test("leaves that don't climb to the definition's root", () => {
    // Another tier's root, a leaf added, a leaf removed, the leaves reordered.
    // (A trailing 0 is no change: empty leaves are 0.)
    const t2 = tree("tier-2");
    const s2 = { ...statement, root: t2.root };
    expect(refusal(() => membershipProverInput(secret, t0.leaves, s2))).toBe("root");
    for (const leaves of [
      [...t0.leaves, t2.leaves[0] as bigint],
      t0.leaves.slice(0, 2),
      [...t0.leaves].reverse(),
    ])
      expect(refusal(() => membershipProverInput(secret, leaves, statement))).toBe("root");
  });

  test("statement values a definition can't hold, as membershipScope refuses them", () => {
    for (const bad of [
      { ...statement, root: 0n },
      { ...statement, root: BN254_R + t0.root },
      { ...statement, tier: 3 },
      { ...statement, definitionHash: new Uint8Array(31) },
      { ...statement, message: new Uint8Array(31) },
    ])
      expect(() => membershipProverInput(secret, t0.leaves, bad)).toThrow();
  });

  test("a leaf list holding a forbidden value is a replay bug, never proved over", () => {
    expect(() => membershipProverInput(secret, [...t0.leaves, 1n], statement)).toThrow(RangeError);
  });

  test("a proving key that isn't semaphore-32.zkey by its sha256", () => {
    for (const bad of [new Uint8Array(0), new Uint8Array(1024), bytes(first.proof)])
      expect(refusal(() => checkMembershipZkey(bad))).toBe("zkey");
    expect(() => checkMembershipZkey("zkey" as unknown as Uint8Array)).toThrow(TypeError);
  });

  test("a witness calculator that isn't semaphore-32.wasm by its sha256", () => {
    for (const bad of [new Uint8Array(0), new Uint8Array(1024), bytes(first.proof)])
      expect(refusal(() => checkMembershipWasm(bad))).toBe("wasm");
    expect(() => checkMembershipWasm("wasm" as unknown as Uint8Array)).toThrow(TypeError);
  });

  test("the witness always has depth 32, whatever the tier's size", () => {
    for (const c of vectors.cases) {
      const { witness } = inputOf(c);
      expect(witness.merkleProofLength).toBe("32");
      expect(witness.merkleProofSiblings).toHaveLength(32);
    }
  });
});

describe("finishing a proof", () => {
  const input = inputOf(first);
  const proof = bytes(first.proof);
  const counting = () => {
    let draws = 0;
    const draw = (n: number) => {
      draws++;
      return Uint8Array.from({ length: n }, (_, i) => (i * 7 + draws) & 0xff);
    };
    return { draw, draws: () => draws };
  };

  test("refuses a proof that fails self-verification, before drawing any randomness", () => {
    const other = vectors.cases[1];
    if (other === undefined) throw new Error("no second case");
    const flipped = proof.slice();
    flipped[255] = (flipped[255] as number) ^ 1;
    for (const bad of [
      bytes(other.proof), // another statement's valid proof
      flipped, // doesn't decode or doesn't verify
      proof.subarray(0, 255),
      new Uint8Array([...proof, 0]),
      new Uint8Array(256),
    ]) {
      const { draw, draws } = counting();
      expect(refusal(() => finishMembershipProofWith(input, bad, draw))).toBe("proof");
      expect(draws()).toBe(0);
    }
  });

  test("checks against the signals it computed, never ones a caller supplies", () => {
    // The same shape, but not built by membershipProverInput: a caller can't
    // finish a proof against the prover's own publicSignals.
    const lookalike = { witness: input.witness, signals: { ...input.signals } };
    expect(() => finishMembershipProof(lookalike, proof)).toThrow(TypeError);
    // The signals are frozen, so nothing can swap them after the build.
    expect(Object.isFrozen(input) && Object.isFrozen(input.signals)).toBe(true);
  });

  test("takes t from [1, r) and u from [0, r) by rejection, and u = 0 still verifies", () => {
    // t: a draw at or above r, then 0 (below t's minimum), then 1; u: 0.
    const queue = [new Uint8Array(32).fill(0xff), new Uint8Array(32), word(1n), new Uint8Array(32)];
    const draw = () => {
      const next = queue.shift();
      if (next === undefined) throw new Error("drew too often");
      return next;
    };
    const out = finishMembershipProofWith(input, proof, draw);
    expect(queue).toHaveLength(0);
    // t = 1 and u = 0 leave the proof as it was.
    expect(Buffer.from(out).equals(Buffer.from(proof))).toBe(true);
  });

  test("re-randomises as (t⁻¹·A, t·B + t·u·δ₂, C + u·A), valid for any scalars", () => {
    const { a, b, c } = decodeMembershipProof(proof);
    // δ₂ from the pinned key's encoding: alpha (64 bytes), beta and gamma
    // (128 each), then delta, each coordinate imaginary part first.
    const vk = membershipVkEncoding();
    const at = (i: number) => BigInt(`0x${Buffer.from(vk.subarray(i, i + 32)).toString("hex")}`);
    const delta = bn254.G2.Point.fromAffine({
      x: bn254.fields.Fp2.create({ c0: at(352), c1: at(320) }),
      y: bn254.fields.Fp2.create({ c0: at(416), c1: at(384) }),
    });
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: BN254_R - 1n }),
        fc.bigInt({ min: 1n, max: BN254_R - 1n }),
        (t, u) => {
          const out = rerandomiseMembershipProof(proof, t, u);
          expect(verifyMembershipProof(out, input.signals)).toBe(true);
          const next = decodeMembershipProof(out);
          // Each component exactly as specified, so dropping the u terms (which
          // would keep the prover's C) fails here.
          expect(next.a.multiply(t).equals(a)).toBe(true);
          expect(next.b.equals(b.add(delta.multiply(u)).multiply(t))).toBe(true);
          expect(next.c.equals(c.add(a.multiply(u)))).toBe(true);
          expect(next.c.equals(c)).toBe(false);
        },
      ),
      { numRuns: Math.min(numRuns, 10) },
    );
  });

  test("refuses scalars outside their ranges", () => {
    for (const [t, u] of [
      [0n, 1n],
      [BN254_R, 1n],
      [1n, -1n],
      [1n, BN254_R],
    ] as const)
      expect(() => rerandomiseMembershipProof(proof, t, u)).toThrow(RangeError);
  });
});

describe("inputs over random tiers (fast-check)", () => {
  const field = fc.bigInt({ min: 2n, max: BN254_R - 1n });
  const secretArb = fc.bigInt({ min: 1n, max: BABYJUBJUB_ORDER - 1n });

  test("the path is the tier tree's, at the voter's first leaf, and the signals are derived", () => {
    // The voter is one of Semaphore's identities; the other leaves are any
    // field values that aren't forbidden, or 0.
    const voters = vectors.members.map((m) => ({
      secret: bytes(m.secret),
      s: BigInt(`0x${m.secret}`),
      commitment: decimal(m.commitment),
    }));
    fc.assert(
      fc.property(
        fc.array(fc.oneof(field, fc.constant(0n)), { maxLength: 12 }),
        fc.nat(),
        fc.nat(),
        fc.nat({ max: 2 }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        (others, pick, at, tier, message) => {
          const voter = voters[pick % voters.length] as (typeof voters)[number];
          const leaves = others.filter((v) => !voters.some((x) => x.commitment === v));
          const index = at % (leaves.length + 1);
          leaves.splice(index, 0, voter.commitment);
          // Registered twice: the path is at the first leaf.
          if (at % 3 === 0) leaves.push(voter.commitment);
          const root = tierTreeRoot(leaves);
          const input = membershipProverInput(voter.secret, leaves, {
            definitionHash,
            tier,
            root,
            message,
          });
          const scope = membershipScope(definitionHash, tier, root);
          expect(input.witness.merkleProofIndex).toBe(String(leaves.indexOf(voter.commitment)));
          expect(input.witness.merkleProofIndex).toBe(String(index));
          expect(input.witness.merkleProofSiblings).toEqual(
            tierTreePath(leaves, index).map(String),
          );
          expect(input.signals).toEqual({
            root,
            nullifier: poseidon2(scope, voter.s),
            message: semaphoreField(message),
            scope,
          });
          // The nullifier alone, with no leaves and no message, is the input's.
          expect(membershipNullifier(voter.secret, { definitionHash, tier, root })).toBe(
            input.signals.nullifier,
          );
        },
      ),
      { numRuns: Math.min(numRuns, 50) },
    );
  });

  test("a secret not among the leaves is never given a witness", () => {
    fc.assert(
      fc.property(secretArb, fc.array(field, { minLength: 1, maxLength: 8 }), (s, leaves) => {
        const statement = {
          definitionHash,
          tier: 0,
          root: tierTreeRoot(leaves),
          message: new Uint8Array(32),
        };
        // A random leaf is a random secret's commitment with probability ~2^-254.
        expect(refusal(() => membershipProverInput(word(s), leaves, statement))).toBe(
          "not-a-member",
        );
      }),
      { numRuns: Math.min(numRuns, 50) },
    );
  });
});
