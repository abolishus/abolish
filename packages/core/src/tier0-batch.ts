// Tier 0 registration's batch job (docs/spec/registration.md, Queue and The
// batch; ADR 0024, option B): at each period boundary, for each published
// group in ascending `group_id`, wait for the last batch to be final, recheck
// the queue against the Tier 0 index, hold a short queue, select at most
// `MAX_BATCH` commitments uniformly at random, sort them, sign the addition
// with the registrars' keys, keep the record as the group's in-flight batch
// and submit it. The chain is behind `Tier0Chain`, so this file decides and
// the adapter only reads and sends.
//
// One batch per position (docs/spec/contracts.md, Group registry, Additions;
// T-06): a record is kept in Redis before it is first sent, resubmitted
// unchanged until it lands, and a position is signed again only once
// finalized history shows the record can never land.
//
// T-10, T-11, T-13: Redis gains only the in-flight records, which the chain
// shows once sent, and a count per group; the job's report names groups and
// steps, never a commitment.

import {
  checkGroupApprovals,
  decodeGroupAddition,
  encodeGroupAddition,
  GROUP_REGISTRY_MAX_BATCH,
  groupAdditionDigest,
  groupRegistryDomainSeparator,
  POSEIDON2_ZERO_ONE,
  signGroupApproval,
} from "@abolishus/crypto";
import { commitmentKey, type Tier0Keys, tier0Keys, type Tier0Redis } from "./tier0-registration.ts";

/** Seconds in a registration period; batches are formed only at its boundaries. */
export const REGISTRATION_PERIOD = 600;
/** The fewest commitments signed into one batch, unless the group was held `MAX_REGISTRATION_HOLD` boundaries. */
export const MIN_REGISTRATION_BATCH = 8;
/** Boundaries in a row at which a group's short queue may be held. */
export const MAX_REGISTRATION_HOLD = 6;
/**
 * Milliseconds the batch job's lock lasts. Every write checks it in the same
 * script, so a runner whose lock lapsed (a stalled chain read) writes
 * nothing; the adapter's calls should time out well within it.
 */
export const TIER0_BATCH_LOCK_MS = 5 * 60_000;

const U64_MAX = (1n << 64n) - 1n;
// SADD's arguments per script call while the index is rebuilt.
const INDEX_CHUNK = 1_000;

/** A group as the L2 node shows it. */
export interface Tier0GroupState {
  /** The tier from its `GroupCreated` event. */
  readonly tier: number;
  /** Its member count in finalized history. */
  readonly finalizedSize: bigint;
  /** Its member count at the latest block, unfinalized included. */
  readonly latestSize: bigint;
}

/** An addition the group registry logged. */
export interface Tier0LoggedAddition {
  /** The record as `addMembers` took it. */
  readonly record: Uint8Array;
  /** Whether its block is finalized. */
  readonly final: boolean;
}

/**
 * What the batch job reads from L2 and sends to it: the group registry and
 * the paymaster's bundler (docs/spec/contracts.md, Group registry and
 * Registration paymaster). Every read is of public chain data.
 */
export interface Tier0Chain {
  /**
   * Every commitment in any Tier 0 group, signed or self-paid, up to the
   * node's latest block, unfinalized included (Answers, step 6).
   */
  tier0Commitments(): Promise<Iterable<bigint>>;
  group(groupId: bigint): Promise<Tier0GroupState>;
  /**
   * The addition whose `first_index` is `firstIndex` in the group, up to the
   * latest block, or null if there is none.
   */
  additionAt(groupId: bigint, firstIndex: bigint): Promise<Tier0LoggedAddition | null>;
  /** Sends the record through the paymaster. Resolves once a bundler has taken it. */
  submit(record: Uint8Array): Promise<void>;
}

/** One registrar key the service holds, at its seat in the pinned set. */
export interface Tier0Signer {
  /** 1-based, as the registry pins the registrars. */
  readonly seat: number;
  readonly secretKey: Uint8Array;
}

export interface Tier0BatchOptions {
  readonly redis: Tier0Redis;
  readonly chain: Tier0Chain;
  /** The published groups, as the route takes them (docs/spec/registration.md, Groups). */
  readonly groups: ReadonlyMap<number, bigint>;
  /** The L2's chain ID and the group registry's address, for the EIP-712 domain. */
  readonly chainId: bigint;
  readonly registry: Uint8Array;
  /** The registry's pinned registrars and threshold; every record is checked against them before it is kept. */
  readonly registrars: readonly Uint8Array[];
  readonly threshold: number;
  /** The keys the service signs with: `threshold` of them, in ascending seat order. */
  readonly signers: readonly Tier0Signer[];
  /** UNIX time in seconds. */
  readonly now: () => number;
  /** The first segment of every key, as the route's. */
  readonly prefix?: string;
}

/** What happened to one group at a boundary (docs/spec/registration.md, The batch). */
export type Tier0GroupOutcome =
  /** The chain couldn't be read for the group; nothing changed. */
  | "chain-unavailable"
  /** Step 1: the last batch, or an addition we didn't send, isn't final yet. */
  | "waiting"
  /** Step 1: the last batch isn't on chain, so it was sent again unchanged. */
  | "resubmitted"
  /** Step 2: the index couldn't be brought up to date. */
  | "index-unavailable"
  /** Step 3: nothing queued. */
  | "empty"
  /** Step 3: a short queue held for another boundary. */
  | "held"
  /** Step 6: a batch signed, kept and sent. */
  | "signed";

export interface Tier0GroupReport {
  readonly groupId: bigint;
  readonly outcome: Tier0GroupOutcome;
  /** A batch that could never land was abandoned at step 1, its commitments queued again. */
  readonly abandoned: boolean;
  /** At `signed`, whether the submission failed; it is resubmitted at the next boundary. */
  readonly submitFailed?: boolean;
}

/** The lock is held by another runner, or lapsed during a run. */
export class Tier0LockError extends Error {
  override readonly name = "Tier0LockError";
  constructor() {
    super("the Tier 0 batch lock is held elsewhere");
  }
}

// Every script that writes takes the lock as KEYS[1] and its token as
// ARGV[1], and refuses if the lock isn't still ours.
const FENCE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return redis.error_reply('tier0-lock') end
`;

const LOCK = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 end
return 0
`;

const UNLOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
return 1
`;

// The index is rebuilt in `next` and swapped in whole, so the route never
// reads a partial one.
const INDEX_CLEAR = `${FENCE}
redis.call('DEL', KEYS[2])
return 1
`;

const INDEX_ADD = `${FENCE}
redis.call('SADD', KEYS[2], unpack(ARGV, 2))
return 1
`;

const INDEX_SWAP = `${FENCE}
if redis.call('EXISTS', KEYS[2]) == 1 then
  redis.call('RENAME', KEYS[2], KEYS[3])
else
  redis.call('DEL', KEYS[3])
end
redis.call('SET', KEYS[4], ARGV[2])
return 1
`;

const READ_BATCH = `return redis.call('HGET', KEYS[1], ARGV[1]) or ''`;

// Step 1, a final batch: its commitments are live now, so they leave the
// in-flight set with the record.
const FINISH = `${FENCE}
redis.call('HDEL', KEYS[3], ARGV[2])
if #ARGV > 2 then redis.call('SREM', KEYS[2], unpack(ARGV, 3)) end
return 1
`;

// Step 1, a batch that can never land: its commitments go back into the map
// for the same group, even past the bound (they were accepted), unless one
// is queued already; step 2 then drops any that are live.
const ABANDON = `${FENCE}
local added = 0
for i = 3, #ARGV do
  redis.call('SREM', KEYS[4], ARGV[i])
  if redis.call('HSETNX', KEYS[2], ARGV[i], ARGV[2]) == 1 then added = added + 1 end
end
if added > 0 then redis.call('HINCRBY', KEYS[3], ARGV[2], added) end
redis.call('HDEL', KEYS[5], ARGV[2])
return 1
`;

// Step 2: drop each commitment queued for the group that is live, in any
// group's in-flight batch, or forbidden; return the rest.
const RECHECK = `${FENCE}
local all = redis.call('HGETALL', KEYS[2])
local kept = {}
local dropped = 0
for i = 1, #all, 2 do
  local c = all[i]
  if all[i + 1] == ARGV[2] then
    if redis.call('SISMEMBER', KEYS[4], c) == 1 or redis.call('SISMEMBER', KEYS[5], c) == 1
      or c == ARGV[3] or c == ARGV[4] or c == ARGV[5] then
      redis.call('HDEL', KEYS[2], c)
      dropped = dropped + 1
    else
      kept[#kept + 1] = c
    end
  end
end
if dropped > 0 then
  if redis.call('HINCRBY', KEYS[3], ARGV[2], -dropped) <= 0 then redis.call('HDEL', KEYS[3], ARGV[2]) end
end
local held = redis.call('HGET', KEYS[6], ARGV[2]) or '0'
return { held, kept }
`;

const HOLD = `${FENCE}
if ARGV[3] == '0' then redis.call('HDEL', KEYS[2], ARGV[2]) else redis.call('HSET', KEYS[2], ARGV[2], ARGV[3]) end
return 1
`;

// Step 6: the record is kept and its commitments move from the map to the
// in-flight set in one step, before it is first sent. Each must still be
// queued for the group: under the lock nothing else removes one.
const COMMIT = `${FENCE}
for i = 4, #ARGV do
  if redis.call('HGET', KEYS[2], ARGV[i]) ~= ARGV[2] then return redis.error_reply('tier0-queue') end
end
for i = 4, #ARGV do
  redis.call('HDEL', KEYS[2], ARGV[i])
  redis.call('SADD', KEYS[4], ARGV[i])
end
if redis.call('HINCRBY', KEYS[3], ARGV[2], -(#ARGV - 3)) <= 0 then redis.call('HDEL', KEYS[3], ARGV[2]) end
redis.call('HSET', KEYS[5], ARGV[2], ARGV[3])
redis.call('HDEL', KEYS[6], ARGV[2])
return 1
`;

const FORBIDDEN = [0n, 1n, POSEIDON2_ZERO_ONE].map(commitmentKey);

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** A uniform integer in `[0, n)`, `n ≤ 2³²`, from the CSPRNG by rejection sampling. */
function uniform(n: number): number {
  const limit = 2 ** 32 - (2 ** 32 % n);
  const word = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(word);
    const x = word[0] as number;
    if (x < limit) return x % n;
  }
}

/**
 * Step 4: `count` of `items` chosen uniformly at random, by a Fisher–Yates
 * shuffle whose indices come from `crypto.getRandomValues` (T-13).
 */
export function selectUniformly<T>(items: readonly T[], count: number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = uniform(i + 1);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a.slice(0, count);
}

/** The batch job's service: keeps the Tier 0 index and signs one batch per group per boundary. */
export class Tier0Batches {
  readonly #redis: Tier0Redis;
  readonly #chain: Tier0Chain;
  readonly #groups: readonly bigint[];
  readonly #domain: Uint8Array;
  readonly #registrars: readonly Uint8Array[];
  readonly #threshold: number;
  readonly #signers: readonly Tier0Signer[];
  readonly #now: () => number;
  readonly #keys: Tier0Keys;

  constructor(options: Tier0BatchOptions) {
    // As the route: region 0 only, with one published group, until the
    // registry records a region per group (ADR 0019).
    if (options.groups.size !== 1 || !options.groups.has(0))
      throw new RangeError("groups must publish exactly one group, for region 0");
    const groups = [...options.groups.values()];
    for (const g of groups)
      if (typeof g !== "bigint" || g < 0n || g > U64_MAX)
        throw new RangeError("a group_id must be a u64");
    const signers = options.signers.map((s) => ({ seat: s.seat, secretKey: s.secretKey.slice() }));
    // Exactly the threshold, in ascending seats: a record carries no more
    // approvals than it needs, and their order is the registry's.
    if (signers.length !== options.threshold)
      throw new RangeError("signers: need exactly `threshold` keys");
    for (let i = 1; i < signers.length; i++)
      if ((signers[i] as Tier0Signer).seat <= (signers[i - 1] as Tier0Signer).seat)
        throw new RangeError("signers: seats must ascend");
    this.#redis = options.redis;
    this.#chain = options.chain;
    this.#groups = groups.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    this.#domain = groupRegistryDomainSeparator(options.chainId, options.registry);
    this.#registrars = options.registrars.map((r) => r.slice());
    this.#threshold = options.threshold;
    this.#signers = signers;
    this.#now = options.now;
    this.#keys = tier0Keys(options.prefix);
  }

  /**
   * Brings the index up to the L2 node's latest block, for the route's
   * step 6 between boundaries. Resolves false if the chain couldn't be read;
   * the index is then left as it was. Throws `Tier0LockError` if a boundary
   * or another refresh is running.
   */
  async refreshIndex(): Promise<boolean> {
    return this.#locked((token) => this.#refresh(token));
  }

  /**
   * One boundary: every published group in ascending `group_id`, each
   * against the state the groups before it left. Throws `Tier0LockError` if
   * another runner holds the lock; the boundary is then that runner's.
   */
  async runBoundary(): Promise<Tier0GroupReport[]> {
    return this.#locked(async (token) => {
      const reports: Tier0GroupReport[] = [];
      for (const g of this.#groups) reports.push(await this.#group(token, g));
      return reports;
    });
  }

  async #locked<T>(run: (token: string) => Promise<T>): Promise<T> {
    const k = this.#keys;
    const token = crypto.randomUUID();
    const got = await this.#redis.eval(LOCK, 1, k.lock, token, String(TIER0_BATCH_LOCK_MS));
    if (got !== 1) throw new Tier0LockError();
    try {
      return await run(token);
    } finally {
      await this.#redis.eval(UNLOCK, 1, k.lock, token);
    }
  }

  async #fenced(script: string, keys: string[], token: string, ...args: string[]) {
    try {
      return await this.#redis.eval(
        script,
        keys.length + 1,
        this.#keys.lock,
        ...keys,
        token,
        ...args,
      );
    } catch (e) {
      if (e instanceof Error && e.message.includes("tier0-lock")) throw new Tier0LockError();
      throw e;
    }
  }

  async #refresh(token: string): Promise<boolean> {
    const k = this.#keys;
    // The time the read starts: the index is at least this current.
    const at = Math.floor(this.#now());
    let commitments: string[];
    try {
      commitments = [...(await this.#chain.tier0Commitments())].map(commitmentKey);
    } catch {
      return false;
    }
    await this.#fenced(INDEX_CLEAR, [k.next], token);
    for (let i = 0; i < commitments.length; i += INDEX_CHUNK)
      await this.#fenced(INDEX_ADD, [k.next], token, ...commitments.slice(i, i + INDEX_CHUNK));
    await this.#fenced(INDEX_SWAP, [k.next, k.live, k.indexed], token, String(at));
    return true;
  }

  async #group(token: string, groupId: bigint): Promise<Tier0GroupReport> {
    const k = this.#keys;
    const g = groupId.toString();
    let abandoned = false;
    const report = (outcome: Tier0GroupOutcome, submitFailed?: boolean): Tier0GroupReport => ({
      groupId,
      outcome,
      abandoned,
      ...(submitFailed === undefined ? {} : { submitFailed }),
    });

    let state: Tier0GroupState;
    try {
      state = await this.#chain.group(groupId);
    } catch {
      return report("chain-unavailable");
    }
    // A published group is Tier 0 by its `GroupCreated` event; anything
    // else is a misconfigured deployment, never something to sign into.
    if (state.tier !== 0) throw new RangeError(`group ${g} is not a Tier 0 group`);

    // Step 1: wait for the last batch.
    const stored = await this.#redis.eval(READ_BATCH, 1, k.batches, g);
    if (typeof stored === "string" && stored !== "") {
      const record = Uint8Array.from(Buffer.from(stored, "hex"));
      const decoded = decodeGroupAddition(record);
      // Only checked records are kept, so this is a corrupted store: stop
      // rather than guess which commitments it held.
      if (!decoded.ok) throw new Error(`group ${g}: the in-flight record doesn't decode`);
      const { firstIndex, commitments } = decoded.value;
      const keys = commitments.map(commitmentKey);
      let logged: Tier0LoggedAddition | null;
      try {
        logged = await this.#chain.additionAt(groupId, firstIndex);
      } catch {
        return report("chain-unavailable");
      }
      if (logged !== null && equalBytes(logged.record, record)) {
        if (!logged.final) return report("waiting");
        await this.#fenced(FINISH, [k.inflight, k.batches], token, g, ...keys);
      } else if (state.finalizedSize > firstIndex) {
        // Finalized history holds another record at its position: it can
        // never land, and the next batch takes the position.
        await this.#fenced(ABANDON, [k.queue, k.sizes, k.inflight, k.batches], token, g, ...keys);
        abandoned = true;
      } else if (state.latestSize > firstIndex) {
        // Taken only in unfinalized blocks, which a reorg could undo.
        return report("waiting");
      } else {
        try {
          await this.#chain.submit(record);
        } catch {
          // Sent again at the next boundary, unchanged.
        }
        return report("resubmitted");
      }
    }
    // An addition we didn't send isn't final yet (a record of ours whose
    // store was lost, say): signing the finalized position now would race it.
    if (state.latestSize !== state.finalizedSize) return report("waiting");

    // Step 2: recheck against the index as of the latest block.
    if (!(await this.#refresh(token))) return report("index-unavailable");
    const rechecked = await this.#fenced(
      RECHECK,
      [k.queue, k.sizes, k.live, k.inflight, k.held],
      token,
      g,
      ...FORBIDDEN,
    );
    const [heldText, kept] = rechecked as [string, string[]];
    const held = Number(heldText);

    // Step 3: hold a short queue.
    if (kept.length === 0) {
      await this.#fenced(HOLD, [k.held], token, g, "0");
      return report("empty");
    }
    if (kept.length < MIN_REGISTRATION_BATCH && held < MAX_REGISTRATION_HOLD) {
      await this.#fenced(HOLD, [k.held], token, g, String(held + 1));
      return report("held");
    }

    // Steps 4 and 5: select, then order by value.
    const chosen =
      kept.length > GROUP_REGISTRY_MAX_BATCH
        ? selectUniformly(kept, GROUP_REGISTRY_MAX_BATCH)
        : kept;
    const values = chosen.map((c) => BigInt(`0x${c}`)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    // Step 6: sign at the next position, check, keep, then send.
    const message = { groupId, tier: 0, firstIndex: state.finalizedSize, commitments: values };
    const digest = groupAdditionDigest(this.#domain, message);
    const approvals = this.#signers.map((s) => signGroupApproval(digest, s.seat, s.secretKey));
    const check = checkGroupApprovals(digest, approvals, this.#registrars, this.#threshold);
    // A key that isn't its seat's registrar: a misconfiguration, never a record to keep.
    if (!check.ok)
      throw new RangeError(`signers: the registry would refuse the approvals (${check.error})`);
    const record = encodeGroupAddition({
      groupId,
      firstIndex: state.finalizedSize,
      commitments: values,
      approvals,
    });
    await this.#fenced(
      COMMIT,
      [k.queue, k.sizes, k.inflight, k.batches, k.held],
      token,
      g,
      toHex(record),
      ...values.map(commitmentKey),
    );
    try {
      await this.#chain.submit(record);
      return report("signed", false);
    } catch {
      return report("signed", true);
    }
  }
}
