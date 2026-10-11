// A worker for every queue over one Redis (or Dragonfly) connection, and the
// schedule that queues the board audit. Job data is parsed against its
// queue's schema before it is handled, and every outcome is logged by kind
// (T-10).

import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Sql } from "postgres";
import { HANDLERS, JobError } from "./jobs.ts";
import type { Log } from "./log.ts";
import { JOB_OPTIONS, KEY_PREFIX, QUEUES, type QueueKey } from "./queues.ts";

export interface WorkerOptions {
  /** Shared by every queue and worker; BullMQ duplicates it for blocking reads. */
  readonly connection: Redis;
  /** Connected as a user granted abolish_app, never the owner. */
  readonly sql: Sql;
  readonly log: Log;
  /** How often every board is audited. */
  readonly auditEveryMs: number;
  /** The first segment of every key; tests give each run its own. */
  readonly prefix?: string;
}

export interface RunningWorker {
  close(): Promise<void>;
}

const elapsed = (job: { processedOn?: number | undefined; finishedOn?: number | undefined }) =>
  job.processedOn === undefined || job.finishedOn === undefined
    ? 0
    : Math.max(0, job.finishedOn - job.processedOn);

export async function startWorker(options: WorkerOptions): Promise<RunningWorker> {
  const { connection, sql, log } = options;
  const prefix = options.prefix ?? KEY_PREFIX;
  const ctx = { sql, log };
  const workers = (Object.keys(QUEUES) as QueueKey[]).map((key) => {
    const spec = QUEUES[key];
    const worker = new Worker(
      spec.name,
      async (job) => {
        // Whatever wrote to Redis, a handler sees only the fields its
        // queue's schema names.
        const data = spec.data.safeParse(job.data);
        if (!data.success) throw new JobError("invalid-job-data");
        await HANDLERS[key](ctx, data.data);
      },
      // T-10: a job's data, error and stack trace leave Redis as soon as it
      // finishes, even when its producer didn't ask (JOB_OPTIONS does).
      {
        connection,
        prefix,
        autorun: false,
        removeOnComplete: { count: 0 },
        removeOnFail: { count: 0 },
      },
    );
    worker.on("completed", (job) =>
      log({ queue: spec.name, outcome: "completed", ms: elapsed(job) }),
    );
    worker.on("failed", (job, err) =>
      log({
        queue: spec.name,
        outcome: "failed",
        error: err instanceof JobError ? err.kind : "internal",
        ms: job === undefined ? 0 : elapsed(job),
      }),
    );
    // Without a listener an 'error' event would crash the process; its
    // message can quote a command's arguments, so only the fact is logged.
    worker.on("error", () => log({ queue: spec.name, error: "worker" }));
    return { name: spec.name, worker };
  });
  const audits = new Queue(QUEUES.boardAudit.name, { connection, prefix });
  await audits.upsertJobScheduler(
    "board-audit",
    { every: options.auditEveryMs },
    { name: "boardAudit", data: {}, opts: JOB_OPTIONS },
  );
  // Started only once the schedule is in place, so a failure there leaves
  // nothing running.
  for (const { name, worker } of workers)
    worker.run().catch(() => log({ queue: name, error: "worker" }));
  return {
    async close() {
      await Promise.all(workers.map(({ worker }) => worker.close()));
      await audits.close();
    },
  };
}
