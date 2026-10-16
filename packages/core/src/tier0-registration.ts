// Tier 0 registration's route and queue (docs/spec/registration.md, Request,
// Answers and Queue; ADR 0024, option B). A request is checked in the
// spec's order, cheapest first, so a malformed or unserviceable one never
// spends the voter's Turnstile token; then one Redis script queues its
// commitment for its region's group. The batch job (P3-2 part 4d-2) signs
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
 * - `queue`: a hash from each queued commitment (64 lowercase hex digits) to
 *   the `group_id` it is queued for, so a commitment waits for one group
 *   only, whatever region a later request names (T-16);
 * - `sizes`: a hash from `group_id` to how many commitments are queued for it;
 * - `live`: a set of the commitments the Tier 0 index holds in any Tier 0
 *   group, signed or self-paid;
 * - `inflight`: a set of the commitments in any group's in-flight batch;
 * - `indexed`: the UNIX time, in seconds, at which the index was last brought
 *   up to the L2 node's latest block.
 *
 * The index and the in-flight batches are kept by the batch job; the route
 * only reads them.
 */
export function tier0Keys(prefix = "abolish") {
  const at = (name: string) => `${prefix}:{tier0-registration}:${name}`;
  return {
    queue: at("queue"),
    sizes: at("sizes"),
    live: at("live"),
    inflight: at("inflight"),
    indexed: at("indexed"),
  } as const;
}

export type Tier0Keys = ReturnType<typeof tier0Keys>;

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
// queued (for any group) is accepted and changes nothing.
const ENQUEUE = `
local size = tonumber(redis.call('HGET', KEYS[2], ARGV[2]) or '0')
if size >= tonumber(ARGV[3]) then return 0 end
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
    const keys = this.#keys;
    const probe = await this.#redis.eval(PROBE, 2, keys.sizes, keys.indexed, group);
    const [size, indexed] = probe as [string, string];
    if (Number(size) >= REGISTRATION_QUEUE_MAX) throw new Tier0RegistrationError("busy");
    // An index never brought up to date, or not within the last minute, can't
    // tell a live commitment from a new one (step 6).
    if (!/^[0-9]{1,15}$/.test(indexed) || this.#now() - Number(indexed) > TIER0_INDEX_MAX_LAG)
      throw new Tier0RegistrationError("unavailable");
    const verdict = await this.#turnstile.verify(request.turnstile, TURNSTILE_ACTION_TIER0);
    if (verdict === "refused") throw new Tier0RegistrationError("challenge-refused");
    if (verdict === "unavailable") throw new Tier0RegistrationError("challenge-unavailable");
    const queued = await this.#redis.eval(
      ENQUEUE,
      4,
      keys.queue,
      keys.sizes,
      keys.live,
      keys.inflight,
      request.commitment,
      group,
      String(REGISTRATION_QUEUE_MAX),
    );
    if (queued !== 1) throw new Tier0RegistrationError("busy");
  }
}
