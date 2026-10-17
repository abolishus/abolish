// The ballot worker's side of a membership proof (docs/spec/membership.md,
// Security notes; ADR 0009, Amendment of 2026-10-17). Here, where snarkjs
// never runs: the witness is built from the identity secret and the tier's
// leaves, with the scope, nullifier and path computed by @abolishus/crypto and
// the path checked against the definition's root (T-10, T-13); the prover
// worker gets only the witness; its answer is verified under the pinned key
// against the signals computed here, then re-randomised from this realm's
// CSPRNG and verified again (`finishMembershipProof`). Only that result
// leaves, so a prover that is wrong or hijacked can stop a ballot but never
// make one carry its own randomness or a proof of another statement (T-07,
// T-12, T-55).

import {
  finishMembershipProof,
  membershipProverInput,
  MembershipProverError,
  type MembershipProverInput,
} from "@abolishus/crypto";

import { parseAnswer, PROVER_PROTOCOL_VERSION, type ProverWitness } from "../prover/protocol.ts";
import {
  type MembershipProofProblem,
  type MembershipProofResult,
  type ProveMembershipRequest,
  PROVER_TIMEOUT_MS,
} from "./protocol.ts";

/** The proof for `request`, or the check that refused it; never throws for a refusal. */
export async function proveMembership(
  request: ProveMembershipRequest,
  timeoutMs = PROVER_TIMEOUT_MS,
): Promise<MembershipProofResult> {
  const { prover } = request;
  try {
    let input: MembershipProverInput;
    try {
      input = membershipProverInput(request.secret, request.leaves, {
        definitionHash: request.definitionHash,
        tier: request.tier,
        root: request.root,
        message: request.message,
      });
    } finally {
      // membershipProverInput read its own copy; this realm's copy of the
      // secret goes now (T-12). The witness's decimal string can't be wiped.
      request.secret.fill(0);
    }
    const answer = await askProver(prover, input.witness, timeoutMs);
    if (!answer.ok) return answer;
    return { ok: true, proof: finishMembershipProof(input, answer.proof) };
  } catch (e) {
    if (e instanceof MembershipProverError) return { ok: false, problem: e.code };
    throw e;
  } finally {
    prover.close();
  }
}

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
