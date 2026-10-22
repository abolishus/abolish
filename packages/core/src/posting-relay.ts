// The posting relay's route and queue (docs/spec/posting-relay.md, Request,
// Answers and Queue; ADR 0042, option A). A request is checked in the spec's
// order, cheapest first: the fields' forms and the calldata's size, the
// records' own checks (the verifier's `postingForm`), the election by our
// index of the registry and the relay's clock, then the public check of the
// posting against the election's registered key set (the verifier's posting
// judge), so with the worker's simulation, which checks the ballot's
// membership proof, the relay pays only for postings that deliver (T-52).
// Then one
// Redis script queues the pair, and the route waits for the posting
// worker's outcome, which holds the posting key and sends.
//
// T-10, T-11, T-13, T-18: nothing here sees a header, cookie or address.
// The queue is one hash from the posting's keccak256 to the pair, with no
// arrival time, order, request identifier or count per pair, and an outcome
// is one expiring key per posting. No answer depends on whether the ballot
// was cast, receipted or posted before, except a repeat of the same bytes,
// whose sender already holds them.

import { deliveryDeadlines } from "@abolishus/crypto";
import {
  PINNED_FORCED_INCLUSION,
  type PostingAdmissionCode,
  postingForm,
  type PostingFormCode,
} from "@abolishus/verifier";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Sql } from "postgres";
import { type BallotAdmissions, SubmitError } from "./admission.ts";
import { registeredElection } from "./registrations.ts";

/** The most bytes of `submitPosting` calldata the relay sends: a deposit's data cap on the portal (docs/spec/posting-relay.md, Values). */
export const POSTING_MAX_DATA = 120_000;
/** The most pairs queued at once, across every election. */
export const POSTING_QUEUE_MAX = 64;
/** Seconds the route waits for the worker's outcome before it answers busy. */
export const POSTING_WAIT = 20;
/** Seconds before `c_D` after which the relay sends nothing new on L2. */
export const POSTING_SEND_MARGIN = 6_600n;
/** Seconds the relay's index may lag before the route answers unavailable (step 4). */
export const POSTING_INDEX_MAX_LAG = 60;
/**
 * Seconds an index time may run ahead of this server's clock, for skew
 * between the worker's host and ours; beyond it the time is refused, so a
 * fast clock there can't keep a stale index current here.
 */
export const POSTING_INDEX_MAX_SKEW = 5;
/**
 * Most posting requests handled at once by one server. Each may hold its
 * server slot for `POSTING_WAIT` while the worker sends, so past this the
 * route answers busy rather than take more of the server's slots from
 * ballots and the board (T-52); the client sends the same bytes again.
 */
export const POSTING_MAX_CONCURRENT = 8;
/** How often the route looks for the worker's outcome while it waits, in milliseconds. */
export const POSTING_POLL_MS = 250;

const U64_MAX = (1n << 64n) - 1n;

/**
 * `submitPosting(bytes, bytes)`'s calldata length for records of `p` and `b`
 * bytes: the selector, two offsets, and each record's length word and bytes
 * padded to whole words (docs/spec/posting-relay.md, Answers, step 2).
 */
export function postingCalldataLength(p: number, b: number): number {
  for (const n of [p, b])
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("lengths must be integers ≥ 0");
  return 132 + Math.ceil(p / 32) * 32 + Math.ceil(b / 32) * 32;
}

/** Redis's `EVAL`, as ioredis (and any client of Redis or Dragonfly) offers it. */
export interface PostingRedis {
  eval(script: string, numkeys: number, ...args: string[]): Promise<unknown>;
}

/**
 * The relay's keys, under one hash tag so a script can touch them all in
 * one step on Dragonfly or Redis Cluster:
 *
 * - `queue`: a hash from each queued posting's `postingKey` to the pair as
 *   `postingPairValue` writes it;
 * - `index`: when the worker last read the L2 node's latest block, and that
 *   block's timestamp, as `postingIndexValue` writes them;
 * - `outcome(key)`: the worker's outcome for a posting, as
 *   `postingOutcomeValue` writes it, expiring after `POSTING_WAIT`.
 *
 * The posting worker keeps `index` and the outcomes and takes pairs out of
 * `queue`; the route only reads `index` and the outcomes and adds to
 * `queue`. The store must not evict, persist, snapshot or back up any of
 * them, which hold `m_i` for pairs that may be refused (docs/spec/
 * posting-relay.md, Queue; T-18).
 */
export function postingKeys(prefix = "abolish") {
  // A brace in the prefix would change the hash tag, scattering the keys
  // over slots that one script can't span.
  if (prefix === "" || /[{}]/.test(prefix)) throw new RangeError("invalid key prefix");
  const at = (name: string) => `${prefix}:{posting-relay}:${name}`;
  return {
    queue: at("queue"),
    index: at("index"),
    outcome: (key: string) => {
      if (!KEY.test(key)) throw new RangeError("not a posting key");
      return at(`outcome:${key}`);
    },
  } as const;
}

export type PostingKeys = ReturnType<typeof postingKeys>;

const KEY = /^[0-9a-f]{64}$/;

/** A posting's key in the queue and its outcome's: its keccak256, as 64 lowercase hex digits. */
export function postingKey(posting: Uint8Array): string {
  return bytesToHex(keccak_256(posting));
}

/** A queued pair's value: the posting and the ballot as lowercase hex, space-separated. */
export function postingPairValue(posting: Uint8Array, ballot: Uint8Array): string {
  return `${bytesToHex(posting)} ${bytesToHex(ballot)}`;
}

const PAIR = /^((?:[0-9a-f]{2})+) ((?:[0-9a-f]{2})+)$/;

/** Reads a queued pair, or `undefined` for anything `postingPairValue` wouldn't write. */
export function parsePostingPair(
  value: unknown,
): { readonly posting: Uint8Array; readonly ballot: Uint8Array } | undefined {
  if (typeof value !== "string") return undefined;
  const m = PAIR.exec(value);
  if (m === null) return undefined;
  const [, posting, ballot] = m as unknown as [string, string, string];
  return { posting: fromHex(posting), ballot: fromHex(ballot) };
}

/** What the relay's index says: when the worker read the L2 node's latest block, and that block's timestamp. */
export interface PostingIndex {
  /** UNIX time in seconds. */
  readonly at: number;
  /** The latest L2 block's timestamp, UNIX seconds. */
  readonly l2Time: bigint;
}

// At most 15 digits of time, as the registration relays' index times.
const MAX_INDEX_TIME = 10 ** 15 - 1;
const INDEX = /^(0|[1-9][0-9]{0,14}) (0|[1-9][0-9]{0,19})$/;

/** The `index` key's value: `at` and `l2Time` in canonical decimal, space-separated. */
export function postingIndexValue(index: PostingIndex): string {
  const { at, l2Time } = index;
  if (!Number.isSafeInteger(at) || at < 0 || at > MAX_INDEX_TIME)
    throw new RangeError("at must be a UNIX time");
  if (typeof l2Time !== "bigint" || l2Time < 0n || l2Time > U64_MAX)
    throw new RangeError("l2Time must be a u64");
  return `${at} ${l2Time}`;
}

/** Reads an `index` value, or `undefined` for anything `postingIndexValue` wouldn't write. */
export function parsePostingIndex(value: unknown): PostingIndex | undefined {
  if (typeof value !== "string") return undefined;
  const m = INDEX.exec(value);
  if (m === null) return undefined;
  const [, at, l2Time] = m as unknown as [string, string, string];
  const index = { at: Number(at), l2Time: BigInt(l2Time) };
  return index.l2Time > U64_MAX ? undefined : index;
}

/**
 * The worker's refusals (docs/spec/posting-relay.md, Sending): a pair that
 * doesn't decode again (`malformed`), the send cutoff by the L2's latest
 * block (`too-late`), a simulation that reverts (`simulation`) or keeps
 * failing (`unavailable`), a gas limit over `POSTING_GAS_LIMIT_MAX`
 * (`too-costly`), and the caps (`ballot-cap`, `budget`).
 */
export const POSTING_WORKER_REFUSALS = [
  "malformed",
  "too-late",
  "simulation",
  "unavailable",
  "too-costly",
  "ballot-cap",
  "budget",
] as const;

export type PostingWorkerRefusal = (typeof POSTING_WORKER_REFUSALS)[number];

/** The worker's outcome for a posting: sent, with the last transaction that carried it, or refused. */
export type PostingOutcome =
  | {
      readonly sent: true;
      /** The transaction's hash: an L2 call, or once forced, the L1 deposit. */
      readonly transaction: Uint8Array;
      readonly layer: "l2" | "l1";
    }
  | { readonly sent: false; readonly code: PostingWorkerRefusal };

const SENT = /^sent (l1|l2) ([0-9a-f]{64})$/;
const REFUSED = /^refused ([a-z-]+)$/;

/** An outcome key's value: `sent <layer> <hash>` or `refused <code>`. */
export function postingOutcomeValue(outcome: PostingOutcome): string {
  if (outcome.sent) {
    if (!(outcome.transaction instanceof Uint8Array) || outcome.transaction.length !== 32)
      throw new RangeError("transaction must be 32 bytes");
    if (outcome.layer !== "l1" && outcome.layer !== "l2") throw new RangeError("unknown layer");
    return `sent ${outcome.layer} ${bytesToHex(outcome.transaction)}`;
  }
  if (!(POSTING_WORKER_REFUSALS as readonly string[]).includes(outcome.code))
    throw new RangeError("unknown refusal");
  return `refused ${outcome.code}`;
}

/** Reads an outcome, or `undefined` for anything `postingOutcomeValue` wouldn't write. */
export function parsePostingOutcome(value: unknown): PostingOutcome | undefined {
  if (typeof value !== "string") return undefined;
  const sent = SENT.exec(value);
  if (sent !== null) {
    const [, layer, hash] = sent as unknown as [string, "l1" | "l2", string];
    return { sent: true, transaction: fromHex(hash), layer };
  }
  const refused = REFUSED.exec(value);
  const code = refused?.[1];
  if (code === undefined || !(POSTING_WORKER_REFUSALS as readonly string[]).includes(code))
    return undefined;
  return { sent: false, code: code as PostingWorkerRefusal };
}

const READ = `return redis.call('GET', KEYS[1]) or ''`;

// Step 6, atomically: a posting with an outcome gets it; otherwise a full
// queue answers busy, before anything about the pair; otherwise the pair is
// queued, unless the same posting already is, which changes nothing.
const ENQUEUE = `
local outcome = redis.call('GET', KEYS[2])
if outcome then return outcome end
if redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2])
return 1
`;

/** A request's fields after the contract's form checks: strings only. */
export interface PostingRequestInput {
  /** The share posting record (`0x000d`) with its header, as lowercase hex. */
  readonly posting: string;
  /** The ballot record (`0x0002`) it delivers, with its header, as lowercase hex. */
  readonly ballot: string;
}

export type PostingRelayErrorCode =
  /** A field isn't in its form, or the calldata would exceed `POSTING_MAX_DATA` (step 2). */
  | "form"
  /** The records fail a check they can be judged on alone (step 3). */
  | "malformed"
  /** The posting's definition isn't registered, by our index, as an election this server judges (step 4). */
  | "unknown-election"
  /** The relay's latest L2 block is past `c_D − POSTING_SEND_MARGIN` (step 4). */
  | "too-late"
  /** The relay's index lags, or Redis can't be read (step 4). */
  | "unavailable"
  /** The public check failed (step 5), or the worker refused the pair (step 7). */
  | "refused"
  /** The queue is full, the server at its limit, or the worker hasn't answered yet (steps 6 and 7). */
  | "busy";

/** Under `refused`: the public check's code, or the worker's refusal. */
export type PostingRefusal = Exclude<PostingAdmissionCode, PostingFormCode> | PostingWorkerRefusal;

export class PostingRelayError extends Error {
  override readonly name = "PostingRelayError";
  readonly code: PostingRelayErrorCode;
  /** Under `malformed`: which check of the records failed. */
  readonly malformed?: PostingFormCode;
  /** Under `refused`: why. */
  readonly refusal?: PostingRefusal;
  constructor(code: "malformed", detail: PostingFormCode);
  constructor(code: "refused", detail: PostingRefusal);
  constructor(code: Exclude<PostingRelayErrorCode, "malformed" | "refused">);
  constructor(code: PostingRelayErrorCode, detail?: PostingFormCode | PostingRefusal) {
    // The message never quotes the request (T-11).
    super(`posting refused: ${code}${detail === undefined ? "" : ` (${detail})`}`);
    this.code = code;
    if (code === "malformed") this.malformed = detail as PostingFormCode;
    if (code === "refused") this.refusal = detail as PostingRefusal;
  }
}

/** A `sent` answer: the last transaction that carried the posting, as the worker reported it. */
export interface PostingSent {
  readonly transaction: Uint8Array;
  readonly layer: "l2" | "l1";
}

export interface PostingRelayOptions {
  readonly sql: Sql;
  readonly redis: PostingRedis;
  /** Ballot admission under the panels this release pins, whose cache the judge shares. */
  readonly admissions: Pick<BallotAdmissions, "postings">;
  /** UNIX time in seconds. */
  readonly now: () => number;
  /** The release's `F`, for `c_D = t_D − F`; the verifier's pinned value by default. */
  readonly forcedInclusion?: bigint;
  /** How long the route waits for the worker's outcome, in milliseconds; `POSTING_WAIT` by default. */
  readonly waitMs?: number;
  /** Resolves after `ms` milliseconds; tests make it immediate. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** The first segment of every key; tests give each run its own. */
  readonly prefix?: string;
}

/** The route's service: checks a request in the spec's order, queues its pair and waits for the outcome. */
export class PostingRelay {
  readonly #sql: Sql;
  readonly #redis: PostingRedis;
  readonly #admissions: Pick<BallotAdmissions, "postings">;
  readonly #now: () => number;
  readonly #forcedInclusion: bigint;
  readonly #waitMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #keys: PostingKeys;
  #active = 0;

  constructor(options: PostingRelayOptions) {
    const {
      forcedInclusion = PINNED_FORCED_INCLUSION,
      waitMs = POSTING_WAIT * 1000,
      sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    } = options;
    if (typeof forcedInclusion !== "bigint" || forcedInclusion < 0n)
      throw new RangeError("forcedInclusion must be a bigint ≥ 0");
    if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new RangeError("waitMs must be ≥ 0");
    this.#sql = options.sql;
    this.#redis = options.redis;
    this.#admissions = options.admissions;
    this.#now = options.now;
    this.#forcedInclusion = forcedInclusion;
    this.#waitMs = waitMs;
    this.#sleep = sleep;
    this.#keys = postingKeys(options.prefix);
  }

  /**
   * Steps 2 to 7 (step 1, the transport's, is the server's). Resolves with
   * the worker's `sent` outcome; throws `PostingRelayError` for the first
   * failed step, a refusal or busy. Every answer is a hint: the client
   * stands down only on the board's event (docs/spec/posting-relay.md,
   * Outcome).
   */
  async relay(input: PostingRequestInput): Promise<PostingSent> {
    const { posting, ballot, definitionHash } = checkPostingRequest(input);
    if (this.#active >= POSTING_MAX_CONCURRENT) throw new PostingRelayError("busy");
    this.#active++;
    try {
      return await this.#relay(posting, ballot, definitionHash);
    } finally {
      this.#active--;
    }
  }

  async #relay(posting: Uint8Array, ballot: Uint8Array, definitionHash: Uint8Array) {
    // Step 4: registered by our index of the registry, and judged under a
    // pinned panel with its transcript; an election this server can't
    // establish a registered key set for is one it doesn't know.
    const electionId = await registeredElection(this.#sql, definitionHash);
    if (electionId === undefined) throw new PostingRelayError("unknown-election");
    let election;
    try {
      election = await this.#admissions.postings(this.#sql, electionId);
    } catch (e) {
      if (e instanceof SubmitError) throw new PostingRelayError("unknown-election");
      throw e;
    }
    if (election === undefined) throw new PostingRelayError("unknown-election");
    // An index never brought up, not within the last minute, or dated ahead
    // of our clock can't say where the L2 is.
    const index = parsePostingIndex(await this.#eval(READ, 1, this.#keys.index));
    const now = this.#now();
    if (
      index === undefined ||
      now - index.at > POSTING_INDEX_MAX_LAG ||
      index.at - now > POSTING_INDEX_MAX_SKEW
    )
      throw new PostingRelayError("unavailable");
    const cD =
      deliveryDeadlines(election.closesAt, election.l1InclusionBound).delivery -
      this.#forcedInclusion;
    if (index.l2Time > cD - POSTING_SEND_MARGIN) throw new PostingRelayError("too-late");
    // Step 5: a pair that fails takes no queue place. One that passes needs
    // only a ballot record whose share hashes its maker chose, not a
    // member's: the membership proof is checked by the worker's simulation
    // alone, before any gas is spent.
    const checked = election.posting(posting, ballot);
    if (!checked.ok) {
      // `postingForm` passed and the election is the posting's definition's,
      // so only the election's own checks can fail here.
      throw new PostingRelayError("refused", checked.code as PostingRefusal);
    }
    const key = postingKey(posting);
    const outcomeKey = this.#keys.outcome(key);
    const queued = await this.#eval(
      ENQUEUE,
      2,
      this.#keys.queue,
      outcomeKey,
      key,
      postingPairValue(posting, ballot),
      String(POSTING_QUEUE_MAX),
    );
    if (queued === 0) throw new PostingRelayError("busy");
    if (queued !== 1) return answer(queued);
    // Step 7: the worker drains the queue on its own tick, so the route
    // looks for the outcome until `POSTING_WAIT` has passed.
    const deadline = performance.now() + this.#waitMs;
    for (;;) {
      await this.#sleep(Math.min(POSTING_POLL_MS, Math.max(0, deadline - performance.now())));
      const outcome = await this.#eval(READ, 1, outcomeKey);
      if (outcome !== "") return answer(outcome);
      if (performance.now() >= deadline) throw new PostingRelayError("busy");
    }
  }

  /**
   * One script. A Redis failure answers unavailable, and the client sends
   * the same bytes again. The error itself is dropped, since its message can
   * quote the script's arguments (T-11, T-18).
   */
  async #eval(script: string, numkeys: number, ...keysThenArgs: string[]): Promise<unknown> {
    try {
      return await this.#redis.eval(script, numkeys, ...keysThenArgs);
    } catch {
      throw new PostingRelayError("unavailable");
    }
  }
}

/** The worker's outcome as the answer: `sent`, or its refusal. Anything else is the store's fault. */
function answer(value: unknown): PostingSent {
  const outcome = parsePostingOutcome(value);
  if (outcome === undefined) throw new PostingRelayError("unavailable");
  if (!outcome.sent) throw new PostingRelayError("refused", outcome.code);
  return { transaction: outcome.transaction, layer: outcome.layer };
}

const HEX = /^(?:[0-9a-f]{2})+$/;

/**
 * Step 2: both fields lowercase hex of whole bytes, and `submitPosting`'s
 * calldata for the pair within `POSTING_MAX_DATA`, which keeps every
 * posting the relay sends within a deposit's cap, so it can be forced.
 */
export function parsePostingRequest(input: PostingRequestInput): {
  readonly posting: Uint8Array;
  readonly ballot: Uint8Array;
} {
  const { posting, ballot } = input;
  if (typeof posting !== "string" || typeof ballot !== "string")
    throw new PostingRelayError("form");
  // Bounded before the patterns run over them.
  if (posting.length + ballot.length > 2 * POSTING_MAX_DATA) throw new PostingRelayError("form");
  if (!HEX.test(posting) || !HEX.test(ballot)) throw new PostingRelayError("form");
  if (postingCalldataLength(posting.length / 2, ballot.length / 2) > POSTING_MAX_DATA)
    throw new PostingRelayError("form");
  return { posting: fromHex(posting), ballot: fromHex(ballot) };
}

/**
 * Steps 2 and 3, which need nothing but the request: the fields' forms and
 * the calldata's bound, then the records' own checks (the verifier's
 * `postingForm`). Throws `PostingRelayError` (`form` or `malformed`).
 */
export function checkPostingRequest(input: PostingRequestInput): {
  readonly posting: Uint8Array;
  readonly ballot: Uint8Array;
  readonly definitionHash: Uint8Array;
} {
  const { posting, ballot } = parsePostingRequest(input);
  const form = postingForm(posting, ballot);
  if (!form.ok) throw new PostingRelayError("malformed", form.code);
  return { posting, ballot, definitionHash: form.definitionHash };
}

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}
