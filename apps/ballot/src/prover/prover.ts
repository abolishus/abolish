// The prover worker's entry point: snarkjs, through @abolishus/membership-prover,
// in a realm of its own, started by the page for one proof and terminated
// after it, which also bounds how long the witness's copy of the secret lives
// here (T-12). It takes the artifacts and the ballot worker's port from the
// page, one witness from the ballot worker, and answers the ballot worker
// alone; the page hears only progress. Like the ballot worker it has no
// network, storage or code-loading API (the bundle check bans them from every
// script the page doesn't load, and the build stubs the two places snarkjs
// and ffjavascript would reach for them; T-43). Errors are a bare "error",
// never a message, which could quote the secret.

import { MembershipProverError } from "@abolishus/crypto";
import { MEMBERSHIP_PROVER_STEPS, proveMembership } from "@abolishus/membership-prover";

import {
  parseStart,
  parseWitness,
  PROVER_PROTOCOL_VERSION,
  type ProverAnswer,
  type ProverProgress,
  type ProverStart,
} from "./protocol.ts";

// DedicatedWorkerGlobalScope isn't in the DOM library this package compiles with.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: ProverProgress): void;
};

async function prove(start: ProverStart, witness: unknown): Promise<ProverAnswer> {
  const parsed = parseWitness(witness);
  if (parsed === undefined) return { v: PROVER_PROTOCOL_VERSION, kind: "error" };
  try {
    const proof = await proveMembership(
      parsed.witness,
      { zkey: start.zkey, wasm: start.wasm },
      (done) =>
        scope.postMessage({
          v: PROVER_PROTOCOL_VERSION,
          kind: "progress",
          done,
          of: MEMBERSHIP_PROVER_STEPS,
        }),
    );
    return { v: PROVER_PROTOCOL_VERSION, kind: "proof", proof };
  } catch (e) {
    if (e instanceof MembershipProverError && (e.code === "zkey" || e.code === "wasm"))
      return { v: PROVER_PROTOCOL_VERSION, kind: "refused", problem: e.code };
    return { v: PROVER_PROTOCOL_VERSION, kind: "error" };
  }
}

// One start, then one witness: anything after is ignored.
scope.onmessage = ({ data }) => {
  scope.onmessage = null;
  const start = parseStart(data);
  if (start === undefined) return;
  scope.postMessage({
    v: PROVER_PROTOCOL_VERSION,
    kind: "progress",
    done: 0,
    of: MEMBERSHIP_PROVER_STEPS,
  });
  start.ballot.onmessage = ({ data: witness }: MessageEvent<unknown>) => {
    start.ballot.onmessage = null;
    void prove(start, witness).then((answer) => {
      start.ballot.postMessage(answer);
      start.ballot.close();
    });
  };
};
