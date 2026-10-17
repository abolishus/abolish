// A worker for every queue over one Redis (or Dragonfly) connection, and the
// schedules that queue the board audit, the identity-backup prune and, when
// configured, the board anchoring and the Tier 0 index refresh and boundary.
// The API's ballots are judged only when panels are pinned. Job data is parsed
// against its queue's schema before it is handled, and every outcome is
// logged by kind (T-10).

import type {
  AnchorChain,
  BallotAdmissions,
  BoardClock,
  CreationAnchors,
  PollCreationChain,
  PollRegistrationChain,
  PollStubDeployment,
  Tier0Batches,
} from "@abolishus/core";
import type { Panel } from "@abolishus/crypto";
import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { Sql } from "postgres";
import { BALLOT_MAX_AGE_MS } from "./ballot-queue.ts";
import { BALLOT_BATCH, BallotBatches } from "./ballots.ts";
import { HANDLERS, JobError, TIER0_QUEUES } from "./jobs.ts";
import type { Log } from "./log.ts";
import { JOB_OPTIONS, KEY_PREFIX, QUEUES, type QueueKey } from "./queues.ts";
import type { PollRoots } from "./poll-roots.ts";
import type { RegistrySync } from "./registry-sync.ts";

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
  /**
   * The L1 anchor to anchor every board through, and how often to run: well
   * within the anchor's period, so each checkpoint is sent soon after its
   * period ends and a failed call is retried long before its deadline.
   * Without it, nothing is anchored.
   */
  readonly anchor?: { readonly chain: AnchorChain; readonly everyMs: number };
  /** The clock handlers judge time by; the system clock unless a test moves it. */
  readonly now?: () => Date;
  /** The first segment of every key; tests give each run its own. */
  readonly prefix?: string;
  /** The handlers, `HANDLERS` unless a test replaces them to make one fail. */
  readonly handlers?: typeof HANDLERS;
  /** The Tier 0 batch job; without it, its queues have no worker and no schedule. */
  readonly tier0?: {
    readonly batches: Tier0Batches;
    /** How often the index is rebuilt; `TIER0_INDEX_EVERY_MS` unless a test says otherwise. */
    readonly indexEveryMs?: number;
    /** How often the boundary is tried; `TIER0_BOUNDARY_EVERY_MS` unless a test says otherwise. */
    readonly boundaryEveryMs?: number;
  };
  /**
   * Ballot admission for the API's `{ballot-submit}` queue (T-52); without
   * it, nothing takes that queue's jobs and the API answers each ballot
   * unavailable once it times out.
   */
  readonly ballots?: {
    readonly admissions: BallotAdmissions;
    /** Most ballots judged in one batch; `BALLOT_BATCH` unless a test says otherwise. */
    readonly batch?: number;
    /** How long a batch's first ballot waits for others; `BALLOT_BATCH_WAIT_MS` unless a test says otherwise. */
    readonly waitMs?: number;
  };
  /** The registry sync; without it, its queue has no worker and no schedule. */
  readonly registry?: {
    readonly sync: RegistrySync;
    /** How often it runs; `REGISTRY_SYNC_EVERY_MS` unless a test says otherwise. */
    readonly everyMs?: number;
  };
  /**
   * The roots step (P2-22 part 3b-2), only beside the registry sync, whose
   * index and nodes it reads; without it, no created poll is rooted.
   */
  readonly pollRoots?: {
    readonly roots: PollRoots;
    /** How often it runs; `POLL_ROOT_EVERY_MS` unless a test says otherwise. */
    readonly everyMs?: number;
  };
  /**
   * The stub step (P2-22 part 4b), only beside the registry sync, whose
   * deployment its stubs pin, as `pollStubDeployment` checked it; without
   * it, no rooted poll gets a stub and no ceremony runs.
   */
  readonly pollStubs?: {
    readonly deployment: PollStubDeployment;
    /** How often it runs; `POLL_STUB_EVERY_MS` unless a test says otherwise. */
    readonly everyMs?: number;
    /**
     * How often the ceremony's coordinator, which relays the same panel,
     * opens runs and closes rounds; `CEREMONY_COORDINATE_EVERY_MS` unless a
     * test says otherwise.
     */
    readonly coordinateEveryMs?: number;
    /**
     * The anchoring clock of the anchor every stub pins, as
     * `checkCreationAnchorsDeployment` read it from L1: the opening step
     * boards each transcript in its current segment.
     */
    readonly clock: BoardClock;
    /** How often the opening step runs; `POLL_OPEN_EVERY_MS` unless a test says otherwise. */
    readonly openEveryMs?: number;
  };
  /**
   * The creation step, with the creation key ([[0032-poll-creation-operations]],
   * rule 2): a worker given it runs the `{poll-create}` queue and nothing
   * else, no audit, prune, anchoring, Tier 0, ballot, registry, roots or stub work beside the key,
   * and refuses to start with any of those configured. Without it, nothing
   * creates polls.
   */
  readonly pollCreation?: {
    readonly chain: PollCreationChain & PollRegistrationChain;
    /** Creations sent in any 24 hours (rule 18). */
    readonly dailyCeiling: number;
    /** The L1 anchor each created identifier is checked against (P2-22 part 3b-1). */
    readonly anchors: CreationAnchors;
    /**
     * The default panel whose approved ceremonies the key registers (P2-22
     * part 5b), as `checkPollCreationDeployment` found it pinned.
     */
    readonly panel: Panel;
    /** How often the step runs; `POLL_CREATE_EVERY_MS` unless a test says otherwise. */
    readonly everyMs?: number;
  };
}

/** Expiry is counted in whole UTC months, so once a day is plenty. */
export const PRUNE_EVERY_MS = 24 * 60 * 60_000;

/**
 * A third of the route's `TIER0_INDEX_MAX_LAG` (a minute), so one missed or
 * slow refresh doesn't turn registrations away (docs/spec/registration.md,
 * Answers, step 6).
 */
export const TIER0_INDEX_EVERY_MS = 20_000;

/**
 * A boundary is tried every 30 seconds and runs once per period, so a batch
 * is formed within about 30 seconds of its boundary, and a tick that lost
 * the lock to an index refresh is retried well within the period.
 */
export const TIER0_BOUNDARY_EVERY_MS = 30_000;

/**
 * A registration is recorded only once its block is finalized, which on an
 * OP Stack L2 takes over ten minutes, so a minute's wait adds little, and
 * each run reads the registry's whole log from the index.
 */
export const REGISTRY_SYNC_EVERY_MS = 60_000;

/**
 * Each run sends what was submitted since the last and checks each creation
 * for finality, which takes minutes, so every 30 seconds adds little to setup.
 */
export const POLL_CREATE_EVERY_MS = 30_000;

/**
 * Each run waits for a new output root only through the accumulator it
 * reads, and setup is tens of minutes, so once a minute adds little.
 */
export const POLL_ROOT_EVERY_MS = 60_000;

/**
 * A stub opens `SETUP_SECONDS` after its run, and setup is tens of minutes,
 * so once a minute adds little.
 */
export const POLL_STUB_EVERY_MS = 60_000;

/**
 * A round's deadline is `CEREMONY_ROUND_SECONDS`, and a run opens within a
 * tick of its stub, so every 15 seconds keeps both close to their times.
 */
export const CEREMONY_COORDINATE_EVERY_MS = 15_000;

/**
 * A poll registers at least `REGISTRATION_MARGIN_SECONDS` before it opens,
 * and the registry sync stores it within a minute or two of finality, so
 * once a minute opens it before ballots are taken.
 */
export const POLL_OPEN_EVERY_MS = 60_000;

export interface RunningWorker {
  close(): Promise<void>;
}

const elapsed = (job: { processedOn?: number | undefined; finishedOn?: number | undefined }) =>
  job.processedOn === undefined || job.finishedOn === undefined
    ? 0
    : Math.max(0, job.finishedOn - job.processedOn);

export async function startWorker(options: WorkerOptions): Promise<RunningWorker> {
  const { connection, sql, log } = options;
  const creating = options.pollCreation !== undefined;
  if (options.pollRoots !== undefined && options.registry === undefined)
    throw new Error("the roots step runs only beside the registry sync");
  if (options.pollStubs !== undefined && options.registry === undefined)
    throw new Error("the stub step runs only beside the registry sync");
  if (
    creating &&
    (options.anchor !== undefined ||
      options.tier0 !== undefined ||
      options.ballots !== undefined ||
      options.registry !== undefined ||
      options.pollRoots !== undefined ||
      options.pollStubs !== undefined)
  )
    throw new Error("a worker holding the creation key runs nothing else");
  const prefix = options.prefix ?? KEY_PREFIX;
  const handlers = options.handlers ?? HANDLERS;
  const now = options.now ?? (() => new Date());
  const batch = options.ballots?.batch ?? BALLOT_BATCH;
  const ctx = {
    sql,
    log,
    now,
    ...(options.anchor === undefined ? {} : { anchor: options.anchor.chain }),
    ...(options.tier0 === undefined ? {} : { tier0: options.tier0.batches }),
    ...(options.registry === undefined ? {} : { registry: options.registry.sync }),
    ...(options.pollRoots === undefined ? {} : { pollRoots: options.pollRoots.roots }),
    ...(options.pollStubs === undefined
      ? {}
      : { pollStubs: options.pollStubs.deployment, pollClock: options.pollStubs.clock }),
    ...(options.pollCreation === undefined
      ? {}
      : {
          pollCreation: {
            chain: options.pollCreation.chain,
            dailyCeiling: options.pollCreation.dailyCeiling,
            anchors: options.pollCreation.anchors,
            panel: options.pollCreation.panel,
          },
        }),
    ...(options.ballots === undefined
      ? {}
      : {
          ballots: new BallotBatches({
            sql,
            admissions: options.ballots.admissions,
            now: () => BigInt(Math.floor(now().getTime() / 1000)),
            batch,
            log,
            ...(options.ballots.waitMs === undefined ? {} : { waitMs: options.ballots.waitMs }),
          }),
        }),
  };
  const running = (key: QueueKey) =>
    creating
      ? key === "pollCreate"
      : key === "pollCreate"
        ? false
        : key === "ballotSubmit"
          ? options.ballots !== undefined
          : key === "registrySync"
            ? options.registry !== undefined
            : key === "pollRoot"
              ? options.pollRoots !== undefined
              : key === "pollStub" || key === "ceremonyCoordinate" || key === "pollOpen"
                ? options.pollStubs !== undefined
                : options.tier0 !== undefined ||
                  !(TIER0_QUEUES as readonly QueueKey[]).includes(key);
  const workers = (Object.keys(QUEUES) as QueueKey[]).filter(running).map((key) => {
    const spec = QUEUES[key];
    const worker = new Worker(
      spec.name,
      async (job): Promise<unknown> => {
        // Whatever wrote to Redis, a handler sees only the fields its
        // queue's schema names.
        // The name is kept in the events stream after the job is gone, so it
        // must be the queue's key, never something a producer chose.
        const data = spec.data.safeParse(job.data);
        if (!data.success || job.name !== key) throw new JobError("invalid-job-data");
        // By the system clock, as the API stamped it: a ballot whose API gave
        // up on it is never judged late (T-10, T-25).
        if (key === "ballotSubmit" && Date.now() - job.timestamp > BALLOT_MAX_AGE_MS)
          throw new JobError("stale-job");
        try {
          // The data was parsed by this key's schema, so it is this key's.
          return await (handlers[key] as (c: typeof ctx, d: unknown) => Promise<unknown>)(
            ctx,
            data.data,
          );
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
        // The ballots handled at once are what a batch gathers (T-52).
        concurrency: key === "ballotSubmit" ? batch : 1,
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
  const schedules = (
    creating
      ? [
          {
            key: "pollCreate",
            id: "poll-create",
            every: options.pollCreation?.everyMs ?? POLL_CREATE_EVERY_MS,
          },
        ]
      : everyOtherSchedule(options)
  ) satisfies readonly { key: QueueKey; id: string; every: number }[];
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

/** Every schedule of a worker that doesn't hold the creation key: each takes no data. */
function everyOtherSchedule(options: WorkerOptions) {
  return [
    { key: "boardAudit", id: "board-audit", every: options.auditEveryMs },
    {
      key: "identityBackupPrune",
      id: "identity-backup-prune",
      every: options.pruneEveryMs ?? PRUNE_EVERY_MS,
    },
    ...(options.anchor === undefined
      ? []
      : ([{ key: "boardAnchor", id: "board-anchor", every: options.anchor.everyMs }] as const)),
    ...(options.tier0 === undefined
      ? []
      : ([
          {
            key: "tier0Index",
            id: "tier0-index",
            every: options.tier0.indexEveryMs ?? TIER0_INDEX_EVERY_MS,
          },
          {
            key: "tier0Boundary",
            id: "tier0-boundary",
            every: options.tier0.boundaryEveryMs ?? TIER0_BOUNDARY_EVERY_MS,
          },
        ] as const)),
    ...(options.registry === undefined
      ? []
      : ([
          {
            key: "registrySync",
            id: "registry-sync",
            every: options.registry.everyMs ?? REGISTRY_SYNC_EVERY_MS,
          },
        ] as const)),
    ...(options.pollRoots === undefined
      ? []
      : ([
          {
            key: "pollRoot",
            id: "poll-root",
            every: options.pollRoots.everyMs ?? POLL_ROOT_EVERY_MS,
          },
        ] as const)),
    ...(options.pollStubs === undefined
      ? []
      : ([
          {
            key: "pollStub",
            id: "poll-stub",
            every: options.pollStubs.everyMs ?? POLL_STUB_EVERY_MS,
          },
          {
            key: "ceremonyCoordinate",
            id: "ceremony-coordinate",
            every: options.pollStubs.coordinateEveryMs ?? CEREMONY_COORDINATE_EVERY_MS,
          },
          {
            key: "pollOpen",
            id: "poll-open",
            every: options.pollStubs.openEveryMs ?? POLL_OPEN_EVERY_MS,
          },
        ] as const)),
  ] as const satisfies readonly { key: QueueKey; id: string; every: number }[];
}
