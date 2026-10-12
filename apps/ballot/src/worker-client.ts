// The page's side of the ballot worker: spawns it from the URL the
// ballot-worker policy mints (worker-policy.ts) and matches its answers to
// requests by id.

import type { ElectionCheck } from "./election.ts";
import { PROTOCOL_VERSION, responseId, type WorkerResponse } from "./worker/protocol.ts";
import { workerScriptUrl } from "./worker-policy.ts";

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
  #stopped = false;

  constructor() {
    // A TrustedScriptURL is accepted wherever the sink takes a string.
    this.#worker = new Worker(workerScriptUrl() as string, { name: "ballot" });
    this.#worker.onmessage = ({ data }: MessageEvent<unknown>) => {
      const id = responseId(data);
      const pending = id === undefined ? undefined : this.#pending.get(id);
      if (id === undefined || pending === undefined) return;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.resolve(data as WorkerResponse);
    };
    // A script that didn't load, an uncaught error or an unreadable message
    // stops the worker: every request in flight fails, and so does every
    // later one, at once rather than at its timeout.
    this.#worker.onerror = () => this.terminate();
    this.#worker.onmessageerror = () => this.terminate();
  }

  /** Checks an election in the worker (election.ts). */
  async checkElection(
    electionId: Uint8Array,
    definition: Uint8Array,
    displayText: Uint8Array,
  ): Promise<ElectionCheck> {
    if (this.#stopped) throw new WorkerFailure("the ballot worker stopped");
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
    this.#stopped = true;
    this.#worker.terminate();
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(new WorkerFailure("the ballot worker stopped"));
    }
    this.#pending.clear();
  }
}
