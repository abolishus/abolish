import { readFileSync } from "node:fs";
import {
  BN254_R,
  checkGroupApprovals,
  decodeGroupAddition,
  encodeGroupAddition,
  GROUP_REGISTRY_MAX_BATCH,
  groupAdditionDigest,
  groupRegistryDomainSeparator,
  POSEIDON2_ZERO_ONE,
  signGroupApproval,
} from "@abolishus/crypto";
import fc from "fast-check";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  commitmentKey,
  MAX_REGISTRATION_HOLD,
  MIN_REGISTRATION_BATCH,
  REGISTRATION_PERIOD,
  REGISTRATION_QUEUE_MAX,
  selectUniformly,
  Tier0Batches,
  type Tier0Chain,
  type Tier0GroupState,
  tier0Keys,
  Tier0LockError,
  type Tier0LoggedAddition,
  type Tier0Redis,
  Tier0Registrations,
} from "../src/index.ts";

// Tier 0 registration's batch job against a live Redis and an in-memory group
// registry (docs/spec/registration.md, Queue and The batch): one batch per
// position, resubmitted unchanged until it lands and abandoned only once
// finalized history shows it never can; a short queue held at most
// `MAX_REGISTRATION_HOLD` boundaries; at most `MAX_BATCH` per batch, chosen
// at random and sorted; nothing live, in flight or forbidden signed; the
// queue's counts kept exact; and Redis holding nothing about a registration
// beyond the commitments and the records the chain shows (T-06, T-10, T-13,
// T-16, T-52).

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

interface RegistrarVectors {
  readonly threshold: number;
  readonly secretKeys: readonly string[];
  readonly addresses: readonly string[];
  readonly outsiderSecretKey: string;
}
const vectors = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/group-registry.json", import.meta.url), "utf8"),
) as { registrars: RegistrarVectors };
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const REGISTRARS = vectors.registrars.addresses.map(bytes);
const SECRETS = vectors.registrars.secretKeys.map(bytes);
const THRESHOLD = vectors.registrars.threshold;
const CHAIN_ID = 421_614n;
const REGISTRY = bytes("5fbdb2315678afecb367f032d93f642f64180aa3");
const DOMAIN = groupRegistryDomainSeparator(CHAIN_ID, REGISTRY);

const GROUP = 7n;
const NOW = 1_800_000_000;

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
  prefix = `test-tier0-batch-${process.pid}-${Date.now()}-${run++}`;
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

const keys = () => tier0Keys(prefix);
const cmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

interface Logged {
  readonly record: Uint8Array;
  readonly firstIndex: bigint;
  readonly commitments: readonly bigint[];
  final: boolean;
}

/**
 * The group registry as the batch job sees it: each group's additions in
 * order, applied only at the group's count with approvals the pinned set
 * accepts (docs/spec/contracts.md, Group registry, Additions), each final or
 * not; plus self-paid commitments in other Tier 0 groups.
 */
class FakeChain implements Tier0Chain {
  readonly logs = new Map<bigint, Logged[]>();
  readonly tiers = new Map<bigint, number>();
  readonly selfPaid = new Set<bigint>();
  readonly submitted: Uint8Array[] = [];
  down = false;
  submitFails = false;
  /** Called during the next chain read, once: a stall, say. */
  onRead: (() => Promise<void>) | undefined;
  /** Answers `group` from a node at another block, while set. */
  staleGroup: Tier0GroupState | undefined;
  /** Answers `additionAt` from a node that hasn't seen any addition, while set. */
  staleAdditions = false;

  constructor(groups: readonly bigint[] = [GROUP]) {
    for (const g of groups) {
      this.logs.set(g, []);
      this.tiers.set(g, 0);
    }
  }

  async #read() {
    const hook = this.onRead;
    this.onRead = undefined;
    if (hook) await hook();
    if (this.down) throw new Error("node down");
  }

  async tier0Commitments(): Promise<Iterable<bigint>> {
    await this.#read();
    const all = [...this.selfPaid];
    for (const [g, logs] of this.logs)
      if (this.tiers.get(g) === 0) for (const l of logs) all.push(...l.commitments);
    return all;
  }

  async group(groupId: bigint): Promise<Tier0GroupState> {
    await this.#read();
    if (this.staleGroup !== undefined) return this.staleGroup;
    const logs = this.logs.get(groupId) ?? [];
    const size = (ls: readonly Logged[]) =>
      ls.reduce((n, l) => n + BigInt(l.commitments.length), 0n);
    return {
      tier: this.tiers.get(groupId) ?? 0,
      finalizedSize: size(logs.filter((l) => l.final)),
      latestSize: size(logs),
    };
  }

  async additionAt(groupId: bigint, firstIndex: bigint): Promise<Tier0LoggedAddition | null> {
    await this.#read();
    if (this.staleAdditions) return null;
    const l = (this.logs.get(groupId) ?? []).find((x) => x.firstIndex === firstIndex);
    return l === undefined ? null : { record: l.record.slice(), final: l.final };
  }

  async submit(record: Uint8Array): Promise<void> {
    await this.#read();
    this.submitted.push(record.slice());
    if (this.submitFails) throw new Error("bundler refused");
    this.land(record);
  }

  /** Applies a record as the registry would, or ignores it (a revert). */
  land(record: Uint8Array, final = false) {
    const d = decodeGroupAddition(record);
    if (!d.ok) return;
    const logs = this.logs.get(d.value.groupId);
    if (logs === undefined) return;
    const count = logs.reduce((n, l) => n + BigInt(l.commitments.length), 0n);
    if (d.value.firstIndex !== count) return;
    const digest = groupAdditionDigest(DOMAIN, {
      groupId: d.value.groupId,
      tier: this.tiers.get(d.value.groupId) ?? 0,
      firstIndex: d.value.firstIndex,
      commitments: d.value.commitments,
    });
    if (!checkGroupApprovals(digest, d.value.approvals, REGISTRARS, THRESHOLD).ok) return;
    logs.push({
      record: record.slice(),
      firstIndex: d.value.firstIndex,
      commitments: d.value.commitments,
      final,
    });
  }

  finalize() {
    for (const logs of this.logs.values()) for (const l of logs) l.final = true;
  }

  members(groupId: bigint): bigint[] {
    return (this.logs.get(groupId) ?? []).flatMap((l) => [...l.commitments]);
  }
}

/** A record of `commitments` at `firstIndex`, signed by the registrars as ours would be. */
function foreignRecord(groupId: bigint, firstIndex: bigint, commitments: bigint[]): Uint8Array {
  const digest = groupAdditionDigest(DOMAIN, { groupId, tier: 0, firstIndex, commitments });
  const approvals = [1, 2].map((seat) =>
    signGroupApproval(digest, seat, SECRETS[seat - 1] as Uint8Array),
  );
  return encodeGroupAddition({ groupId, firstIndex, commitments, approvals });
}

function batches(
  chain: Tier0Chain,
  over: { signers?: { seat: number; secretKey: Uint8Array }[] } = {},
) {
  const job = newJob(chain, over.signers);
  // Each run is the next period's boundary.
  return {
    refreshIndex: () => job.refreshIndex(),
    runBoundary: async () => {
      clock += REGISTRATION_PERIOD;
      const reports = await job.runBoundary();
      if (reports === null) throw new Error("boundary already run");
      return reports;
    },
  };
}

function newJob(
  chain: Tier0Chain,
  signers = [
    { seat: 1, secretKey: SECRETS[0] as Uint8Array },
    { seat: 3, secretKey: SECRETS[2] as Uint8Array },
  ],
  store: Tier0Redis = redis,
) {
  return new Tier0Batches({
    redis: store,
    chain,
    groups: new Map([[0, GROUP]]),
    chainId: CHAIN_ID,
    registry: REGISTRY,
    registrars: REGISTRARS,
    threshold: THRESHOLD,
    signers,
    now: () => clock,
    prefix,
  });
}

/** Distinct commitments the route accepts. */
function commitments(n: number, seed = 1n): bigint[] {
  const out: bigint[] = [];
  for (let i = 0n; out.length < n; i++) {
    const v = (seed * 0x9e3779b97f4a7c15n + i * 0x5851f42d4c957f2dn + 2n) % BN254_R;
    if (v > 1n && v !== POSEIDON2_ZERO_ONE && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Queues `values` for `group` as the route's script does: nothing live or in
 * flight, and the map and the count together.
 */
async function enqueue(values: readonly bigint[], group = GROUP) {
  const k = keys();
  // In descending order, so a batch is sorted only if the job sorts it.
  for (const v of values.slice().sort(cmp).reverse()) {
    const c = commitmentKey(v);
    if ((await redis.sismember(k.live, c)) === 1 || (await redis.sismember(k.inflight, c)) === 1)
      continue;
    if ((await redis.hsetnx(k.queue, c, group.toString())) === 1)
      await redis.hincrby(k.sizes, group.toString(), 1);
  }
}

async function queued(group = GROUP): Promise<bigint[]> {
  const all = await redis.hgetall(keys().queue);
  return Object.entries(all)
    .filter(([, g]) => g === group.toString())
    .map(([c]) => BigInt(`0x${c}`))
    .sort(cmp);
}

/** `sizes` matches the map for every group, and nothing is both queued and in flight (Queue). */
async function expectConsistent() {
  const k = keys();
  const queue = await redis.hgetall(k.queue);
  const sizes = await redis.hgetall(k.sizes);
  const counts: Record<string, string> = {};
  for (const g of Object.values(queue)) counts[g] = String(Number(counts[g] ?? 0) + 1);
  expect(sizes).toEqual(counts);
  const inflight = new Set(await redis.smembers(k.inflight));
  for (const c of Object.keys(queue)) expect(inflight.has(c)).toBe(false);
}

const lastRecord = (chain: FakeChain) => {
  const d = decodeGroupAddition(chain.submitted.at(-1) as Uint8Array);
  if (!d.ok) throw new Error("undecodable");
  return d.value;
};

describe("values", () => {
  test("match docs/spec/registration.md, Values", () => {
    const spec = readFileSync(
      new URL("../../../docs/spec/registration.md", import.meta.url),
      "utf8",
    );
    const value = (name: string) =>
      new RegExp(`^\\| \`${name}\`\\s*\\| ([^|]+?)\\s*\\|`, "m").exec(spec)?.[1];
    expect(value("REGISTRATION_PERIOD")).toBe(String(REGISTRATION_PERIOD));
    expect(value("MIN_REGISTRATION_BATCH")).toBe(String(MIN_REGISTRATION_BATCH));
    expect(value("MAX_REGISTRATION_HOLD")).toBe(String(MAX_REGISTRATION_HOLD));
  });
});

describe("configuration", () => {
  test("refuses anything but one published group for region 0, and a bad group_id", () => {
    const chain = new FakeChain();
    const base = {
      redis,
      chain,
      chainId: CHAIN_ID,
      registry: REGISTRY,
      registrars: REGISTRARS,
      threshold: THRESHOLD,
      signers: [
        { seat: 1, secretKey: SECRETS[0] as Uint8Array },
        { seat: 2, secretKey: SECRETS[1] as Uint8Array },
      ],
      now: () => NOW,
      prefix,
    };
    for (const groups of [
      new Map<number, bigint>(),
      new Map([[1, GROUP]]),
      new Map([
        [0, GROUP],
        [1, GROUP + 1n],
      ]),
      new Map([[0, -1n]]),
      new Map([[0, 1n << 64n]]),
    ])
      expect(() => new Tier0Batches({ ...base, groups })).toThrow(RangeError);
  });

  test("refuses signers that aren't exactly the threshold in ascending seats", () => {
    const chain = new FakeChain();
    const s = (seat: number) => ({ seat, secretKey: SECRETS[seat - 1] as Uint8Array });
    for (const signers of [[s(1)], [s(1), s(2), s(3)], [s(2), s(1)], [s(2), s(2)]])
      expect(() => batches(chain, { signers })).toThrow(RangeError);
  });

  test("a key that isn't its seat's registrar signs nothing and keeps nothing", async () => {
    const chain = new FakeChain();
    const job = batches(chain, {
      signers: [
        { seat: 1, secretKey: SECRETS[0] as Uint8Array },
        { seat: 2, secretKey: bytes(vectors.registrars.outsiderSecretKey) },
      ],
    });
    const values = commitments(MIN_REGISTRATION_BATCH);
    await enqueue(values);
    await expect(job.runBoundary()).rejects.toThrow(/approvals/);
    expect(chain.submitted).toEqual([]);
    expect(await queued()).toEqual(values.sort(cmp));
    expect(await redis.hgetall(keys().batches)).toEqual({});
    // The lock is released even so.
    expect(await redis.exists(keys().lock)).toBe(0);
  });

  test("a published group that isn't Tier 0 is never signed into", async () => {
    const chain = new FakeChain();
    chain.tiers.set(GROUP, 1);
    await enqueue(commitments(MIN_REGISTRATION_BATCH));
    await expect(batches(chain).runBoundary()).rejects.toThrow(/not a Tier 0 group/);
    expect(chain.submitted).toEqual([]);
  });
});

describe("the index", () => {
  test("holds every Tier 0 commitment, signed or self-paid, and its time", async () => {
    const chain = new FakeChain([GROUP, 9n]);
    chain.land(foreignRecord(9n, 0n, commitments(3, 5n)), true);
    for (const c of commitments(2_500, 6n)) chain.selfPaid.add(c);
    expect(await batches(chain).refreshIndex()).toBe(true);
    const live = (await redis.smembers(keys().live)).sort();
    expect(live).toEqual(
      [...commitments(3, 5n), ...commitments(2_500, 6n)].map(commitmentKey).sort(),
    );
    expect(await redis.get(keys().indexed)).toBe(String(NOW));
    expect(await redis.exists(keys().next)).toBe(0);
  });

  test("is replaced whole: a commitment gone from the chain (a reorg) leaves it", async () => {
    const chain = new FakeChain();
    const [a, b] = commitments(2);
    chain.selfPaid.add(a as bigint).add(b as bigint);
    const job = batches(chain);
    await job.refreshIndex();
    chain.selfPaid.delete(a as bigint);
    await job.refreshIndex();
    expect(await redis.smembers(keys().live)).toEqual([commitmentKey(b as bigint)]);
    chain.selfPaid.clear();
    await job.refreshIndex();
    expect(await redis.exists(keys().live)).toBe(0);
  });

  test("is left as it was, with its old time, when the chain can't be read", async () => {
    const chain = new FakeChain();
    chain.selfPaid.add(commitments(1)[0] as bigint);
    const job = batches(chain);
    await job.refreshIndex();
    const before = await redis.smembers(keys().live);
    await redis.set(keys().indexed, String(NOW - 100));
    chain.down = true;
    expect(await job.refreshIndex()).toBe(false);
    expect(await redis.smembers(keys().live)).toEqual(before);
    expect(await redis.get(keys().indexed)).toBe(String(NOW - 100));
  });

  test("keeps the route's step 6 current: a refreshed index lets it queue", async () => {
    const chain = new FakeChain();
    await batches(chain).refreshIndex();
    const route = new Tier0Registrations({
      redis,
      groups: new Map([[0, GROUP]]),
      turnstile: { verify: () => Promise.resolve("passed") },
      now: () => NOW + 30,
      prefix,
    });
    const [c] = commitments(1);
    await route.register({ commitment: commitmentKey(c as bigint), region: "0", turnstile: "t" });
    expect(await queued()).toEqual([c]);
  });
});

describe("the batch", () => {
  test("an empty queue isn't held", async () => {
    const chain = new FakeChain();
    await redis.hset(keys().held, GROUP.toString(), "3");
    expect(await batches(chain).runBoundary()).toEqual([
      { groupId: GROUP, outcome: "empty", abandoned: false },
    ]);
    expect(await redis.hgetall(keys().held)).toEqual({});
  });

  test("a short queue is held MAX_REGISTRATION_HOLD boundaries, then signed", async () => {
    const chain = new FakeChain();
    const job = batches(chain);
    const values = commitments(MIN_REGISTRATION_BATCH - 1);
    await enqueue(values);
    for (let i = 1; i <= MAX_REGISTRATION_HOLD; i++) {
      expect((await job.runBoundary())[0]?.outcome).toBe("held");
      expect(await redis.hget(keys().held, GROUP.toString())).toBe(String(i));
    }
    expect((await job.runBoundary())[0]).toEqual({
      groupId: GROUP,
      outcome: "signed",
      abandoned: false,
      submitFailed: false,
    });
    expect(chain.members(GROUP)).toEqual(values.sort(cmp));
    expect(await redis.hgetall(keys().held)).toEqual({});
  });

  test("a queue of MIN_REGISTRATION_BATCH is signed at once, sorted, at the group's count", async () => {
    const chain = new FakeChain();
    chain.land(foreignRecord(GROUP, 0n, commitments(3, 9n)), true);
    const values = commitments(MIN_REGISTRATION_BATCH);
    await enqueue(values);
    expect((await batches(chain).runBoundary())[0]?.outcome).toBe("signed");
    const record = lastRecord(chain);
    expect(record.groupId).toBe(GROUP);
    expect(record.firstIndex).toBe(3n);
    expect(record.commitments).toEqual(values.slice().sort(cmp));
    expect(record.approvals.map((a) => a.seat)).toEqual([1, 3]);
    // Out of the map, into the in-flight set, the record kept.
    const k = keys();
    expect(await queued()).toEqual([]);
    expect(await redis.hgetall(k.sizes)).toEqual({});
    expect((await redis.smembers(k.inflight)).sort()).toEqual(values.map(commitmentKey).sort());
    expect(await redis.hget(k.batches, GROUP.toString())).toBe(
      Buffer.from(chain.submitted[0] as Uint8Array).toString("hex"),
    );
  });

  test("more than MAX_BATCH: MAX_BATCH chosen, the rest kept queued", async () => {
    const chain = new FakeChain();
    const values = commitments(GROUP_REGISTRY_MAX_BATCH + 44);
    await enqueue(values);
    await batches(chain).runBoundary();
    const signed = lastRecord(chain).commitments;
    expect(signed).toHaveLength(GROUP_REGISTRY_MAX_BATCH);
    const rest = await queued();
    expect(rest).toHaveLength(44);
    expect([...signed, ...rest].sort(cmp)).toEqual(values.sort(cmp));
    await expectConsistent();
  });

  test("drops what is live, in flight or forbidden, and signs only the rest", async () => {
    const chain = new FakeChain();
    const values = commitments(MIN_REGISTRATION_BATCH + 3);
    const [selfPaid, inflight] = values;
    chain.selfPaid.add(selfPaid as bigint);
    await enqueue(values);
    // In another group's in-flight batch since it was queued (a stand-in).
    await redis.sadd(keys().inflight, commitmentKey(inflight as bigint));
    // Forbidden values never come through the route; written here directly.
    await enqueue([0n, 1n, POSEIDON2_ZERO_ONE]);
    expect((await batches(chain).runBoundary())[0]?.outcome).toBe("signed");
    expect(lastRecord(chain).commitments).toEqual(values.slice(2).sort(cmp));
    expect(await queued()).toEqual([]);
    expect(await redis.hgetall(keys().sizes)).toEqual({});
  });

  test("a queue that falls short after the recheck is held", async () => {
    const chain = new FakeChain();
    const values = commitments(MIN_REGISTRATION_BATCH);
    chain.selfPaid.add(values[0] as bigint);
    await enqueue(values);
    expect((await batches(chain).runBoundary())[0]?.outcome).toBe("held");
    expect(await queued()).toEqual(values.slice(1).sort(cmp));
  });

  test("near 2³² members, the batch is cut to the leaves left; a full group signs nothing", async () => {
    const chain = new FakeChain();
    const values = commitments(MIN_REGISTRATION_BATCH + 2);
    await enqueue(values);
    const last = 1n << 32n;
    chain.staleGroup = { tier: 0, finalizedSize: last - 3n, latestSize: last - 3n };
    expect((await batches(chain).runBoundary())[0]?.outcome).toBe("signed");
    const signed = lastRecord(chain);
    expect(signed.firstIndex).toBe(last - 3n);
    expect(signed.commitments).toHaveLength(3);
    expect(await queued()).toHaveLength(values.length - 3);

    // The record is final at the group's last leaves; the group is now full.
    await redis.hdel(keys().batches, GROUP.toString());
    await redis.del(keys().inflight);
    const job = batches(chain);
    chain.staleGroup = { tier: 0, finalizedSize: last, latestSize: last };
    expect((await job.runBoundary())[0]?.outcome).toBe("full");
    expect(chain.submitted).toHaveLength(1);
    expect(await queued()).toHaveLength(values.length - 3);
    expect(await redis.hgetall(keys().held)).toEqual({});
    await expectConsistent();
  });

  test("an unreadable index or chain changes nothing", async () => {
    const chain = new FakeChain();
    const values = commitments(MIN_REGISTRATION_BATCH);
    await enqueue(values);
    chain.down = true;
    expect((await batches(chain).runBoundary())[0]?.outcome).toBe("chain-unavailable");
    expect(await queued()).toEqual(values.sort(cmp));
    expect(await redis.hgetall(keys().held)).toEqual({});
  });
});

describe("one batch per position", () => {
  test("waits while the last batch isn't final, then signs the next position", async () => {
    const chain = new FakeChain();
    const job = batches(chain);
    const first = commitments(MIN_REGISTRATION_BATCH, 1n);
    const second = commitments(MIN_REGISTRATION_BATCH, 2n);
    await enqueue(first);
    await job.runBoundary();
    await enqueue(second);
    expect((await job.runBoundary())[0]?.outcome).toBe("waiting");
    expect(chain.submitted).toHaveLength(1);
    // The record and its commitments stay in flight until it is final.
    expect((await redis.smembers(keys().inflight)).sort()).toEqual(first.map(commitmentKey).sort());
    expect(await redis.hexists(keys().batches, GROUP.toString())).toBe(1);
    chain.finalize();
    expect((await job.runBoundary())[0]?.outcome).toBe("signed");
    expect(lastRecord(chain).firstIndex).toBe(BigInt(MIN_REGISTRATION_BATCH));
    // The first batch's commitments left the in-flight set once final.
    expect((await redis.smembers(keys().inflight)).sort()).toEqual(
      second.map(commitmentKey).sort(),
    );
  });

  test("a batch that didn't land is sent again unchanged, by a restarted job too", async () => {
    const chain = new FakeChain();
    await enqueue(commitments(MIN_REGISTRATION_BATCH));
    chain.submitFails = true;
    expect((await batches(chain).runBoundary())[0]).toMatchObject({
      outcome: "signed",
      submitFailed: true,
    });
    expect((await batches(chain).runBoundary())[0]?.outcome).toBe("resubmitted");
    chain.submitFails = false;
    expect((await batches(chain).runBoundary())[0]?.outcome).toBe("resubmitted");
    expect(chain.submitted).toHaveLength(3);
    for (const r of chain.submitted) expect(r).toEqual(chain.submitted[0]);
    chain.finalize();
    expect((await batches(chain).runBoundary())[0]?.outcome).toBe("empty");
    expect(await redis.hgetall(keys().batches)).toEqual({});
    expect(await redis.exists(keys().inflight)).toBe(0);
  });

  test("a position taken in unfinalized blocks by another record is waited on", async () => {
    const chain = new FakeChain();
    await enqueue(commitments(MIN_REGISTRATION_BATCH));
    chain.submitFails = true;
    await batches(chain).runBoundary();
    chain.land(foreignRecord(GROUP, 0n, commitments(2, 9n)));
    expect((await batches(chain).runBoundary())[0]?.outcome).toBe("waiting");
    expect(chain.submitted).toHaveLength(1);
  });

  test("a batch whose position finalized history took is abandoned, and its commitments signed again", async () => {
    const chain = new FakeChain();
    const values = commitments(MIN_REGISTRATION_BATCH);
    await enqueue(values);
    chain.submitFails = true;
    await batches(chain).runBoundary();
    const lost = chain.submitted[0] as Uint8Array;
    const other = commitments(2, 9n);
    // One of ours is in the other record too, so it is live and dropped.
    chain.land(foreignRecord(GROUP, 0n, [...other, values[0] as bigint].sort(cmp)), true);
    chain.submitFails = false;
    const report = (await batches(chain).runBoundary())[0];
    // Seven remain after the drop, below the minimum, so the queue is held.
    expect(report).toEqual({ groupId: GROUP, outcome: "held", abandoned: true });
    expect(await queued()).toEqual(values.slice(1).sort(cmp));
    expect(await redis.hgetall(keys().batches)).toEqual({});
    expect(await redis.exists(keys().inflight)).toBe(0);
    await expectConsistent();
    await enqueue(commitments(1, 4n));
    expect((await batches(chain).runBoundary())[0]?.outcome).toBe("signed");
    expect(lastRecord(chain).firstIndex).toBe(3n);
    expect(chain.submitted.at(-1)).not.toEqual(lost);
  });

  test("an abandoned batch's commitments return even past the queue's bound", async () => {
    const chain = new FakeChain();
    const lost = commitments(GROUP_REGISTRY_MAX_BATCH, 1n);
    await enqueue(lost);
    chain.submitFails = true;
    await batches(chain).runBoundary();
    const full = commitments(REGISTRATION_QUEUE_MAX, 2n);
    await enqueue(full);
    chain.land(foreignRecord(GROUP, 0n, commitments(1, 9n)), true);
    chain.submitFails = false;
    const report = (await batches(chain).runBoundary())[0];
    expect(report).toMatchObject({ outcome: "signed", abandoned: true });
    // All 1,280 were queued together: one batch of them signed, the rest queued.
    const signed = lastRecord(chain).commitments;
    expect(signed).toHaveLength(GROUP_REGISTRY_MAX_BATCH);
    expect([...signed, ...(await queued())].sort(cmp)).toEqual([...lost, ...full].sort(cmp));
    await expectConsistent();
    // 1,280 commitments through Redis and the batch: seconds on a shared runner.
  }, 60_000);

  test("an unfinalized addition the job didn't send is waited on", async () => {
    const chain = new FakeChain();
    chain.land(foreignRecord(GROUP, 0n, commitments(2, 9n)));
    await enqueue(commitments(MIN_REGISTRATION_BATCH));
    expect((await batches(chain).runBoundary())[0]?.outcome).toBe("waiting");
    expect(chain.submitted).toEqual([]);
  });
});

describe("nodes at different blocks", () => {
  test("a final batch seen by additionAt before group() catches up signs nothing at its position", async () => {
    const chain = new FakeChain();
    await enqueue(commitments(MIN_REGISTRATION_BATCH, 1n));
    const job = batches(chain);
    await job.runBoundary();
    chain.finalize();
    await enqueue(commitments(MIN_REGISTRATION_BATCH, 2n));
    // group() still at the block before the batch: count 0, all final.
    chain.staleGroup = { tier: 0, finalizedSize: 0n, latestSize: 0n };
    expect((await job.runBoundary())[0]?.outcome).toBe("waiting");
    expect(chain.submitted).toHaveLength(1);
    chain.staleGroup = undefined;
    expect((await job.runBoundary())[0]?.outcome).toBe("signed");
    expect(lastRecord(chain).firstIndex).toBe(BigInt(MIN_REGISTRATION_BATCH));
    chain.finalize();
    expect((await job.runBoundary())[0]?.outcome).toBe("empty");
    // Once a record is finished, a count below its end is never signed at,
    // even when no node shows anything at that position.
    chain.staleGroup = { tier: 0, finalizedSize: 0n, latestSize: 0n };
    chain.staleAdditions = true;
    await enqueue(commitments(MIN_REGISTRATION_BATCH, 3n));
    expect((await job.runBoundary())[0]?.outcome).toBe("waiting");
    // A stale node may have a record resent, but never a second record at a position.
    const byPosition = new Map<bigint, Set<string>>();
    for (const r of chain.submitted) {
      const d = decodeGroupAddition(r);
      if (!d.ok) throw new Error("undecodable");
      const seen = byPosition.get(d.value.firstIndex) ?? new Set<string>();
      byPosition.set(d.value.firstIndex, seen.add(Buffer.from(r).toString("hex")));
    }
    for (const seen of byPosition.values()) expect(seen.size).toBe(1);
  });

  test("a lagging count is never signed at where another record is final", async () => {
    const chain = new FakeChain();
    chain.land(foreignRecord(GROUP, 0n, commitments(2, 9n)), true);
    chain.staleGroup = { tier: 0, finalizedSize: 0n, latestSize: 0n };
    await enqueue(commitments(MIN_REGISTRATION_BATCH));
    expect((await batches(chain).runBoundary())[0]?.outcome).toBe("waiting");
    expect(chain.submitted).toEqual([]);
  });

  test("a landed batch that additionAt can't see yet is never abandoned", async () => {
    const chain = new FakeChain();
    await enqueue(commitments(MIN_REGISTRATION_BATCH));
    const job = batches(chain);
    await job.runBoundary();
    chain.finalize();
    chain.staleAdditions = true;
    expect((await job.runBoundary())[0]).toEqual({
      groupId: GROUP,
      outcome: "waiting",
      abandoned: false,
    });
    expect(await queued()).toEqual([]);
    expect(chain.submitted).toHaveLength(1);
  });
});

describe("boundaries", () => {
  test("each period's boundary runs once", async () => {
    const job = newJob(new FakeChain());
    await enqueue(commitments(3));
    expect(await job.runBoundary()).not.toBeNull();
    clock += REGISTRATION_PERIOD - 1;
    expect(await job.runBoundary()).toBeNull();
    expect(await redis.hget(keys().held, GROUP.toString())).toBe("1");
    clock += 1;
    expect(await job.runBoundary()).not.toBeNull();
    expect(await redis.hget(keys().held, GROUP.toString())).toBe("2");
  });

  test("a Redis failure is reported without the script's arguments", async () => {
    const chain = new FakeChain();
    const values = commitments(MIN_REGISTRATION_BATCH);
    await enqueue(values);
    const failing: Tier0Redis = {
      eval: (script, numkeys, ...args) =>
        script.includes("tier0-queue")
          ? Promise.reject(Object.assign(new Error(`ERR ${args.join(" ")}`), { command: { args } }))
          : redis.eval(script, numkeys, ...args),
    };
    const e = await newJob(chain, undefined, failing)
      .runBoundary()
      .then(
        () => undefined,
        (x: unknown) => x,
      );
    expect(e).toBeInstanceOf(Error);
    expect(Object.keys(e as object)).toEqual([]);
    for (const v of values) expect((e as Error).message).not.toContain(commitmentKey(v));
    expect(chain.submitted).toEqual([]);
  });
});

describe("the lock", () => {
  test("a second runner at the same time does nothing", async () => {
    const chain = new FakeChain();
    await enqueue(commitments(MIN_REGISTRATION_BATCH));
    let release!: () => void;
    chain.onRead = () => new Promise((resolve) => (release = resolve));
    const first = batches(chain).runBoundary();
    await new Promise((r) => setTimeout(r, 50));
    await expect(batches(chain).runBoundary()).rejects.toBeInstanceOf(Tier0LockError);
    await expect(batches(chain).refreshIndex()).rejects.toBeInstanceOf(Tier0LockError);
    release();
    expect((await first)[0]?.outcome).toBe("signed");
    expect(chain.submitted).toHaveLength(1);
  });

  test("a runner whose lock lapsed writes nothing", async () => {
    const chain = new FakeChain();
    const values = commitments(MIN_REGISTRATION_BATCH);
    await enqueue(values);
    // The lock expires and another runner takes it during the chain read.
    chain.onRead = async () => {
      await redis.set(keys().lock, "someone-else");
    };
    await expect(batches(chain).runBoundary()).rejects.toBeInstanceOf(Tier0LockError);
    expect(chain.submitted).toEqual([]);
    expect(await queued()).toEqual(values.sort(cmp));
    expect(await redis.exists(keys().live)).toBe(0);
    // Its lock is left to its holder.
    expect(await redis.get(keys().lock)).toBe("someone-else");
  });
});

describe("selection", () => {
  test("is a subset of distinct items of the asked size", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer(), { maxLength: 600 }),
        fc.nat({ max: 600 }),
        (items, n) => {
          const chosen = selectUniformly(items, n);
          expect(chosen).toHaveLength(Math.min(n, items.length));
          expect(new Set(chosen).size).toBe(chosen.length);
          for (const c of chosen) expect(items).toContain(c);
        },
      ),
      { numRuns },
    );
  });

  test("chooses each item about equally often", () => {
    // 5 of 20, 20,000 draws: each item's expected count is 5,000, with a
    // standard deviation near 61; 6 deviations either way fails by chance
    // with probability below 10⁻⁷.
    const items = Array.from({ length: 20 }, (_, i) => i);
    const counts = Array.from({ length: 20 }, () => 0);
    for (let i = 0; i < 20_000; i++)
      for (const c of selectUniformly(items, 5)) counts[c] = (counts[c] ?? 0) + 1;
    for (const c of counts) expect(Math.abs(c - 5_000)).toBeLessThan(6 * 61);
  });
});

describe("the queue's state", () => {
  test("stays exact under any interleaving of requests, boundaries and finality", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.record({
              op: fc.constant("enqueue" as const),
              n: fc.nat({ max: 12 }),
              seed: fc.bigInt({ min: 1n, max: 40n }),
            }),
            fc.record({ op: fc.constant("boundary" as const) }),
            fc.record({ op: fc.constant("finalize" as const) }),
            fc.record({ op: fc.constant("fail" as const), on: fc.boolean() }),
          ),
          { maxLength: 25 },
        ),
        async (ops) => {
          const left = await allKeys();
          if (left.length > 0) await redis.del(...left);
          const chain = new FakeChain();
          for (const o of ops) {
            if (o.op === "enqueue") await enqueue(commitments(o.n, o.seed));
            else if (o.op === "boundary") await batches(chain).runBoundary();
            else if (o.op === "finalize") chain.finalize();
            else chain.submitFails = o.on;
            await expectConsistent();
          }
          // No commitment is ever a member twice.
          const members = chain.members(GROUP).map(commitmentKey);
          expect(new Set(members).size).toBe(members.length);
          // Every batch is sorted, with at most MAX_BATCH.
          for (const l of chain.logs.get(GROUP) ?? []) {
            expect(l.commitments.length).toBeLessThanOrEqual(GROUP_REGISTRY_MAX_BATCH);
            expect(l.commitments.slice().sort(cmp)).toEqual(l.commitments);
          }
          // Redis keeps the route's and the job's keys and nothing else.
          const k = keys();
          const allowed = new Set([
            k.queue,
            k.sizes,
            k.live,
            k.inflight,
            k.indexed,
            k.held,
            k.batches,
            k.positions,
            k.boundary,
          ]);
          for (const key of await allKeys()) expect(allowed.has(key)).toBe(true);
        },
      ),
      { numRuns: Math.min(numRuns, 50) },
    );
  });
});
