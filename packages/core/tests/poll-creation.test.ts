import { createHash } from "node:crypto";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  advancePollCreations,
  type CreationStatus,
  createPollDraft,
  MIN_OPEN_SECONDS,
  newAccountId,
  type PollCreationChain,
  pollCreationTxs,
  type PollDraft,
  SETUP_SECONDS,
  type SignedCreation,
  submitPollDraft,
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// The creation step of a poll's setup (ADR 0032, rules 12, 14 and 18; P2-22
// part 3a), against a chain that keeps a mempool and finalizes when told: a
// creation is recorded before it is sent and never signed twice, whatever
// crashes; a poll moves to `created` only once its creation is final; a
// reverted, replaced or stuck creation fails its poll; and the daily ceiling
// holds (T-25, T-52, T-72).

const NOW = new Date("2026-10-17T12:00:00Z");
const NOW_S = BigInt(NOW.getTime() / 1000);
const HOUR = 3600_000;

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());

const draft = (closesAt = NOW_S + 7n * 24n * 3600n): PollDraft => ({
  language: "en",
  title: "Lunch",
  description: "",
  questions: [
    {
      question: "Which day?",
      description: "",
      options: [
        { label: "Friday", description: "" },
        { label: "Monday", description: "" },
      ],
      minSelections: 0,
      maxSelections: 1,
    },
  ],
  tiers: [0],
  closesAt,
});

interface Mined {
  readonly hash: string;
  readonly nonce: bigint;
  readonly block: bigint;
  readonly reverts: boolean;
}

/** The creation key on a chain that includes its mempool, in nonce order, when `mine` says. */
class FakeChain implements PollCreationChain {
  readonly creator = new Uint8Array(20).fill(0xc0);
  readonly signed: bigint[] = [];
  readonly sent: string[] = [];
  /** Sent and not included, by nonce: a later send at a nonce replaces the earlier. */
  readonly mempool = new Map<bigint, string>();
  readonly mined: Mined[] = [];
  block = 10n;
  finalized = 10n;
  /** Throws on the next `n` sends. */
  refuse = 0;
  /** Hashes whose creation reverts. */
  readonly reverting = new Set<string>();
  /** Runs before each send: a test looks at the table at that moment. */
  onSend: ((hash: string) => Promise<void>) | undefined;

  async nonces() {
    const latest = BigInt(this.mined.length);
    const finalized = BigInt(this.mined.filter((m) => m.block <= this.finalized).length);
    let pending = latest;
    while (this.mempool.has(pending)) pending++;
    return { finalized, latest, pending };
  }

  async signCreation(nonce: bigint): Promise<SignedCreation> {
    this.signed.push(nonce);
    const tx = new TextEncoder().encode(`create:${nonce}:${this.signed.length}`);
    return { tx, hash: sha256(tx) };
  }

  async broadcast(tx: Uint8Array): Promise<void> {
    const hash = hex(sha256(tx));
    await this.onSend?.(hash);
    if (this.refuse > 0) {
      this.refuse--;
      throw new Error("the node refused it");
    }
    this.sent.push(hash);
    const nonce = BigInt(new TextDecoder().decode(tx).split(":")[1]!);
    if (nonce >= BigInt(this.mined.length)) this.mempool.set(nonce, hash);
  }

  async creation(hash: Uint8Array): Promise<CreationStatus> {
    const m = this.mined.find((x) => x.hash === hex(hash));
    if (m === undefined) return { state: "unknown" };
    if (m.block > this.finalized) return { state: "included" };
    if (m.reverts) return { state: "reverted" };
    return {
      state: "created",
      electionId: sha256(new TextEncoder().encode(m.hash)),
      block: m.block,
    };
  }

  /** Includes the mempool's run of nonces from the next one, each in its own block. */
  mine() {
    for (let n = BigInt(this.mined.length); this.mempool.has(n); n++) {
      const hash = this.mempool.get(n)!;
      this.mempool.delete(n);
      this.mined.push({ hash, nonce: n, block: ++this.block, reverts: this.reverting.has(hash) });
    }
  }

  /** Includes a transaction of the key that isn't a recorded creation. */
  mineStranger() {
    const nonce = BigInt(this.mined.length);
    this.mempool.delete(nonce);
    this.mined.push({ hash: `stranger:${nonce}`, nonce, block: ++this.block, reverts: false });
  }

  finalize() {
    this.finalized = this.block;
  }
}

let db: TestDb;
let app: Sql;
let app2: Sql;

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  app2 = await db.as("abolish_app");
});
afterAll(() => db?.close());
beforeEach(async () => {
  await db.admin`DELETE FROM account_polls`;
  await db.admin`DELETE FROM poll_creation_txs`;
});

async function submitted(n = 1, closesAt?: bigint, at = NOW): Promise<string[]> {
  const turnstile = { verify: async () => "passed" as const };
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    // An author each, so no account's own limits get in the way.
    const author = newAccountId();
    await app`
      INSERT INTO account_users VALUES (${author}, ${`${newAccountId()}@account.invalid`},
        false, '', NULL, now(), now())`;
    const id = await createPollDraft(app, author, draft(closesAt), at);
    // Submitted a second apart, so the oldest-first order is the creation order.
    await submitPollDraft(app, author, id, {
      turnstile,
      token: "t",
      now: new Date(at.getTime() + i * 1000),
    });
    ids.push(id);
  }
  return ids;
}

const row = async (id: string) => {
  const [r] = await db.admin`
    SELECT p.state, p.failure, t.nonce AS create_nonce, encode(p.create_tx_hash, 'hex') AS hash,
      encode(p.election_id, 'hex') AS election, p.created_block
    FROM account_polls p LEFT JOIN poll_creation_txs t ON t.tx_hash = p.create_tx_hash
    WHERE p.id = ${id}`;
  return r!;
};

const run = (chain: FakeChain, now = NOW, client = app, dailyCeiling?: number) =>
  advancePollCreations(client, chain, {
    now,
    ...(dailyCeiling === undefined ? {} : { dailyCeiling }),
  });

describe("advancePollCreations", () => {
  test("creates each submitted poll once, oldest first, and records its identifier once final", async () => {
    const chain = new FakeChain();
    const ids = await submitted(3);
    const first = await run(chain);
    expect(first).toMatchObject({ sent: 3, resent: 0, created: 0, ceilingReached: false });
    expect(chain.signed).toEqual([0n, 1n, 2n]);
    expect((await Promise.all(ids.map(row))).map((r) => r["create_nonce"])).toEqual([
      "0",
      "1",
      "2",
    ]);
    // Included but not final: nothing moves, and nothing is signed again.
    chain.mine();
    expect(await run(chain)).toMatchObject({ sent: 0, resent: 0, created: 0 });
    expect((await row(ids[0]!))["state"]).toBe("submitted");
    chain.finalize();
    expect(await run(chain)).toMatchObject({ sent: 0, resent: 0, created: 3 });
    for (const id of ids) {
      const r = await row(id);
      expect(r).toMatchObject({ state: "created", failure: null });
      expect(r["election"]).toBe(hex(sha256(new TextEncoder().encode(r["hash"]))));
    }
    expect(chain.signed).toEqual([0n, 1n, 2n]);
    expect(await run(chain)).toMatchObject({ sent: 0, resent: 0, created: 0 });
  });

  test("records a creation before sending it", async () => {
    const chain = new FakeChain();
    const [id] = await submitted();
    const seen: unknown[] = [];
    chain.onSend = async (hash) => {
      seen.push((await row(id!))["hash"] === hash);
    };
    await run(chain);
    expect(seen).toEqual([true]);
  });

  test("sends the recorded bytes again after a failed send, never signing a second creation", async () => {
    const chain = new FakeChain();
    const [id] = await submitted();
    chain.refuse = 2;
    expect(await run(chain)).toMatchObject({ sent: 0, sendFailed: 1 });
    expect(await run(chain)).toMatchObject({ resent: 0, sendFailed: 1 });
    expect(await run(chain)).toMatchObject({ resent: 1, sendFailed: 0 });
    chain.mine();
    chain.finalize();
    expect(await run(chain)).toMatchObject({ created: 1 });
    expect(chain.signed).toEqual([0n]);
    expect(new Set(chain.sent)).toEqual(new Set([(await row(id!))["hash"]]));
  });

  test("a creation the node dropped is sent again at its own nonce, ahead of new ones", async () => {
    const chain = new FakeChain();
    const [a] = await submitted();
    await run(chain);
    chain.mempool.clear();
    const [b] = await submitted(1, undefined, new Date(NOW.getTime() + 60_000));
    expect(await run(chain)).toMatchObject({ resent: 1, sent: 1 });
    expect(chain.signed).toEqual([0n, 1n]);
    chain.mine();
    chain.finalize();
    await run(chain);
    expect((await row(a!))["state"]).toBe("created");
    expect((await row(b!))["state"]).toBe("created");
  });

  test("two runs at once sign each poll once, at distinct nonces", async () => {
    const chain = new FakeChain();
    const ids = await submitted(4);
    await Promise.all([run(chain, NOW, app), run(chain, NOW, app2)]);
    expect([...chain.signed].sort((x, y) => Number(x - y))).toEqual([0n, 1n, 2n, 3n]);
    const nonces = (await Promise.all(ids.map(row))).map((r) => r["create_nonce"]);
    expect(new Set(nonces).size).toBe(4);
  });

  test("fails a poll whose creation reverted", async () => {
    const chain = new FakeChain();
    const [id] = await submitted();
    await run(chain);
    chain.reverting.add((await row(id!))["hash"]);
    chain.mine();
    // A revert not yet final waits like any inclusion.
    expect(await run(chain)).toMatchObject({ failed: {} });
    chain.finalize();
    expect(await run(chain)).toMatchObject({ failed: { "creation-reverted": 1 } });
    expect(await row(id!)).toMatchObject({ state: "failed", failure: "creation-reverted" });
  });

  test("fails a poll whose nonce another transaction of the key took, once that is final", async () => {
    const chain = new FakeChain();
    const [id] = await submitted();
    await run(chain);
    chain.mineStranger();
    expect(await run(chain)).toMatchObject({ failed: {} });
    chain.finalize();
    expect(await run(chain)).toMatchObject({ failed: { "creation-replaced": 1 } });
    expect(await row(id!)).toMatchObject({ state: "failed", failure: "creation-replaced" });
    // The node's count is past the stranger's nonce, so the next creation uses the next one.
    await submitted();
    await run(chain);
    expect(chain.signed).toEqual([0n, 1n]);
  });

  test("fails a creation not final by the deadline, and keeps sending it so later nonces land", async () => {
    const chain = new FakeChain();
    const [id] = await submitted();
    await run(chain);
    chain.mempool.clear();
    const late = new Date(NOW.getTime() + 2 * HOUR + 1000);
    expect(await run(chain, late)).toMatchObject({ resent: 1, failed: { "creation-timeout": 1 } });
    expect(await row(id!)).toMatchObject({ state: "failed", failure: "creation-timeout" });
    chain.mempool.clear();
    expect(await run(chain, late)).toMatchObject({ resent: 1, failed: {} });
    chain.mine();
    chain.finalize();
    // Landed after its poll failed: an unused identifier (rule 16), and sent no more.
    expect(await run(chain, late)).toMatchObject({ resent: 0, created: 0 });
    expect((await row(id!))["state"]).toBe("failed");
  });

  test("an included creation not final by the deadline fails too", async () => {
    const chain = new FakeChain();
    const [id] = await submitted();
    await run(chain);
    chain.mine();
    await run(chain, new Date(NOW.getTime() + 2 * HOUR + 1000));
    expect(await row(id!)).toMatchObject({ state: "failed", failure: "creation-timeout" });
  });

  test("sends at most the daily ceiling in any 24 hours", async () => {
    const chain = new FakeChain();
    const ids = await submitted(3);
    expect(await run(chain, NOW, app, 2)).toMatchObject({ sent: 2, ceilingReached: true });
    expect((await row(ids[2]!))["state"]).toBe("submitted");
    expect(await run(chain, new Date(NOW.getTime() + 23 * HOUR), app, 2)).toMatchObject({
      sent: 0,
      ceilingReached: true,
    });
    expect(await run(chain, new Date(NOW.getTime() + 24 * HOUR + 1000), app, 2)).toMatchObject({
      sent: 1,
    });
    expect(chain.signed).toEqual([0n, 1n, 2n]);
  });

  test("an author deleting their account frees no ceiling slot and leaves no nonce unsent", async () => {
    const chain = new FakeChain();
    const [a] = await submitted();
    await run(chain, NOW, app, 2);
    await db.admin`DELETE FROM account_users WHERE id = (SELECT user_id FROM account_polls WHERE id = ${a!})`;
    chain.mempool.clear();
    await submitted(2, undefined, new Date(NOW.getTime() + 60_000));
    // The deleted poll's creation is sent again at nonce 0, and only one more fits the ceiling.
    expect(await run(chain, NOW, app, 2)).toMatchObject({
      resent: 1,
      sent: 1,
      ceilingReached: true,
    });
    expect(chain.signed).toEqual([0n, 1n]);
    chain.mine();
    expect(chain.mined.map((m) => m.nonce)).toEqual([0n, 1n]);
  });

  test("fails a poll that now closes too soon for setup, spending nothing", async () => {
    const chain = new FakeChain();
    const closesAt = NOW_S + BigInt(SETUP_SECONDS + MIN_OPEN_SECONDS);
    const [id] = await submitted(1, closesAt);
    expect(await run(chain, new Date(NOW.getTime() + 1000))).toMatchObject({
      sent: 0,
      failed: { "closes-too-soon": 1 },
    });
    expect(await row(id!)).toMatchObject({ state: "failed", failure: "closes-too-soon" });
    expect(chain.signed).toEqual([]);
  });

  test("refuses a creator that isn't an address", async () => {
    const chain: PollCreationChain = Object.assign(new FakeChain(), {
      creator: new Uint8Array(19),
    });
    await expect(advancePollCreations(app, chain, { now: NOW })).rejects.toThrow(RangeError);
  });
});

describe("account_polls' creation columns", () => {
  test("poll_creation_txs' Drizzle table agrees with the migration", async () => {
    const config = getTableConfig(pollCreationTxs);
    const cols = await db.admin`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = ${config.name} ORDER BY ordinal_position`;
    expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
      config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
    );
  });

  test("refuse a state past `submitted` without a creation, and a failure outside `failed`", async () => {
    const [id] = await submitted();
    for (const state of ["created", "rooted", "open"])
      await expect(
        app`UPDATE account_polls SET state = ${state} WHERE id = ${id!}`,
      ).rejects.toThrow(/check/);
    await expect(
      app`UPDATE account_polls SET failure = 'creation-timeout' WHERE id = ${id!}`,
    ).rejects.toThrow(/check/);
    await expect(app`UPDATE account_polls SET state = 'failed' WHERE id = ${id!}`).rejects.toThrow(
      /check/,
    );
  });

  test("refuse a partial creation record, a draft with one, and a second transaction at one nonce", async () => {
    const chain = new FakeChain();
    const [a] = await submitted();
    await run(chain);
    await expect(
      app`UPDATE account_polls SET create_tx_hash = NULL WHERE id = ${a!}`,
    ).rejects.toThrow(/check/);
    await expect(app`UPDATE account_polls SET state = 'drafted' WHERE id = ${a!}`).rejects.toThrow(
      /check/,
    );
    await expect(
      app`UPDATE account_polls SET election_id = ${new Uint8Array(32)} WHERE id = ${a!}`,
    ).rejects.toThrow(/check/);
    await expect(
      app`INSERT INTO poll_creation_txs VALUES (${chain.creator}, 0, ${Uint8Array.of(1)},
        ${new Uint8Array(32).fill(7)}, now())`,
    ).rejects.toThrow(/duplicate key/);
  });

  test("keep the key's transactions append-only", async () => {
    const chain = new FakeChain();
    await submitted();
    await run(chain);
    await expect(app`UPDATE poll_creation_txs SET sent_at = now()`).rejects.toThrow(/permission/);
    await expect(app`DELETE FROM poll_creation_txs`).rejects.toThrow(/permission/);
  });
});
