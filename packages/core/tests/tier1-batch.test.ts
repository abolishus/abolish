import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type ContractEventRecord,
  countTier1Additions,
  decodeTier1Addition,
  type GroupRegistryEvent,
  type Tier1CountContext,
  VOUCH_ROOT_WINDOW,
} from "@abolishus/crypto";
import fc from "fast-check";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  parseTier1Index,
  recordKey,
  TIER1_RELAY_MAX_BATCH,
  TIER1_RELAY_PERIOD,
  TIER1_RELAY_SEND_MARGIN,
  Tier1Batches,
  type Tier1BoundaryReport,
  type Tier1Chain,
  type Tier1Heads,
  tier1Keys,
  Tier1LockError,
  type Tier1SignedSend,
} from "../src/index.ts";

// The Tier 1 relay's job against a live Redis and an in-memory group
// registry and account (docs/spec/tier1-relay.md, Queue, The batch and The
// counting state): what is sent counts under one replay of the registry's
// events followed by the sent records, at most `TIER1_RELAY_MAX_BATCH` a
// boundary, in an order of their contents; a sent record's transaction is
// kept before it is sent, rebroadcast unchanged, replaced at its nonce only
// at a second boundary, and judged again only once its nonce went elsewhere
// or the node refused it; nothing new is sent while one is pending; a
// record that can never land is deleted; a reorganisation rebuilds the
// counting state; a node that answers inconsistently is never read from;
// and Redis keeps nothing about a request beyond the records and the
// transactions the chain shows (T-10, T-13, T-25, T-52, T-53, T-71).
//
// The registry's history is docs/spec/vectors/vouch-count.json's
// `deployment` case, whose verdicts are written by hand from
// docs/spec/vouching.md: up to block 1,260,099 it holds the groups and Tier 2
// records and no Tier 1 addition, so its logged additions stand for queued
// records, judged as if logged in block 1,260,100.

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

interface EventVector {
  readonly kind: "group-created" | "members-added" | "members-removed" | "tier1-addition";
  readonly block: string;
  readonly groupId?: string;
  readonly tier?: number;
  readonly record?: string;
}
const read = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../docs/spec/vectors/${name}`, import.meta.url), "utf8"),
  ) as unknown;
const vectors = read("vouch-count.json") as {
  readonly context: {
    readonly chainId: string;
    readonly registry: string;
    readonly registrars: readonly string[];
    readonly threshold: number;
  };
  readonly cases: readonly { readonly id: string; readonly events: readonly EventVector[] }[];
};
// Topic 0 of each group-registry event, from the independent generator of
// contract-event-v6.json, so the logs built below are the registry's.
const eventVectors = read("contract-event-v6.json") as {
  readonly events: readonly { readonly signature: string; readonly topic0: string }[];
};

const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sha256 = (s: string | Uint8Array) => new Uint8Array(createHash("sha256").update(s).digest());

const ctx: Tier1CountContext = {
  chainId: BigInt(vectors.context.chainId),
  registry: bytes(vectors.context.registry),
  registrars: vectors.context.registrars.map(bytes),
  threshold: vectors.context.threshold,
};

function events(list: readonly EventVector[]): GroupRegistryEvent[] {
  return list.map((e) => {
    const block = BigInt(e.block);
    if (e.kind === "group-created")
      return { kind: e.kind, block, groupId: BigInt(e.groupId ?? ""), tier: e.tier as number };
    if (e.kind === "members-added" || e.kind === "members-removed")
      return {
        kind: e.kind,
        block,
        groupId: BigInt(e.groupId ?? ""),
        record: bytes(e.record ?? ""),
      };
    return { kind: e.kind, block, record: bytes(e.record ?? "") };
  });
}
const caseEvents = (id: string) => {
  const c = vectors.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return events(c.events);
};

const DEPLOYMENT = caseEvents("deployment");
const B = 1_260_099n;
// The history before any Tier 1 addition, as the registry logs it: without
// event 4, a Tier 0 record that doesn't decode, which the vectors carry to
// test the replay and the registry never logs.
const HISTORY = DEPLOYMENT.filter((e, i) => e.block <= B && i !== 4);
const at = (i: number) => {
  const e = DEPLOYMENT[i];
  if (e?.kind !== "tier1-addition") throw new Error(`event ${i} isn't a Tier 1 addition`);
  return e.record;
};
// Group 9, the published group. 13 and 17 count, in either order; 14 and 15
// share 13's commitment (and 14 a slot of it); 27 and 28 name made-up Tier 2
// groups and 29 a root the registry never had, so they never count.
const GROUP = 9n;
const R13 = at(13);
const R14 = at(14);
const R15 = at(15);
const R17 = at(17);
const JUNK = [at(27), at(28), at(29)];
// Group 10, a Tier 1 group the relay doesn't publish.
const R18 = at(18);
const commitment = (r: Uint8Array) => {
  const d = decodeTier1Addition(r);
  if (!d.ok) throw new Error("undecodable vector record");
  return d.value.commitment;
};
const windowEnd = (r: Uint8Array) => {
  const d = decodeTier1Addition(r);
  if (!d.ok) throw new Error("undecodable vector record");
  return d.value.vouches
    .map((v) => v.rootBlock + VOUCH_ROOT_WINDOW)
    .reduce((x, y) => (x < y ? x : y));
};

const topic0 = (signature: string) => {
  const found = eventVectors.events.find((e) => e.signature === signature);
  if (found === undefined) throw new Error(`no event ${signature}`);
  return bytes(found.topic0);
};
const word = (v: bigint) => bytes(v.toString(16).padStart(64, "0"));
const abiBytes = (b: Uint8Array) => {
  const padded = new Uint8Array(Math.ceil(b.length / 32) * 32);
  padded.set(b);
  return Uint8Array.from([...word(32n), ...word(BigInt(b.length)), ...padded]);
};
const u64At = (b: Uint8Array, offset: number) =>
  new DataView(b.buffer, b.byteOffset).getBigUint64(offset, false);

function logOf(e: GroupRegistryEvent, n: bigint): ContractEventRecord {
  const base = {
    contract: ctx.registry,
    n,
    l2_block: e.block,
    l2_timestamp: 1_760_000_000n + e.block * 2n,
  };
  if (e.kind === "group-created")
    return {
      ...base,
      topics: [topic0("GroupCreated(uint64,uint8)"), word(e.groupId), word(BigInt(e.tier))],
      data: new Uint8Array(0),
    };
  if (e.kind === "members-added")
    return {
      ...base,
      topics: [
        topic0("MembersAdded(uint64,uint64,bytes)"),
        word(e.groupId),
        word(e.firstIndex ?? u64At(e.record, 8)),
      ],
      data: abiBytes(e.record),
    };
  if (e.kind === "members-removed")
    return {
      ...base,
      topics: [topic0("MembersRemoved(uint64,bytes)"), word(e.groupId)],
      data: abiBytes(e.record),
    };
  if (e.kind !== "tier1-addition") throw new Error(`no log here for ${e.kind}`);
  return { ...base, topics: [topic0("Tier1MemberAdded(bytes)")], data: abiBytes(e.record) };
}

const pinnedLog = (registrars: readonly Uint8Array[] = ctx.registrars): ContractEventRecord => ({
  contract: ctx.registry,
  n: 0n,
  l2_block: 1n,
  l2_timestamp: 1_760_000_002n,
  topics: [topic0("RegistrarsPinned(uint8,address[])")],
  data: Uint8Array.from([
    ...word(BigInt(ctx.threshold)),
    ...word(64n),
    ...word(BigInt(registrars.length)),
    ...registrars.flatMap((r) => [...new Uint8Array(12), ...r]),
  ]),
});

interface Tx {
  readonly record: Uint8Array;
  readonly nonce: bigint;
}

/**
 * The group registry and the relay's account as one L2 node shows them: the
 * registry's events in log order, block hashes that change from a fork's
 * height on, and transactions that are broadcast, then mined into a block
 * that logs their record.
 */
class FakeChain implements Tier1Chain {
  readonly logged: GroupRegistryEvent[];
  pinned = pinnedLog();
  latest = B;
  safe = B - 100n;
  finalized = B - 200n;
  #fork = 0;
  #forkFrom = 0n;
  readonly txs = new Map<string, Tx>();
  readonly mined = new Map<string, bigint>();
  /** Nonces another transaction of the account took. */
  readonly foreign = new Set<bigint>();
  readonly broadcasts: Uint8Array[] = [];
  readonly signs: { record: Uint8Array; nonce: bigint; replacing: Uint8Array | undefined }[] = [];
  readonly simulated: Uint8Array[] = [];
  readonly recordCalls: (bigint | null)[] = [];
  readonly refuse = new Set<string>();
  /** Signs every replacement as the transaction it replaces, as an adapter at its fee cap. */
  capped = false;
  readonly reverts = new Set<string>();
  down = false;
  /** Blocks every read but `nonce` lags the true latest by: a backend behind another. */
  lag = 0n;
  /** Called on a broadcast the fake refuses, before it answers. */
  onRefuse: ((tx: Uint8Array) => void) | undefined;
  /** Applied to `records`' answer, once set. */
  tamper: ((records: ContractEventRecord[]) => ContractEventRecord[]) | undefined;
  /** Called after `records` reads, once: a reorganisation mid-read, say. */
  afterRecords: (() => void) | undefined;

  constructor(history: readonly GroupRegistryEvent[] = HISTORY) {
    this.logged = history.slice();
  }

  #check() {
    if (this.down) return Promise.reject(new Error("node down"));
    return Promise.resolve();
  }

  hash(n: bigint): Uint8Array {
    return sha256(`${n >= this.#forkFrom ? this.#fork : 0}:${n}`);
  }

  /** Every block from `from` on gets a new hash, and the logs there are replaced by `logs`. */
  reorg(from: bigint, logs: readonly GroupRegistryEvent[] = []) {
    this.#fork++;
    this.#forkFrom = from;
    const kept = this.logged.filter((e) => e.block < from);
    this.logged.length = 0;
    this.logged.push(...kept, ...logs);
    for (const [h, block] of this.mined) if (block >= from) this.mined.delete(h);
  }

  async heads(): Promise<Tier1Heads> {
    await this.#check();
    const latest = this.latest - this.lag;
    return {
      latest: { number: latest, hash: this.hash(latest) },
      safe: this.safe,
      finalized: this.finalized,
    };
  }

  async blockHash(n: bigint) {
    await this.#check();
    return n > this.latest ? null : this.hash(n);
  }

  async records(after: bigint | null, through: bigint) {
    await this.#check();
    this.recordCalls.push(after);
    const all = [this.pinned, ...this.logged.map((e, i) => logOf(e, BigInt(i + 1)))];
    let out = all.filter((r) => r.l2_block > (after ?? -1n) && r.l2_block <= through);
    if (this.tamper) out = this.tamper(out);
    const hook = this.afterRecords;
    this.afterRecords = undefined;
    hook?.();
    return out;
  }

  /** Read at the true latest block, whatever `lag` the other reads have. */
  async nonce() {
    await this.#check();
    const taken = new Set(this.foreign);
    for (const [h, block] of this.mined)
      if (block <= this.latest) taken.add((this.txs.get(h) as Tx).nonce);
    return { count: BigInt(taken.size), at: { number: this.latest, hash: this.hash(this.latest) } };
  }

  async included(hash: Uint8Array) {
    await this.#check();
    const block = this.mined.get(hex(hash));
    return block !== undefined && block <= this.latest - this.lag ? block : null;
  }

  async simulate(record: Uint8Array) {
    await this.#check();
    this.simulated.push(record);
    return !this.reverts.has(hex(record));
  }

  async sign(record: Uint8Array, nonce: bigint, replacing?: Uint8Array): Promise<Tier1SignedSend> {
    await this.#check();
    this.signs.push({ record, nonce, replacing });
    // At its fee cap an adapter can't outbid, and signs what it replaces.
    if (this.capped && replacing !== undefined)
      return { tx: replacing.slice(), hash: sha256(replacing) };
    const tx = Uint8Array.from([
      ...new TextEncoder().encode(`tx:${nonce}:${this.signs.length}:`),
      ...record,
    ]);
    const hash = sha256(tx);
    this.txs.set(hex(hash), { record, nonce });
    return { tx, hash };
  }

  async broadcast(tx: Uint8Array) {
    await this.#check();
    this.broadcasts.push(tx);
    if (!this.refuse.has(hex(tx))) return "sent" as const;
    this.onRefuse?.(tx);
    return "refused" as const;
  }

  /** Mines the transaction into `block`, logging its record there. */
  mine(tx: Uint8Array, block: bigint) {
    const h = hex(sha256(tx));
    const sent = this.txs.get(h);
    if (sent === undefined) throw new Error("unknown transaction");
    this.mined.set(h, block);
    this.log({ kind: "tier1-addition", block, record: sent.record });
  }

  log(e: GroupRegistryEvent) {
    const last = this.logged.at(-1);
    if (last !== undefined && last.block > e.block) throw new Error("logs out of order");
    this.logged.push(e);
  }

  /** Moves every head to `latest`. */
  advance(latest: bigint, finalized = latest - 200n) {
    this.latest = latest;
    this.safe = latest - 100n > finalized ? latest - 100n : finalized;
    this.finalized = finalized;
  }
}

const NOW = 1_800_000_000 - (1_800_000_000 % TIER1_RELAY_PERIOD) + 5;

let redis: Redis;
let run = 0;
let prefix: string;
let clock = NOW;
beforeAll(() => {
  redis = new Redis(redisUrl);
});
afterAll(async () => {
  await redis.quit();
});
beforeEach(() => {
  prefix = `test-tier1-batch-${process.pid}-${Date.now()}-${run++}`;
  clock = NOW;
});
afterEach(async () => {
  const left = await allKeys();
  if (left.length > 0) await redis.del(...left);
});

async function allKeys() {
  const found: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 1000);
    cursor = next;
    found.push(...batch);
  } while (cursor !== "0");
  return found.sort();
}

const keys = () => tier1Keys(prefix);

function job(chain: FakeChain, groups = new Map([[0, GROUP]])) {
  return new Tier1Batches({
    redis,
    chain,
    groups,
    chainId: ctx.chainId,
    registry: ctx.registry,
    registrars: ctx.registrars,
    threshold: ctx.threshold,
    version: 7,
    now: () => clock,
    prefix,
  });
}

const enqueue = (...records: Uint8Array[]) =>
  Promise.all(records.map((r) => redis.hset(keys().queue, recordKey(r), hex(r))));
const queued = async () => Object.values(await redis.hgetall(keys().queue)).sort();
const inFlight = async () =>
  Object.entries(await redis.hgetall(keys().inflight)).map(([key, v]) => ({
    key,
    ...(JSON.parse(v) as {
      record: string;
      nonce: string;
      txs: string[];
      hashes: string[];
      pending: number;
    }),
  }));

/** The next period's boundary. */
async function boundary(j: Tier1Batches): Promise<Tier1BoundaryReport> {
  const report = await j.runBoundary();
  clock += TIER1_RELAY_PERIOD;
  if (report === null) throw new Error("the boundary had already run");
  return report;
}

const report = (
  outcome: Tier1BoundaryReport["outcome"],
  counts: Partial<Tier1BoundaryReport> = {},
) => ({
  outcome,
  finished: 0,
  expired: 0,
  returned: 0,
  rebroadcast: 0,
  replaced: 0,
  refused: 0,
  dropped: 0,
  reverted: 0,
  sent: 0,
  sendFailed: 0,
  ...counts,
});

/** The records signed, in the order signed. */
const signedRecords = (chain: FakeChain) => chain.signs.map((s) => hex(s.record));

/** Whether every record counts when logged in order in block `b + 1` after `history`. */
function allCount(
  history: readonly GroupRegistryEvent[],
  b: bigint,
  records: readonly Uint8Array[],
) {
  const appended: GroupRegistryEvent[] = records.map((record) => ({
    kind: "tier1-addition",
    block: b + 1n,
    record,
  }));
  const counted = countTier1Additions([...history, ...appended], ctx).additions;
  return counted.slice(-records.length).every((a) => a.verdict.ok);
}

describe("Tier1Batches: the index", () => {
  test("writes the latest block and the safe head, dated when the read began", async () => {
    const chain = new FakeChain();
    expect(await job(chain).refreshIndex()).toBe(true);
    expect(parseTier1Index(await redis.get(keys().index))).toEqual({
      at: NOW,
      latest: B,
      safe: B - 100n,
    });
  });

  test("extends the counting state by the new blocks only, and rebuilds it on a reorganisation", async () => {
    const chain = new FakeChain();
    const j = job(chain);
    await j.refreshIndex();
    chain.advance(B + 50n);
    await j.refreshIndex();
    // A reorganisation above the state's block leaves it standing.
    chain.advance(B + 60n);
    chain.reorg(B + 55n);
    await j.refreshIndex();
    chain.advance(B + 70n);
    chain.reorg(B + 45n);
    await j.refreshIndex();
    // The whole history, then from the last block read each time, then the
    // whole history again once that block's hash changed.
    expect(chain.recordCalls).toEqual([null, B, B + 50n, null]);
  });

  test.each([
    ["a node behind the block already read", (c: FakeChain) => c.advance(B - 1n, B - 300n)],
    ["heads out of order", (c: FakeChain) => (c.safe = c.latest + 1n)],
    ["a node that drops a log", (c: FakeChain) => (c.tamper = (r) => r.filter((x) => x.n !== 3n))],
    [
      "a node that repeats a log",
      (c: FakeChain) => (c.tamper = (r) => [...r, r.at(-1) as ContractEventRecord]),
    ],
    [
      "other registrars pinned",
      (c: FakeChain) => (c.pinned = pinnedLog([...ctx.registrars].reverse())),
    ],
    [
      "a log the registry never emits",
      (c: FakeChain) => (c.tamper = (r) => r.map((x) => (x.n === 2n ? { ...x, topics: [] } : x))),
    ],
    ["a reorganisation mid-read", (c: FakeChain) => (c.afterRecords = () => c.reorg(c.latest))],
    ["a node that can't be reached", (c: FakeChain) => (c.down = true)],
  ])("refuses %s and leaves the index as it was", async (_, spoil) => {
    const chain = new FakeChain();
    const j = job(chain);
    // A first read only where the case needs one to be behind.
    if (_ === "a node behind the block already read") await j.refreshIndex();
    const before = await redis.get(keys().index);
    clock += 30;
    spoil(chain);
    expect(await j.refreshIndex()).toBe(false);
    expect(await redis.get(keys().index)).toBe(before);
  });

  test("refuses to start under pins the counting state can't take", () => {
    expect(
      () =>
        new Tier1Batches({
          redis,
          chain: new FakeChain(),
          groups: new Map([[0, GROUP]]),
          chainId: ctx.chainId,
          registry: ctx.registry,
          registrars: ctx.registrars,
          threshold: ctx.registrars.length + 1,
          version: 7,
          now: () => clock,
          prefix,
        }),
    ).toThrow();
    expect(() => job(new FakeChain(), new Map([[1, GROUP]]))).toThrow(RangeError);
  });

  test("one runner at a time", async () => {
    const chain = new FakeChain();
    const j = job(chain);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const original = chain.heads.bind(chain);
    chain.heads = async () => {
      await held;
      return original();
    };
    const first = j.refreshIndex();
    await expect(job(chain).refreshIndex()).rejects.toBeInstanceOf(Tier1LockError);
    await expect(job(chain).runBoundary()).rejects.toBeInstanceOf(Tier1LockError);
    release();
    expect(await first).toBe(true);
  });
});

// Judging verifies Groth16 proofs, a second or more a record on a slow runner.
describe("Tier1Batches: a boundary", { timeout: 120_000 }, () => {
  test("sends what counts in commitment order at consecutive nonces, and drops what doesn't", async () => {
    const chain = new FakeChain();
    const j = job(chain);
    await enqueue(R13, R17, ...JUNK);
    expect(await boundary(j)).toEqual(report("judged", { sent: 2, dropped: 3 }));
    const sorted = [R13, R17].sort((a, b) => (commitment(a) < commitment(b) ? -1 : 1));
    expect(signedRecords(chain)).toEqual(sorted.map(hex));
    expect(chain.signs.map((s) => [s.nonce, s.replacing])).toEqual([
      [0n, undefined],
      [1n, undefined],
    ]);
    // Each simulated before it was signed, and broadcast once.
    expect(chain.simulated.map(hex)).toEqual(sorted.map(hex));
    expect(chain.broadcasts).toHaveLength(2);
    expect(await queued()).toEqual([]);
    const kept = await inFlight();
    const byNonce = (a: { nonce: string }, b: { nonce: string }) =>
      Number(a.nonce) - Number(b.nonce);
    expect(kept.sort(byNonce).map((f) => [f.record, f.nonce, f.pending, f.txs.length])).toEqual(
      sorted.map((r, i) => [hex(r), String(i), 0, 1]),
    );
    expect(await allKeys()).toEqual([keys().boundary, keys().index, keys().inflight].sort());
  });

  test("of records that spend one slot or add one commitment, sends one", async () => {
    const chain = new FakeChain();
    await enqueue(R13, R14, R15);
    expect(await boundary(job(chain))).toEqual(report("judged", { sent: 1, dropped: 2 }));
    expect(
      allCount(
        HISTORY,
        B,
        chain.signs.map((s) => s.record),
      ),
    ).toBe(true);
  });

  test("whatever is queued, the batch counts under one replay followed by it, in its order", () => {
    // A small number of runs: each judges several records' Groth16 proofs.
    const pool = [R13, R14, R15, at(16), R17, ...JUNK, at(39), at(40)];
    return fc.assert(
      fc.asyncProperty(fc.subarray(pool, { minLength: 1 }), async (records) => {
        prefix = `test-tier1-batch-${process.pid}-${Date.now()}-${run++}`;
        const chain = new FakeChain();
        await enqueue(...records);
        const got = await boundary(job(chain));
        const sent = chain.signs.map((s) => s.record);
        expect(got.outcome).toBe("judged");
        expect(got.sent + got.dropped).toBe(new Set(records.map(hex)).size);
        expect(sent.length).toBeLessThanOrEqual(TIER1_RELAY_MAX_BATCH);
        expect(allCount(HISTORY, B, sent)).toBe(true);
        // And nothing that would count after them is dropped.
        for (const r of records)
          if (!sent.some((x) => hex(x) === hex(r)))
            expect(allCount(HISTORY, B, [...sent, r])).toBe(false);
        for (let i = 1; i < sent.length; i++)
          expect(commitment(sent[i - 1] as Uint8Array) <= commitment(sent[i] as Uint8Array)).toBe(
            true,
          );
        const left = await allKeys();
        if (left.length > 0) await redis.del(...left);
      }),
      { numRuns: Math.min(numRuns, 8) },
    );
  }, 600_000);

  test("drops a record of a group the relay doesn't publish", async () => {
    const chain = new FakeChain();
    await enqueue(R18);
    expect(await boundary(job(chain))).toEqual(report("judged", { dropped: 1 }));
    expect(chain.simulated).toEqual([]);
  });

  test("drops a record with less than the send margin left in a vouch's window", async () => {
    const end = windowEnd(R13);
    const chain = new FakeChain();
    chain.advance(end - TIER1_RELAY_SEND_MARGIN + 1n, B - 200n);
    await enqueue(R13);
    expect(await boundary(job(chain))).toEqual(report("judged", { dropped: 1 }));
    const fits = new FakeChain();
    fits.advance(end - TIER1_RELAY_SEND_MARGIN, B - 200n);
    await enqueue(R13);
    expect(await boundary(job(fits))).toEqual(report("judged", { sent: 1 }));
  });

  test("a record whose simulation reverts is dropped and takes no nonce", async () => {
    const chain = new FakeChain();
    const [first, second] = [R13, R17].sort((a, b) => (commitment(a) < commitment(b) ? -1 : 1));
    chain.reverts.add(hex(first as Uint8Array));
    await enqueue(R13, R17);
    expect(await boundary(job(chain))).toEqual(report("judged", { sent: 1, reverted: 1 }));
    expect(chain.signs.map((s) => [hex(s.record), s.nonce])).toEqual([
      [hex(second as Uint8Array), 0n],
    ]);
    expect(await queued()).toEqual([]);
  });

  test("runs once a period", async () => {
    const chain = new FakeChain();
    const j = job(chain);
    expect(await j.runBoundary()).not.toBeNull();
    clock += TIER1_RELAY_PERIOD - 10;
    expect(await j.runBoundary()).toBeNull();
    clock += 10;
    expect(await j.runBoundary()).not.toBeNull();
  });

  test("a broken Tier 2 history stops the boundary with the queue kept", async () => {
    const broken = caseEvents("broken-tier2");
    const last = broken.reduce((m, e) => (e.block > m ? e.block : m), 0n);
    const chain = new FakeChain(broken.filter((e) => e.kind !== "tier1-addition"));
    chain.advance(last, last - 200n);
    await enqueue(R13);
    expect(await boundary(job(chain))).toEqual(report("broken"));
    expect(await queued()).toEqual([hex(R13)]);
  });

  test("a node that can't be reached changes nothing", async () => {
    const chain = new FakeChain();
    await enqueue(R13);
    chain.down = true;
    expect(await boundary(job(chain))).toEqual(report("chain-unavailable"));
    expect(await queued()).toEqual([hex(R13)]);
    expect(await redis.hlen(keys().inflight)).toBe(0);
  });

  test("a send the node doesn't take stays in flight, kept before it was sent", async () => {
    const chain = new FakeChain();
    const original = chain.broadcast.bind(chain);
    let seen: number | undefined;
    chain.broadcast = async (tx) => {
      seen = await redis.hlen(keys().inflight);
      await original(tx);
      throw new Error("timeout");
    };
    await enqueue(R13);
    expect(await boundary(job(chain))).toEqual(report("judged", { sent: 1, sendFailed: 1 }));
    expect(seen).toBe(1);
    expect(await inFlight()).toHaveLength(1);
  });
});

describe("Tier1Batches: what was sent", { timeout: 120_000 }, () => {
  // One boundary that sends R13 and R17, then the chain as each test sets it.
  async function sent() {
    const chain = new FakeChain();
    const j = job(chain);
    await enqueue(R13, R17);
    await boundary(j);
    const txs = chain.broadcasts.slice();
    return { chain, j, txs };
  }

  test("a pending send is rebroadcast unchanged, replaced at its nonce at a second boundary, and nothing new is sent", async () => {
    const { chain, j, txs } = await sent();
    await enqueue(R15);
    expect(await boundary(j)).toEqual(report("pending", { rebroadcast: 2 }));
    expect(chain.broadcasts.slice(2).map(hex)).toEqual(txs.map(hex));
    expect(chain.signs).toHaveLength(2);
    expect(await boundary(j)).toEqual(report("pending", { replaced: 2 }));
    // Each replacement carries the same record at the same nonce, outbidding
    // the transaction it replaces.
    expect(
      chain.signs.slice(2).map((s) => [hex(s.record), s.nonce, hex(s.replacing as Uint8Array)]),
    ).toEqual(
      chain.signs.slice(0, 2).map((s, i) => [hex(s.record), s.nonce, hex(txs[i] as Uint8Array)]),
    );
    expect((await inFlight()).map((f) => f.hashes.length)).toEqual([2, 2]);
    expect(await queued()).toEqual([hex(R15)]);
    // The original lands: found by its own hash, among the record's.
    for (const tx of txs) chain.mine(tx, B + 1n);
    chain.advance(B + 2n, B - 200n);
    expect(await boundary(j)).toEqual(report("judged", { dropped: 1 }));
  });

  test("a replacement at the adapter's fee cap is the transaction already kept, kept once", async () => {
    const { chain, j, txs } = await sent();
    chain.capped = true;
    expect(await boundary(j)).toEqual(report("pending", { rebroadcast: 2 }));
    for (let i = 0; i < 3; i++)
      expect(await boundary(j)).toEqual(report("pending", { replaced: 2 }));
    const kept = await inFlight();
    expect(kept.map((f) => f.hashes.length)).toEqual([1, 1]);
    expect(kept.flatMap((f) => f.txs).sort()).toEqual(txs.map(hex).sort());
    expect(kept.map((f) => f.pending)).toEqual([4, 4]);
  });

  test("a landed send is kept until final, then deleted", async () => {
    const { chain, j, txs } = await sent();
    for (const tx of txs) chain.mine(tx, B + 1n);
    chain.advance(B + 2n, B);
    expect(await boundary(j)).toEqual(report("judged"));
    expect(await inFlight()).toHaveLength(2);
    chain.advance(B + 3n, B + 1n);
    expect(await boundary(j)).toEqual(report("judged", { finished: 2 }));
    expect(await inFlight()).toHaveLength(0);
  });

  test("a nonce another transaction took sends the record back to be judged, and a copy that landed drops it", async () => {
    const { chain, j } = await sent();
    // A copy of R13 lands first from someone else; the relay's nonces go to
    // other transactions of its account.
    chain.log({ kind: "tier1-addition", block: B + 1n, record: R13 });
    chain.foreign.add(0n);
    chain.foreign.add(1n);
    chain.advance(B + 2n, B - 200n);
    const got = await boundary(j);
    expect(got).toMatchObject({ outcome: "judged", returned: 2 });
    // R17 still counts and is sent again at the next nonce; R13 doesn't.
    expect(got.sent).toBe(1);
    expect(chain.signs.at(-1)).toMatchObject({ nonce: 2n, replacing: undefined });
    expect(hex(chain.signs.at(-1)?.record as Uint8Array)).toBe(hex(R17));
    expect(got.dropped).toBe(1);
  });

  test("a refused send whose nonce is still free stays in flight and is replaced at the next boundary", async () => {
    const { chain, j, txs } = await sent();
    chain.refuse.add(hex(txs[0] as Uint8Array));
    expect(await boundary(j)).toEqual(report("pending", { refused: 1, rebroadcast: 1 }));
    expect(await queued()).toEqual([]);
    expect(chain.signs).toHaveLength(2);
    expect(await boundary(j)).toEqual(report("pending", { replaced: 2 }));
    expect(chain.signs.slice(2).map((s) => [s.nonce, hex(s.replacing as Uint8Array)])).toEqual([
      [0n, hex(txs[0] as Uint8Array)],
      [1n, hex(txs[1] as Uint8Array)],
    ]);
  });

  test("a send refused because it landed meanwhile is kept, and nothing is given back or sent", async () => {
    const { chain, j, txs } = await sent();
    const first = txs[0] as Uint8Array;
    chain.refuse.add(hex(first));
    chain.onRefuse = (tx) => {
      chain.mine(tx, B + 1n);
      chain.advance(B + 1n, B - 200n);
    };
    expect(await boundary(j)).toEqual(report("pending", { rebroadcast: 1 }));
    expect(await queued()).toEqual([]);
    expect(await inFlight()).toHaveLength(2);
    expect(chain.signs).toHaveLength(2);
  });

  test("a record given back for a taken nonce isn't judged against a history older than that nonce", async () => {
    const { chain, j, txs } = await sent();
    // Both land in B + 1, but every read except the nonce's comes from a
    // backend a block behind, which doesn't show them.
    for (const tx of txs) chain.mine(tx, B + 1n);
    chain.advance(B + 1n, B - 200n);
    chain.lag = 1n;
    expect(await boundary(j)).toEqual(report("index-unavailable", { returned: 2 }));
    expect(chain.signs).toHaveLength(2);
    expect(await queued()).toHaveLength(2);
    // Once the replay reaches the nonce's block, it sees both counted.
    chain.lag = 0n;
    expect(await boundary(j)).toEqual(report("judged", { dropped: 2 }));
    expect(chain.signs).toHaveLength(2);
  });

  test("a send that can never land is deleted once its window's last block is final", async () => {
    const { chain, j } = await sent();
    const end = windowEnd(R13) < windowEnd(R17) ? windowEnd(R13) : windowEnd(R17);
    chain.advance(end + 200n, end - 1n);
    expect((await boundary(j)).expired).toBe(0);
    chain.advance(end + 201n, end);
    expect((await boundary(j)).expired).toBe(2);
    expect(await inFlight()).toHaveLength(0);
  });

  test("a reorganisation that removes a landed send's block sees it pending again", async () => {
    const { chain, j, txs } = await sent();
    for (const tx of txs) chain.mine(tx, B + 1n);
    chain.advance(B + 2n, B - 200n);
    expect(await boundary(j)).toEqual(report("judged"));
    chain.reorg(B + 1n);
    expect(await boundary(j)).toEqual(report("pending", { rebroadcast: 2 }));
  });

  test("keeps nothing about a request: no time, address or order", async () => {
    await sent();
    for (const f of await inFlight())
      expect(Object.keys(f).sort()).toEqual(["hashes", "key", "nonce", "pending", "record", "txs"]);
    expect(await allKeys()).toEqual([keys().boundary, keys().index, keys().inflight].sort());
  });
});
