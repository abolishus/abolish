// Where the simulation runs trustee seats' intake: in the calling thread, or
// spread over worker threads (./intake-worker.ts), since intake (each seat
// checking every ballot's proofs) is most of a run's cost and each ballot's
// is independent of every other's. Either way each result is
// @abolishus/crypto's intakeShares, unchanged; ./run.ts orders and checks
// them as before.

import { Worker } from "node:worker_threads";
import {
  COMMITTED_VOTE,
  type CommittedVote,
  encode,
  type IntakeKeys,
  intakeShares,
  type ValidityContext,
} from "@abolishus/crypto";
import type { IntakeJob, IntakeReply, IntakeWorkerData, SeatIntake } from "./intake-worker.ts";

export type { SeatIntake } from "./intake-worker.ts";

/** The most worker threads a run starts. */
export const MAX_INTAKE_WORKERS = 64;

export interface SeatCiphertext {
  readonly seat: number;
  readonly ciphertext: Uint8Array;
}

export interface Intake {
  /** Each listed seat's intake of one ballot, in the order given. */
  run(
    ctx: ValidityContext,
    vote: CommittedVote,
    ciphertexts: readonly SeatCiphertext[],
  ): Promise<readonly SeatIntake[]>;
  /** How many ballots may wait for intake ahead of the one the run needs next. */
  readonly ahead: number;
  /** Stops every worker. */
  close(): Promise<void>;
}

const keysOf = (seats: readonly IntakeKeys[], seat: number): IntakeKeys => {
  const keys = seats.find((s) => s.seat === seat);
  if (keys === undefined) throw new RangeError(`intake: no keys for seat ${seat}`);
  return keys;
};

/** Intake in the calling thread, one ballot at a time. */
export function intakeInThread(seats: readonly IntakeKeys[]): Intake {
  return {
    ahead: 0,
    run: async (ctx, vote, ciphertexts) =>
      ciphertexts.map(({ seat, ciphertext }) =>
        intakeShares(ctx, keysOf(seats, seat), vote, ciphertext),
      ),
    close: async () => {},
  };
}

// Node runs the worker as TypeScript from the source tree (the tests) and as
// the packed entry beside dist/index.mjs.
const workerUrl = () =>
  new URL(
    import.meta.url.endsWith(".ts") ? "./intake-worker.ts" : "./intake-worker.mjs",
    import.meta.url,
  );

/**
 * Intake over `count` worker threads, each holding every seat's intake keys
 * (they never leave the process). A ballot goes to the worker with the
 * fewest waiting. A worker that fails or exits fails every ballot waiting
 * and every later one: the run stops rather than counting without it.
 */
export function intakeInWorkers(seats: readonly IntakeKeys[], count: number): Intake {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_INTAKE_WORKERS)
    throw new RangeError(`intake: workers must be an integer from 1 to ${MAX_INTAKE_WORKERS}`);
  const data: IntakeWorkerData = { abolishSimulationIntake: true, seats };
  const waiting = new Map<
    number,
    {
      readonly resolve: (results: readonly SeatIntake[]) => void;
      readonly reject: (error: Error) => void;
    }
  >();
  const load = Array.from({ length: count }, () => 0);
  let failure: Error | undefined;
  let closing = false;
  const fail = (error: Error) => {
    failure ??= error;
    for (const w of waiting.values()) w.reject(failure);
    waiting.clear();
  };
  const start = (i: number) => {
    const worker = new Worker(workerUrl(), { workerData: data });
    worker.on("message", (reply: IntakeReply) => {
      const w = waiting.get(reply.id);
      if (w === undefined) return;
      waiting.delete(reply.id);
      load[i] = (load[i] ?? 0) - 1;
      if ("error" in reply)
        w.reject(new Error(`simulation: intake failed in a worker (${reply.error})`));
      else w.resolve(reply.results);
    });
    worker.on("error", (e) => fail(e));
    worker.on("exit", (code) => {
      if (!closing) fail(new Error(`simulation: an intake worker exited (${code})`));
    });
    return worker;
  };
  // A worker that can't start stops those already started, so none is left holding the process.
  const workers: Worker[] = [];
  try {
    for (let i = 0; i < count; i++) workers.push(start(i));
  } catch (e) {
    closing = true;
    for (const w of workers) void w.terminate();
    throw e;
  }
  let next = 0;
  return {
    ahead: 2 * count,
    run(ctx, vote, ciphertexts) {
      if (failure !== undefined) return Promise.reject(failure);
      const id = next++;
      const i = load.indexOf(Math.min(...load));
      const job: IntakeJob = { id, ctx, vote: encode(COMMITTED_VOTE, vote), ciphertexts };
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        load[i] = (load[i] ?? 0) + 1;
        (workers[i] as Worker).postMessage(job);
      });
    },
    async close() {
      closing = true;
      await Promise.all(workers.map((w) => w.terminate()));
      fail(new Error("simulation: intake closed"));
    },
  };
}
