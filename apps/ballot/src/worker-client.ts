// The page's side of the ballot worker: the one Trusted Types policy the CSP
// allows, `ballot-worker`, and the client that spawns the worker and matches
// its answers to requests.
//
// `new Worker(url)` is a script-URL sink, so under `require-trusted-types-for
// 'script'` it needs a TrustedScriptURL. The policy turns exactly one string,
// the worker's own bundled URL, into one, and refuses every other. The CSP
// names the policy without 'allow-duplicates', so once `claimWorkerPolicy`
// has created it nothing else in the page can, including code that runs later
// and would want a policy to mint script URLs of its own (T-43).

import type { ElectionCheck } from "./election.ts";
import { PROTOCOL_VERSION, responseId, type WorkerResponse } from "./worker/protocol.ts";
import workerPath from "./worker/worker.ts?worker&url";

/** The worker script's absolute URL: the only string the policy accepts. */
export const WORKER_URL = new URL(workerPath, import.meta.url).href;

// TypeScript's DOM library has no Trusted Types yet.
interface TrustedScriptURL {
  readonly __brand: "TrustedScriptURL";
}
interface WorkerPolicy {
  createScriptURL(input: string): TrustedScriptURL;
}
interface TrustedTypes {
  createPolicy(name: string, rules: { createScriptURL(input: string): string }): WorkerPolicy;
}

/** The policy's rule: the worker's own URL passes; anything else throws. */
export function allowWorkerUrl(input: string): string {
  if (input !== WORKER_URL) throw new TypeError("ballot-worker: not the ballot worker's URL");
  return input;
}

let policy: WorkerPolicy | undefined;

/**
 * Creates the `ballot-worker` policy. main.tsx calls it before anything else
 * runs, so no other script can claim the name first. A browser without
 * Trusted Types gets no policy and spawns the worker from the plain URL,
 * which `worker-src 'self'` still confines to the client's origin.
 */
export function claimWorkerPolicy(): void {
  const trustedTypes = (globalThis as { trustedTypes?: TrustedTypes }).trustedTypes;
  if (trustedTypes === undefined || policy !== undefined) return;
  policy = trustedTypes.createPolicy("ballot-worker", { createScriptURL: allowWorkerUrl });
}

/** How long a request may take before the client gives up on the worker. */
const TIMEOUT_MS = 30_000;

/** Thrown when the worker answers with an error, crashes, or doesn't answer in time. */
export class WorkerFailure extends Error {
  override readonly name = "WorkerFailure";
}

type Pending = {
  resolve: (response: WorkerResponse) => void;
  reject: (error: WorkerFailure) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** One ballot worker. Requests are answered in any order, matched by id. */
export class BallotWorker {
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  #nextId = 0;

  constructor() {
    claimWorkerPolicy();
    const url = policy === undefined ? WORKER_URL : policy.createScriptURL(WORKER_URL);
    // A TrustedScriptURL is accepted wherever the sink takes a string.
    this.#worker = new Worker(url as string, { name: "ballot" });
    this.#worker.onmessage = ({ data }: MessageEvent<unknown>) => {
      const id = responseId(data);
      const pending = id === undefined ? undefined : this.#pending.get(id);
      if (id === undefined || pending === undefined) return;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.resolve(data as WorkerResponse);
    };
    // A crash or an unreadable message fails every request in flight.
    this.#worker.onerror = () => this.#failAll();
    this.#worker.onmessageerror = () => this.#failAll();
  }

  /** Checks an election in the worker (election.ts). */
  async checkElection(
    electionId: Uint8Array,
    definition: Uint8Array,
    displayText: Uint8Array,
  ): Promise<ElectionCheck> {
    const id = this.#nextId++;
    const response = await new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new WorkerFailure("the ballot worker didn't answer"));
      }, TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      this.#worker.postMessage({
        v: PROTOCOL_VERSION,
        id,
        kind: "check-election",
        electionId,
        definition,
        displayText,
      });
    });
    if (response.kind !== "check-election") throw new WorkerFailure("the ballot worker failed");
    return response.result;
  }

  terminate(): void {
    this.#worker.terminate();
    this.#failAll();
  }

  #failAll(): void {
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(new WorkerFailure("the ballot worker stopped"));
    }
    this.#pending.clear();
  }
}
