// The API's side of the `{ballot-submit}` queue: it queues each ballot it
// receives and waits for the worker's outcome, so the API process verifies no
// proof (T-52). The job carries the election and the ballot's bytes and
// nothing else (T-10). Its ID is random, so the API can listen for the outcome
// before queuing the job, and like BullMQ's counter it says nothing about the
// data. A ballot whose outcome doesn't arrive in time is answered
// `unavailable`: it may still be boarded, and the same bytes submitted again
// return its entry.
//
// The `{receipt-submit}` queue works the same way for share receipts
// (`ReceiptQueue`): the job carries the election and the receipt record's
// bytes, and the worker judges it by the board path's rules
// (docs/spec/delivery.md, Boarding), so the API checks no signature either.
// So does the `{opening-submit}` queue for tally openings (`OpeningQueue`),
// judged by the Boarding rule over the anchored counted set
// (docs/spec/tally.md, Opening record, Boarding), whose admission of the
// board's ballots the API never runs (T-52).

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

/**
 * What the worker returns for each share receipt: the board position of the
 * entry that carries it, or of the earlier receipt for its seat that stands
 * in for it (`earlier`), or the refusal's code (core's ReceiptError), never
 * the receipt.
 */
export const RECEIPT_OUTCOME = z.union([
  z.strictObject({
    ok: z.literal(true),
    index: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
    earlier: z.boolean(),
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(["unknown-election", "not-open", "rejected"]),
    rejection: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
      .max(64)
      .optional(),
  }),
]);
export type ReceiptOutcome = z.output<typeof RECEIPT_OUTCOME>;

/**
 * What the worker returns for each tally opening: the board position of the
 * entry that carries it, its own or, for a resend, the one boarded before,
 * or the refusal's code (core's OpeningError), never the opening.
 */
export const OPENING_OUTCOME = z.union([
  z.strictObject({ ok: z.literal(true), index: z.string().regex(/^(0|[1-9][0-9]{0,18})$/) }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(["unknown-election", "not-ready", "not-open", "rejected"]),
    rejection: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
      .max(64)
      .optional(),
  }),
]);
export type OpeningOutcome = z.output<typeof OPENING_OUTCOME>;

/** The worker gave no outcome in time, or the queue couldn't take the ballot. */
export interface BallotUnavailable {
  readonly ok: false;
  readonly code: "unavailable";
}

const UNAVAILABLE: BallotUnavailable = { ok: false, code: "unavailable" };

/** A share receipt's `BallotUnavailable`. */
export type ReceiptUnavailable = BallotUnavailable;

/** A tally opening's `BallotUnavailable`. */
export type OpeningUnavailable = BallotUnavailable;

/** About four events per job (added, waiting, active, completed). */
export const BALLOT_EVENTS_MAX_LEN = 1024;

/**
 * A job older than this is refused unjudged by the worker: its API has
 * answered it `unavailable` long ago (20 s by default), or was gone before it
 * could remove it, and a ballot, receipt or opening shouldn't sit in Redis to be
 * boarded much later (T-10).
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
  /** How long a ballot or receipt waits for its outcome; 20 s unless a test says otherwise, and below `BALLOT_MAX_AGE_MS`. */
  readonly timeoutMs?: number;
  /**
   * Jobs waiting for a worker past which a new one is answered
   * `unavailable` without being queued, so a flood or a stopped worker can't
   * grow Redis without bound (T-52). 4,096 unless a test says otherwise.
   */
  readonly maxWaiting?: number;
}

/** The queues the API submits to and hears an outcome from. */
type SubmitKey = "ballotSubmit" | "receiptSubmit" | "openingSubmit";

/**
 * One submitting queue: queues a job of `key`'s data and waits for the
 * worker's outcome, read through `outcome`'s schema, or `unavailable`.
 */
class SubmitQueue<Outcome> {
  readonly #key: SubmitKey;
  readonly #queue: Queue;
  readonly #events: QueueEvents;
  readonly #eventsConnection: Redis;
  readonly #timeoutMs: number;
  readonly #maxWaiting: number;
  readonly #pending = new Map<string, (answer: Outcome | BallotUnavailable) => void>();

  private constructor(
    key: SubmitKey,
    outcome: z.ZodType<Outcome>,
    queue: Queue,
    events: QueueEvents,
    eventsConnection: Redis,
    timeoutMs: number,
    maxWaiting: number,
  ) {
    this.#key = key;
    this.#queue = queue;
    this.#events = events;
    this.#eventsConnection = eventsConnection;
    this.#timeoutMs = timeoutMs;
    this.#maxWaiting = maxWaiting;
    events.on("completed", ({ jobId, returnvalue }) => {
      const parsed = outcome.safeParse(returnvalue);
      this.#settle(jobId, parsed.success ? parsed.data : UNAVAILABLE);
    });
    events.on("failed", ({ jobId }) => this.#settle(jobId, UNAVAILABLE));
  }

  /** Connects, and resolves once outcomes can be heard. */
  static async open<Outcome>(
    key: SubmitKey,
    outcome: z.ZodType<Outcome>,
    options: BallotQueueOptions,
  ): Promise<SubmitQueue<Outcome>> {
    const { connection, prefix = KEY_PREFIX, timeoutMs = 20_000, maxWaiting = 4096 } = options;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs >= BALLOT_MAX_AGE_MS)
      throw new RangeError("timeoutMs must be at least 1 and below BALLOT_MAX_AGE_MS");
    if (!Number.isSafeInteger(maxWaiting) || maxWaiting < 1)
      throw new RangeError("maxWaiting must be at least 1");
    const name = QUEUES[key].name;
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
    // Unheard, BullMQ prints the error, which can quote a command's arguments.
    queue.on("error", () => {});
    let events: QueueEvents | undefined;
    try {
      // BullMQ's events loop starts reading from `$` only after a round trip
      // of its own, so an outcome boarded before that first read would go
      // unheard and its client wait out `timeoutMs`. Reading from the
      // server's clock now, the stream IDs' clock, hears every outcome after
      // opening.
      const [seconds, micros] = await eventsConnection.time();
      const lastEventId = `${Number(seconds) * 1000 + Math.floor(Number(micros) / 1000)}-0`;
      events = new QueueEvents(name, { connection: eventsConnection, prefix, lastEventId });
      events.on("error", () => {});
      await Promise.all([queue.waitUntilReady(), events.waitUntilReady()]);
    } catch (e) {
      await Promise.allSettled([queue.close(), events?.close()]);
      eventsConnection.disconnect();
      throw e;
    }
    return new SubmitQueue(key, outcome, queue, events, eventsConnection, timeoutMs, maxWaiting);
  }

  /** Queues `data`, already parsed by the key's schema, and answers the outcome. */
  async submit(data: unknown): Promise<Outcome | BallotUnavailable> {
    const jobId = randomUUID();
    const answer = new Promise<Outcome | BallotUnavailable>((resolve) => {
      const timer = setTimeout(() => this.#settle(jobId, UNAVAILABLE), this.#timeoutMs);
      this.#pending.set(jobId, (a) => {
        clearTimeout(timer);
        resolve(a);
      });
    });
    try {
      if ((await this.#queue.getWaitingCount()) >= this.#maxWaiting)
        this.#settle(jobId, UNAVAILABLE);
      else await this.#queue.add(this.#key, data, { ...JOB_OPTIONS, jobId });
    } catch {
      this.#settle(jobId, UNAVAILABLE);
    }
    const outcome = await answer;
    // A job no worker took in time leaves the queue, if it's still waiting;
    // one being judged finishes, and a retry finds its entry.
    if (outcome === UNAVAILABLE) await this.#queue.remove(jobId).catch(() => 0);
    return outcome;
  }

  #settle(jobId: string, answer: Outcome | BallotUnavailable) {
    const settle = this.#pending.get(jobId);
    if (settle === undefined) return;
    this.#pending.delete(jobId);
    settle(answer);
  }

  /** Answers every waiting job `unavailable` and disconnects. */
  async close(): Promise<void> {
    for (const jobId of this.#pending.keys()) this.#settle(jobId, UNAVAILABLE);
    const closed = await Promise.allSettled([this.#queue.close(), this.#events.close()]);
    // A connection passed in is the caller's to close; this one is ours.
    this.#eventsConnection.disconnect();
    for (const c of closed) if (c.status === "rejected") throw c.reason;
  }
}

export class BallotQueue {
  readonly #queue: SubmitQueue<BallotOutcome>;

  private constructor(queue: SubmitQueue<BallotOutcome>) {
    this.#queue = queue;
  }

  /** Connects, and resolves once outcomes can be heard. */
  static async open(options: BallotQueueOptions): Promise<BallotQueue> {
    return new BallotQueue(await SubmitQueue.open("ballotSubmit", BALLOT_OUTCOME, options));
  }

  /**
   * Queues `ballot` for `electionId` and answers the worker's outcome, or
   * `unavailable`. Never throws for Redis's state: a client then retries,
   * or submits directly (T-25).
   */
  submit(electionId: Uint8Array, ballot: Uint8Array): Promise<BallotOutcome | BallotUnavailable> {
    return this.#queue.submit(
      QUEUES.ballotSubmit.data.parse({
        electionId: Buffer.from(electionId).toString("hex"),
        ballot: Buffer.from(ballot).toString("hex"),
      }),
    );
  }

  /** Answers every waiting ballot `unavailable` and disconnects. */
  close(): Promise<void> {
    return this.#queue.close();
  }
}

export class ReceiptQueue {
  readonly #queue: SubmitQueue<ReceiptOutcome>;

  private constructor(queue: SubmitQueue<ReceiptOutcome>) {
    this.#queue = queue;
  }

  /** Connects, and resolves once outcomes can be heard. */
  static async open(options: BallotQueueOptions): Promise<ReceiptQueue> {
    return new ReceiptQueue(await SubmitQueue.open("receiptSubmit", RECEIPT_OUTCOME, options));
  }

  /**
   * Queues `record`, a share receipt record's bytes, for `electionId` and
   * answers the worker's outcome, or `unavailable`. Never throws for
   * Redis's state: the sender then retries, or uses the contract path (T-25).
   */
  submit(electionId: Uint8Array, record: Uint8Array): Promise<ReceiptOutcome | ReceiptUnavailable> {
    return this.#queue.submit(
      QUEUES.receiptSubmit.data.parse({
        electionId: Buffer.from(electionId).toString("hex"),
        record: Buffer.from(record).toString("hex"),
      }),
    );
  }

  /** Answers every waiting receipt `unavailable` and disconnects. */
  close(): Promise<void> {
    return this.#queue.close();
  }
}

export class OpeningQueue {
  readonly #queue: SubmitQueue<OpeningOutcome>;

  private constructor(queue: SubmitQueue<OpeningOutcome>) {
    this.#queue = queue;
  }

  /** Connects, and resolves once outcomes can be heard. */
  static async open(options: BallotQueueOptions): Promise<OpeningQueue> {
    return new OpeningQueue(await SubmitQueue.open("openingSubmit", OPENING_OUTCOME, options));
  }

  /**
   * Queues `opening`, a tally opening record's bytes, for `electionId` and
   * answers the worker's outcome, or `unavailable`. Never throws for
   * Redis's state: the seat's node sends it again until the seal.
   */
  submit(
    electionId: Uint8Array,
    opening: Uint8Array,
  ): Promise<OpeningOutcome | OpeningUnavailable> {
    return this.#queue.submit(
      QUEUES.openingSubmit.data.parse({
        electionId: Buffer.from(electionId).toString("hex"),
        opening: Buffer.from(opening).toString("hex"),
      }),
    );
  }

  /** Answers every waiting opening `unavailable` and disconnects. */
  close(): Promise<void> {
    return this.#queue.close();
  }
}
