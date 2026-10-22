// The page's side of the ballot worker: spawns it from the URL the
// ballot-worker policy mints (worker-policy.ts) and matches its answers to
// requests by id.

import type { Panel } from "@abolishus/crypto";

import type { CheckedReceipt } from "./casts.ts";
import type { ElectionCheck } from "./election.ts";
import {
  type BackupLocatorResult,
  type BackupOpenRequest,
  type BackupOpenResult,
  type BackupSealResult,
  type CastRequest,
  type CastResult,
  type ChallengeResult,
  type IntakeResult,
  type PostingResult,
  type ReceiptResult,
  type CommitmentResult,
  type FindCellRequest,
  type FindCellResult,
  PROTOCOL_VERSION,
  PROVER_TIMEOUT_MS,
  responseId,
  type SealResult,
  type Tier0OutcomeRequest,
  type Tier0OutcomeResult,
  type WorkerRequest,
  type WorkerResponse,
} from "./worker/protocol.ts";
import { workerScriptUrl } from "./worker-policy.ts";

/** How long a request may take before the client gives up on the worker. */
const TIMEOUT_MS = 30_000;
/** A proof waits on the prover worker, which the ballot worker gives up on first. */
const PROVE_TIMEOUT_MS = PROVER_TIMEOUT_MS + TIMEOUT_MS;
/**
 * Rebuilding a tier recovers a signer per registrar approval (thousands for
 * a large tier, P2-21 part 3, Known-weak), so it gets as long as a proof.
 */
const FIND_CELL_TIMEOUT_MS = PROVE_TIMEOUT_MS;

/** A cell search as the page makes it: everything but the envelope. */
export type FindCellQuery = Omit<FindCellRequest, "v" | "id" | "kind">;

/** A registration's outcome as the page asks for it: everything but the envelope. */
export type Tier0OutcomeQuery = Omit<Tier0OutcomeRequest, "v" | "id" | "kind">;

/** A recovery's open as the page asks for it: everything but the message's envelope. */
export type BackupOpenQuery = Omit<BackupOpenRequest, "v" | "id" | "kind">;

/** A cast as the page makes it: everything but the envelope. */
export type CastBallotRequest = Omit<CastRequest, "v" | "id" | "kind">;

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
      if (id === undefined || pending === undefined) {
        // An open answered after its timeout: no one will zero its secret but here (T-12).
        const late = data as { kind?: unknown; result?: { secret?: unknown } } | null;
        if (late?.kind === "backup-open" && late.result?.secret instanceof Uint8Array)
          late.result.secret.fill(0);
        return;
      }
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

  /** The identity commitment of `secret`, which is copied; the worker zeroes its copy. */
  async commitment(secret: Uint8Array): Promise<CommitmentResult> {
    const response = await this.#request(
      (id) => ({ v: PROTOCOL_VERSION, id, kind: "commitment", secret }),
      [],
      TIMEOUT_MS,
    );
    if (response.kind !== "commitment") throw new WorkerFailure("the ballot worker failed");
    return response.result;
  }

  /**
   * `secret` sealed for the backup passkey whose PRF output is `prf`: the
   * envelope and its locator. Both are copied; the worker zeroes its copies.
   */
  async backupSeal(prf: Uint8Array, secret: Uint8Array): Promise<BackupSealResult> {
    const response = await this.#request(
      (id) => ({ v: PROTOCOL_VERSION, id, kind: "backup-seal", prf, secret }),
      [],
      TIMEOUT_MS,
    );
    if (response.kind !== "backup-seal") throw new WorkerFailure("the ballot worker failed");
    return response.result;
  }

  /**
   * The locator of the backup passkey whose PRF output is `prf`, which is
   * copied; the worker keeps its copy for `backupOpen`, so both go to the
   * same worker.
   */
  async backupLocator(prf: Uint8Array): Promise<BackupLocatorResult> {
    const response = await this.#request(
      (id) => ({ v: PROTOCOL_VERSION, id, kind: "backup-locator", prf }),
      [],
      TIMEOUT_MS,
    );
    if (response.kind !== "backup-locator") throw new WorkerFailure("the ballot worker failed");
    return response.result;
  }

  /**
   * Opens a recovered envelope under the PRF output the last
   * `backupLocator` gave this worker, and finds its identity among the
   * published Tier 0 groups from the group registry's whole log: a replay
   * like `tier0Outcome`'s, so it gets as long. The secret comes back only
   * once found, for the caller to keep and zero.
   */
  async backupOpen(query: BackupOpenQuery): Promise<BackupOpenResult> {
    const response = await this.#request(
      (id) => ({ v: PROTOCOL_VERSION, id, kind: "backup-open", ...query }),
      [],
      FIND_CELL_TIMEOUT_MS,
    );
    if (response.kind !== "backup-open") throw new WorkerFailure("the ballot worker failed");
    return response.result;
  }

  /**
   * Finds the voter's cell in the poll the worker last checked, from the
   * whole board; the worker keeps its leaves for `cast`. The secret is
   * copied, and the worker zeroes its copy.
   */
  async findCell(query: FindCellQuery): Promise<FindCellResult> {
    const response = await this.#request(
      (id) => ({ v: PROTOCOL_VERSION, id, kind: "find-cell", ...query }),
      [],
      FIND_CELL_TIMEOUT_MS,
    );
    if (response.kind !== "find-cell") throw new WorkerFailure("the ballot worker failed");
    return response.result;
  }

  /**
   * Where the identity's commitment stands among the published Tier 0
   * groups, from the group registry's whole log. The replay recovers a
   * signer per registrar approval, as a cell search does, so it gets as
   * long. The secret is copied, and the worker zeroes its copy.
   */
  async tier0Outcome(query: Tier0OutcomeQuery): Promise<Tier0OutcomeResult> {
    const response = await this.#request(
      (id) => ({ v: PROTOCOL_VERSION, id, kind: "tier0-outcome", ...query }),
      [],
      FIND_CELL_TIMEOUT_MS,
    );
    if (response.kind !== "tier0-outcome") throw new WorkerFailure("the ballot worker failed");
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
   * Casts a seal the worker holds, proved by the prover worker at the other
   * end of `request.prover` (prover-client.ts). The port is transferred; the
   * secret is copied, and the worker zeroes its copy. The seal can't be
   * challenged after this, whatever the answer.
   */
  async cast(request: CastBallotRequest): Promise<CastResult> {
    const response = await this.#request(
      (id) => ({ v: PROTOCOL_VERSION, id, kind: "cast", ...request }),
      [request.prover],
      PROVE_TIMEOUT_MS,
    );
    if (response.kind !== "cast") throw new WorkerFailure("the ballot worker failed");
    return response.result;
  }

  /**
   * The seat `receipt` receipts `ballot` for, a cast of the poll the worker
   * last checked, checked against that poll's registered signing keys.
   */
  async receipt(
    ballot: Uint8Array,
    receipt: Uint8Array,
  ): Promise<
    | { readonly ok: true; readonly checked: CheckedReceipt }
    | Extract<ReceiptResult, { readonly ok: false }>
  > {
    const response = await this.#request(
      (id) => ({ v: PROTOCOL_VERSION, id, kind: "receipt", ballot, receipt }),
      [],
      TIMEOUT_MS,
    );
    if (response.kind !== "receipt") throw new WorkerFailure("the ballot worker failed");
    const { result } = response;
    if (!result.ok) return result;
    // The one place a `CheckedReceipt` is made: the worker passed these bytes.
    const checked = { seat: result.seat, receipt: receipt.slice() } as unknown as CheckedReceipt;
    return { ok: true, checked };
  }

  /** The stub and ceremony transcript each seat's intake takes beside a ballot of the poll `definitionHash` names. */
  async intake(definitionHash: Uint8Array): Promise<IntakeResult> {
    const response = await this.#request(
      (id) => ({ v: PROTOCOL_VERSION, id, kind: "intake", definitionHash }),
      [],
      TIMEOUT_MS,
    );
    if (response.kind !== "intake") throw new WorkerFailure("the ballot worker failed");
    return response.result;
  }

  /**
   * Whether `share`, kept for a seat of `ballot`, a version-3 record naming
   * the poll the worker last checked, would deliver that seat if posted: checked against
   * the poll's registered KEM key for the seat before any posting is offered
   * (Client rule 4). The worker gets its own copy of `m` and zeroes it.
   */
  async posting(
    ballot: Uint8Array,
    share: { readonly seat: number; readonly ciphertext: Uint8Array; readonly m: Uint8Array },
  ): Promise<PostingResult> {
    const { seat, ciphertext, m } = share;
    const response = await this.#request(
      (id) => ({ v: PROTOCOL_VERSION, id, kind: "posting", ballot, seat, ciphertext, m }),
      [],
      TIMEOUT_MS,
    );
    if (response.kind !== "posting") throw new WorkerFailure("the ballot worker failed");
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
