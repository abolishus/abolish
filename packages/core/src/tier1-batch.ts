// The Tier 1 relay's job (docs/spec/tier1-relay.md, The batch and The
// counting state; P3-3 part 3c-2b-2a): between boundaries it keeps the
// relay's index current for the route; at each period boundary it
// rebroadcasts what it sent and isn't yet in the chain, brings its counting
// state up to the L2 node's latest block, shuffles the queue, judges each
// record against the state with the ones chosen before it, and sends what
// counts from the relay's account, in an order of their contents. The chain
// is behind `Tier1Chain`, so this file decides and the adapter only reads,
// signs and sends.
//
// One transaction per record (T-52, T-25): a record's signed transaction is
// kept in Redis before it is first sent and rebroadcast unchanged, or
// replaced at its nonce carrying the same record; the record is judged again
// only once that nonce went to another transaction or the node refuses it,
// and the replay then sees any copy that landed in the meantime.
//
// T-10, T-11, T-13: Redis gains only the in-flight records with their
// transactions, which the chain shows once sent, and a count of boundaries
// each was found pending at; no time, request or order. The report counts
// records and names steps, never a record, commitment or slot.

import {
  type ContractEventRecord,
  type ContractEventVersion,
  decodeTier1Addition,
  groupRegistryEvents,
  Tier1CountingState,
  VOUCH_ROOT_WINDOW,
} from "@abolishus/crypto";
import { selectUniformly } from "./tier0-batch.ts";
import {
  recordKey,
  TIER1_RECORD_HEX,
  tier1IndexValue,
  type Tier1Keys,
  tier1Keys,
  type Tier1Redis,
} from "./tier1-relay.ts";

/** Seconds in a relay period, aligned to UNIX time as Tier 0's (docs/spec/tier1-relay.md, Values). */
export const TIER1_RELAY_PERIOD = 600;
/** The most additions the relay sends at one boundary. */
export const TIER1_RELAY_MAX_BATCH = 16;
/** L2 blocks a chosen record must still have in every vouch's window past the block it is judged at. */
export const TIER1_RELAY_SEND_MARGIN = 150n;
/** The gas limit of every relayed call; the adapter signs with it. */
export const TIER1_RELAY_GAS_LIMIT = 2_000_000n;
/**
 * Milliseconds the job's lock lasts. Every write checks it in the same
 * script, so a runner whose lock lapsed (a stalled chain read) writes
 * nothing; the adapter's calls should time out well within it.
 */
export const TIER1_BATCH_LOCK_MS = 5 * 60_000;

const U64_MAX = (1n << 64n) - 1n;

/** The node's latest block, by number and hash, which the index is brought up to. */
export interface Tier1Head {
  readonly number: bigint;
  readonly hash: Uint8Array;
}

/** The node's heads, read together. */
export interface Tier1Heads {
  readonly latest: Tier1Head;
  /** `s`: the newest block derived from L1 data. */
  readonly safe: bigint;
  readonly finalized: bigint;
}

/** A signed `addTier1Member` call. */
export interface Tier1SignedSend {
  /** The signed transaction's bytes, as broadcast. */
  readonly tx: Uint8Array;
  /** Its hash, 32 bytes. */
  readonly hash: Uint8Array;
}

/**
 * What the job reads from L2 and sends to it: the group registry and the
 * relay's account (docs/spec/tier1-relay.md, Roles). Every read is of public
 * chain data. A call that can't reach the node rejects.
 */
export interface Tier1Chain {
  heads(): Promise<Tier1Heads>;
  /** The hash of the node's block at `number`, or null if it has none there. */
  blockHash(number: bigint): Promise<Uint8Array | null>;
  /**
   * Every log of the group registry in blocks after `after` (from its
   * deployment, if null) through `through`, as contract-event records in
   * order of `n` (docs/spec/contracts.md, Contract-event record).
   */
  records(after: bigint | null, through: bigint): Promise<readonly ContractEventRecord[]>;
  /** The relay account's transaction count at the latest block: every lower nonce is taken. */
  nonce(): Promise<bigint>;
  /** The block whose transactions include `hash` in the node's latest history, or null. */
  included(hash: Uint8Array): Promise<bigint | null>;
  /** Simulates `addTier1Member(record)` from the relay's account at the latest block: false if it reverts. */
  simulate(record: Uint8Array): Promise<boolean>;
  /**
   * Signs `addTier1Member(record)` to the registry at `nonce`, with gas
   * limit `TIER1_RELAY_GAS_LIMIT`, sending nothing. `replacing` is the
   * transaction of that nonce it replaces, carrying the same record, whose
   * fees it must raise enough for a node to take it.
   */
  sign(record: Uint8Array, nonce: bigint, replacing?: Uint8Array): Promise<Tier1SignedSend>;
  /** Sends a signed transaction: "sent" if the node took it or already had it, "refused" if it refused it. */
  broadcast(tx: Uint8Array): Promise<"sent" | "refused">;
}

export interface Tier1BatchOptions {
  readonly redis: Tier1Redis;
  readonly chain: Tier1Chain;
  /** The published groups, as the route takes them (docs/spec/tier1-relay.md, Groups). */
  readonly groups: ReadonlyMap<number, bigint>;
  /** The L2's chain ID and the group registry's address: the vouches' binding. */
  readonly chainId: bigint;
  readonly registry: Uint8Array;
  /** The registrars and threshold the release pins; every `RegistrarsPinned` must name them. */
  readonly registrars: readonly Uint8Array[];
  readonly threshold: number;
  /** The contract-event version the release pins for the registry's events. */
  readonly version: ContractEventVersion;
  /** UNIX time in seconds. */
  readonly now: () => number;
  /** The first segment of every key, as the route's. */
  readonly prefix?: string;
}

/** How a boundary ended (docs/spec/tier1-relay.md, The batch). */
export type Tier1BoundaryOutcome =
  /** Step 1: the chain couldn't be read or reached; what was done so far stands. */
  | "chain-unavailable"
  /** Step 1: an in-flight record is still pending, so nothing new is sent. */
  | "pending"
  /** Step 2: the index couldn't be brought up. */
  | "index-unavailable"
  /** Step 2: the registry's Tier 2 history is broken at or before the latest block. */
  | "broken"
  /** Steps 3 to 5 ran: `sent` may be 0. */
  | "judged";

/** What a boundary did, as counts only (T-10, T-13). */
export interface Tier1BoundaryReport {
  readonly outcome: Tier1BoundaryOutcome;
  /** Step 1: in-flight records final on L2, deleted. */
  readonly finished: number;
  /** Step 1: in-flight records that can never land, deleted. */
  readonly expired: number;
  /** Step 1: in-flight records returned to the queue. */
  readonly returned: number;
  /** Step 1: pending transactions broadcast again unchanged. */
  readonly rebroadcast: number;
  /** Step 1: pending transactions replaced at their nonce with higher fees. */
  readonly replaced: number;
  /** Step 4: records that don't count, or can't be sent in time, dropped. */
  readonly dropped: number;
  /** Step 5: chosen records whose simulation reverted, dropped. */
  readonly reverted: number;
  /** Step 5: records signed, kept and sent. */
  readonly sent: number;
  /** Step 5: of those, how many the node refused or couldn't take; each is rebroadcast at the next boundary. */
  readonly sendFailed: number;
}

/** The lock is held by another runner, or lapsed during a run. */
export class Tier1LockError extends Error {
  override readonly name = "Tier1LockError";
  constructor() {
    super("the Tier 1 relay's lock is held elsewhere");
  }
}

// Every script that writes takes the lock as KEYS[1] and its token as
// ARGV[1], and refuses if the lock isn't still ours.
const FENCE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return redis.error_reply('tier1-lock') end
`;

const LOCK = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 end
return 0
`;

const UNLOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
return 1
`;

// A boundary runs once: the period number is kept, and a later run in the
// same period (a retry, a second scheduler) does nothing, so no send moves
// off the boundaries (T-13).
const MARK_BOUNDARY = `${FENCE}
local last = tonumber(redis.call('GET', KEYS[2]) or '-1')
if tonumber(ARGV[2]) <= last then return 0 end
redis.call('SET', KEYS[2], ARGV[2])
return 1
`;

const WRITE_INDEX = `${FENCE}
redis.call('SET', KEYS[2], ARGV[2])
return 1
`;

const READ_ALL = `return redis.call('HGETALL', KEYS[1])`;

const INFLIGHT_SET = `${FENCE}
redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
return 1
`;

const INFLIGHT_DELETE = `${FENCE}
redis.call('HDEL', KEYS[2], ARGV[2])
return 1
`;

// Step 1: back into the queue, even past `TIER1_RELAY_QUEUE_MAX`: it was
// accepted, and is never dropped silently.
const INFLIGHT_RETURN = `${FENCE}
redis.call('HSET', KEYS[3], ARGV[2], ARGV[3])
redis.call('HDEL', KEYS[2], ARGV[2])
return 1
`;

const QUEUE_DROP = `${FENCE}
redis.call('HDEL', KEYS[2], unpack(ARGV, 2))
return 1
`;

// Step 5: the record leaves the queue and is kept with its transaction in
// one step, before it is first sent. It must still be queued: under the
// lock nothing else removes one.
const SEND = `${FENCE}
if redis.call('HEXISTS', KEYS[2], ARGV[2]) ~= 1 then return redis.error_reply('tier1-queue') end
redis.call('HDEL', KEYS[2], ARGV[2])
redis.call('HSET', KEYS[3], ARGV[2], ARGV[3])
return 1
`;

/** An in-flight record as kept: its nonce, every transaction signed for it there, and the boundaries it was found pending at. */
interface InFlight {
  readonly record: string;
  readonly nonce: bigint;
  readonly txs: readonly string[];
  readonly hashes: readonly string[];
  readonly pending: number;
}

const HEX = /^(?:[0-9a-f]{2})+$/;
const HASH = /^[0-9a-f]{64}$/;
const RECORD = new RegExp(`^[0-9a-f]{${TIER1_RECORD_HEX}}$`);

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function writeInFlight(f: InFlight): string {
  return JSON.stringify({
    record: f.record,
    nonce: f.nonce.toString(),
    txs: f.txs,
    hashes: f.hashes,
    pending: f.pending,
  });
}

// Only what `writeInFlight` writes is read back; anything else is a
// corrupted store, and the job stops rather than guess what was sent.
function readInFlight(value: string): InFlight {
  const bad = () => new Error("an in-flight record doesn't parse");
  let v: unknown;
  try {
    v = JSON.parse(value);
  } catch {
    throw bad();
  }
  if (v === null || typeof v !== "object") throw bad();
  const o = v as Record<string, unknown>;
  const { record, nonce, txs, hashes, pending } = o;
  if (
    Object.keys(o).length !== 5 ||
    typeof record !== "string" ||
    !RECORD.test(record) ||
    typeof nonce !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/.test(nonce) ||
    BigInt(nonce) > U64_MAX ||
    !Array.isArray(txs) ||
    !Array.isArray(hashes) ||
    txs.length === 0 ||
    txs.length !== hashes.length ||
    !txs.every((t) => typeof t === "string" && HEX.test(t)) ||
    !hashes.every((h) => typeof h === "string" && HASH.test(h)) ||
    !Number.isSafeInteger(pending) ||
    (pending as number) < 0
  )
    throw bad();
  return {
    record,
    nonce: BigInt(nonce),
    txs: txs as string[],
    hashes: hashes as string[],
    pending: pending as number,
  };
}

/** Pairs from `HGETALL`'s flat answer. */
function pairs(flat: unknown): [string, string][] {
  if (!Array.isArray(flat) || flat.length % 2 !== 0) throw new Error("Redis answered out of form");
  const out: [string, string][] = [];
  for (let i = 0; i < flat.length; i += 2) out.push([String(flat[i]), String(flat[i + 1])]);
  return out;
}

const cmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length && i < b.length; i++)
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return a.length - b.length;
}

// The chain answered something it can't have: a reorganisation mid-read, a
// node behind blocks already read, or logs out of order. Nothing that read
// is used.
class Inconsistent extends Error {}

/** The relay's job: keeps its index and counting state, and sends one batch per boundary. */
export class Tier1Batches {
  readonly #redis: Tier1Redis;
  readonly #chain: Tier1Chain;
  readonly #groups: ReadonlySet<bigint>;
  readonly #chainId: bigint;
  readonly #registry: Uint8Array;
  readonly #registrars: readonly Uint8Array[];
  readonly #threshold: number;
  readonly #version: ContractEventVersion;
  readonly #now: () => number;
  readonly #keys: Tier1Keys;
  // The counting state, its block's hash and the next record's `n`. Held in
  // memory only: a restart, or a reorganisation of a block it was extended
  // past, rebuilds it by a full replay (docs/spec/tier1-relay.md, The
  // counting state).
  #state: Tier1CountingState | null = null;
  #tip: Tier1Head | null = null;
  #next = 0n;

  constructor(options: Tier1BatchOptions) {
    // As the route: region 0 only, with one published group, until the
    // registry records a region per group (ADR 0019).
    if (options.groups.size !== 1 || !options.groups.has(0))
      throw new RangeError("groups must publish exactly one group, for region 0");
    const groups = new Set<bigint>();
    for (const g of options.groups.values()) {
      if (typeof g !== "bigint" || g < 0n || g > U64_MAX)
        throw new RangeError("a group_id must be a u64");
      groups.add(g);
    }
    this.#redis = options.redis;
    this.#chain = options.chain;
    this.#groups = groups;
    this.#chainId = options.chainId;
    this.#registry = options.registry.slice();
    this.#registrars = options.registrars.map((r) => r.slice());
    this.#threshold = options.threshold;
    this.#version = options.version;
    this.#now = options.now;
    this.#keys = tier1Keys(options.prefix);
    // Checks the pins now, so a misconfigured job refuses to start.
    this.#fresh();
  }

  /**
   * Brings the counting state and the route's index up to the L2 node's
   * latest block (docs/spec/tier1-relay.md, Answers, step 5), to run well
   * within `TIER1_INDEX_MAX_LAG` of the last. Resolves false if it couldn't;
   * the index is then left as it was, and ages out. Throws
   * `Tier1LockError` if a boundary or another refresh is running.
   */
  async refreshIndex(): Promise<boolean> {
    return this.#locked((token) => this.#refresh(token));
  }

  /**
   * The boundary that began the current period. Resolves null if this
   * period's boundary has already run. Throws `Tier1LockError` if another
   * runner holds the lock, which may be an index refresh: the caller
   * retries within the period.
   */
  async runBoundary(): Promise<Tier1BoundaryReport | null> {
    return this.#locked(async (token) => {
      const period = Math.floor(this.#now() / TIER1_RELAY_PERIOD);
      const marked = await this.#fenced(
        MARK_BOUNDARY,
        [this.#keys.boundary],
        token,
        String(period),
      );
      if (marked !== 1) return null;
      return this.#boundary(token);
    });
  }

  #fresh(): Tier1CountingState {
    return new Tier1CountingState({
      chainId: this.#chainId,
      registry: this.#registry,
      registrars: this.#registrars,
      threshold: this.#threshold,
    });
  }

  async #locked<T>(run: (token: string) => Promise<T>): Promise<T> {
    const k = this.#keys;
    const token = crypto.randomUUID();
    const got = await this.#eval(LOCK, [k.lock], token, String(TIER1_BATCH_LOCK_MS));
    if (got !== 1) throw new Tier1LockError();
    try {
      return await run(token);
    } finally {
      await this.#eval(UNLOCK, [k.lock], token);
    }
  }

  #fenced(script: string, keys: string[], token: string, ...args: string[]) {
    return this.#eval(script, [this.#keys.lock, ...keys], token, ...args);
  }

  /**
   * One script. A Redis error is replaced by one that quotes nothing: the
   * client's error carries the command's arguments, which can be a record
   * not yet sent (T-11, T-13).
   */
  async #eval(script: string, keys: string[], ...args: string[]): Promise<unknown> {
    try {
      return await this.#redis.eval(script, keys.length, ...keys, ...args);
    } catch (e) {
      if (e instanceof Error && e.message.includes("tier1-lock")) throw new Tier1LockError();
      throw new Error("Tier 1 relay: a Redis script failed");
    }
  }

  // Step 2, and the index between boundaries. True once the state is at the
  // node's latest block and the index says so.
  async #refresh(token: string): Promise<boolean> {
    // The time the read starts: the index is at least this current.
    const at = Math.floor(this.#now());
    let heads: Tier1Heads;
    try {
      heads = await this.#extend();
    } catch {
      // Unreachable, or inconsistent: either way nothing read is kept, and a
      // state an extension may have part applied is replaced by a full
      // replay next time.
      this.#state = null;
      this.#tip = null;
      return false;
    }
    await this.#fenced(
      WRITE_INDEX,
      [this.#keys.index],
      token,
      tier1IndexValue({ at, latest: heads.latest.number, safe: heads.safe }),
    );
    return true;
  }

  async #extend(): Promise<Tier1Heads> {
    const chain = this.#chain;
    const heads = await chain.heads();
    const { latest } = heads;
    if (heads.finalized > heads.safe || heads.safe > latest.number) throw new Inconsistent();
    // A reorganisation of a block the state was extended past changes that
    // block's hash, since each block's hash covers its parent's: the state
    // is rebuilt from nothing. A node that doesn't have the block (behind
    // us, or a backend that is) is read again later, never trusted.
    if (this.#tip !== null) {
      if (latest.number < this.#tip.number) throw new Inconsistent();
      const hash = await chain.blockHash(this.#tip.number);
      if (hash === null) throw new Inconsistent();
      if (!equalBytes(hash, this.#tip.hash)) {
        this.#state = null;
        this.#tip = null;
      }
    }
    const after = this.#tip?.number ?? null;
    if (after !== null && after === latest.number) {
      if (!equalBytes(latest.hash, (this.#tip as Tier1Head).hash)) throw new Inconsistent();
      return heads;
    }
    const records = await chain.records(after, latest.number);
    // The logs must be of the block whose hash was read: one reorganised in
    // between could have given logs of another.
    const again = await chain.blockHash(latest.number);
    if (again === null || !equalBytes(again, latest.hash)) throw new Inconsistent();
    const start = after === null ? 0n : this.#next;
    for (const [i, r] of records.entries())
      if (
        r === null ||
        typeof r !== "object" ||
        r.n !== start + BigInt(i) ||
        (after !== null && r.l2_block <= after) ||
        r.l2_block > latest.number
      )
        throw new Inconsistent();
    const read = groupRegistryEvents(records, this.#registry, this.#version);
    // A log the release's registry never emits, or other pins: a node not to
    // read from, or other bytecode, never a count to send by (T-53, T-71).
    if (!read.ok) throw new Inconsistent();
    for (const p of read.pinned)
      if (
        p.threshold !== this.#threshold ||
        p.registrars.length !== this.#registrars.length ||
        p.registrars.some((r, i) => !equalBytes(r, this.#registrars[i] as Uint8Array))
      )
        throw new Inconsistent();
    const state = this.#state ?? this.#fresh();
    state.extend(read.events, latest.number);
    this.#state = state;
    this.#tip = { number: latest.number, hash: latest.hash.slice() };
    this.#next = start + BigInt(records.length);
    return heads;
  }

  async #boundary(token: string): Promise<Tier1BoundaryReport> {
    const k = this.#keys;
    const counts = {
      finished: 0,
      expired: 0,
      returned: 0,
      rebroadcast: 0,
      replaced: 0,
      dropped: 0,
      reverted: 0,
      sent: 0,
      sendFailed: 0,
    };
    const report = (outcome: Tier1BoundaryOutcome): Tier1BoundaryReport => ({
      outcome,
      ...counts,
    });
    const chain = this.#chain;

    // Step 1: what was sent before, in nonce order. The inclusions are read
    // before the nonce, and the index after both: a transaction included
    // between the reads looks like a consumed nonce, its record goes back to
    // the queue, and the replay then sees it counted and drops the record
    // (T-52).
    const inFlight = pairs(await this.#eval(READ_ALL, [k.inflight]))
      .map(([key, value]) => ({ key, f: readInFlight(value) }))
      .sort((a, b) => cmp(a.f.nonce, b.f.nonce));
    let heads: Tier1Heads;
    let consumed: bigint;
    const included = new Map<string, bigint | null>();
    try {
      heads = await chain.heads();
      for (const { key, f } of inFlight) {
        let block: bigint | null = null;
        for (const h of f.hashes) {
          block = await chain.included(fromHex(h));
          if (block !== null) break;
        }
        included.set(key, block);
      }
      consumed = await chain.nonce();
    } catch {
      return report("chain-unavailable");
    }
    let pending = 0;
    // The next nonce to sign at: past the nonces the chain has taken and
    // every transaction still ours to land.
    let nextNonce = consumed;
    const keep = (nonce: bigint) => {
      if (nonce + 1n > nextNonce) nextNonce = nonce + 1n;
    };
    // A nonce whose transaction was refused, and so every later one, which
    // can't land without it: their records go back to the queue, and their
    // nonces are signed again, each outbidding the transaction it replaces.
    let gap = false;
    const freed = new Map<bigint, Uint8Array>();
    const giveBack = async (key: string, f: InFlight) => {
      await this.#fenced(INFLIGHT_RETURN, [k.inflight, k.queue], token, key, f.record);
      if (f.nonce >= consumed) freed.set(f.nonce, fromHex(f.txs.at(-1) as string));
      counts.returned++;
    };
    for (const { key, f } of inFlight) {
      const block = included.get(key) ?? null;
      if (block !== null) {
        if (block <= heads.finalized) {
          await this.#fenced(INFLIGHT_DELETE, [k.inflight], token, key);
          counts.finished++;
        } else keep(f.nonce);
        continue;
      }
      // Its window's last block is final without it: it can never land.
      if (heads.finalized >= windowEnd(f.record)) {
        await this.#fenced(INFLIGHT_DELETE, [k.inflight], token, key);
        counts.expired++;
        continue;
      }
      // Its nonce went to another transaction of the account, or an earlier
      // one's did: judged again with the queue, never sent again without that.
      if (f.nonce < consumed || gap) {
        await giveBack(key, f);
        continue;
      }
      try {
        if (f.pending >= 1) {
          // Pending at a second boundary: replaced at its nonce with a
          // higher fee, kept before it is sent. A refused replacement leaves
          // the transaction it replaces, still a way to land.
          const last = fromHex(f.txs.at(-1) as string);
          const signed = await chain.sign(fromHex(f.record), f.nonce, last);
          const next: InFlight = {
            ...f,
            txs: [...f.txs, toHex(signed.tx)],
            hashes: [...f.hashes, toHex(signed.hash)],
            pending: f.pending + 1,
          };
          await this.#fenced(INFLIGHT_SET, [k.inflight], token, key, writeInFlight(next));
          if ((await chain.broadcast(signed.tx)) === "refused") await chain.broadcast(last);
          counts.replaced++;
        } else {
          if ((await chain.broadcast(fromHex(f.txs.at(-1) as string))) === "refused") {
            gap = true;
            await giveBack(key, f);
            continue;
          }
          const next: InFlight = { ...f, pending: f.pending + 1 };
          await this.#fenced(INFLIGHT_SET, [k.inflight], token, key, writeInFlight(next));
          counts.rebroadcast++;
        }
      } catch (e) {
        if (e instanceof Tier1LockError) throw e;
        return report("chain-unavailable");
      }
      keep(f.nonce);
      pending++;
    }
    // At most `TIER1_RELAY_MAX_BATCH` additions are spent a period,
    // rebroadcasts included.
    if (pending > 0) return report("pending");

    // Step 2: the index and the counting state at the latest block.
    if (!(await this.#refresh(token))) return report("index-unavailable");
    const state = this.#state as Tier1CountingState;
    if (state.broken !== null) return report("broken");

    // Step 3: the queue, in an order drawn with the CSPRNG (T-13).
    const queued: { key: string; record: Uint8Array }[] = [];
    const unusable: string[] = [];
    for (const [key, value] of pairs(await this.#eval(READ_ALL, [k.queue]))) {
      // The route queues only well-formed records of a published group; a
      // published list changed since, or a corrupted entry, is dropped.
      if (!RECORD.test(value) || recordKey(fromHex(value)) !== key) {
        unusable.push(key);
        continue;
      }
      const record = fromHex(value);
      const decoded = decodeTier1Addition(record);
      if (!decoded.ok || !this.#groups.has(decoded.value.groupId)) unusable.push(key);
      else queued.push({ key, record });
    }
    const order = selectUniformly(queued, queued.length);

    // Step 4: each against the state and the ones chosen before it.
    const judged = state.judge(
      order.map((q) => q.record),
      { limit: TIER1_RELAY_MAX_BATCH, sendMargin: TIER1_RELAY_SEND_MARGIN },
    );
    if (!judged.ok) return report("broken");
    const dropped = [...unusable];
    const chosen: { key: string; record: Uint8Array; commitment: bigint }[] = [];
    for (const [i, c] of judged.candidates.entries()) {
      const q = order[i] as (typeof order)[number];
      if (c.status === "dropped") dropped.push(q.key);
      else if (c.status === "chosen") chosen.push({ ...q, commitment: c.value.commitment });
    }
    if (dropped.length > 0) await this.#fenced(QUEUE_DROP, [k.queue], token, ...dropped);
    counts.dropped = dropped.length;

    // Step 5: in an order of their contents (T-13), each simulated first;
    // nonces only to the ones sent, consecutively.
    chosen.sort((a, b) => cmp(a.commitment, b.commitment) || compareBytes(a.record, b.record));
    for (const c of chosen) {
      let signed: Tier1SignedSend;
      try {
        if (!(await chain.simulate(c.record))) {
          await this.#fenced(QUEUE_DROP, [k.queue], token, c.key);
          counts.reverted++;
          continue;
        }
        signed = await chain.sign(c.record, nextNonce, freed.get(nextNonce));
      } catch (e) {
        if (e instanceof Tier1LockError) throw e;
        // The rest stay queued, judged again at the next boundary.
        return report("chain-unavailable");
      }
      const kept: InFlight = {
        record: toHex(c.record),
        nonce: nextNonce,
        txs: [toHex(signed.tx)],
        hashes: [toHex(signed.hash)],
        pending: 0,
      };
      await this.#fenced(SEND, [k.queue, k.inflight], token, c.key, writeInFlight(kept));
      nextNonce++;
      counts.sent++;
      try {
        if ((await chain.broadcast(signed.tx)) === "refused") counts.sendFailed++;
      } catch {
        // Kept: rebroadcast at the next boundary, unchanged.
        counts.sendFailed++;
      }
    }
    return report("judged");
  }
}

/** The last L2 block in every one of the record's vouch windows: once final without it, it can never land. */
function windowEnd(record: string): bigint {
  const decoded = decodeTier1Addition(fromHex(record));
  // Only records the route checked are kept, so this is a corrupted store.
  if (!decoded.ok) throw new Error("an in-flight record doesn't decode");
  let end: bigint | null = null;
  for (const v of decoded.value.vouches) {
    const e = v.rootBlock + VOUCH_ROOT_WINDOW;
    if (end === null || e < end) end = e;
  }
  return end as bigint;
}
