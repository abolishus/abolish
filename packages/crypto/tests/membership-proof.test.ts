import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  BN254_R,
  DecodeError,
  decodeMembershipProof,
  encodeMembershipProof,
  MEMBERSHIP_DEPTH,
  MEMBERSHIP_PROOF_LENGTH,
  MEMBERSHIP_ZKEY_SHA256,
  membershipScope,
  type MembershipSignals,
  membershipVkEncoding,
  membershipVkHash,
  semaphoreField,
  tierTreeRoot,
  verifyMembershipProof,
} from "../src/index.ts";
import { SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/membership-proof.json holds real Semaphore v4.14.3 proofs
// over Abolish tier trees, with every verdict from snarkjs, made outside the
// workspace by scripts/membership-proof-vectors.mjs (docs/spec/membership.md;
// T-04, T-05, T-07, T-38). No expected value comes from the code under test.

interface Signals {
  readonly root: string;
  readonly nullifier: string;
  readonly message: string;
  readonly scope: string;
}

interface ProofVectors {
  readonly format: string;
  readonly verificationKey: {
    readonly depth: number;
    readonly encoding: string;
    readonly zkeySha256: string;
    readonly hash: string;
  };
  readonly definitionHash: string;
  readonly trees: readonly {
    readonly id: string;
    readonly tier: number;
    readonly leaves: readonly string[];
    readonly root: string;
  }[];
  readonly fieldMapping: readonly (
    | {
        readonly scopeBytes: string;
        readonly tier: number;
        readonly root: string;
        readonly scope: string;
      }
    | { readonly messageBytes: string; readonly message: string }
  )[];
  readonly proofs: readonly {
    readonly name: string;
    readonly proof: string;
    readonly signals: Signals;
    readonly snarkjs: boolean;
    readonly valid: boolean;
    readonly reason?: "proof" | "signal" | "root";
  }[];
  readonly decode: readonly { readonly name: string; readonly proof: string }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("membership-proof.json", SPEC_VECTORS), "utf8"),
) as ProofVectors;

const decimal = (s: string | undefined) => {
  if (s === undefined || !/^(?:0|[1-9][0-9]*)$/.test(s)) throw new Error(`not a decimal: ${s}`);
  return BigInt(s);
};
const bytes = (hex: string) => {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error(`not hex: ${hex}`);
  return Uint8Array.from(Buffer.from(hex, "hex"));
};
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const signals = (s: Signals): MembershipSignals => ({
  root: decimal(s.root),
  nullifier: decimal(s.nullifier),
  message: decimal(s.message),
  scope: decimal(s.scope),
});
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const proofCase = (name: string) => {
  const found = vectors.proofs.find((p) => p.name === name);
  if (found === undefined) throw new Error(`no proof ${name}`);
  return found;
};
const honest = proofCase("honest");

describe("membership-proof vectors (docs/spec/vectors/membership-proof.json)", () => {
  test("uses the format this reader knows", () => {
    expect(vectors.format).toBe("abolish-membership-proof-vectors/1");
  });

  test("the pinned key's encoding and hash match the independent generator", () => {
    const vk = vectors.verificationKey;
    expect(vk.depth).toBe(MEMBERSHIP_DEPTH);
    expect(toHex(membershipVkEncoding())).toBe(vk.encoding);
    expect(MEMBERSHIP_ZKEY_SHA256).toBe(vk.zkeySha256);
    expect(toHex(membershipVkHash())).toBe(vk.hash);
  });

  test("F of Abolish's scope and message bytes is Semaphore's own hash", () => {
    // The real proofs were made by Semaphore's generateProof from int(S_g) and
    // int(M); snarkjs accepted them only with these field values.
    expect(vectors.fieldMapping).toHaveLength(4);
    const definitionHash = bytes(vectors.definitionHash);
    for (const v of vectors.fieldMapping) {
      if ("scopeBytes" in v) {
        expect(semaphoreField(bytes(v.scopeBytes))).toBe(decimal(v.scope));
        expect(membershipScope(definitionHash, v.tier, decimal(v.root))).toBe(decimal(v.scope));
      } else expect(semaphoreField(bytes(v.messageBytes))).toBe(decimal(v.message));
    }
  });

  test("the proofs' tier trees rebuild to the roots Semaphore proved against", () => {
    expect(vectors.trees).toHaveLength(3);
    for (const t of vectors.trees)
      expect(tierTreeRoot(t.leaves.map(decimal)), t.id).toBe(decimal(t.root));
    expect(decimal(honest.signals.root)).toBe(decimal(vectors.trees[0]?.root));
  });

  test("accepts exactly the proofs the spec accepts, agreeing with snarkjs except where it must not", () => {
    expect(vectors.proofs).toHaveLength(16);
    for (const p of vectors.proofs) {
      expect(verifyMembershipProof(bytes(p.proof), signals(p.signals)), p.name).toBe(p.valid);
      // snarkjs is the stock verifier; Abolish is stricter only on root 0.
      if (p.reason !== "root") expect(p.snarkjs, p.name).toBe(p.valid);
    }
    expect(vectors.proofs.filter((p) => p.valid).map((p) => p.name)).toEqual([
      "honest",
      "honest-sparse",
      "rerandomised",
    ]);
  });

  test("rejects the root-0 proof that snarkjs accepts (proof length above the depth)", () => {
    const p = proofCase("root-zero");
    expect(p.snarkjs).toBe(true);
    expect(decimal(p.signals.root)).toBe(0n);
    expect(verifyMembershipProof(bytes(p.proof), signals(p.signals))).toBe(false);
  });

  test("a re-randomised proof has other bytes and the same statement (T-38)", () => {
    const p = proofCase("rerandomised");
    expect(p.proof).not.toBe(honest.proof);
    expect(p.signals).toEqual(honest.signals);
  });

  test("every accepted proof re-encodes to itself", () => {
    for (const p of vectors.proofs) {
      const b = bytes(p.proof);
      expect(toHex(encodeMembershipProof(decodeMembershipProof(b))), p.name).toBe(p.proof);
    }
  });

  test("rejects every malformed proof encoding as non-canonical, truncated or trailing", () => {
    const expected: Readonly<Record<string, readonly [string, number]>> = {
      short: ["truncated", 0],
      long: ["trailing-bytes", 256],
      "a-x-plus-p": ["non-canonical", 0],
      "a-y-off-curve": ["non-canonical", 0],
      "a-identity": ["non-canonical", 0],
      "b-coordinate-plus-p": ["non-canonical", 64],
      "b-component-order": ["non-canonical", 64],
      "b-off-curve": ["non-canonical", 64],
      "b-outside-subgroup": ["non-canonical", 64],
      "b-identity": ["non-canonical", 64],
      "c-x-plus-p": ["non-canonical", 192],
      "c-identity": ["non-canonical", 192],
    };
    expect(vectors.decode.map((d) => d.name)).toEqual(Object.keys(expected));
    for (const d of vectors.decode) {
      const [code, offset] = expected[d.name] ?? ["", -1];
      let error: unknown;
      try {
        decodeMembershipProof(bytes(d.proof));
      } catch (e) {
        error = e;
      }
      expect(error, d.name).toBeInstanceOf(DecodeError);
      expect([(error as DecodeError).code, (error as DecodeError).offset], d.name).toEqual([
        code,
        offset,
      ]);
      expect(verifyMembershipProof(bytes(d.proof), signals(honest.signals)), d.name).toBe(false);
    }
  });
});

describe("membership proof verification", () => {
  const proof = bytes(honest.proof);
  const good = signals(honest.signals);

  test("any changed byte of an honest proof is rejected", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: MEMBERSHIP_PROOF_LENGTH - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, flip) => {
          const tampered = proof.slice();
          tampered[at] = (tampered[at] as number) ^ flip;
          expect(verifyMembershipProof(tampered, good)).toBe(false);
        },
      ),
      { numRuns: Math.min(numRuns, 40) },
    );
  });

  test("any changed signal is rejected", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("root", "nullifier", "message", "scope" as const),
        fc.bigInt({ min: 1n, max: BN254_R - 1n }),
        (field, delta) => {
          const changed = { ...good, [field]: (good[field] + delta) % BN254_R };
          expect(verifyMembershipProof(proof, changed)).toBe(false);
        },
      ),
      { numRuns: Math.min(numRuns, 40) },
    );
  });

  test("never reduces a signal modulo r", () => {
    for (const field of ["root", "nullifier", "message", "scope"] as const) {
      expect(verifyMembershipProof(proof, { ...good, [field]: good[field] + BN254_R })).toBe(false);
      expect(verifyMembershipProof(proof, { ...good, [field]: -1n })).toBe(false);
    }
  });

  test("random 256-byte strings are rejected or re-encode to themselves", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 256, maxLength: 256 }), (b) => {
        try {
          expect(encodeMembershipProof(decodeMembershipProof(b))).toEqual(b);
        } catch (e) {
          expect(e).toBeInstanceOf(DecodeError);
        }
      }),
      { numRuns },
    );
  });

  test("rejects signals that aren't bigints instead of coercing them", () => {
    expect(() => verifyMembershipProof(proof, { ...good, root: 1 as never })).toThrow(TypeError);
    expect(() => verifyMembershipProof(proof, null as never)).toThrow(TypeError);
  });
});
