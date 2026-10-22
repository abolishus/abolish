import { BN254_R } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { getTableConfig } from "drizzle-orm/pg-core";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  appendEntry,
  AppendError,
  boardBallotKeys,
  type BallotKey,
  loadMigrations,
  migrate,
  readBoard,
} from "../src/index.ts";
import { newElection, type TestDb, testDb } from "./db.ts";

// The board_ballot_keys table's guarantees (migrations/0008_board_ballot_keys.sql;
// T-23, T-38, T-52): the app role can only read and append, nobody (the
// owner included) can change or remove a row, a key names a ballot on the
// board, and appendEntry boards a key once. Admission against real ballots,
// whose keys the verifier computes, is admission.test.ts's.

const b32 = () => new Uint8Array(randomBytes(32));
const ballot = (...body: number[]) => Uint8Array.of(0x00, 0x02, 1, ...body);
const transcript = Uint8Array.of(0x00, 0x05, 1);
const keyOf = (tier = 0, nullifier = 7n, message = new Uint8Array(32).fill(1)): BallotKey => ({
  tier,
  nullifier,
  message,
  ballotHash: b32(),
});

let db: TestDb;
let app: Sql;
let owner: Sql;

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  owner = await db.as("abolish_migrator");
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

const count = async (e: Uint8Array) =>
  (await db.admin`SELECT count(*)::int AS n FROM board_ballot_keys WHERE election_id = ${e}`)[0]![
    "n"
  ];

describe("schema", () => {
  test("the Drizzle table matches the migrated one", async () => {
    const cols = await db.admin`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = 'board_ballot_keys' ORDER BY ordinal_position`;
    const config = getTableConfig(boardBallotKeys);
    expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
      config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
    );
    const indexes = await db.admin`
      SELECT i.indisprimary AS pk, array_agg(a.attname ORDER BY array_position(i.indkey, a.attnum)) AS cols
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = ${`"${db.schema}".board_ballot_keys`}::regclass AND i.indisunique
      GROUP BY i.indexrelid, i.indisprimary ORDER BY i.indisprimary DESC`;
    expect(indexes.map((r) => [r["pk"], r["cols"]])).toEqual([
      [true, config.primaryKeys[0]!.columns.map((c) => c.name)],
      [false, config.uniqueConstraints[0]!.columns.map((c) => c.name)],
    ]);
  });

  test("the app role holds SELECT and INSERT and nothing else", async () => {
    const privs = await db.admin`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = ${db.schema} AND table_name = 'board_ballot_keys' AND grantee = 'abolish_app'
      ORDER BY privilege_type`;
    expect(privs.map((p) => p["privilege_type"])).toEqual(["INSERT", "SELECT"]);
  });
});

describe("append-only", () => {
  const changes = {
    update: (sql: Sql, e: Uint8Array) =>
      sql`UPDATE board_ballot_keys SET message = message WHERE election_id = ${e}`,
    delete: (sql: Sql, e: Uint8Array) =>
      sql`DELETE FROM board_ballot_keys WHERE election_id = ${e}`,
    truncate: (sql: Sql) => sql`TRUNCATE board_ballot_keys`,
  };
  for (const [role, client] of [
    ["app", () => app],
    ["owner", () => owner],
  ] as const) {
    for (const [op, run] of Object.entries(changes)) {
      test(`${op} fails as the ${role}`, async () => {
        const e = await newElection(app);
        await appendEntry(app, e, 0, ballot(1), { ballot: keyOf() });
        expect(await failsWith(run(client(), e))).toBe("42501");
        expect(await count(e)).toBe(1);
      });
    }
  }

  test("the app role can't disable the triggers or drop the table", async () => {
    expect(await failsWith(app`ALTER TABLE board_ballot_keys DISABLE TRIGGER USER`)).toBe("42501");
    expect(await failsWith(app`DROP TABLE board_ballot_keys`)).toBe("42501");
  });
});

describe("a key names a ballot on the board", () => {
  const put = (
    e: Uint8Array,
    idx: bigint | number,
    { tier = 0, nullifier = b32(), message = b32() } = {},
  ) =>
    app`INSERT INTO board_ballot_keys (election_id, tier, nullifier, message, idx)
      VALUES (${e}, ${tier}, ${nullifier}, ${message}, ${idx.toString()})`;

  test("refuses a key whose entry isn't on the board, or isn't a ballot", async () => {
    const e = await newElection(app);
    await appendEntry(app, e, 0, transcript);
    expect(await failsWith(put(e, 0))).toBe("23514");
    expect(await failsWith(put(e, 1))).toBe("23514");
    expect(await failsWith(put(b32(), 0))).toBe("23514");
  });

  test("refuses a second key for one entry, and one key twice", async () => {
    const e = await newElection(app);
    await appendEntry(app, e, 0, ballot(1), { ballot: keyOf() });
    await appendEntry(app, e, 0, ballot(2));
    expect(await failsWith(put(e, 0))).toBe("23505");
    const { tier, nullifier, message } = keyOf();
    const nu = Uint8Array.from(Buffer.from(nullifier.toString(16).padStart(64, "0"), "hex"));
    expect(
      await failsWith(put(e, 1, { tier, nullifier: nu, message: new Uint8Array(message) })),
    ).toBe("23505");
  });

  test.each([
    ["a short nullifier", { nullifier: new Uint8Array(31) }],
    ["a short message", { message: new Uint8Array(31) }],
    ["a tier above 255", { tier: 256 }],
    ["a negative tier", { tier: -1 }],
  ])("refuses %s", async (_, fields) => {
    const e = await newElection(app);
    await appendEntry(app, e, 0, ballot(1));
    expect(await failsWith(put(e, 0, fields))).toBe("23514");
  });

  test("a temporary table can't stand in for the board", async () => {
    const e = b32();
    await app`CREATE TEMP TABLE board_entries (LIKE ${app(db.schema)}.board_entries)`;
    await app`INSERT INTO pg_temp.board_entries VALUES (${e}, 0, 0, ${ballot(0)}, ${b32()}, ${new Uint8Array(32)}, ${b32()})`;
    expect(
      await failsWith(
        app`INSERT INTO ${app(db.schema)}.board_ballot_keys VALUES (${e}, 0, ${b32()}, ${b32()}, 0)`,
      ),
    ).toBe("23514");
    await app`DROP TABLE pg_temp.board_entries`;
    expect(await count(e)).toBe(0);
  });
});

describe("appendEntry with a ballot key", () => {
  test("boards a key once: the same bytes get their entry, other bytes are a repeat", async () => {
    const e = await newElection(app);
    const first = await appendEntry(app, e, 0, ballot(1), { ballot: keyOf() });
    await appendEntry(app, e, 1, ballot(9), { ballot: keyOf(0, 8n) });
    // Asked for a later segment, the retry still gets the entry as boarded.
    expect(await appendEntry(app, e, 2, ballot(1), { ballot: keyOf() })).toEqual(first);
    expect(await failsWith(appendEntry(app, e, 2, ballot(2), { ballot: keyOf() }))).toBe("repeat");
    expect(await readBoard(app, e)).toHaveLength(2);
    expect(await count(e)).toBe(2);
  });

  test("keys that differ in any part are different ballots", async () => {
    const e = await newElection(app);
    const message = new Uint8Array(32).fill(1);
    const other = new Uint8Array(32).fill(2);
    for (const [i, key] of [
      keyOf(0, 7n, message),
      keyOf(1, 7n, message),
      keyOf(0, 8n, message),
      keyOf(0, 7n, other),
    ].entries())
      expect((await appendEntry(app, e, 0, ballot(i), { ballot: key })).index).toBe(BigInt(i));
    // The same key on another election's board is no repeat.
    const f = await newElection(app);
    expect((await appendEntry(app, f, 0, ballot(0), { ballot: keyOf() })).index).toBe(0n);
  });

  test("a ballot boarded without a key makes nothing a repeat", async () => {
    // Only admitted ballots carry keys; appendEntry's other callers board
    // without one, and the verifier finds repeats among those itself.
    const e = await newElection(app);
    await appendEntry(app, e, 0, ballot(1));
    expect((await appendEntry(app, e, 0, ballot(2), { ballot: keyOf() })).index).toBe(1n);
  });

  test.each([
    ["a payload that isn't a ballot", transcript, keyOf()],
    ["a tier above 255", ballot(1), keyOf(256)],
    ["a fractional tier", ballot(1), keyOf(0.5)],
    ["a negative nullifier", ballot(1), keyOf(0, -1n)],
    ["a nullifier outside the field", ballot(1), keyOf(0, BN254_R)],
    ["a short message", ballot(1), keyOf(0, 7n, new Uint8Array(31))],
  ])("refuses %s, writing nothing", async (_, payload, key) => {
    const e = await newElection(app);
    expect(await failsWith(appendEntry(app, e, 0, payload, { ballot: key }))).toBe("invalid-entry");
    expect(await readBoard(app, e)).toHaveLength(0);
  });
});

describe("migration", () => {
  async function migrated(
    before: (sql: Sql) => Promise<unknown>,
  ): Promise<{ result: Promise<unknown>; done: () => Promise<void> }> {
    const schema = `t_${randomBytes(8).toString("hex")}`;
    await db.admin.unsafe(`CREATE SCHEMA "${schema}" AUTHORIZATION abolish_migrator`);
    const url = process.env["TEST_DATABASE_URL"] as string;
    const sql = postgres(url, { max: 1, onnotice: () => {}, connection: { search_path: schema } });
    await sql.unsafe("SET ROLE abolish_migrator");
    const all = loadMigrations();
    const at = all.findIndex((m) => m.name === "0008_board_ballot_keys.sql");
    await migrate(sql, schema, all.slice(0, at));
    await before(sql);
    const result = migrate(sql, schema, all);
    // Settled before the schema is dropped, whatever the outcome.
    await result.catch(() => {});
    return {
      result,
      done: async () => {
        await sql.end();
        await db.admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
      },
    };
  }
  const insert = (sql: Sql, payload: Uint8Array) =>
    sql`INSERT INTO board_entries (election_id, idx, segment, payload, entry_hash, prev_link, link)
      VALUES (${b32()}, 0, 0, ${payload}, ${b32()}, ${new Uint8Array(32)}, ${b32()})`;

  test("refuses to apply over a board that already has ballots", async () => {
    const m = await migrated((sql) => insert(sql, ballot(0)));
    try {
      await expect(m.result).rejects.toThrow(/wipe and rebuild/);
    } finally {
      await m.done();
    }
  });

  test("applies over a board with entries that aren't ballots", async () => {
    const m = await migrated((sql) => insert(sql, transcript));
    try {
      await expect(m.result).resolves.toContain("0008_board_ballot_keys.sql");
    } finally {
      await m.done();
    }
  });
});
