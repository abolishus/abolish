// The ballot worker's side of the channel to the prover worker (ADR 0009,
// Amendment of 2026-10-17). Here, where snarkjs never runs, the prover
// worker gets only the witness `castSealV3` built from a statement this
// worker derived from the definition it checked (session.ts); what comes
// back is an unchecked proof, which the caller verifies and re-randomises
// (`finishSealV3`) before anything leaves, so a prover that is wrong or
// hijacked can stop a ballot but never make one carry its own randomness or
// a proof of another statement (T-07, T-12, T-55).

import { parseAnswer, PROVER_PROTOCOL_VERSION, type ProverWitness } from "../prover/protocol.ts";
import type { MembershipProofProblem } from "./protocol.ts";

/**
 * The prover's unchecked proof for `witness`, or why none came: the artifact
 * it refused, or `prover` for a failure, a malformed first answer or none in
 * time. The caller verifies and re-randomises the proof before anything
 * leaves (T-12, T-55), and closes the port.
 */
export async function askProver(
  prover: MessagePort,
  witness: ProverWitness["witness"],
  timeoutMs: number,
): Promise<
  | { readonly ok: true; readonly proof: Uint8Array }
  | { readonly ok: false; readonly problem: MembershipProofProblem }
> {
  const answer = await ask(prover, witness, timeoutMs);
  if (answer === undefined || answer.kind === "error") return { ok: false, problem: "prover" };
  if (answer.kind === "refused") return { ok: false, problem: answer.problem };
  return { ok: true, proof: answer.proof };
}

/** Sends the witness and waits for one well-formed answer; `undefined` on anything else or on timeout. */
function ask(
  prover: MessagePort,
  witness: ProverWitness["witness"],
  timeoutMs: number,
): Promise<ReturnType<typeof parseAnswer>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    // The first message decides: a prover that sends anything malformed first has failed.
    prover.onmessage = ({ data }: MessageEvent<unknown>) => {
      clearTimeout(timer);
      prover.onmessage = null;
      resolve(parseAnswer(data));
    };
    prover.onmessageerror = () => {
      clearTimeout(timer);
      resolve(undefined);
    };
    const message: ProverWitness = { v: PROVER_PROTOCOL_VERSION, kind: "witness", witness };
    prover.postMessage(message);
  });
}
