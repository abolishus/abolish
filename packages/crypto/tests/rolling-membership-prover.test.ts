import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  BN254_R,
  membershipProverInput,
  MembershipProverError,
  type MembershipProverErrorCode,
  membershipScope,
  poseidon2,
  rollingMembershipNullifier,
  rollingMembershipProverInput,
  rollingMembershipScope,
  RollingTierTree,
  semaphoreField,
  tierTreePath,
  tierTreeRoot,
} from "../src/index.ts";
import { SPEC_VECTORS } from "./spec-vectors.ts";

// The prover's request for a rolling ballot (docs/spec/membership.md, Rolling
// scope; Checks for rolling ballots): the path over a step tree's leaves,
// removed ones 0, and the tier's rolling scope, with no root in it. The
// voters are Semaphore v4.14.3's own identities from
// docs/spec/vectors/membership-prover.json, whose secret scalars and
// commitments come from outside the workspace; the scope and nullifier are
// checked against the spec's formulas, built here from their parts.

interface Member {
  readonly secret: string;
  readonly commitment: string;
}

const { members, definitionHash: definitionHex } = JSON.parse(
  readFileSync(new URL("membership-prover.json", SPEC_VECTORS), "utf8"),
) as { readonly members: readonly Member[]; readonly definitionHash: string };

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const definitionHash = bytes(definitionHex);
const voters = members.map((m) => ({
  secret: bytes(m.secret),
  s: BigInt(`0x${m.secret}`),
  commitment: BigInt(m.commitment),
}));
const voter = (i: number) => voters[i % voters.length] as (typeof voters)[number];
// Each run hashes depth-32 trees with Poseidon, so the runs are capped.
const numRuns = Math.min(Number(process.env["FC_NUM_RUNS"] ?? 100), 25);
const message = new Uint8Array(32).fill(7);

function refusal(f: () => unknown): MembershipProverErrorCode {
  try {
    f();
  } catch (e) {
    if (e instanceof MembershipProverError) return e.code;
    throw e;
  }
  throw new Error("expected a refusal");
}

/** A step tree of one group: `commitments` added in order, then the leaves at `removed` set to 0. */
function stepTree(commitments: readonly bigint[], removed: readonly number[] = []) {
  const tree = new RollingTierTree([1n]);
  tree.apply({
    kind: "add",
    groupId: 1n,
    commitments: [...commitments],
    blockNumber: 1n,
    timestamp: 1n,
  });
  if (removed.length > 0)
    tree.apply({
      kind: "remove",
      groupId: 1n,
      indices: removed.map(BigInt),
      blockNumber: 2n,
      timestamp: 2n,
    });
  return tree;
}

describe("a rolling ballot's prover input", { timeout: 120_000 }, () => {
  const field = fc.bigInt({ min: 2n, max: BN254_R - 1n });

  test("proves at the voter's first live leaf under the rolling scope, with the step's root", () => {
    fc.assert(
      fc.property(
        fc.array(field, { maxLength: 10 }),
        fc.nat(),
        fc.nat(),
        fc.nat({ max: 2 }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        (others, pick, at, tier, m) => {
          const v = voter(pick);
          const leaves = others.filter((x) => !voters.some((y) => y.commitment === x));
          const index = at % (leaves.length + 1);
          leaves.splice(index, 0, v.commitment);
          const tree = stepTree(leaves);
          const root = tree.root();
          expect(root).toBe(tierTreeRoot(leaves));
          const input = rollingMembershipProverInput(v.secret, tree.leaves, {
            definitionHash,
            tier,
            root,
            message: m,
          });
          // ŝ_t = F(H(DS("abolish/v1/rolling-nullifier-scope", definition_hash ‖ u8(t)))),
          // never the fixed scope of the same root (T-31).
          const scope = rollingMembershipScope(definitionHash, tier);
          expect(scope).not.toBe(membershipScope(definitionHash, tier, root));
          expect(input.witness.scope).toBe(scope.toString());
          expect(input.witness.merkleProofIndex).toBe(String(index));
          expect(input.witness.merkleProofSiblings).toEqual(
            tierTreePath(leaves, index).map(String),
          );
          expect(input.signals).toEqual({
            root,
            nullifier: poseidon2(scope, v.s),
            message: semaphoreField(m),
            scope,
          });
          expect(rollingMembershipNullifier(v.secret, { definitionHash, tier })).toBe(
            input.signals.nullifier,
          );
        },
      ),
      { numRuns },
    );
  });

  test("one nullifier per secret and tier at every step, and after a removal and re-addition", () => {
    fc.assert(
      fc.property(
        fc.array(field, { minLength: 1, maxLength: 8 }),
        fc.nat(),
        fc.nat({ max: 2 }),
        (others, pick, tier) => {
          const v = voter(pick);
          const leaves = others.filter((x) => !voters.some((y) => y.commitment === x));
          // An earlier step holds the voter's first leaf; a later one has it
          // removed (0) and the commitment added again at the end.
          const early = [v.commitment, ...leaves];
          const late = stepTree([...early, v.commitment], [0]);
          const statement = (root: bigint) => ({ definitionHash, tier, root, message });
          const a = rollingMembershipProverInput(v.secret, early, statement(tierTreeRoot(early)));
          const b = rollingMembershipProverInput(v.secret, late.leaves, statement(late.root()));
          expect(a.signals.root).not.toBe(b.signals.root);
          expect(a.signals.nullifier).toBe(b.signals.nullifier);
          // The removed leaf is 0, so the path is at the live one.
          expect(b.witness.merkleProofIndex).toBe(String(early.length));
          // The fixed scope binds the root, so it would give two (T-01, T-02).
          const fixed = (root: bigint) =>
            membershipProverInput(v.secret, early, statement(root)).signals.nullifier;
          expect(fixed(tierTreeRoot(early))).not.toBe(b.signals.nullifier);
          // Another tier of the same poll has its own (T-13).
          const other = rollingMembershipNullifier(v.secret, {
            definitionHash,
            tier: (tier + 1) % 3,
          });
          expect(other).not.toBe(a.signals.nullifier);
        },
      ),
      { numRuns },
    );
  });
});

describe("refusals before any proving", () => {
  const v = voter(0);
  const w = voter(1);

  test("a voter whose only leaf was removed isn't a member of the step", () => {
    const tree = stepTree([w.commitment, v.commitment], [1]);
    expect(
      refusal(() =>
        rollingMembershipProverInput(v.secret, tree.leaves, {
          definitionHash,
          tier: 0,
          root: tree.root(),
          message,
        }),
      ),
    ).toBe("not-a-member");
  });

  test("leaves that don't climb to the step's root", () => {
    const early = stepTree([v.commitment]);
    const late = stepTree([v.commitment, w.commitment]);
    expect(
      refusal(() =>
        rollingMembershipProverInput(v.secret, late.leaves, {
          definitionHash,
          tier: 0,
          root: early.root(),
          message,
        }),
      ),
    ).toBe("root");
  });

  test("a secret that isn't an identity secret's encoding", () => {
    const tree = stepTree([v.commitment]);
    const statement = { definitionHash, tier: 0, root: tree.root(), message };
    expect(
      refusal(() => rollingMembershipProverInput(new Uint8Array(32), tree.leaves, statement)),
    ).toBe("secret");
    expect(refusal(() => rollingMembershipNullifier(new Uint8Array(31), statement))).toBe("secret");
  });

  test("a tier or definition hash the rolling scope can't take", () => {
    const tree = stepTree([v.commitment]);
    const at = (d: Uint8Array, tier: number) => () =>
      rollingMembershipProverInput(v.secret, tree.leaves, {
        definitionHash: d,
        tier,
        root: tree.root(),
        message,
      });
    expect(at(definitionHash, 3)).toThrow(RangeError);
    expect(at(new Uint8Array(31), 0)).toThrow();
    expect(() => rollingMembershipNullifier(v.secret, { definitionHash, tier: 3 })).toThrow(
      RangeError,
    );
  });
});
