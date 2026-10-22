// Tier 0 registration's route and queue (docs/spec/registration.md, Request,
// Answers and Queue; ADR 0024, option B). A request is checked in the
// spec's order, cheapest first, so a malformed or unserviceable one never
// spends the voter's Turnstile token; then one Redis script queues its
// commitment for its region's group. The batch job (tier0-batch.ts) signs
// what is queued.
//
// T-10, T-11, T-13: nothing here sees a header, cookie or address, and the
// queue keeps each commitment and the group it waits for and nothing else:
// no arrival time, order, token, request identifier or count per
// commitment. No answer depends on the commitment's own state, so the route
// can't say whether a commitment is waiting.

import { BN254_R, GROUP_REGISTRY_MAX_BATCH, isForbiddenCommitment } from "@abolishus/crypto";
import type { Turnstile } from "./turnstile.ts";

/** The most commitments queued for one group: four full batches (docs/spec/registration.md, Values). */
export const REGISTRATION_QUEUE_MAX = 4 * GROUP_REGISTRY_MAX_BATCH;
/** The Turnstile action a registration's token must be solved for. */
export const TURNSTILE_ACTION_TIER0 = "tier0-register";
/** Seconds the Tier 0 index may lag before the route answers unavailable (step 6). */
export const TIER0_INDEX_MAX_LAG = 60;
/**
 * Seconds an index time may run ahead of this server's clock, for skew
 * between the batch job's host and ours; beyond it the time is refused, so a
 * fast clock there can't keep a stale index current here.
 */
export const TIER0_INDEX_MAX_SKEW = 5;
/**
 * Most registrations handled at once by one server. A request holds its slot
 * through a Redis round trip and Turnstile's (up to 5 s), and anyone can send
 * well-formed requests with made-up tokens, so past this the route answers
 * unavailable rather than take more of the server's slots from ballots and
 * the board (T-52, T-25).
 */
export const TIER0_MAX_CONCURRENT = 8;
/**
 * Seconds a shown commitment stays marked past its lapse. The mark is
 * written on the issuer's clock and read on the signing service's, which can
 * disagree, and a redemption's key check runs before Turnstile's round trip
 * and this script, so a mark judged lapsed at its exact second would let a
 * redemption the service still took queue a commitment whose account has
 * already re-issued (docs/spec/tier0-token.md, Keys, item 4; T-74). An
 * abandoned commitment costs nothing to keep marked longer.
 */
export const TIER0_SHOWN_MARGIN = 86_400;

const U32_MAX = 2 ** 32 - 1;
const U64_MAX = (1n << 64n) - 1n;

/** Redis's `EVAL`, as ioredis (and any client of Redis or Dragonfly) offers it. */
export interface Tier0Redis {
  eval(script: string, numkeys: number, ...args: string[]): Promise<unknown>;
}

/**
 * Every key of Tier 0 registration, under one hash tag so a script can touch
 * them all in one step on Dragonfly or Redis Cluster:
 *
 * - `queue`: a hash from each queued commitment to the `group_id` (canonical
 *   decimal) it is queued for, so a commitment waits for one group only,
 *   whatever region a later request names (T-16);
 * - `sizes`: a hash from `group_id` to how many commitments are queued for it;
 * - `live`: a set of the commitments the Tier 0 index holds in any Tier 0
 *   group, signed or self-paid;
 * - `inflight`: a set of the commitments in any group's in-flight batch;
 * - `indexed`: the UNIX time, in seconds, at which the index was last brought
 *   up to the L2 node's latest block;
 * - `held`: a hash from `group_id` to the boundaries in a row at which its
 *   short queue was held (absent for 0);
 * - `batches`: a hash from `group_id` to its in-flight addition record (hex);
 * - `positions`: a hash from `group_id` to the lowest position the batch job
 *   may still sign, past every record of ours that landed;
 * - `boundary`: the number of the last period whose boundary ran;
 * - `next`: the index being rebuilt, swapped in for `live` once whole;
 * - `shown`: a sorted set of the commitments shown at a token's
 *   re-issuance, each scored by the UNIX second at which its dead key's
 *   redemption window ends, its lapse, and kept `TIER0_SHOWN_MARGIN` past
 *   it (tier0-shown.ts);
 * - `lock`: the batch job's lock, so one runner at a time writes the rest.
 *
 * Every commitment, in `queue`, `live` and `inflight` alike, is written as
 * `commitmentKey` writes it (64 lowercase hex digits), or a membership test
 * would miss it. `sizes[g]` is always the number of `queue` entries whose
 * value is `g`: whatever adds to or removes from `queue` (the route, and the
 * batch job's selections, drops and returns) changes `sizes` in the same
 * script, since the queue's bound rests on it (T-52).
 *
 * The index, the in-flight batches and `held` are kept by the batch job
 * (tier0-batch.ts), and `shown` by re-issuance (tier0-shown.ts); the route
 * only reads `live`, `inflight`, `shown` and `indexed`.
 */
export function tier0Keys(prefix = "abolish") {
  // A brace in the prefix would change the hash tag, scattering the keys
  // over slots that one script can't span.
  if (prefix === "" || /[{}]/.test(prefix)) throw new RangeError("invalid key prefix");
  const at = (name: string) => `${prefix}:{tier0-registration}:${name}`;
  return {
    queue: at("queue"),
    sizes: at("sizes"),
    live: at("live"),
    inflight: at("inflight"),
    indexed: at("indexed"),
    held: at("held"),
    batches: at("batches"),
    positions: at("positions"),
    finished: at("finished"),
    added: at("added"),
    boundary: at("boundary"),
    next: at("next"),
    shown: at("shown"),
    lock: at("lock"),
  } as const;
}

export type Tier0Keys = ReturnType<typeof tier0Keys>;

/** A commitment as every Tier 0 key holds it: 64 lowercase hex digits. */
export function commitmentKey(value: bigint): string {
  if (typeof value !== "bigint" || value < 0n || value >= BN254_R)
    throw new RangeError("a commitment is a field<bn254> element");
  return value.toString(16).padStart(64, "0");
}

// Steps 5 and 6 in one round trip: the group's queue size and the index's age.
const PROBE = `
local size = redis.call('HGET', KEYS[1], ARGV[1])
local indexed = redis.call('GET', KEYS[2])
return { size or '0', indexed or '' }
`;

// Step 8, atomically. The bound is checked before anything about the
// commitment, so a full queue answers busy whatever is sent, and again here
// rather than only at step 5, since step 7's round trip lets concurrent
// requests pass step 5 together. A commitment already live, in flight or
// queued (for any group) is accepted and changes nothing. So is one shown at
// a re-issuance whose mark is kept: it is abandoned and never queued
// (docs/spec/tier0-token.md, Keys, item 4), and checking it in this script
// serialises queueing with the mark's own check (tier0-shown.ts), so neither
// can slip between the other's check and write.
const ENQUEUE = `
local size = tonumber(redis.call('HGET', KEYS[2], ARGV[2]) or '0')
if size >= tonumber(ARGV[3]) then return 0 end
local lapse = redis.call('ZSCORE', KEYS[5], ARGV[1])
if lapse and tonumber(lapse) + tonumber(ARGV[5]) > tonumber(ARGV[4]) then return 1 end
if redis.call('SISMEMBER', KEYS[3], ARGV[1]) == 1 then return 1 end
if redis.call('SISMEMBER', KEYS[4], ARGV[1]) == 1 then return 1 end
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 1 then
  redis.call('HINCRBY', KEYS[2], ARGV[2], 1)
end
return 1
`;

/** A request's fields after the contract's form checks: strings only. */
export interface Tier0RequestInput {
  /** 64 lowercase hex digits. */
  readonly commitment: string;
  /** A canonical decimal `u32`. */
  readonly region: string;
  /** The challenge page's Turnstile token. */
  readonly turnstile: string;
}

export interface Tier0Request {
  /** As sent: 64 lowercase hex digits, below `r`. */
  readonly commitment: string;
  readonly region: number;
  readonly turnstile: string;
}

export type Tier0RegistrationErrorCode =
  /** A field isn't in its form, the commitment isn't below `r`, or it is forbidden (steps 2 and 3). */
  | "malformed"
  /** The region has no published group (step 4). */
  | "region-unknown"
  /** The group's queue is full (steps 5 and 8). */
  | "busy"
  /** The Tier 0 index lags, or the service isn't configured (step 6). */
  | "unavailable"
  /** Turnstile refused the token (step 7). */
  | "challenge-refused"
  /** Turnstile couldn't say (step 7). */
  | "challenge-unavailable";

/** Under `malformed`: which form failed. */
export type Tier0MalformedCode =
  | "commitment"
  | "region"
  | "turnstile"
  | "non-canonical"
  | "forbidden-commitment";

export class Tier0RegistrationError extends Error {
  override readonly name = "Tier0RegistrationError";
  readonly code: Tier0RegistrationErrorCode;
  readonly malformed?: Tier0MalformedCode;
  constructor(code: Tier0RegistrationErrorCode, malformed?: Tier0MalformedCode) {
    // The message never quotes the request (T-11).
    super(`registration refused: ${code}${malformed === undefined ? "" : ` (${malformed})`}`);
    this.code = code;
    if (malformed !== undefined) this.malformed = malformed;
  }
}

const COMMITMENT = /^[0-9a-f]{64}$/;
const REGION = /^(?:0|[1-9][0-9]{0,9})$/;
// docs/spec/registration.md, Request: 1 to 2,048 characters from 0x21 to 0x7e.
const TOKEN = /^[\x21-\x7e]{1,2048}$/;

/**
 * Steps 2 and 3: the fields' forms, then a commitment below `r` and not
 * forbidden (`0`, `1` or `Poseidon2(0, 1)`). The contract has checked the
 * forms already; they are checked again here so core never trusts its
 * transport.
 */
export function parseTier0Request(input: Tier0RequestInput): Tier0Request {
  const malformed = (code: Tier0MalformedCode) => new Tier0RegistrationError("malformed", code);
  if (!COMMITMENT.test(input.commitment)) throw malformed("commitment");
  if (!REGION.test(input.region) || Number(input.region) > U32_MAX) throw malformed("region");
  if (!TOKEN.test(input.turnstile)) throw malformed("turnstile");
  const value = BigInt(`0x${input.commitment}`);
  if (value >= BN254_R) throw malformed("non-canonical");
  if (isForbiddenCommitment(value)) throw malformed("forbidden-commitment");
  return { commitment: input.commitment, region: Number(input.region), turnstile: input.turnstile };
}

export interface Tier0RegistrationOptions {
  readonly redis: Tier0Redis;
  /**
   * The published groups: each region code the service serves and its one
   * Tier 0 group's `group_id`, as the deployment record lists them
   * (docs/spec/registration.md, Groups).
   */
  readonly groups: ReadonlyMap<number, bigint>;
  /** Checks tokens for the challenge origin's host. */
  readonly turnstile: Turnstile;
  /** UNIX time in seconds. */
  readonly now: () => number;
  /** The first segment of every key; tests give each run its own. */
  readonly prefix?: string;
}

/** The route's service: checks a request in the spec's order and queues its commitment. */
export class Tier0Registrations {
  readonly #redis: Tier0Redis;
  readonly #groups: ReadonlyMap<number, string>;
  readonly #turnstile: Turnstile;
  readonly #now: () => number;
  readonly #keys: Tier0Keys;
  #active = 0;

  constructor(options: Tier0RegistrationOptions) {
    // Until the group registry records a region per group (ADR 0019), the
    // service serves region 0 only, with one published group
    // (docs/spec/registration.md, Groups; T-16).
    if (options.groups.size !== 1 || !options.groups.has(0))
      throw new RangeError("groups must publish exactly one group, for region 0");
    const groups = new Map<number, string>();
    for (const [region, group] of options.groups) {
      if (typeof group !== "bigint" || group < 0n || group > U64_MAX)
        throw new RangeError("a group_id must be a u64");
      groups.set(region, group.toString());
    }
    this.#redis = options.redis;
    this.#groups = groups;
    this.#turnstile = options.turnstile;
    this.#now = options.now;
    this.#keys = tier0Keys(options.prefix);
  }

  /**
   * Steps 2 to 8 (step 1, the transport's, is the server's). Resolves once
   * the commitment is queued, or was already queued, live or in flight: the
   * same answer for each. Throws `Tier0RegistrationError` for the first
   * failed step.
   */
  async register(input: Tier0RequestInput): Promise<void> {
    const request = parseTier0Request(input);
    const group = this.#groups.get(request.region);
    if (group === undefined) throw new Tier0RegistrationError("region-unknown");
    if (this.#active >= TIER0_MAX_CONCURRENT) throw new Tier0RegistrationError("unavailable");
    this.#active++;
    try {
      await this.#queue(request, group);
    } finally {
      this.#active--;
    }
  }

  async #queue(request: Tier0Request, group: string): Promise<void> {
    const keys = this.#keys;
    const probe = await this.#eval(PROBE, 2, keys.sizes, keys.indexed, group);
    if (!Array.isArray(probe) || probe.length !== 2)
      throw new Tier0RegistrationError("unavailable");
    const [size, indexed] = probe as unknown[];
    if (Number(size) >= REGISTRATION_QUEUE_MAX) throw new Tier0RegistrationError("busy");
    // An index never brought up to date, not within the last minute, or
    // dated ahead of our clock can't be trusted to tell a live commitment
    // from a new one (step 6).
    const now = this.#now();
    if (
      typeof indexed !== "string" ||
      !/^[0-9]{1,15}$/.test(indexed) ||
      now - Number(indexed) > TIER0_INDEX_MAX_LAG ||
      Number(indexed) - now > TIER0_INDEX_MAX_SKEW
    )
      throw new Tier0RegistrationError("unavailable");
    const verdict = await this.#turnstile.verify(request.turnstile, TURNSTILE_ACTION_TIER0);
    if (verdict === "refused") throw new Tier0RegistrationError("challenge-refused");
    if (verdict === "unavailable") throw new Tier0RegistrationError("challenge-unavailable");
    const queued = await this.#eval(
      ENQUEUE,
      5,
      keys.queue,
      keys.sizes,
      keys.live,
      keys.inflight,
      keys.shown,
      request.commitment,
      group,
      String(REGISTRATION_QUEUE_MAX),
      String(Math.floor(this.#now())),
      String(TIER0_SHOWN_MARGIN),
    );
    if (queued !== 1) throw new Tier0RegistrationError("busy");
  }

  /**
   * One script. A Redis failure answers
   * unavailable: the request's token may be spent, and the client retries
   * with a new solve. The error itself is dropped, since its message can
   * quote the script's arguments (T-11).
   */
  async #eval(script: string, numkeys: number, ...keysThenArgs: string[]): Promise<unknown> {
    try {
      return await this.#redis.eval(script, numkeys, ...keysThenArgs);
    } catch {
      throw new Tier0RegistrationError("unavailable");
    }
  }
}
