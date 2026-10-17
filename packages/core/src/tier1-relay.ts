// The Tier 1 relay's route and queue (docs/spec/tier1-relay.md, Request,
// Answers and Queue). A request is checked in the spec's order, cheapest
// first, so a malformed or unserviceable record never spends the vouchee's
// Turnstile token; then one Redis script queues the record. The relay job
// judges what is queued at each boundary against its counting state and
// sends what counts (tier1-batch.ts).
//
// T-10, T-11, T-13: nothing here sees a header, cookie or address, and the
// queue keeps each record's bytes under their hash and nothing else: no
// arrival time, order, token, request identifier or count per record. No
// answer depends on the commitment's state, so the route can't say whether
// a commitment is a member, its slots spent or its record already queued.

import { createHash } from "node:crypto";
import {
  checkTier1AdditionForm,
  VOUCH_K,
  VOUCH_LENGTH,
  VOUCH_ROOT_INTERVAL,
  VOUCH_ROOT_WINDOW,
  type Tier1Addition,
} from "@abolishus/crypto";
import type { Turnstile } from "./turnstile.ts";

/** The most records queued at once, across every group (docs/spec/tier1-relay.md, Values). */
export const TIER1_RELAY_QUEUE_MAX = 64;
/**
 * L2 blocks a record must still have in every vouch's root window, past the
 * relay's latest block, to be queued (docs/spec/tier1-relay.md, Values).
 */
export const TIER1_RELAY_MARGIN = 1_800n;
/** The Turnstile action a relay request's token must be solved for. */
export const TURNSTILE_ACTION_TIER1 = "tier1-relay";
/** Seconds the relay's index may lag before the route answers unavailable (step 5). */
export const TIER1_INDEX_MAX_LAG = 60;
/**
 * Seconds an index time may run ahead of this server's clock, for skew
 * between the relay job's host and ours; beyond it the time is refused, so a
 * fast clock there can't keep a stale index current here.
 */
export const TIER1_INDEX_MAX_SKEW = 5;
/**
 * Most relay requests handled at once by one server. A request holds its
 * slot through a Redis round trip and Turnstile's (up to 5 s), and anyone can
 * send well-formed records with made-up tokens, so past this the route
 * answers unavailable rather than take more of the server's slots from
 * ballots and the board (T-52, T-25).
 */
export const TIER1_MAX_CONCURRENT = 8;
/** A record's length in hex digits: `41 + 626 · VOUCH_K` bytes. */
export const TIER1_RECORD_HEX = 2 * (41 + VOUCH_LENGTH * VOUCH_K);

const U64_MAX = (1n << 64n) - 1n;

/** Redis's `EVAL`, as ioredis (and any client of Redis or Dragonfly) offers it. */
export interface Tier1Redis {
  eval(script: string, numkeys: number, ...args: string[]): Promise<unknown>;
}

/**
 * The relay's keys, under one hash tag so a script can touch them all in
 * one step on Dragonfly or Redis Cluster:
 *
 * - `queue`: a hash from each queued record's `recordKey` to the record as
 *   lowercase hex, so two records for one commitment are two entries (T-25);
 * - `index`: the relay's index as `tier1IndexValue` writes it, the UNIX time
 *   it was last brought up to the L2 node's latest block with that block
 *   and the safe head, set in one write so the three always agree;
 * - `inflight`: a hash from each sent record's `recordKey` to the record,
 *   its nonce and the transactions signed for it, until it is final or can
 *   never land (docs/spec/tier1-relay.md, Queue);
 * - `boundary`: the number of the last period whose boundary ran;
 * - `lock`: the job's lock, which every write of the job checks.
 *
 * The relay job (`Tier1Batches`) keeps `index`, `inflight`, `boundary` and
 * `lock` and takes records out of `queue`; the route only reads `index` and
 * adds to `queue`.
 */
export function tier1Keys(prefix = "abolish") {
  // A brace in the prefix would change the hash tag, scattering the keys
  // over slots that one script can't span.
  if (prefix === "" || /[{}]/.test(prefix)) throw new RangeError("invalid key prefix");
  const at = (name: string) => `${prefix}:{tier1-relay}:${name}`;
  return {
    queue: at("queue"),
    index: at("index"),
    inflight: at("inflight"),
    boundary: at("boundary"),
    lock: at("lock"),
  } as const;
}

export type Tier1Keys = ReturnType<typeof tier1Keys>;

/** A record's key in the queue: the SHA-256 of its bytes, as 64 lowercase hex digits. */
export function recordKey(record: Uint8Array): string {
  return createHash("sha256").update(record).digest("hex");
}

/** What the relay's index says: when it was brought up, its latest block `b` and the safe head `s`. */
export interface Tier1Index {
  /** UNIX time in seconds. */
  readonly at: number;
  readonly latest: bigint;
  readonly safe: bigint;
}

// At most 15 digits of time, as Tier 0's index time.
const MAX_INDEX_TIME = 10 ** 15 - 1;
const INDEX = /^(0|[1-9][0-9]{0,14}) (0|[1-9][0-9]{0,19}) (0|[1-9][0-9]{0,19})$/;

/** The `index` key's value: `at`, `b` and `s` in canonical decimal, space-separated. */
export function tier1IndexValue(index: Tier1Index): string {
  const { at, latest, safe } = index;
  if (!Number.isSafeInteger(at) || at < 0 || at > MAX_INDEX_TIME)
    throw new RangeError("at must be a UNIX time");
  if (typeof latest !== "bigint" || latest < 0n || latest > U64_MAX)
    throw new RangeError("latest must be a u64");
  if (typeof safe !== "bigint" || safe < 0n || safe > latest)
    throw new RangeError("safe must be a u64 at or below latest");
  return `${at} ${latest} ${safe}`;
}

/** Reads an `index` value, or `undefined` for anything `tier1IndexValue` wouldn't write. */
export function parseTier1Index(value: unknown): Tier1Index | undefined {
  if (typeof value !== "string") return undefined;
  const m = INDEX.exec(value);
  if (m === null) return undefined;
  const [, at, latest, safe] = m as unknown as [string, string, string, string];
  const index = { at: Number(at), latest: BigInt(latest), safe: BigInt(safe) };
  if (index.latest > U64_MAX || index.safe > index.latest) return undefined;
  return index;
}

const READ_INDEX = `return redis.call('GET', KEYS[1]) or ''`;

// Step 8, atomically. The bound is checked before anything about the
// record, so a full queue answers busy whatever is sent, and only here,
// after the solve, so watching the queue fill costs a solve per look
// (docs/spec/tier1-relay.md, Busy only after the solve). A record already
// queued is accepted and changes nothing.
const ENQUEUE = `
if redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2])
return 1
`;

/** A request's fields after the contract's form checks: strings only. */
export interface Tier1RequestInput {
  /** The Tier 1 addition record: `TIER1_RECORD_HEX` lowercase hex digits. */
  readonly record: string;
  /** The challenge page's Turnstile token. */
  readonly turnstile: string;
}

/** A request whose record passed step 3. */
export interface Tier1Request {
  /** As sent: lowercase hex. */
  readonly hex: string;
  readonly record: Uint8Array;
  readonly addition: Tier1Addition;
  readonly turnstile: string;
}

export type Tier1RelayErrorCode =
  /** A field isn't in its form (step 2); the contract refuses these first. */
  | "form"
  /** The record fails a check it can be judged on alone (step 3). */
  | "malformed"
  /** The record's group isn't a published Tier 1 group (step 4). */
  | "group-unknown"
  /** The relay's index lags, or the service is at its limit or isn't configured (step 5). */
  | "unavailable"
  /** A vouch's root is past the safe head, or too little of its window is left (step 6). */
  | "vouch-window"
  /** Turnstile refused the token (step 7). */
  | "challenge-refused"
  /** Turnstile couldn't say (step 7). */
  | "challenge-unavailable"
  /** The queue is full (step 8). */
  | "busy";

/** Under `malformed`: which check of the record failed (docs/spec/vouching.md, Checks of one addition). */
export type Tier1MalformedCode =
  | "decode"
  | "forbidden-commitment"
  | "slot"
  | "root"
  | "duplicate-voucher"
  | "duplicate-slot"
  | "root-grid";

export class Tier1RelayError extends Error {
  override readonly name = "Tier1RelayError";
  readonly code: Tier1RelayErrorCode;
  readonly malformed?: Tier1MalformedCode;
  /** Under `malformed`: the failing vouch's position, for a check of one vouch. */
  readonly vouch?: number;
  constructor(code: Tier1RelayErrorCode, malformed?: Tier1MalformedCode, vouch?: number) {
    // The message never quotes the request (T-11).
    super(
      `relay refused: ${code}${malformed === undefined ? "" : ` (${malformed}${vouch === undefined ? "" : ` at vouch ${vouch}`})`}`,
    );
    this.code = code;
    if (malformed !== undefined) this.malformed = malformed;
    if (vouch !== undefined) this.vouch = vouch;
  }
}

const RECORD = new RegExp(`^[0-9a-f]{${TIER1_RECORD_HEX}}$`);
// docs/spec/registration.md, Request: 1 to 2,048 characters from 0x21 to 0x7e.
const TOKEN = /^[\x21-\x7e]{1,2048}$/;

/**
 * Steps 2 and 3: the fields' forms, then checks 1 to 6 of
 * docs/spec/vouching.md (Checks of one addition) and every vouch's
 * `root_block` on the root grid. Each needs the record alone, and none
 * verifies a proof (T-52): whether the record counts is the job's.
 */
export function parseTier1Request(input: Tier1RequestInput): Tier1Request {
  if (!RECORD.test(input.record) || !TOKEN.test(input.turnstile)) throw new Tier1RelayError("form");
  const record = new Uint8Array(Buffer.from(input.record, "hex"));
  const checked = checkTier1AdditionForm(record);
  if (!checked.ok)
    throw new Tier1RelayError(
      "malformed",
      checked.error,
      "vouch" in checked ? checked.vouch : undefined,
    );
  for (const [i, v] of checked.value.vouches.entries())
    if (v.rootBlock % VOUCH_ROOT_INTERVAL !== 0n)
      throw new Tier1RelayError("malformed", "root-grid", i);
  return { hex: input.record, record, addition: checked.value, turnstile: input.turnstile };
}

export interface Tier1RelayOptions {
  readonly redis: Tier1Redis;
  /**
   * The published groups: each region code the relay serves and its one
   * Tier 1 group's `group_id`, as the deployment record lists them
   * (docs/spec/tier1-relay.md, Groups).
   */
  readonly groups: ReadonlyMap<number, bigint>;
  /** Checks tokens for the challenge origin's host. */
  readonly turnstile: Turnstile;
  /** UNIX time in seconds. */
  readonly now: () => number;
  /** The first segment of every key; tests give each run its own. */
  readonly prefix?: string;
}

/** The route's service: checks a request in the spec's order and queues its record. */
export class Tier1Relay {
  readonly #redis: Tier1Redis;
  readonly #groups: ReadonlySet<bigint>;
  readonly #turnstile: Turnstile;
  readonly #now: () => number;
  readonly #keys: Tier1Keys;
  #active = 0;

  constructor(options: Tier1RelayOptions) {
    // Until the group registry records a region per group (ADR 0019), the
    // relay serves region 0 only, with one published group
    // (docs/spec/tier1-relay.md, Groups).
    if (options.groups.size !== 1 || !options.groups.has(0))
      throw new RangeError("groups must publish exactly one group, for region 0");
    const groups = new Set<bigint>();
    for (const group of options.groups.values()) {
      if (typeof group !== "bigint" || group < 0n || group > U64_MAX)
        throw new RangeError("a group_id must be a u64");
      groups.add(group);
    }
    this.#redis = options.redis;
    this.#groups = groups;
    this.#turnstile = options.turnstile;
    this.#now = options.now;
    this.#keys = tier1Keys(options.prefix);
  }

  /**
   * Steps 2 to 8 (step 1, the transport's, is the server's). Resolves once
   * the record is queued, or was already queued: the same answer for each,
   * and for a record that can never count. Throws `Tier1RelayError` for the
   * first failed step.
   */
  async relay(input: Tier1RequestInput): Promise<void> {
    const request = parseTier1Request(input);
    if (!this.#groups.has(request.addition.groupId)) throw new Tier1RelayError("group-unknown");
    if (this.#active >= TIER1_MAX_CONCURRENT) throw new Tier1RelayError("unavailable");
    this.#active++;
    try {
      await this.#queue(request);
    } finally {
      this.#active--;
    }
  }

  async #queue(request: Tier1Request): Promise<void> {
    // Step 5: an index never brought up, not within the last minute, or
    // dated ahead of our clock can't say which roots are safe or how much of
    // a window is left.
    const index = parseTier1Index(await this.#eval(READ_INDEX, 1, this.#keys.index));
    const now = this.#now();
    if (
      index === undefined ||
      now - index.at > TIER1_INDEX_MAX_LAG ||
      index.at - now > TIER1_INDEX_MAX_SKEW
    )
      throw new Tier1RelayError("unavailable");
    // Step 6: roots at or below the safe head, so a reorganisation of unsafe
    // blocks can't change one after the relay pays, and each window long
    // enough to reach the next boundary and its resends.
    for (const v of request.addition.vouches)
      if (
        v.rootBlock > index.safe ||
        index.latest + TIER1_RELAY_MARGIN > v.rootBlock + VOUCH_ROOT_WINDOW
      )
        throw new Tier1RelayError("vouch-window");
    const verdict = await this.#turnstile.verify(request.turnstile, TURNSTILE_ACTION_TIER1);
    if (verdict === "refused") throw new Tier1RelayError("challenge-refused");
    if (verdict === "unavailable") throw new Tier1RelayError("challenge-unavailable");
    const queued = await this.#eval(
      ENQUEUE,
      1,
      this.#keys.queue,
      recordKey(request.record),
      request.hex,
      String(TIER1_RELAY_QUEUE_MAX),
    );
    if (queued !== 1) throw new Tier1RelayError("busy");
  }

  /**
   * One script. A Redis failure answers unavailable: the request's token may
   * be spent, and the client retries with a new solve. The error itself is
   * dropped, since its message can quote the script's arguments (T-11).
   */
  async #eval(script: string, numkeys: number, ...keysThenArgs: string[]): Promise<unknown> {
    try {
      return await this.#redis.eval(script, numkeys, ...keysThenArgs);
    } catch {
      throw new Tier1RelayError("unavailable");
    }
  }
}
