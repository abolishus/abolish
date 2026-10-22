// The board side of a Tier 0 token's re-issuance (docs/spec/tier0-token.md,
// Keys, item 4): before an account re-issues against a dead token, the
// commitment it shows is checked against the Tier 0 index, every in-flight
// batch and the queue, and marked so that the route never queues it, all in
// one Redis script with the route's own queueing (tier0-registration.ts,
// ENQUEUE). So a redemption racing the re-issuance either queued `C` first,
// and the mark refuses, or comes after the mark, and is dropped.
//
// T-10: the mark is keyed on the commitment alone. It holds no account, no
// session and no time of the re-issuance, only when the dead key's
// redemption window ends, which every token under that key shares. The
// account side (P2-30 part 3d-2) calls this before it replaces the account's
// record, and a repeat of the same mark succeeds, so a re-issuance whose
// record write failed can be retried with the same commitment.

import { isForbiddenCommitment } from "@abolishus/crypto";
import {
  commitmentKey,
  TIER0_INDEX_MAX_LAG,
  TIER0_INDEX_MAX_SKEW,
  type Tier0Keys,
  tier0Keys,
  type Tier0Redis,
} from "./tier0-registration.ts";

/**
 * What the mark found:
 *
 * - `shown`: `C` was never added to a Tier 0 group, isn't in flight or
 *   queued, and is now marked (or already was, until at least `lapse`);
 * - `registered`: the index (the addition history of every Tier 0 group,
 *   signed or self-paid, removed since or not), an in-flight batch or the
 *   queue holds `C`, so the re-issuance is refused (`reissue-refused`);
 * - `unavailable`: the index lags, or Redis failed; nothing was marked, and
 *   the re-issuance can be retried.
 */
export type Tier0ShowOutcome = "shown" | "registered" | "unavailable";

export interface Tier0ShownOptions {
  readonly redis: Tier0Redis;
  /** UNIX time in seconds: the signing service's clock, which judges a mark's lapse. */
  readonly now: () => number;
  /** The first segment of every key, as the route's. */
  readonly prefix?: string;
}

// One step: the index's age (as the route's step 6, so a lagging index never
// passes a commitment it would have held), lapsed marks pruned, then the
// check and the mark. A lapse below the one already kept never shortens it.
const SHOW = `
local indexed = redis.call('GET', KEYS[5])
if not indexed or not string.match(indexed, '^%d+$') or #indexed > 15 then return 'unavailable' end
local now = tonumber(ARGV[2])
local at = tonumber(indexed)
if now - at > tonumber(ARGV[4]) or at - now > tonumber(ARGV[5]) then return 'unavailable' end
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', ARGV[2])
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1
  or redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1
  or redis.call('HEXISTS', KEYS[3], ARGV[1]) == 1 then
  return 'registered'
end
local kept = redis.call('ZSCORE', KEYS[4], ARGV[1])
if tonumber(ARGV[3]) > now and (not kept or tonumber(kept) < tonumber(ARGV[3])) then
  redis.call('ZADD', KEYS[4], ARGV[3], ARGV[1])
end
return 'shown'
`;

/** Re-issuance's check-and-mark of a shown commitment, on the queue's Redis. */
export class Tier0ShownList {
  readonly #redis: Tier0Redis;
  readonly #now: () => number;
  readonly #keys: Tier0Keys;

  constructor(options: Tier0ShownOptions) {
    this.#redis = options.redis;
    this.#now = options.now;
    this.#keys = tier0Keys(options.prefix);
  }

  /**
   * Checks that `commitment` was never added to a Tier 0 group and is in no
   * in-flight batch or queue, and marks it so the route drops it until
   * `lapse`, the UNIX second at which the dead token's key stops redeeming
   * (the end of its period `q + 1`, or at once for a key retired early).
   * Rejects a commitment that isn't canonical or is forbidden, and a lapse
   * that isn't a safe integer: the caller decodes both first.
   */
  async show(commitment: bigint, lapse: number): Promise<Tier0ShowOutcome> {
    const c = commitmentKey(commitment);
    if (isForbiddenCommitment(commitment))
      throw new RangeError("a shown commitment isn't forbidden");
    if (!Number.isSafeInteger(lapse) || lapse < 0) throw new RangeError("lapse is a UNIX second");
    const k = this.#keys;
    let outcome: unknown;
    try {
      outcome = await this.#redis.eval(
        SHOW,
        5,
        k.live,
        k.inflight,
        k.queue,
        k.shown,
        k.indexed,
        c,
        String(Math.floor(this.#now())),
        String(lapse),
        String(TIER0_INDEX_MAX_LAG),
        String(TIER0_INDEX_MAX_SKEW),
      );
    } catch {
      // The client's error quotes the script's arguments, the commitment
      // among them (T-11).
      return "unavailable";
    }
    if (outcome === "shown" || outcome === "registered" || outcome === "unavailable")
      return outcome;
    return "unavailable";
  }
}
