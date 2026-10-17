// The page's side of the ballot worker: spawns it from the URL the
// ballot-worker policy mints (worker-policy.ts) and matches its answers to
// requests by id.

import type { Panel } from "@abolishus/crypto";

import type { ElectionCheck } from "./election.ts";
import {
  type ChallengeResult,
  type MembershipProofResult,
  type ProveMembershipRequest,
  PROTOCOL_VERSION,
  PROVER_TIMEOUT_MS,
  responseId,
  type SealResult,
  type WorkerRequest,
  type WorkerResponse,
} from "./worker/protocol.ts";
import { workerScriptUrl } from "./worker-policy.ts";

/** How long a request may take before the client gives up on the worker. */
const TIMEOUT_MS = 30_000;
/** A proof waits on the prover worker, which the ballot worker gives up on first. */
const PROVE_TIMEOUT_MS = PROVER_TIMEOUT_MS + TIMEOUT_MS;

/** A proof request as the page makes it: everything but the envelope. */
export type MembershipProofRequest = Omit<ProveMembershipRequest, "v" | "id" | "kind">;

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

  /**
   * Checks an election in the worker (election.ts), and a version-5 poll's
   * ceremony transcript among `entries` under the one of `panels` it names
   * (worker/session.ts); the worker then holds the poll for `seal`.
   */
  async checkElection(
    electionId: Uint8Array,
    registeredHash: Uint8Array,
    definition: Uint8Array,
    displayText: Uint8Array,
    entries: readonly Uint8Array[],
    panels: readonly Panel[],
  ): Promise<ElectionCheck> {
    const response = await this.#request(
      (id) => ({
        v: PROTOCOL_VERSION,
        id,
        kind: "check-election",
        electionId,
        registeredHash,
        definition,
        displayText,
        entries,
        panels,
      }),
      [],
      TIMEOUT_MS,
    );
    if (response.kind !== "check-election") throw new WorkerFailure("the ballot worker failed");
    return response.result;
  }

  /** Seals `votes` in `cell` of the poll the worker last checked; the worker keeps the seal. */
  async seal(
    definitionHash: Uint8Array,
    cell: number,
    votes: readonly (0 | 1)[],
  ): Promise<SealResult> {
    const response = await this.#request(
      (id) => ({ v: PROTOCOL_VERSION, id, kind: "seal", definitionHash, cell, votes }),
      [],
      TIMEOUT_MS,
    );
    if (response.kind !== "seal") throw new WorkerFailure("the ballot worker failed");
    return response.result;
  }

  /** Opens the seal the voter challenged, which is then spent. */
  async challenge(seal: number): Promise<ChallengeResult> {
    const response = await this.#request(
      (id) => ({ v: PROTOCOL_VERSION, id, kind: "challenge", seal }),
      [],
      TIMEOUT_MS,
    );
    if (response.kind !== "challenge") throw new WorkerFailure("the ballot worker failed");
    return response.result;
  }

  /**
   * A membership proof, built in the worker with the prover worker at the
   * other end of `request.prover` (prover-client.ts). The port is
   * transferred; the secret is copied, and the worker zeroes its copy.
   */
  async proveMembership(request: MembershipProofRequest): Promise<MembershipProofResult> {
    const response = await this.#request(
      (id) => ({ v: PROTOCOL_VERSION, id, kind: "prove-membership", ...request }),
      [request.prover],
      PROVE_TIMEOUT_MS,
    );
    if (response.kind !== "prove-membership") throw new WorkerFailure("the ballot worker failed");
    return response.result;
  }

  async #request(
    message: (id: number) => WorkerRequest,
    transfer: Transferable[],
    timeoutMs: number,
  ): Promise<WorkerResponse> {
    if (this.#stopped) throw new WorkerFailure("the ballot worker stopped");
    const id = this.#nextId++;
    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new WorkerFailure("the ballot worker didn't answer"));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#worker.postMessage(message(id), transfer);
    });
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
