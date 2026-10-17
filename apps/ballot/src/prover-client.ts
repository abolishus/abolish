// The page's side of a membership proof: one prover worker per proof,
// started from the URL the ballot-worker policy mints (worker-policy.ts),
// given the checked artifacts and one end of a channel whose other end goes
// to the ballot worker, and terminated once the ballot worker answers. The
// witness and the prover's answer travel over the channel, so the page sees
// neither; it hears the prover's progress and the ballot worker's finished
// proof or ballot, or its refusal (prover/protocol.ts; T-12, T-55).

import type { ProverArtifacts } from "./prover-artifacts.ts";
import { parseProgress, PROVER_PROTOCOL_VERSION, type ProverStart } from "./prover/protocol.ts";
import type { CastResult, MembershipProofResult } from "./worker/protocol.ts";
import {
  type BallotWorker,
  type CastBallotRequest,
  type MembershipProofRequest,
  WorkerFailure,
} from "./worker-client.ts";
import { proverScriptUrl } from "./worker-policy.ts";

/** Called with how many of `of` proving steps are done: real progress, never time. */
export type ProvingProgress = (done: number, of: number) => void;

/**
 * The finished `membership_proof`, or the check that refused it. Throws
 * `WorkerFailure` if either worker fails or doesn't answer in time.
 */
export function proveMembership(
  ballot: BallotWorker,
  request: Omit<MembershipProofRequest, "prover">,
  artifacts: ProverArtifacts,
  onProgress: ProvingProgress = () => {},
): Promise<MembershipProofResult> {
  return withProver(artifacts, onProgress, (prover) =>
    ballot.proveMembership({ ...request, prover }),
  );
}

/**
 * The cast of a seal the ballot worker holds: the finished record, or why
 * there is none. Throws `WorkerFailure` if either worker fails or doesn't
 * answer in time; the seal stays cast either way.
 */
export function castBallot(
  ballot: BallotWorker,
  request: Omit<CastBallotRequest, "prover">,
  artifacts: ProverArtifacts,
  onProgress: ProvingProgress = () => {},
): Promise<CastResult> {
  return withProver(artifacts, onProgress, (prover) => ballot.cast({ ...request, prover }));
}

/** Runs `ask` with the ballot worker's end of a channel to a new prover worker, which ends with it. */
async function withProver<T>(
  artifacts: ProverArtifacts,
  onProgress: ProvingProgress,
  ask: (prover: MessagePort) => Promise<T>,
): Promise<T> {
  // A TrustedScriptURL is accepted wherever the sink takes a string.
  const prover = new Worker(proverScriptUrl() as string, { name: "prover" });
  try {
    const channel = new MessageChannel();
    const failed = new Promise<never>((_, reject) => {
      const fail = () => reject(new WorkerFailure("the prover worker failed"));
      prover.onerror = fail;
      prover.onmessageerror = fail;
    });
    prover.onmessage = ({ data }: MessageEvent<unknown>) => {
      const progress = parseProgress(data);
      if (progress !== undefined) onProgress(progress.done, progress.of);
    };
    // Copies, transferred: the caller's bytes stay whole for another proof.
    const zkey = artifacts.zkey.slice();
    const wasm = artifacts.wasm.slice();
    const start: ProverStart = {
      v: PROVER_PROTOCOL_VERSION,
      kind: "start",
      zkey,
      wasm,
      ballot: channel.port2,
    };
    prover.postMessage(start, [channel.port2, zkey.buffer, wasm.buffer]);
    return await Promise.race([ask(channel.port1), failed]);
  } finally {
    prover.terminate();
  }
}
