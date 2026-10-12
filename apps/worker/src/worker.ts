// A worker for every queue over one Redis (or Dragonfly) connection, and the
// schedules that queue the board audit and the identity-backup prune. Job
// data is parsed against its queue's schema before it is handled, and every
// outcome is logged by kind (T-10).

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
  /** How often expired identity backups are deleted; daily unless a test says otherwise. */
  readonly pruneEveryMs?: number;
  /** The clock handlers judge time by; the system clock unless a test moves it. */
  readonly now?: () => Date;
  /** The first segment of every key; tests give each run its own. */
  readonly prefix?: string;
  /** The handlers, `HANDLERS` unless a test replaces them to make one fail. */
  readonly handlers?: typeof HANDLERS;
}

/** Expiry is counted in whole UTC months, so once a day is plenty. */
export const PRUNE_EVERY_MS = 24 * 60 * 60_000;

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
  const handlers = options.handlers ?? HANDLERS;
  const ctx = { sql, log, now: options.now ?? (() => new Date()) };
  const workers = (Object.keys(QUEUES) as QueueKey[]).map((key) => {
    const spec = QUEUES[key];
    const worker = new Worker(
      spec.name,
      async (job): Promise<void> => {
        // Whatever wrote to Redis, a handler sees only the fields its
        // queue's schema names.
        // The name is kept in the events stream after the job is gone, so it
        // must be the queue's key, never something a producer chose.
        const data = spec.data.safeParse(job.data);
        if (!data.success || job.name !== key) throw new JobError("invalid-job-data");
        try {
          await handlers[key](ctx, data.data);
        } catch (e) {
          // T-10: BullMQ writes a failure's message to the queue's events
          // stream, which removeOnFail doesn't clear, and any other error's
          // message can quote data. Only a JobError's fixed message gets there.
          throw e instanceof JobError ? e : new JobError("internal");
        }
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
  // Each scheduled job takes no data, and runs once at start, then every
  // `every` milliseconds.
  const schedules = [
    { key: "boardAudit", id: "board-audit", every: options.auditEveryMs },
    {
      key: "identityBackupPrune",
      id: "identity-backup-prune",
      every: options.pruneEveryMs ?? PRUNE_EVERY_MS,
    },
  ] as const satisfies readonly { key: QueueKey; id: string; every: number }[];
  const queues = schedules.map((schedule) => {
    const name = QUEUES[schedule.key].name;
    const queue = new Queue(name, { connection, prefix });
    // Unheard, BullMQ prints the error and its stack to stderr.
    queue.on("error", () => log({ queue: name, error: "worker" }));
    return { schedule, queue };
  });
  const close = async () => {
    const closed = await Promise.allSettled([
      ...workers.map(({ worker }) => worker.close()),
      ...queues.map(({ queue }) => queue.close()),
    ]);
    for (const c of closed) if (c.status === "rejected") throw c.reason;
  };
  try {
    for (const { schedule, queue } of queues)
      await queue.upsertJobScheduler(
        schedule.id,
        { every: schedule.every },
        { name: schedule.key, data: {}, opts: JOB_OPTIONS },
      );
  } catch (e) {
    await close();
    throw e;
  }
  // Started only once the schedules are in place, so a failure there leaves
  // nothing running.
  for (const { name, worker } of workers)
    worker.run().catch(() => log({ queue: name, error: "worker" }));
  return { close };
}
