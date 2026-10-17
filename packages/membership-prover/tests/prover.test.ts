import {
  finishMembershipProof,
  MEMBERSHIP_PROOF_LENGTH,
  MEMBERSHIP_WASM_SHA256,
  MEMBERSHIP_ZKEY_SHA256,
  membershipProverInput,
  MembershipProverError,
  type MembershipProverErrorCode,
  type MembershipWitness,
  verifyMembershipProof,
} from "@abolishus/crypto";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { MEMBERSHIP_PROVER_STEPS, proveMembership } from "../src/index.ts";

// Proves docs/spec/vectors/membership-prover.json's cases (Semaphore 4.14.3's
// identities and the inputs its generateProof hands snarkjs, P2-21 part 2)
// with the vendored artifacts, and checks every proof with packages/crypto's
// verifier and finisher, as the ballot worker does. No expected value comes
// from the code under test.

interface ProverVectors {
  readonly definitionHash: string;
  readonly members: readonly { readonly secret: string }[];
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
  }[];
}

const ARTIFACTS = new URL("../artifacts/", import.meta.url);
const vectors = JSON.parse(
  readFileSync(
    new URL("../../../docs/spec/vectors/membership-prover.json", import.meta.url),
    "utf8",
  ),
) as ProverVectors;

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

interface ManifestEntry {
  readonly path: string;
  readonly sha256: string;
}
const manifest = JSON.parse(readFileSync(new URL("manifest.json", ARTIFACTS), "utf8")) as {
  readonly format: string;
  readonly files: readonly ManifestEntry[];
};
// Read only through the manifest, and only if the bytes match its sha256
// (node:crypto, never the code under test).
const vendored = (path: string) => {
  const entry = manifest.files.find((f) => f.path === path);
  if (entry === undefined) throw new Error(`${path}: not in manifest.json`);
  const b = new Uint8Array(readFileSync(new URL(path, ARTIFACTS)));
  if (sha256(b) !== entry.sha256) throw new Error(`${path}: sha256 differs from manifest.json`);
  return b;
};
const artifacts = {
  zkey: vendored("snark-artifacts/semaphore-32.zkey"),
  wasm: vendored("snark-artifacts/semaphore-32.wasm"),
};

const inputOf = (c: ProverVectors["cases"][number]) => {
  const t = vectors.trees.find((x) => x.id === c.tree);
  const m = vectors.members[c.member];
  if (t === undefined || m === undefined) throw new Error(`${c.name}: no tree or member`);
  return membershipProverInput(bytes(m.secret), t.leaves.map(BigInt), {
    definitionHash: bytes(vectors.definitionHash),
    tier: t.tier,
    root: BigInt(t.root),
    message: bytes(c.message),
  });
};
const first = vectors.cases[0];
if (first === undefined) throw new Error("no cases");

async function refusal(f: () => Promise<unknown>): Promise<MembershipProverErrorCode> {
  try {
    await f();
  } catch (e) {
    if (e instanceof MembershipProverError) return e.code;
    throw e;
  }
  throw new Error("expected a refusal");
}

const PROOF_TIMEOUT = 60_000;

describe("vendored artifacts (artifacts/manifest.json)", () => {
  test("are the two files the client pins, by the sha256s packages/crypto checks", () => {
    expect(manifest.format).toBe("abolish-test-vectors-manifest/1");
    expect(manifest.files.map((f) => [f.path, f.sha256])).toEqual([
      ["snark-artifacts/semaphore-32.zkey", MEMBERSHIP_ZKEY_SHA256],
      ["snark-artifacts/semaphore-32.wasm", MEMBERSHIP_WASM_SHA256],
    ]);
    expect(readdirSync(new URL("snark-artifacts/", ARTIFACTS)).sort()).toEqual([
      "semaphore-32.wasm",
      "semaphore-32.zkey",
    ]);
  });
});

describe("proveMembership", () => {
  test(
    "proves every vector case: the bytes verify against the inputs packages/crypto computed, and finish",
    async () => {
      expect(vectors.cases).toHaveLength(4);
      for (const c of vectors.cases) {
        const input = inputOf(c);
        const steps: number[] = [];
        const proof = await proveMembership(input.witness, artifacts, (done) => steps.push(done));
        expect(proof, c.name).toHaveLength(MEMBERSHIP_PROOF_LENGTH);
        expect(verifyMembershipProof(proof, input.signals), c.name).toBe(true);
        expect(verifyMembershipProof(finishMembershipProof(input, proof), input.signals)).toBe(
          true,
        );
        // Every step snarkjs logs, once and in order: a snarkjs that logs
        // others would leave the progress indicator stuck.
        expect(steps, c.name).toEqual(
          Array.from({ length: MEMBERSHIP_PROVER_STEPS }, (_, i) => i + 1),
        );
      }
    },
    4 * PROOF_TIMEOUT,
  );

  test(
    "a witness that doesn't climb to the definition's root proves another statement, which finishing refuses",
    async () => {
      const input = inputOf(first);
      const [sibling = "0", ...rest] = input.witness.merkleProofSiblings;
      const wrong: MembershipWitness = {
        ...input.witness,
        merkleProofSiblings: [(BigInt(sibling) + 1n).toString(), ...rest],
      };
      const proof = await proveMembership(wrong, artifacts);
      expect(() => finishMembershipProof(input, proof)).toThrow(MembershipProverError);
    },
    PROOF_TIMEOUT,
  );

  test(
    "proves with the bytes it checked, whatever the caller's buffers hold afterwards",
    async () => {
      const input = inputOf(first);
      const zkey = artifacts.zkey.slice();
      const wasm = artifacts.wasm.slice();
      const pending = proveMembership(input.witness, { zkey, wasm });
      zkey.fill(0);
      wasm.fill(0);
      expect(verifyMembershipProof(await pending, input.signals)).toBe(true);
    },
    PROOF_TIMEOUT,
  );

  test("refuses any other proving key or witness calculator before proving", async () => {
    const { witness } = inputOf(first);
    const flip = (b: Uint8Array, at: number) => {
      const out = b.slice();
      out[at] = (out[at] as number) ^ 1;
      return out;
    };
    const steps: number[] = [];
    const onProgress = (done: number) => steps.push(done);
    for (const zkey of [flip(artifacts.zkey, 0), flip(artifacts.zkey, artifacts.zkey.length - 1)])
      expect(
        await refusal(() => proveMembership(witness, { ...artifacts, zkey }, onProgress)),
      ).toBe("zkey");
    for (const wasm of [flip(artifacts.wasm, 0), artifacts.wasm.subarray(1), artifacts.zkey])
      expect(
        await refusal(() => proveMembership(witness, { ...artifacts, wasm }, onProgress)),
      ).toBe("wasm");
    expect(steps).toEqual([]);
    await expect(
      proveMembership(witness, { ...artifacts, zkey: "key" as unknown as Uint8Array }),
    ).rejects.toThrow(TypeError);
  });

  test("refuses a path of any length but 32", async () => {
    const { witness } = inputOf(first);
    for (const siblings of [
      witness.merkleProofSiblings.slice(0, 31),
      [...witness.merkleProofSiblings, "0"],
    ])
      await expect(
        proveMembership({ ...witness, merkleProofSiblings: siblings }, artifacts),
      ).rejects.toThrow(TypeError);
    await expect(
      proveMembership({ ...witness, merkleProofLength: "31" }, artifacts),
    ).rejects.toThrow(TypeError);
  });
});
