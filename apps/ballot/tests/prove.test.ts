// The ballot worker's side of a membership proof (src/worker/prove.ts),
// against a stand-in prover on the other end of the channel answering with
// docs/spec/vectors/membership-prover.json's Semaphore-made proofs: the
// witness it sends is the one Semaphore's generateProof hands snarkjs, only a
// proof that verifies for the statement is finished, the result is a
// re-randomised proof of the same statement, and every other answer, or none,
// is a refusal (T-07, T-12, T-55). No expected value comes from the code
// under test.

import { readFileSync } from "node:fs";

import { membershipProverInput, verifyMembershipProof } from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";

import { PROVER_PROTOCOL_VERSION } from "../src/prover/protocol.ts";
import { proveMembership } from "../src/worker/prove.ts";
import { PROTOCOL_VERSION, type ProveMembershipRequest } from "../src/worker/protocol.ts";

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
    readonly input: Record<string, unknown>;
    readonly proof: string;
  }[];
}

const vectors = JSON.parse(
  readFileSync(
    new URL("../../../docs/spec/vectors/membership-prover.json", import.meta.url),
    "utf8",
  ),
) as ProverVectors;
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));

const cases = vectors.cases.map((c) => {
  const tree = vectors.trees.find((t) => t.id === c.tree);
  const member = vectors.members[c.member];
  if (tree === undefined || member === undefined) throw new Error(`${c.name}: no tree or member`);
  return { ...c, tree, secret: member.secret };
});
const [first] = cases;
if (first === undefined) throw new Error("no cases");

type Case = typeof first;

/** A stand-in prover: records what it is sent and answers with `reply(witness)`, if anything. */
function prover(reply: (witness: unknown) => unknown) {
  const { port1, port2 } = new MessageChannel();
  const received: unknown[] = [];
  port2.onmessage = ({ data }: MessageEvent<unknown>) => {
    received.push(data);
    const answer = reply((data as { witness?: unknown }).witness);
    if (answer !== undefined) port2.postMessage(answer);
  };
  return { port: port1, received, close: () => port2.close() };
}

const request = (c: Case, port: MessagePort, secret = bytes(c.secret)): ProveMembershipRequest => ({
  v: PROTOCOL_VERSION,
  id: 1,
  kind: "prove-membership",
  secret,
  leaves: c.tree.leaves.map(BigInt),
  definitionHash: bytes(vectors.definitionHash),
  tier: c.tree.tier,
  root: BigInt(c.tree.root),
  message: bytes(c.message),
  prover: port,
});

const signalsOf = (c: Case) =>
  membershipProverInput(bytes(c.secret), c.tree.leaves.map(BigInt), {
    definitionHash: bytes(vectors.definitionHash),
    tier: c.tree.tier,
    root: BigInt(c.tree.root),
    message: bytes(c.message),
  }).signals;

const proofOf = (c: Case) => ({ v: PROVER_PROTOCOL_VERSION, kind: "proof", proof: bytes(c.proof) });

describe("proving in the ballot worker", () => {
  test.each(cases.map((c) => [c.name, c] as const))(
    "%s: sends Semaphore's witness, and finishes Semaphore's proof into another that verifies",
    async (_, c) => {
      const p = prover(() => proofOf(c));
      const result = await proveMembership(request(c, p.port));
      p.close();
      expect(p.received).toEqual([
        { v: PROVER_PROTOCOL_VERSION, kind: "witness", witness: c.input },
      ]);
      if (!result.ok) throw new Error(`refused: ${result.problem}`);
      expect(verifyMembershipProof(result.proof, signalsOf(c))).toBe(true);
      // Re-randomised: the prover's bytes never leave.
      expect(Buffer.from(result.proof).toString("hex")).not.toBe(c.proof);
    },
  );

  test("zeroes its copy of the secret once the witness is built", async () => {
    const secret = bytes(first.secret);
    const p = prover(() => proofOf(first));
    await proveMembership(request(first, p.port, secret));
    p.close();
    expect(secret).toEqual(new Uint8Array(32));
  });

  test("refuses a proof that doesn't verify for the statement, however close", async () => {
    const flipped = bytes(first.proof);
    flipped[200] = (flipped[200] as number) ^ 1;
    const other = cases.find((c) => c.proof !== first.proof);
    if (other === undefined) throw new Error("one proof only");
    for (const proof of [
      flipped,
      bytes(other.proof),
      new Uint8Array(256),
      bytes(first.proof).slice(1),
    ]) {
      const p = prover(() => ({ v: PROVER_PROTOCOL_VERSION, kind: "proof", proof }));
      await expect(proveMembership(request(first, p.port))).resolves.toEqual({
        ok: false,
        problem: "proof",
      });
      p.close();
    }
  });

  test.each([
    ["the key", { v: PROVER_PROTOCOL_VERSION, kind: "refused", problem: "zkey" }, "zkey"],
    ["the calculator", { v: PROVER_PROTOCOL_VERSION, kind: "refused", problem: "wasm" }, "wasm"],
    ["a failure", { v: PROVER_PROTOCOL_VERSION, kind: "error" }, "prover"],
    ["another version", { v: 2, kind: "proof", proof: new Uint8Array(256) }, "prover"],
    ["an unknown refusal", { v: PROVER_PROTOCOL_VERSION, kind: "refused", problem: "x" }, "prover"],
    ["a proof as hex", { v: PROVER_PROTOCOL_VERSION, kind: "proof", proof: first.proof }, "prover"],
  ])("names the prover's answer when it refuses %s", async (_, answer, problem) => {
    const p = prover(() => answer);
    await expect(proveMembership(request(first, p.port))).resolves.toEqual({ ok: false, problem });
    p.close();
  });

  test("gives up on a prover that doesn't answer", async () => {
    const p = prover(() => undefined);
    await expect(proveMembership(request(first, p.port), 50)).resolves.toEqual({
      ok: false,
      problem: "prover",
    });
    p.close();
  });

  test("refuses a secret that isn't a member, or isn't a secret, before the prover hears anything", async () => {
    // The tree without the member's own leaf.
    const notMember = prover(() => proofOf(first));
    const notSecret = prover(() => proofOf(first));
    const [nonMember, nonSecret] = await Promise.all([
      proveMembership({
        ...request(first, notMember.port),
        leaves: first.tree.leaves
          .filter((_, i) => i !== Number(first.input["merkleProofIndex"]))
          .map(BigInt),
      }),
      proveMembership(request(first, notSecret.port, new Uint8Array(32).fill(0xff))),
    ]);
    notMember.close();
    notSecret.close();
    expect(nonMember).toEqual({ ok: false, problem: "not-a-member" });
    expect(nonSecret).toEqual({ ok: false, problem: "secret" });
    expect(notMember.received).toEqual([]);
    expect(notSecret.received).toEqual([]);
  });

  test("refuses leaves that don't climb to the definition's root", async () => {
    const p = prover(() => proofOf(first));
    await expect(
      proveMembership({ ...request(first, p.port), root: BigInt(first.tree.root) + 1n }),
    ).resolves.toEqual({ ok: false, problem: "root" });
    p.close();
    expect(p.received).toEqual([]);
  });
});
