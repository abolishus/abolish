// The API's side of the `{ballot-submit}` queue: it queues each ballot it
// receives and waits for the worker's outcome, so the API process verifies no
// proof (T-52). The job carries the election and the ballot's bytes and
// nothing else (T-10). Its ID is random, so the API can listen for the outcome
// before queuing the job, and like BullMQ's counter it says nothing about the
// data. A ballot whose outcome doesn't arrive in time is answered
// `unavailable`: it may still be boarded, and the same bytes submitted again
// return its entry.

import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import * as z from "zod";
import { JOB_OPTIONS, KEY_PREFIX, QUEUES } from "./queues.ts";

/**
 * What the worker returns for each ballot, the only thing about it that
 * reaches the queue's events stream: the board position it was boarded at,
 * or the refusal's code (core's SubmitError), never the ballot.
 */
export const BALLOT_OUTCOME = z.union([
  z.strictObject({ ok: z.literal(true), index: z.string().regex(/^(0|[1-9][0-9]{0,18})$/) }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(["unknown-election", "not-open", "rejected"]),
    admission: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
      .max(64)
      .optional(),
  }),
]);
export type BallotOutcome = z.output<typeof BALLOT_OUTCOME>;

/** The worker gave no outcome in time, or the queue couldn't take the ballot. */
export interface BallotUnavailable {
  readonly ok: false;
  readonly code: "unavailable";
}

const UNAVAILABLE: BallotUnavailable = { ok: false, code: "unavailable" };

/** About four events per job (added, waiting, active, completed). */
export const BALLOT_EVENTS_MAX_LEN = 1024;

/**
 * A job older than this is refused unjudged by the worker: its API has
 * answered it `unavailable` long ago (20 s by default), or was gone before it
 * could remove it, and a ballot shouldn't sit in Redis to be boarded much
 * later (T-10).
 */
export const BALLOT_MAX_AGE_MS = 60_000;

export interface BallotQueueOptions {
  /**
   * The queue's connection, which can fail fast; its events are read on a
   * connection of their own, with the same server and credentials.
   */
  readonly connection: Redis;
  /** The first segment of every key, as the worker's; tests give each run its own. */
  readonly prefix?: string;
  /** How long a ballot waits for its outcome; 20 s unless a test says otherwise, and below `BALLOT_MAX_AGE_MS`. */
  readonly timeoutMs?: number;
  /**
   * Ballots waiting for a worker past which a new one is answered
   * `unavailable` without being queued, so a flood or a stopped worker can't
   * grow Redis without bound (T-52). 4,096 unless a test says otherwise.
   */
  readonly maxWaiting?: number;
}

export class BallotQueue {
  readonly #queue: Queue;
  readonly #events: QueueEvents;
  readonly #eventsConnection: Redis;
  readonly #timeoutMs: number;
  readonly #maxWaiting: number;
  readonly #pending = new Map<string, (answer: BallotOutcome | BallotUnavailable) => void>();

  private constructor(
    queue: Queue,
    events: QueueEvents,
    eventsConnection: Redis,
    timeoutMs: number,
    maxWaiting: number,
  ) {
    this.#queue = queue;
    this.#events = events;
    this.#eventsConnection = eventsConnection;
    this.#timeoutMs = timeoutMs;
    this.#maxWaiting = maxWaiting;
    events.on("completed", ({ jobId, returnvalue }) => {
      const outcome = BALLOT_OUTCOME.safeParse(returnvalue);
      this.#settle(jobId, outcome.success ? outcome.data : UNAVAILABLE);
    });
    events.on("failed", ({ jobId }) => this.#settle(jobId, UNAVAILABLE));
  }

  /** Connects, and resolves once outcomes can be heard. */
  static async open(options: BallotQueueOptions): Promise<BallotQueue> {
    const { connection, prefix = KEY_PREFIX, timeoutMs = 20_000, maxWaiting = 4096 } = options;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs >= BALLOT_MAX_AGE_MS)
      throw new RangeError("timeoutMs must be at least 1 and below BALLOT_MAX_AGE_MS");
    if (!Number.isSafeInteger(maxWaiting) || maxWaiting < 1)
      throw new RangeError("maxWaiting must be at least 1");
    const name = QUEUES.ballotSubmit.name;
    // T-10: the events stream keeps each outcome's board index with a
    // millisecond time; kept short, it holds only the last few hundred jobs,
    // still far more than the outcomes this process hasn't read yet.
    const queue = new Queue(name, {
      connection,
      prefix,
      streams: { events: { maxLen: BALLOT_EVENTS_MAX_LEN } },
    });
    // Its reads block for seconds and must wait out a reconnect rather than
    // fail, whatever fail-fast options the queue's connection has.
    const { commandTimeout: _, ...base } = connection.options;
    const eventsConnection = new Redis({
      ...base,
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
    });
    const events = new QueueEvents(name, { connection: eventsConnection, prefix });
    // Unheard, BullMQ prints the error, which can quote a command's arguments.
    queue.on("error", () => {});
    events.on("error", () => {});
    try {
      await Promise.all([queue.waitUntilReady(), events.waitUntilReady()]);
    } catch (e) {
      await Promise.allSettled([queue.close(), events.close()]);
      eventsConnection.disconnect();
      throw e;
    }
    return new BallotQueue(queue, events, eventsConnection, timeoutMs, maxWaiting);
  }

  /**
   * Queues `ballot` for `electionId` and answers the worker's outcome, or
   * `unavailable`. Never throws for Redis's state: a client then retries,
   * or submits directly (T-25).
   */
  async submit(
    electionId: Uint8Array,
    ballot: Uint8Array,
  ): Promise<BallotOutcome | BallotUnavailable> {
    const data = QUEUES.ballotSubmit.data.parse({
      electionId: Buffer.from(electionId).toString("hex"),
      ballot: Buffer.from(ballot).toString("hex"),
    });
    const jobId = randomUUID();
    const answer = new Promise<BallotOutcome | BallotUnavailable>((resolve) => {
      const timer = setTimeout(() => this.#settle(jobId, UNAVAILABLE), this.#timeoutMs);
      this.#pending.set(jobId, (a) => {
        clearTimeout(timer);
        resolve(a);
      });
    });
    try {
      if ((await this.#queue.getWaitingCount()) >= this.#maxWaiting)
        this.#settle(jobId, UNAVAILABLE);
      else await this.#queue.add("ballotSubmit", data, { ...JOB_OPTIONS, jobId });
    } catch {
      this.#settle(jobId, UNAVAILABLE);
    }
    const outcome = await answer;
    // A ballot no worker took in time leaves the queue, if it's still
    // waiting; one being judged finishes, and a retry finds its entry.
    if (!outcome.ok && outcome.code === "unavailable")
      await this.#queue.remove(jobId).catch(() => 0);
    return outcome;
  }

  #settle(jobId: string, answer: BallotOutcome | BallotUnavailable) {
    const settle = this.#pending.get(jobId);
    if (settle === undefined) return;
    this.#pending.delete(jobId);
    settle(answer);
  }

  /** Answers every waiting ballot `unavailable` and disconnects. */
  async close(): Promise<void> {
    for (const jobId of this.#pending.keys()) this.#settle(jobId, UNAVAILABLE);
    const closed = await Promise.allSettled([this.#queue.close(), this.#events.close()]);
    // A connection passed in is the caller's to close; this one is ours.
    this.#eventsConnection.disconnect();
    for (const c of closed) if (c.status === "rejected") throw c.reason;
  }
}
