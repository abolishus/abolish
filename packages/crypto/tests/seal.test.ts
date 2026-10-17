import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { checkedKeySetForTests } from "../src/ceremony.ts";
import {
  castSealV3,
  challengeSealV3,
  checkChallengeOpeningV2,
  decodeElectionDefinitionV5,
  decodeOpening,
  type ElectionDefinitionV5,
  finishSealV3,
  identityCommitment,
  kemKeygen,
  MEMBERSHIP_PROOF_LENGTH,
  MembershipProverError,
  type MembershipProverErrorCode,
  membershipScope,
  type QuestionBallotElection,
  questionBallotElection,
  sealBallotV3,
  tierTreeRoot,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// The ballot client's sealing (docs/spec/ballot-validity.md, Casting (version
// 3); docs/spec/challenge.md, Client rules). A cast finishes only with a real
// Groth16 proof, which packages/membership-prover's tests make with snarkjs
// (tests/seal.test.ts there); here, the core and its challenge, and every
// refusal before the prover hears anything.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// Semaphore 4.14.3's identities (docs/spec/vectors/membership-prover.json):
// cell 0 (tier 0) holds the first four commitments, cell 2 (tier 2) the rest.
const members = (
  JSON.parse(readFileSync(new URL("membership-prover.json", SPEC_VECTORS), "utf8")) as {
    readonly members: readonly { readonly secret: string }[];
  }
).members.map((m) => hex(m.secret));
const leaves = members.map(identityCommitment);
const cell0 = leaves.slice(0, 4);
const cell2 = leaves.slice(4);

// ballot-v3-records.json's three questions (pick one of 3, up to 2 of 4,
// exactly 1 of 2) and partition, with the cells' roots made over the leaves above.
const v3 = JSON.parse(readFileSync(new URL("ballot-v3-records.json", SPEC_VECTORS), "utf8")) as {
  readonly elections: Readonly<Record<string, { readonly definition: string }>>;
};
const base = decodeElectionDefinitionV5(
  hex((v3.elections["questions"] as { definition: string }).definition),
);
const definition: ElectionDefinitionV5 = {
  ...base,
  electorate: base.electorate.map((t, i) => ({
    ...t,
    cells: t.cells.map((c, j) =>
      i === 0 && j === 0
        ? { ...c, root: tierTreeRoot(cell0) }
        : t.tier === 2
          ? { ...c, root: tierTreeRoot(cell2) }
          : c,
    ),
  })),
};

const kem = Array.from({ length: definition.panel_size }, () => kemKeygen().publicKey);
const electionOf = (seats: readonly number[]): QuestionBallotElection =>
  questionBallotElection(
    definition,
    checkedKeySetForTests(
      seats.map((index) => ({
        index,
        kemKey: kem[index - 1] as (typeof kem)[number],
        signingKey: new Uint8Array(33),
      })),
      definition.ceremony_transcript_hash,
    ),
  );
const all = Array.from({ length: definition.panel_size }, (_, i) => i + 1);
const election = electionOf(all);
// One seat outside the registered key set.
const partial = electionOf(all.slice(1));

const VOTES = [1, 0, 0, 0, 1, 1, 0, 0, 1] as const;
const L1 = { number: 1234n, hash: new Uint8Array(32).fill(7) };

// Every vote the three questions allow.
const allowed = fc
  .tuple(
    fc.constantFrom([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]),
    fc
      .array(fc.constantFrom(0, 1), { minLength: 4, maxLength: 4 })
      .filter((v) => v.reduce<number>((a, b) => a + b, 0) <= 2),
    fc.constantFrom([1, 0], [0, 1]),
  )
  .map(([a, b, c]) => [...a, ...b, ...c] as (0 | 1)[]);

function refusal(f: () => unknown): MembershipProverErrorCode {
  try {
    f();
  } catch (e) {
    if (e instanceof MembershipProverError) return e.code;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("sealBallotV3", () => {
  test("the opening of a challenged seal rebuilds the code shown and the votes sealed", () => {
    fc.assert(
      fc.property(allowed, fc.constantFrom(0, 1, 2), fc.boolean(), (votes, cell, unqualified) => {
        const e = unqualified ? partial : election;
        const sealed = sealBallotV3(e, cell, votes);
        expect(sealed.cell).toBe(cell);
        expect(sealed.trackingCode).toHaveLength(32);
        const { opening, trackingCode } = challengeSealV3(sealed);
        expect(toHex(trackingCode)).toBe(toHex(sealed.trackingCode));
        const decoded = decodeOpening(opening, 2);
        const checked = checkChallengeOpeningV2(e, decoded);
        if (!checked.ok) throw new Error(checked.code);
        expect(toHex(checked.coreHash)).toBe(toHex(sealed.trackingCode));
        expect(checked.votes).toEqual(votes.map(BigInt));
        expect(checked.withinRules).toBe(true);
        // A seat outside the registered key set reveals nothing and has a zero hash.
        expect(decoded.seats.map((s) => s.seat)).toEqual(unqualified ? all.slice(1) : all);
        expect(toHex(decoded.share_hashes[0] as Uint8Array) === "00".repeat(32)).toBe(unqualified);
      }),
      { numRuns: Math.min(numRuns, 20) },
    );
  });

  test("two seals of the same votes show different codes", () => {
    const a = sealBallotV3(election, 0, [...VOTES]);
    const b = sealBallotV3(election, 0, [...VOTES]);
    expect(toHex(a.trackingCode)).not.toBe(toHex(b.trackingCode));
  });

  test("refuses votes outside a question's limits, a cell outside the partition and a hand-built context", () => {
    // Two picks where the first question allows one; no pick where the last needs one.
    expect(() => sealBallotV3(election, 0, [1, 1, 0, 0, 0, 0, 0, 1, 0])).toThrow();
    expect(() => sealBallotV3(election, 0, [1, 0, 0, 0, 0, 0, 0, 0, 0])).toThrow();
    expect(() => sealBallotV3(election, 0, [1, 0, 0, 0, 1, 1, 1, 1, 0])).toThrow();
    expect(() => sealBallotV3(election, 0, [1, 0, 0])).toThrow();
    for (const cell of [3, -1, 0.5, 255, Number.NaN])
      expect(() => sealBallotV3(election, cell, [...VOTES])).toThrow(/no such cell/);
    expect(() => sealBallotV3({ ...election }, 0, [...VOTES])).toThrow(TypeError);
    expect(() => challengeSealV3({ cell: 0, trackingCode: new Uint8Array(32) })).toThrow(
      /sealBallotV3/,
    );
  });
});

describe("castSealV3", () => {
  test("builds the witness under the cell's scope, the member's own path, and the full depth", () => {
    for (const [cell, member, index] of [
      [0, 2, 2],
      [2, 5, 1],
    ] as const) {
      const sealed = sealBallotV3(election, cell, [...VOTES]);
      const { witness } = castSealV3(
        sealed,
        members[member] as Uint8Array,
        cell === 0 ? cell0 : cell2,
        L1,
      );
      const target = election.cells[cell] as (typeof election.cells)[number];
      expect(witness.scope).toBe(
        String(membershipScope(election.definitionHash, target.tier, target.root)),
      );
      expect(witness.merkleProofLength).toBe("32");
      expect(witness.merkleProofIndex).toBe(String(index));
      expect(witness.merkleProofSiblings).toHaveLength(32);
    }
  });

  test("a recast under another L1 block keeps the scope and changes only the message", () => {
    const sealed = sealBallotV3(election, 0, [...VOTES]);
    const secret = members[0] as Uint8Array;
    const first = castSealV3(sealed, secret, cell0, L1).witness;
    const again = castSealV3(sealed, secret, cell0, L1).witness;
    const later = castSealV3(sealed, secret, cell0, {
      number: 1300n,
      hash: new Uint8Array(32),
    }).witness;
    // One committed vote per seal: the same block gives the same message.
    expect(again).toEqual(first);
    expect(later.scope).toBe(first.scope);
    expect(later.message).not.toBe(first.message);
    // Another identity never casts a seal already cast.
    expect(() => castSealV3(sealed, members[1] as Uint8Array, cell0, L1)).toThrow(
      /another identity/,
    );
  });

  test("refuses a bad secret, a non-member and leaves that aren't the cell's before any proving", () => {
    const sealed = () => sealBallotV3(election, 0, [...VOTES]);
    expect(refusal(() => castSealV3(sealed(), new Uint8Array(32), cell0, L1))).toBe("secret");
    expect(refusal(() => castSealV3(sealed(), new Uint8Array(31).fill(1), cell0, L1))).toBe(
      "secret",
    );
    // A member of the other cell isn't in this one.
    expect(refusal(() => castSealV3(sealed(), members[5] as Uint8Array, cell0, L1))).toBe(
      "not-a-member",
    );
    // A leaf missing: the rebuilt root isn't the definition's.
    expect(
      refusal(() => castSealV3(sealed(), members[0] as Uint8Array, cell0.slice(0, 3), L1)),
    ).toBe("root");
  });

  test("a challenged seal is never cast, and a cast seal is never opened", () => {
    const challenged = sealBallotV3(election, 0, [...VOTES]);
    challengeSealV3(challenged);
    expect(() => castSealV3(challenged, members[0] as Uint8Array, cell0, L1)).toThrow(/challenged/);
    const cast = sealBallotV3(election, 0, [...VOTES]);
    castSealV3(cast, members[0] as Uint8Array, cell0, L1);
    expect(() => challengeSealV3(cast)).toThrow(/never opened/);
    // So is one whose cast failed after its validity proofs: the voter chose to cast.
    const failed = sealBallotV3(election, 0, [...VOTES]);
    expect(refusal(() => castSealV3(failed, members[0] as Uint8Array, cell0.slice(0, 3), L1))).toBe(
      "root",
    );
    expect(() => challengeSealV3(failed)).toThrow(/never opened/);
  });
});

describe("finishSealV3", () => {
  test("refuses any proof that doesn't verify for the cast's own signals", () => {
    const casting = castSealV3(
      sealBallotV3(election, 0, [...VOTES]),
      members[0] as Uint8Array,
      cell0,
      L1,
    );
    expect(refusal(() => finishSealV3(casting, new Uint8Array(MEMBERSHIP_PROOF_LENGTH)))).toBe(
      "proof",
    );
    expect(refusal(() => finishSealV3(casting, new Uint8Array(10)))).toBe("proof");
    expect(() => finishSealV3({ witness: casting.witness }, new Uint8Array(256))).toThrow(
      /castSealV3/,
    );
  });
});
