// The ballot worker's side of the channel to the prover worker
// (src/worker/prove.ts, `askProver`), against a stand-in prover on the other
// end: the witness goes over in one message and nothing else, the prover's
// first answer decides, and every answer that isn't a well-formed proof, or
// none in time, is a refusal naming what failed (T-12, T-55). Whether a proof
// verifies is the cast's to judge (tests/cast.test.ts).

import type { MembershipWitness } from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";

import { PROVER_PROTOCOL_VERSION } from "../src/prover/protocol.ts";
import { askProver } from "../src/worker/prove.ts";

/** A stand-in prover: records what it is sent and answers with each of `replies(witness)`. */
function prover(replies: (witness: unknown) => readonly unknown[]) {
  const { port1, port2 } = new MessageChannel();
  const received: unknown[] = [];
  port2.onmessage = ({ data }: MessageEvent<unknown>) => {
    received.push(data);
    for (const answer of replies((data as { witness?: unknown }).witness))
      port2.postMessage(answer);
  };
  return {
    port: port1,
    received,
    close: () => {
      port1.close();
      port2.close();
    },
  };
}

// The stand-in never reads the witness, so any stands in for one.
const witness = { identitySecret: "1" } as unknown as MembershipWitness;
const proof = new Uint8Array(256).fill(7);
const answer = { v: PROVER_PROTOCOL_VERSION, kind: "proof", proof };

describe("asking the prover worker", () => {
  test("sends the witness alone, once, and hands back the proof it answers with", async () => {
    const p = prover(() => [answer]);
    await expect(askProver(p.port, witness, 5_000)).resolves.toEqual({ ok: true, proof });
    expect(p.received).toEqual([{ v: PROVER_PROTOCOL_VERSION, kind: "witness", witness }]);
    p.close();
  });

  test.each([
    ["the key", { v: PROVER_PROTOCOL_VERSION, kind: "refused", problem: "zkey" }, "zkey"],
    ["the calculator", { v: PROVER_PROTOCOL_VERSION, kind: "refused", problem: "wasm" }, "wasm"],
    ["a failure", { v: PROVER_PROTOCOL_VERSION, kind: "error" }, "prover"],
    ["another version", { v: 2, kind: "proof", proof }, "prover"],
    ["an unknown refusal", { v: PROVER_PROTOCOL_VERSION, kind: "refused", problem: "x" }, "prover"],
    [
      "a proof as hex",
      { v: PROVER_PROTOCOL_VERSION, kind: "proof", proof: Buffer.from(proof).toString("hex") },
      "prover",
    ],
  ])("names the prover's answer when it gives %s", async (_, reply, problem) => {
    const p = prover(() => [reply]);
    await expect(askProver(p.port, witness, 5_000)).resolves.toEqual({ ok: false, problem });
    p.close();
  });

  test("the first answer decides: a malformed one isn't saved by a proof after it", async () => {
    const p = prover(() => [{ v: PROVER_PROTOCOL_VERSION, kind: "progress" }, answer]);
    await expect(askProver(p.port, witness, 5_000)).resolves.toEqual({
      ok: false,
      problem: "prover",
    });
    p.close();
  });

  test("gives up on a prover that doesn't answer", async () => {
    const p = prover(() => []);
    await expect(askProver(p.port, witness, 50)).resolves.toEqual({
      ok: false,
      problem: "prover",
    });
    p.close();
  });
});
