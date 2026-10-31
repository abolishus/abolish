import {
  type Anchor,
  type Checkpoint,
  checkBoard,
  checkpointHash,
  checkpointOf,
  decodeElectionDefinition,
  encodeArchiveLocator,
  encodeCheckpoint,
  verifyBoard,
} from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  type AnchorChain,
  anchorBoards,
  type AnchorFinding,
  type AnchorRun,
  appendEntry,
  type LocatorSource,
  AppendError,
  boardCheckpoints,
  readBoard,
  readCheckpoints,
  readLatestCheckpoints,
  readDefinition,
  MAX_L1_CLOCK_LEAD,
  takeCheckpoints,
} from "../src/index.ts";
import { newElection, type TestDb, testDb } from "./db.ts";

// Taking checkpoints and anchoring them (src/anchoring.ts,
// migrations/0009_board_checkpoints.sql; docs/spec/board.md, Segments and
// checkpoints; T-23, T-24, T-49, T-52): a taken checkpoint is the verifier's
// own for the board, it fences its segment against later appends in
// appendEntry and in the table's triggers, the table is append-only, and
// each run sends exactly the timely checkpoints the anchor doesn't hold,
// judged here by a model of the anchor's rules and by the verifier's
// verifyBoard over what it anchored.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const b32 = () => new Uint8Array(randomBytes(32));
const ballot = (...body: number[]) => Uint8Array.of(0x00, 0x02, 1, ...body);

const HOUR = 3600n;
/** The deployment's clock (docs/spec/contracts.md, Board anchor): hourly, 12 hours to anchor. */
const CLOCK = { epoch: 0n, period: HOUR, deadline: 12n * HOUR } as const;
const endOf = (s: number) => CLOCK.epoch + (BigInt(s) + 1n) * CLOCK.period;

let db: TestDb;
let app: Sql;
let owner: Sql;
/** The L1 the typical vector's definition names, which newElection stores. */
let l1ChainId: bigint;

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app", { max: 2 });
  owner = await db.as("abolish_migrator");
  l1ChainId = decodeElectionDefinition(
    (await readDefinition(app, await newElection(app)))!,
  ).l1_chain_id;
});
afterAll(() => db?.close());

async function failsWith(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (e) {
    if (e instanceof AppendError) return e.code;
    const err = e as { code?: string; cause?: { code?: string } };
    return err.cause?.code ?? err.code ?? "no code";
  }
  throw new Error("query succeeded");
}

/** The verifier's checkpoint of the stored board after segment `s`. */
async function expected(e: Uint8Array, s: number): Promise<Checkpoint | undefined> {
  return checkpointOf(checkBoard(e, await readBoard(app, e), 5), s);
}

/** A board with entries in each of `segments`, in order, of an election naming `anchor`. */
async function boardFor(anchor: { address: Uint8Array }, ...segments: number[]) {
  const e = await newElection(app, 5, anchor.address);
  for (const [i, s] of segments.entries()) await appendEntry(app, e, s, ballot(i));
  return e;
}

/** A board with entries in each of `segments`, in order. */
const boardIn = (...segments: number[]) => boardFor({ address: b32().slice(12) }, ...segments);

/**
 * A model of the board anchor (docs/spec/contracts.md, Board anchor): one
 * slot per election and segment, a call all or nothing, and each checkpoint
 * refused when empty, outside `[end of s, end of s + deadline]` at the
 * block's time, or for a slot already filled, in the call or before it.
 * Each has an address of its own, so a test's runs anchor only the elections
 * it made for it: every other board in the schema names another anchor.
 */
class ModelAnchor implements AnchorChain {
  readonly chainId: bigint;
  readonly address: Uint8Array;
  readonly clock = CLOCK;
  time = 0n;
  /** How long after `time` a call is included, and judged. */
  inclusionDelay = 0n;
  /** Makes the next calls revert. */
  failing = false;
  readonly calls: Checkpoint[][] = [];
  /** The locator each call in `calls` carried, `undefined` for none. */
  readonly locators: (Uint8Array | undefined)[] = [];
  /** The locator the anchor holds. */
  held: Uint8Array | undefined;
  /** Calls sent, failed or not. */
  attempts = 0;
  readonly #slots = new Map<string, Anchor>();

  constructor(chain: { chainId?: bigint; address?: Uint8Array } = {}) {
    this.chainId = chain.chainId ?? l1ChainId;
    this.address = chain.address ?? b32().slice(12);
  }

  static key(electionId: Uint8Array, segment: number) {
    return `${Buffer.from(electionId).toString("hex")}/${segment}`;
  }

  async now() {
    return this.time;
  }

  async anchored(electionId: Uint8Array, segment: number) {
    const slot = this.#slots.get(ModelAnchor.key(electionId, segment));
    return slot === undefined ? undefined : checkpointHash(slot.checkpoint);
  }

  async latestLocator() {
    return this.held;
  }

  async anchor(checkpoints: readonly Checkpoint[], locator: Uint8Array | undefined) {
    this.attempts++;
    if (this.failing) throw new Error("reverted");
    if (checkpoints.length === 0 && locator === undefined) throw new Error("reverted");
    const keys = new Set<string>();
    for (const c of checkpoints) {
      const key = ModelAnchor.key(c.election_id, c.segment);
      if (c.size === 0n || this.#slots.has(key) || keys.has(key)) throw new Error("reverted");
      const at = this.time + this.inclusionDelay;
      if (at < endOf(c.segment) || at > endOf(c.segment) + CLOCK.deadline)
        throw new Error("reverted");
      keys.add(key);
    }
    this.calls.push([...checkpoints]);
    this.locators.push(locator);
    if (locator !== undefined) this.held = locator;
    for (const c of checkpoints)
      this.#slots.set(ModelAnchor.key(c.election_id, c.segment), {
        checkpoint: c,
        anchoredAt: this.time + this.inclusionDelay,
      });
  }

  /** Fills a slot as if another sender had. */
  put(checkpoint: Checkpoint) {
    this.#slots.set(ModelAnchor.key(checkpoint.election_id, checkpoint.segment), {
      checkpoint,
      anchoredAt: this.time,
    });
  }

  /** An L1 reorganisation that drops a slot's anchor. */
  drop(electionId: Uint8Array, segment: number) {
    this.#slots.delete(ModelAnchor.key(electionId, segment));
  }

  anchorsOf(electionId: Uint8Array): Anchor[] {
    const prefix = `${Buffer.from(electionId).toString("hex")}/`;
    return [...this.#slots].filter(([k]) => k.startsWith(prefix)).map(([, a]) => a);
  }
}

/** A run with the worker's clock at the L1 time, unless a test says otherwise. */
const run = (chain: ModelAnchor, localNow = chain.time) => anchorBoards(app, chain, localNow);

/**
 * An archive whose chain's manifests are those `locators` name, the i-th at
 * sequence i, and whose latest locator is the last.
 */
const archiveOf = (...locators: Uint8Array[]): LocatorSource => ({
  latest: async () =>
    locators.length === 0
      ? undefined
      : { sequence: BigInt(locators.length - 1), locator: locators.at(-1)! },
  sequenceOf: async (cid) => {
    const i = locators.findIndex((l) => Buffer.from(l.slice(2, 38)).equals(Buffer.from(cid)));
    return i < 0 ? undefined : BigInt(i);
  },
});

/** A run over `archive`. */
const runWith = (chain: ModelAnchor, archive: LocatorSource) =>
  anchorBoards(app, chain, chain.time, { archive });

/** The run's findings about no election: the locator's. */
const locatorFindings = (result: AnchorRun) =>
  result.findings.filter((f) => f.electionId === undefined).map((f) => f.code);

/** A version-3 locator naming a raw CID and a transaction (docs/spec/archive.md, Locator). */
const locatorOf = (version: 1 | 2 | 3 = 3) =>
  encodeArchiveLocator(Uint8Array.of(0x01, 0x55, 0x12, 0x20, ...b32()), b32(), version);

const reportOf = (result: AnchorRun, e: Uint8Array) =>
  result.reports.find((r) => Buffer.from(r.electionId).equals(Buffer.from(e)));

const findingsOf = (findings: readonly AnchorFinding[], e: Uint8Array) =>
  findings
    .filter((f) => f.electionId !== undefined && Buffer.from(f.electionId).equals(Buffer.from(e)))
    .map((f) => (f.segment === undefined ? f.code : `${f.code}@${f.segment}`));

describe("schema", () => {
  test("the Drizzle table matches the migrated one", async () => {
    const cols = await db.admin`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = 'board_checkpoints' ORDER BY ordinal_position`;
    const config = getTableConfig(boardCheckpoints);
    expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
      config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
    );
    const pk = await db.admin`
      SELECT array_agg(a.attname ORDER BY array_position(i.indkey, a.attnum)) AS cols
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = ${`"${db.schema}".board_checkpoints`}::regclass AND i.indisprimary
      GROUP BY i.indexrelid`;
    expect(pk.map((r) => r["cols"])).toEqual([config.primaryKeys[0]!.columns.map((c) => c.name)]);
  });

  test("the app role holds SELECT and INSERT and nothing else", async () => {
    const privs = await db.admin`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = ${db.schema} AND table_name = 'board_checkpoints' AND grantee = 'abolish_app'
      ORDER BY privilege_type`;
    expect(privs.map((p) => p["privilege_type"])).toEqual(["INSERT", "SELECT"]);
  });
});

describe("append-only", () => {
  const changes = {
    update: (sql: Sql, e: Uint8Array) =>
      sql`UPDATE board_checkpoints SET size = size WHERE election_id = ${e}`,
    delete: (sql: Sql, e: Uint8Array) =>
      sql`DELETE FROM board_checkpoints WHERE election_id = ${e}`,
    truncate: (sql: Sql) => sql`TRUNCATE board_checkpoints`,
  };
  for (const [role, client] of [
    ["app", () => app],
    ["owner", () => owner],
  ] as const) {
    for (const [op, run] of Object.entries(changes)) {
      test(`${op} fails as the ${role}`, async () => {
        const e = await boardIn(0);
        await takeCheckpoints(app, e, 0);
        expect(await failsWith(run(client(), e))).toBe("42501");
        expect(await readCheckpoints(app, e)).toHaveLength(1);
      });
    }
  }

  test("the app role can't disable the triggers or drop the table", async () => {
    expect(await failsWith(app`ALTER TABLE board_checkpoints DISABLE TRIGGER USER`)).toBe("42501");
    expect(await failsWith(app`DROP TABLE board_checkpoints`)).toBe("42501");
  });
});

describe("the table's checks", () => {
  const put = (c: Checkpoint, bytes = encodeCheckpoint(c), size = c.size) =>
    app`INSERT INTO board_checkpoints (election_id, segment, size, checkpoint)
      VALUES (${c.election_id}, ${c.segment.toString()}, ${size.toString()}, ${bytes})`;

  test("accepts the verifier's checkpoint, once", async () => {
    const e = await boardIn(0, 0, 2);
    const c = (await expected(e, 2))!;
    await put(c);
    expect(await readCheckpoints(app, e)).toEqual([c]);
    expect(await failsWith(put(c))).toBe("23514");
  });

  test("refuses a segment at or below a taken one", async () => {
    const e = await boardIn(0, 3);
    await put((await expected(e, 3))!);
    expect(await failsWith(put((await expected(e, 0))!))).toBe("23514");
  });

  test("refuses an encoding that doesn't carry the row's election, segment or size", async () => {
    const e = await boardIn(0, 1);
    const c = (await expected(e, 0))!;
    const other = await boardIn(0);
    for (const bytes of [
      encodeCheckpoint({ ...c, election_id: other }),
      encodeCheckpoint({ ...c, segment: 9 }),
      encodeCheckpoint({ ...c, size: 2n }),
    ])
      expect(await failsWith(put(c, bytes))).toBe("23514");
    expect(await failsWith(put(c, encodeCheckpoint(c), 2n))).toBe("23514");
  });

  test("refuses a size that doesn't end its segment, or exceeds the board", async () => {
    const e = await boardIn(0, 0, 1);
    const c = (await expected(e, 0))!;
    for (const size of [1n, 3n, 4n])
      expect(await failsWith(put({ ...c, size }, encodeCheckpoint({ ...c, size }), size))).toBe(
        "23514",
      );
  });

  test("refuses a head that isn't the last entry's link", async () => {
    const e = await boardIn(0, 1);
    const c = (await expected(e, 0))!;
    expect(await failsWith(put({ ...c, head: b32() }))).toBe("23514");
  });

  test("the board refuses an entry at or below a taken segment, from any writer", async () => {
    const e = await boardIn(0, 2);
    await takeCheckpoints(app, e, 2);
    const [last] = await app`SELECT link FROM board_entries WHERE election_id = ${e} AND idx = 1`;
    const insert = (segment: number) =>
      app`INSERT INTO board_entries (election_id, idx, segment, payload, entry_hash, prev_link, link)
        VALUES (${e}, 2, ${segment}, ${ballot(9)}, ${b32()}, ${last!["link"]}, ${b32()})`;
    // Segment 2 is the previous entry's, so only the fence refuses it.
    expect(await failsWith(insert(2))).toBe("23514");
    await insert(3);
  });

  test("a checkpoint and an entry behind it, written concurrently without the lock, never both land", async () => {
    // Raw writers that skip appendEntry's and takeCheckpoints' lock: the
    // triggers take it, so the second waits for the first and sees it.
    const e = await boardIn(0);
    const c = (await expected(e, 0))!;
    const [first] = await app`SELECT link FROM board_entries WHERE election_id = ${e}`;
    const other = await db.as("abolish_app");
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const putting = new Promise<void>((r) => (inserted = r));
    const take = app.begin(async (tx) => {
      await tx`INSERT INTO board_checkpoints (election_id, segment, size, checkpoint)
        VALUES (${e}, 0, 1, ${encodeCheckpoint(c)})`;
      inserted();
      await held;
    });
    await putting;
    let settled = false;
    const append = failsWith(
      other`INSERT INTO board_entries (election_id, idx, segment, payload, entry_hash, prev_link, link)
        VALUES (${e}, 1, 0, ${ballot(9)}, ${b32()}, ${first!["link"]}, ${b32()})`,
    ).finally(() => (settled = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);
    release();
    await take;
    expect(await append).toBe("23514");
    expect(await readCheckpoints(app, e)).toEqual([c]);
    expect(await readBoard(app, e)).toHaveLength(1);
  });

  test("a temporary table can't stand in for the checkpoints", async () => {
    const e = await boardIn(0);
    await takeCheckpoints(app, e, 0);
    await app`CREATE TEMP TABLE board_checkpoints (LIKE ${app(db.schema)}.board_checkpoints)`;
    try {
      // appendEntry reads the empty temporary table and lets the entry
      // through; the trigger, reading the real one, refuses it.
      expect(await failsWith(appendEntry(app, e, 0, ballot(9)))).toBe("23514");
      expect(await readBoard(app, e)).toHaveLength(1);
    } finally {
      await app`DROP TABLE pg_temp.board_checkpoints`;
    }
  });
});

describe("takeCheckpoints", () => {
  let pool: Sql[];
  beforeAll(async () => {
    pool = await Promise.all([1, 2, 3, 4].map(() => db.as("abolish_app")));
  });

  test("takes the verifier's checkpoint of each ended period that added entries", async () => {
    const e = await boardIn(0, 0, 2, 5, 5, 7);
    const taken = await takeCheckpoints(app, e, 5);
    expect(taken.map((c) => c.segment)).toEqual([0, 2, 5]);
    for (const c of taken) expect(c).toEqual(await expected(e, c.segment));
    expect(await readCheckpoints(app, e)).toEqual(taken);
    expect(await readCheckpoints(app, e, 1)).toEqual(taken.slice(1));
  });

  test("takes nothing twice, nothing before the board starts, and nothing at -1", async () => {
    const e = await boardIn(3, 4);
    expect(await takeCheckpoints(app, e, -1)).toEqual([]);
    expect(await takeCheckpoints(app, e, 2)).toEqual([]);
    expect((await takeCheckpoints(app, e, 3)).map((c) => c.segment)).toEqual([3]);
    expect(await takeCheckpoints(app, e, 3)).toEqual([]);
    expect((await takeCheckpoints(app, e, 9)).map((c) => c.segment)).toEqual([4]);
    expect(await takeCheckpoints(app, e, 9)).toEqual([]);
    expect(await takeCheckpoints(app, await newElection(app), 9)).toEqual([]);
  });

  test.each([[-2], [0.5], [2 ** 32]])("refuses through = %s", async (through) => {
    await expect(takeCheckpoints(app, await boardIn(0), through)).rejects.toThrow(RangeError);
  });

  test("fences the segment: appendEntry refuses it, or labels the entry after it", async () => {
    const e = await boardIn(0, 2);
    await takeCheckpoints(app, e, 3);
    expect(await failsWith(appendEntry(app, e, 2, ballot(9)))).toBe("segment-checkpointed");
    expect(await failsWith(appendEntry(app, e, 0, ballot(9)))).toBe("segment-checkpointed");
    const raised = await appendEntry(app, e, 1, ballot(9), { raiseToPrevious: true });
    // After the last taken checkpoint (2), not after `through` (3): period 3
    // added nothing, so it took none, and an entry in it is still anchorable.
    expect(raised.entry).toEqual((await readBoard(app, e))[2]);
    expect(checkBoard(e, await readBoard(app, e), 5).entries[2]!.segment).toBe(3);
    expect((await appendEntry(app, e, 3, ballot(10))).index).toBe(3n);
    expect((await takeCheckpoints(app, e, 3)).map((c) => c.segment)).toEqual([3]);
    // Every checkpoint taken stays the verifier's for the final board.
    for (const c of await readCheckpoints(app, e)) expect(c).toEqual(await expected(e, c.segment));
  });

  test(
    "appends racing takes never land behind a taken checkpoint",
    { timeout: 300_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.tuple(fc.integer({ min: 0, max: 5 }), fc.boolean()), {
            minLength: 1,
            maxLength: 12,
          }),
          async (ops) => {
            const e = await newElection(app);
            // Appends labelled by a lagging clock, raised as admission raises
            // them, race takes through each label, over separate connections.
            await Promise.all(
              ops.map(([s, take], i) => {
                const client = pool[i % pool.length]!;
                return take
                  ? takeCheckpoints(client, e, s)
                  : appendEntry(client, e, s, ballot(i), { raiseToPrevious: true });
              }),
            );
            const board = await readBoard(app, e);
            for (const c of await readCheckpoints(app, e))
              expect(c).toEqual(checkpointOf(checkBoard(e, board, 5), c.segment));
          },
        ),
        { numRuns: Math.min(numRuns, 50) },
      );
    },
  );
});

describe("readLatestCheckpoints (P2-19)", () => {
  test("pages the taken checkpoints back from the latest, as stored", async () => {
    const e = await boardIn(0, 1, 3, 4, 6);
    const taken = await takeCheckpoints(app, e, 6);
    const latest = taken.toReversed().map(encodeCheckpoint);
    expect(await readLatestCheckpoints(app, e, 10)).toEqual(latest);
    expect(await readLatestCheckpoints(app, e, 2)).toEqual(latest.slice(0, 2));
    expect(await readLatestCheckpoints(app, e, 2, 4n)).toEqual(latest.slice(2, 4));
    expect(await readLatestCheckpoints(app, e, 10, 1n)).toEqual(latest.slice(4));
    expect(await readLatestCheckpoints(app, e, 10, 0n)).toEqual([]);
    expect(await readLatestCheckpoints(app, e, 0)).toEqual([]);
    // A `before` past every u32 segment is no bound at all.
    expect(await readLatestCheckpoints(app, e, 10, 2n ** 64n - 1n)).toEqual(latest);
    expect(await readLatestCheckpoints(app, await newElection(app), 10)).toEqual([]);
  });

  test("never reaches another board's checkpoints", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 0, max: 20 }), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 0, max: 8 }),
        fc.option(fc.bigInt({ min: 0n, max: 22n }), { nil: undefined }),
        async (segments, limit, before) => {
          const sorted = segments.toSorted((a, b) => a - b);
          const e = await boardIn(...sorted);
          // Another board with the same segments, so a missing election filter shows.
          await takeCheckpoints(app, await boardIn(...sorted), 20);
          const taken = await takeCheckpoints(app, e, 20);
          const want = taken
            .filter((c) => before === undefined || BigInt(c.segment) < before)
            .toReversed()
            .slice(0, limit)
            .map(encodeCheckpoint);
          expect(await readLatestCheckpoints(app, e, limit, before)).toEqual(want);
        },
      ),
      { numRuns: Math.min(numRuns, 25) },
    );
    // Up to 25 runs, each building two boards and taking up to 40
    // checkpoints, outlast the default 5 s on a loaded CI runner.
  }, 60_000);

  test.each([[-1], [0.5]])("refuses limit = %s", async (limit) => {
    await expect(readLatestCheckpoints(app, await boardIn(0), limit)).rejects.toThrow(RangeError);
  });

  test("refuses a negative before", async () => {
    await expect(readLatestCheckpoints(app, await boardIn(0), 1, -1n)).rejects.toThrow(RangeError);
  });
});

describe("anchorBoards", () => {
  test("anchors each election's ended periods in one call, then nothing more", async () => {
    const chain = new ModelAnchor();
    const e = await boardFor(chain, 0, 1, 1, 3);
    const f = await boardFor(chain, 1);
    chain.time = endOf(1) + 60n;
    const result = await run(chain);
    expect(reportOf(result, e)).toEqual({ electionId: e, taken: [0, 1], anchored: [0, 1] });
    expect(reportOf(result, f)).toEqual({ electionId: f, taken: [1], anchored: [1] });
    expect(findingsOf(result.findings, e)).toEqual([]);
    for (const s of [0, 1])
      expect(await chain.anchored(e, s)).toEqual(checkpointHash((await expected(e, s))!));
    const calls = chain.calls.filter((c) => Buffer.from(c[0]!.election_id).equals(Buffer.from(e)));
    expect(calls.map((c) => c.map((x) => x.segment))).toEqual([[0, 1]]);
    // This database's archive holds no chain, so no call carries a locator.
    expect(chain.locators.every((l) => l === undefined)).toBe(true);
    expect(result.locator).toBeUndefined();
    const before = chain.calls.length;
    expect(reportOf(await run(chain), e)).toEqual({
      electionId: e,
      taken: [],
      anchored: [],
    });
    expect(chain.calls.length).toBe(before);
  });

  test("anchors nothing in the first period, or before the epoch", async () => {
    const chain = new ModelAnchor();
    const e = await boardFor(chain, 0);
    chain.time = endOf(0) - 1n;
    await run(chain);
    expect(await chain.anchored(e, 0)).toBeUndefined();
    expect(await readCheckpoints(app, e)).toEqual([]);
  });

  test("leaves an election that names another anchor or L1 alone", async () => {
    const own = new ModelAnchor();
    const e = await boardFor(own, 0);
    for (const chain of [
      new ModelAnchor(),
      new ModelAnchor({ address: own.address, chainId: l1ChainId + 1n }),
    ]) {
      chain.time = endOf(0);
      const result = await run(chain);
      expect(findingsOf(result.findings, e)).toEqual(["anchor-unserved"]);
      expect(chain.calls).toEqual([]);
    }
    expect(await readCheckpoints(app, e)).toEqual([]);
  });

  test("reports a slot holding another checkpoint, and sends the rest", async () => {
    const chain = new ModelAnchor();
    const e = await boardFor(chain, 0, 1);
    chain.time = endOf(1);
    chain.put({ ...(await expected(e, 0))!, root: b32() });
    const result = await run(chain);
    expect(findingsOf(result.findings, e)).toEqual(["anchor-conflict@0"]);
    expect(chain.calls.map((c) => c.map((x) => x.segment))).toEqual([[1]]);
  });

  test("a failed call is retried while timely, overdue past half the deadline, missed after it", async () => {
    const chain = new ModelAnchor();
    const e = await boardFor(chain, 0);
    chain.failing = true;
    chain.time = endOf(0) + 60n;
    expect(findingsOf((await run(chain)).findings, e)).toEqual(["anchor-send-failed"]);
    chain.time = endOf(0) + CLOCK.deadline / 2n;
    expect(findingsOf((await run(chain)).findings, e)).toEqual([
      "anchor-send-failed",
      "anchor-overdue@0",
    ]);
    chain.time = endOf(0) + CLOCK.deadline + 1n;
    chain.failing = false;
    expect(findingsOf((await run(chain)).findings, e)).toEqual(["anchor-missed@0"]);
    expect(chain.calls).toEqual([]);
    // Reported for one deadline after it, then no longer read.
    chain.time = endOf(0) + 2n * CLOCK.deadline + 1n;
    expect(findingsOf((await run(chain)).findings, e)).toEqual([]);
  });

  test("the last moment of the window still anchors", async () => {
    const chain = new ModelAnchor();
    const e = await boardFor(chain, 0);
    chain.time = endOf(0) + CLOCK.deadline;
    await run(chain);
    expect(await chain.anchored(e, 0)).toBeDefined();
  });

  test("an anchor dropped by a reorganisation is sent again", async () => {
    const chain = new ModelAnchor();
    const e = await boardFor(chain, 0);
    chain.time = endOf(0);
    await run(chain);
    chain.drop(e, 0);
    chain.time += 60n;
    expect(reportOf(await run(chain), e)?.anchored).toEqual([0]);
    expect(await chain.anchored(e, 0)).toEqual(checkpointHash((await expected(e, 0))!));
  });

  test("one election's failing reads hold back no other's anchors", async () => {
    const chain = new ModelAnchor();
    const e = await boardFor(chain, 0);
    const f = await boardFor(chain, 0);
    chain.time = endOf(0);
    const anchored = chain.anchored.bind(chain);
    chain.anchored = async (id, s) => {
      if (Buffer.from(id).equals(Buffer.from(e))) throw new Error("node down");
      return anchored(id, s);
    };
    const result = await run(chain);
    expect(findingsOf(result.findings, e)).toEqual(["anchor-error"]);
    expect(await chain.anchored(f, 0)).toBeDefined();
  });

  test("sends nothing for an election whose stored checkpoint the board doesn't give", async () => {
    const chain = new ModelAnchor();
    const e = await boardFor(chain, 0, 1);
    const c = (await expected(e, 0))!;
    // Election, segment, size and head pass the table's checks; the root
    // and CIDs need hashing, so only the run can catch them.
    await app`INSERT INTO board_checkpoints (election_id, segment, size, checkpoint)
      VALUES (${e}, 0, 1, ${encodeCheckpoint({ ...c, root: b32() })})`;
    chain.time = endOf(1);
    const result = await run(chain);
    expect(findingsOf(result.findings, e)).toEqual(["anchor-mismatch@0"]);
    expect(chain.calls).toEqual([]);
    expect(reportOf(result, e)).toEqual({ electionId: e, taken: [1], anchored: [] });
  });

  test("takes no period the worker's clock hasn't seen end, whatever the node says", async () => {
    const chain = new ModelAnchor();
    const e = await boardFor(chain, 0, 1, 2, 3);
    chain.time = endOf(3) + 60n;
    // The node is three hours ahead of the worker's clock, which is in period 1.
    const result = await run(chain, endOf(0) + 60n);
    expect(result.findings.filter((f) => f.code === "anchor-clock")).toEqual([
      { code: "anchor-clock" },
    ]);
    expect(reportOf(result, e)?.taken).toEqual([0]);
    // Within the allowed lead, the node's time decides.
    chain.time = endOf(1) + MAX_L1_CLOCK_LEAD;
    const close = await run(chain, endOf(1));
    expect(close.findings.filter((f) => f.code === "anchor-clock")).toEqual([]);
    expect(reportOf(close, e)?.taken).toEqual([1]);
  });

  test("a checkpoint near its deadline goes alone, so its revert holds back no other", async () => {
    const chain = new ModelAnchor();
    const e = await boardFor(chain, 0, 11);
    chain.time = endOf(0) + CLOCK.deadline - 100n;
    // Included 200 seconds later: past segment 0's window, inside 11's.
    chain.inclusionDelay = 200n;
    const result = await run(chain);
    expect(chain.calls.map((c) => c.map((x) => x.segment))).toEqual([[11]]);
    expect(findingsOf(result.findings, e)).toEqual(["anchor-send-failed", "anchor-overdue@0"]);
    expect(reportOf(result, e)?.anchored).toEqual([11]);
  });

  test("before the epoch, a run takes and sends nothing", async () => {
    const chain = Object.assign(new ModelAnchor(), { clock: { ...CLOCK, epoch: 10n * HOUR } });
    const e = await boardFor(chain, 0);
    chain.time = HOUR;
    const result = await run(chain);
    expect(findingsOf(result.findings, e)).toEqual([]);
    expect(reportOf(result, e)).toEqual({ electionId: e, taken: [], anchored: [] });
  });

  test("refuses a chain with a bad clock or address", async () => {
    const chain = new ModelAnchor();
    for (const bad of [
      Object.assign(new ModelAnchor(), { clock: { ...CLOCK, period: 0n } }),
      Object.assign(new ModelAnchor(), { address: new Uint8Array(19) }),
    ])
      await expect(run(bad)).rejects.toThrow();
    await expect(anchorBoards(app, chain, -1n)).rejects.toThrow(TypeError);
    chain.now = async () => -1n;
    await expect(run(chain)).rejects.toThrow(TypeError);
  });

  test("a run that meets another's lock reads, takes and sends nothing", async () => {
    const chain = new ModelAnchor();
    const e = await boardFor(chain, 0);
    chain.time = endOf(0) + 60n;
    let reads = 0;
    const now = chain.now.bind(chain);
    chain.now = () => (reads++, now());
    const other = await db.as("abolish_app");
    await other`SELECT pg_advisory_lock(hashtextextended('anchor_writer:' || current_schema(), 0))`;
    try {
      expect(await run(chain)).toEqual({
        reports: [],
        findings: [{ code: "anchor-busy" }],
        locator: undefined,
      });
      expect(reads).toBe(0);
      expect(chain.attempts).toBe(0);
      expect(await readCheckpoints(app, e)).toEqual([]);
    } finally {
      await other`SELECT pg_advisory_unlock(hashtextextended('anchor_writer:' || current_schema(), 0))`;
    }
    expect(reportOf(await run(chain), e)?.anchored).toEqual([0]);
  });

  test("a run overlapping another, from another process, does nothing until it ends", async () => {
    const chain = new ModelAnchor();
    const e = await boardFor(chain, 0);
    chain.time = endOf(0) + 60n;
    // The first run's call stays pending until the second run has finished.
    let release!: () => void;
    const pending = new Promise<void>((r) => (release = r));
    const send = chain.anchor.bind(chain);
    let entered!: () => void;
    const inCall = new Promise<void>((r) => (entered = r));
    chain.anchor = async (checkpoints, locator) => {
      entered();
      await pending;
      return send(checkpoints, locator);
    };
    const first = run(chain);
    await inCall;
    // Bounded, so a second run that isn't kept out fails here rather than
    // waiting on the first's call until the test's timeout.
    const second = await Promise.race([
      anchorBoards(await db.as("abolish_app", { max: 2 }), chain, chain.time),
      new Promise<"overlapped">((r) => setTimeout(() => r("overlapped"), 2000)),
    ]);
    expect(second).toMatchObject({ findings: [{ code: "anchor-busy" }] });
    release();
    expect(reportOf(await first, e)?.anchored).toEqual([0]);
    expect(chain.attempts).toBe(1);
  });

  test("a run that throws releases the lock", async () => {
    const chain = new ModelAnchor();
    await boardFor(chain, 0);
    chain.time = endOf(0) + 60n;
    // Thrown inside the lock, by the run's first read.
    chain.now = async () => "nonsense" as unknown as bigint;
    await expect(run(chain)).rejects.toThrow(TypeError);
    const other = await db.as("abolish_app");
    const [row] =
      await other`SELECT pg_try_advisory_lock(hashtextextended('anchor_writer:' || current_schema(), 0)) AS held`;
    expect(row?.["held"]).toBe(true);
    await other`SELECT pg_advisory_unlock(hashtextextended('anchor_writer:' || current_schema(), 0))`;
  });

  test("refuses a pool of one connection, which the lock would hold", async () => {
    await expect(anchorBoards(await db.as("abolish_app"), new ModelAnchor(), 0n)).rejects.toThrow(
      /two connections/,
    );
  });

  test(
    "runs at most half a deadline apart leave a board the verifier accepts",
    { timeout: 300_000 },
    async () => {
      await fc.assert(
        fc.asyncProperty(
          // Each step: a pause, some appends at the time reached, then a run.
          fc.array(
            fc.tuple(
              fc.bigInt({ min: 0n, max: CLOCK.deadline / 2n }),
              fc.integer({ min: 0, max: 3 }),
            ),
            { minLength: 1, maxLength: 12 },
          ),
          async (steps) => {
            const chain = new ModelAnchor();
            const e = await newElection(app, 5, chain.address);
            chain.time = 10n * HOUR;
            let entries = 0;
            for (const [pause, appends] of steps) {
              chain.time += pause;
              // Labelled by a clock a minute behind L1's, as admission labels.
              const s = Number((chain.time - 60n - CLOCK.epoch) / CLOCK.period);
              for (let i = 0; i < appends; i++)
                await appendEntry(app, e, s, ballot(entries++), { raiseToPrevious: true });
              await run(chain);
            }
            // Two closing runs: one past the last entry's period, one more to
            // show nothing is left to send.
            chain.time += CLOCK.period;
            await run(chain);
            chain.time += 60n;
            const before = chain.calls.length;
            await run(chain);
            expect(chain.calls.length).toBe(before);
            const board = await readBoard(app, e);
            const anchors = chain.anchorsOf(e);
            // Every period with entries is anchored, in time; the verifier
            // authenticates the whole board from those anchors.
            const verified = verifyBoard(
              e,
              board,
              5,
              anchors,
              { ...CLOCK, lastSegment: 0xffffffff },
              chain.time,
            );
            expect(verified.unauthenticated).toBe(0);
            expect(verified.board.entries.length).toBe(board.length);
          },
        ),
        { numRuns: Math.min(numRuns, 30) },
      );
    },
  );
});

// Each run reads every election in the schema, and by this block the
// property tests above have made hundreds; the tests that run eight or so
// archives' worth of runs outlast the default 5 s on a loaded CI runner. A
// test that times out leaves its run holding the anchoring lock, so every
// later one met `anchor-busy` and the file's \`afterAll\` waited on it too.
describe("the archive's locator", { timeout: 60_000 }, () => {
  test("every call with checkpoints carries it, and none goes alone", async () => {
    const chain = new ModelAnchor();
    const e = await boardFor(chain, 0, 11);
    const f = await boardFor(chain, 1);
    chain.time = endOf(0) + CLOCK.deadline - 100n;
    const locator = locatorOf();
    const result = await runWith(chain, archiveOf(locator));
    // Segment 0 goes alone, after 11, near its deadline; f's in a call of its own.
    expect(chain.calls.length).toBe(3);
    expect(chain.locators).toEqual([locator, locator, locator]);
    expect(result.locator).toBe("carried");
    expect(reportOf(result, e)?.anchored).toEqual([11, 0]);
    expect(reportOf(result, f)?.anchored).toEqual([1]);
    expect(chain.held).toEqual(locator);
    expect(locatorFindings(result)).toEqual([]);
  });

  test("a run with nothing to anchor sends it alone, unless the anchor holds it", async () => {
    const chain = new ModelAnchor();
    chain.time = endOf(5);
    const first = locatorOf();
    expect((await runWith(chain, archiveOf(first))).locator).toBe("sent");
    expect(chain.calls).toEqual([[]]);
    expect(chain.locators).toEqual([first]);
    expect((await runWith(chain, archiveOf(first))).locator).toBe("held");
    expect(chain.calls.length).toBe(1);
    // A newer locator, from the archive confirming, replaces it.
    const next = locatorOf();
    expect((await runWith(chain, archiveOf(first, next))).locator).toBe("sent");
    expect(chain.held).toEqual(next);
  });

  test("an archive with no locator sends none and leaves the anchor's in place", async () => {
    const chain = new ModelAnchor();
    const e = await boardFor(chain, 0);
    chain.held = locatorOf();
    const held = chain.held;
    chain.time = endOf(0);
    const result = await runWith(chain, archiveOf());
    expect(reportOf(result, e)?.anchored).toEqual([0]);
    expect(chain.locators).toEqual([undefined]);
    expect(chain.held).toBe(held);
    expect(result.locator).toBeUndefined();
    expect(locatorFindings(result)).toEqual([]);
  });

  test("a locator that can't be read, or isn't version 3, is never sent and holds back no anchor", async () => {
    const at = (locator: unknown, sequence: unknown = 0n): LocatorSource => ({
      latest: async () => ({ locator, sequence }) as never,
      sequenceOf: async () => undefined,
    });
    const archives: LocatorSource[] = [
      {
        latest: async () => {
          throw new Error("archive down");
        },
        sequenceOf: async () => undefined,
      },
      at(locatorOf(1)),
      at(locatorOf(2)),
      at(locatorOf().slice(0, 69)),
      at(Uint8Array.of(0x00, 0x03, ...locatorOf().slice(2, 38), 0)),
      at("0x00"),
      at(locatorOf(), -1n),
      at(locatorOf(), 0),
    ];
    for (const archive of archives) {
      const chain = new ModelAnchor();
      const e = await boardFor(chain, 0);
      chain.time = endOf(0);
      const result = await runWith(chain, archive);
      expect(locatorFindings(result)).toEqual(["anchor-locator-unread"]);
      expect(reportOf(result, e)?.anchored).toEqual([0]);
      expect(chain.locators).toEqual([undefined]);
      expect(result.locator).toBeUndefined();
    }
  });

  test("never overwrites a locator that isn't ours at or below the archive's", async () => {
    const ours = [locatorOf(), locatorOf()];
    for (const held of [
      // Another chain's, or one this database lost (a wipe and a new chain).
      locatorOf(),
      // Ours, above the archive's latest: a run reading a stale archive.
      ours[1]!,
      // One no version this reader knows names.
      Uint8Array.of(0x00, 0x09, 1, 2, 3),
    ]) {
      const chain = new ModelAnchor();
      const e = await boardFor(chain, 0);
      chain.held = held;
      chain.time = endOf(0);
      const result = await runWith(chain, archiveOf(ours[0]!));
      expect(locatorFindings(result)).toEqual(["anchor-locator-foreign"]);
      expect(reportOf(result, e)?.anchored).toEqual([0]);
      expect(chain.locators).toEqual([undefined]);
      expect(chain.held).toBe(held);
    }
    // Ours, above the latest a stale read of our own archive gives: never
    // sent, so the anchor's locator never falls.
    const stale: LocatorSource = {
      latest: async () => ({ sequence: 0n, locator: ours[0]! }),
      sequenceOf: (cid) => archiveOf(...ours).sequenceOf(cid),
    };
    const ahead = new ModelAnchor();
    ahead.held = ours[1];
    ahead.time = endOf(5);
    const fell = await runWith(ahead, stale);
    expect(locatorFindings(fell)).toEqual(["anchor-locator-foreign"]);
    expect(ahead.calls).toEqual([]);
    // Ours below the archive's latest is replaced.
    const chain = new ModelAnchor();
    chain.held = ours[0];
    chain.time = endOf(5);
    expect((await runWith(chain, archiveOf(...ours))).locator).toBe("sent");
    expect(chain.held).toEqual(ours[1]);
  });

  test("after a failed checkpoint call the locator never goes alone, so it can't displace the call", async () => {
    const chain = new ModelAnchor();
    const e = await boardFor(chain, 0);
    chain.time = endOf(0);
    chain.failing = true;
    const locator = locatorOf();
    const failed = await runWith(chain, archiveOf(locator));
    expect(findingsOf(failed.findings, e)).toEqual(["anchor-send-failed"]);
    expect(locatorFindings(failed)).toEqual([]);
    expect(failed.locator).toBeUndefined();
    expect(chain.attempts).toBe(1);
    chain.failing = false;
    chain.time += 60n;
    expect((await runWith(chain, archiveOf(locator))).locator).toBe("carried");
    expect(chain.locators).toEqual([locator]);
  });

  test("a failed locator-only call, or a failed read of the anchor's, is reported and retried", async () => {
    const chain = new ModelAnchor();
    chain.time = endOf(5);
    chain.failing = true;
    const locator = locatorOf();
    const failed = await runWith(chain, archiveOf(locator));
    expect(locatorFindings(failed)).toEqual(["anchor-locator-failed"]);
    expect(failed.locator).toBeUndefined();
    chain.failing = false;
    expect((await runWith(chain, archiveOf(locator))).locator).toBe("sent");
    // A read of the anchor's locator that fails, or answers nonsense,
    // carries none: checkpoints still go.
    for (const answer of [
      async () => {
        throw new Error("node down");
      },
      async () => "0x" as unknown as Uint8Array,
    ]) {
      const other = new ModelAnchor();
      const e = await boardFor(other, 0);
      other.time = endOf(0);
      other.latestLocator = answer;
      const unread = await runWith(other, archiveOf(locatorOf()));
      expect(locatorFindings(unread)).toEqual(["anchor-locator-failed"]);
      expect(reportOf(unread, e)?.anchored).toEqual([0]);
      expect(other.locators).toEqual([undefined]);
    }
  });

  test("by default reads this database's archive, which names nothing while it holds no chain", async () => {
    const chain = new ModelAnchor();
    chain.time = endOf(5);
    const result = await run(chain);
    expect(result.locator).toBeUndefined();
    expect(locatorFindings(result)).toEqual([]);
    expect(chain.calls).toEqual([]);
  });
});
