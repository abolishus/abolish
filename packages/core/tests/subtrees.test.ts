import { randomBytes } from "node:crypto";
import { getTableConfig } from "drizzle-orm/pg-core";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  appendEntry,
  boardSubtrees,
  loadMigrations,
  migrate,
  readConsistencyProof,
  readHead,
  readInclusionProof,
} from "../src/index.ts";
import { newElection, type TestDb, testDb } from "./db.ts";

// The board_subtrees table's guarantees (migrations/0006_board_subtrees.sql;
// T-23, T-52): the app role can only read and append, nobody (the owner
// included) can change or remove a row, and no subtree is written before its
// entries. Hashes are the audit's to check (audit.test.ts).

const b32 = () => new Uint8Array(randomBytes(32));
const ballot = (...body: number[]) => Uint8Array.of(0x00, 0x02, 1, ...body);

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
    const err = e as { code?: string; cause?: { code?: string } };
    return err.cause?.code ?? err.code ?? "no code";
  }
  throw new Error("query succeeded");
}

const count = async (e: Uint8Array) =>
  (await db.admin`SELECT count(*)::int AS n FROM board_subtrees WHERE election_id = ${e}`)[0]!["n"];

/** A board of `n` entries, appended through appendEntry. */
async function board(n: number): Promise<Uint8Array> {
  const id = await newElection(app);
  for (let i = 0; i < n; i++) await appendEntry(app, id, 0, ballot(i));
  return id;
}

describe("schema", () => {
  test("the Drizzle table matches the migrated one", async () => {
    const cols = await db.admin`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = 'board_subtrees' ORDER BY ordinal_position`;
    const config = getTableConfig(boardSubtrees);
    expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
      config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
    );
    const pk = await db.admin`
      SELECT a.attname FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = ${`"${db.schema}".board_subtrees`}::regclass AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)`;
    expect(pk.map((r) => r["attname"])).toEqual(config.primaryKeys[0]!.columns.map((c) => c.name));
  });

  test("the app role holds SELECT and INSERT and nothing else", async () => {
    const privs = await db.admin`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = ${db.schema} AND table_name = 'board_subtrees' AND grantee = 'abolish_app'
      ORDER BY privilege_type`;
    expect(privs.map((p) => p["privilege_type"])).toEqual(["INSERT", "SELECT"]);
  });

  test("appendEntry stores one subtree per node of the tree's perfect subtrees", async () => {
    // 2n minus one per set bit of n: 11 entries (1011) store 22 − 3 = 19.
    expect(await count(await board(11))).toBe(19);
  });
});

describe("append-only", () => {
  const changes = {
    update: (sql: Sql, e: Uint8Array) =>
      sql`UPDATE board_subtrees SET hash = hash WHERE election_id = ${e}`,
    delete: (sql: Sql, e: Uint8Array) => sql`DELETE FROM board_subtrees WHERE election_id = ${e}`,
    truncate: (sql: Sql) => sql`TRUNCATE board_subtrees`,
  };
  for (const [role, client] of [
    ["app", () => app],
    ["owner", () => owner],
  ] as const) {
    for (const [op, run] of Object.entries(changes)) {
      test(`${op} fails as the ${role}`, async () => {
        const e = await board(2);
        expect(await failsWith(run(client(), e))).toBe("42501");
        expect(await count(e)).toBe(3);
      });
    }
  }

  test("the app role can't disable the triggers or drop the table", async () => {
    expect(await failsWith(app`ALTER TABLE board_subtrees DISABLE TRIGGER USER`)).toBe("42501");
    expect(await failsWith(app`DROP TABLE board_subtrees`)).toBe("42501");
  });
});

describe("append order", () => {
  const put = (e: Uint8Array, level: number, idx: bigint | number, hash = b32()) =>
    app`INSERT INTO board_subtrees (election_id, level, idx, hash) VALUES (${e}, ${level}, ${idx.toString()}, ${hash})`;

  test("refuses a leaf whose entry isn't on the board", async () => {
    const e = await board(1);
    expect(await failsWith(put(e, 0, 1))).toBe("23514");
    expect(await failsWith(put(b32(), 0, 0))).toBe("23514");
  });

  test("refuses a parent without both children", async () => {
    const e = await board(3);
    // (0, 3) is missing, so (1, 1) can't be written; (2, 0) has no (1, 1).
    expect(await failsWith(put(e, 1, 1))).toBe("23514");
    expect(await failsWith(put(e, 2, 0))).toBe("23514");
    expect(await count(e)).toBe(4);
  });

  test("refuses a subtree written twice", async () => {
    const e = await board(2);
    expect(await failsWith(put(e, 0, 0))).toBe("23505");
    expect(await failsWith(put(e, 1, 0))).toBe("23505");
  });

  test.each([
    ["a short hash", (e: Uint8Array) => put(e, 0, 0, new Uint8Array(31))],
    ["a level above 62", (e: Uint8Array) => put(e, 63, 0)],
    ["a negative level", (e: Uint8Array) => put(e, -1, 0)],
    ["a negative index", (e: Uint8Array) => put(e, 0, -1)],
  ])("refuses %s", async (_, run) => {
    const e = b32();
    await app`INSERT INTO board_entries (election_id, idx, segment, payload, entry_hash, prev_link, link)
      VALUES (${e}, 0, 0, ${ballot(0)}, ${b32()}, ${new Uint8Array(32)}, ${b32()})`;
    expect(await failsWith(run(e))).toBe("23514");
  });

  test("a temporary table can't stand in for the board or a child", async () => {
    const e = b32();
    await app`CREATE TEMP TABLE board_entries (LIKE ${app(db.schema)}.board_entries)`;
    await app`CREATE TEMP TABLE board_subtrees (LIKE ${app(db.schema)}.board_subtrees)`;
    await app`INSERT INTO pg_temp.board_entries VALUES (${e}, 0, 0, ${ballot(0)}, ${b32()}, ${new Uint8Array(32)}, ${b32()})`;
    await app`INSERT INTO pg_temp.board_subtrees VALUES (${e}, 0, 0, ${b32()}), (${e}, 0, 1, ${b32()})`;
    expect(
      await failsWith(
        app`INSERT INTO ${app(db.schema)}.board_subtrees VALUES (${e}, 0, 0, ${b32()})`,
      ),
    ).toBe("23514");
    expect(
      await failsWith(
        app`INSERT INTO ${app(db.schema)}.board_subtrees VALUES (${e}, 1, 0, ${b32()})`,
      ),
    ).toBe("23514");
    await app`DROP TABLE pg_temp.board_entries, pg_temp.board_subtrees`;
    expect(await count(e)).toBe(0);
  });
});

describe("reads", () => {
  test("fail closed when a subtree they need is missing", async () => {
    // An entry written around appendEntry has no subtrees: reads covering it
    // refuse rather than answer from what is there.
    const e = await board(2);
    await app`INSERT INTO board_entries (election_id, idx, segment, payload, entry_hash, prev_link, link)
      SELECT election_id, 2, 0, ${ballot(9)}, ${b32()}, link, ${b32()} FROM board_entries
      WHERE election_id = ${e} AND idx = 1`;
    await expect(readHead(app, e)).rejects.toThrow(/subtree/);
    await expect(readInclusionProof(app, e, 0n, 3n)).rejects.toThrow(/subtree/);
    await expect(readConsistencyProof(app, e, 1n, 3n)).rejects.toThrow(/subtree/);
    // Trees within the entries appendEntry wrote still answer.
    expect(await readInclusionProof(app, e, 0n, 2n)).toHaveLength(1);
  });
});

describe("migration", () => {
  test("refuses to apply over a board that already has entries", async () => {
    const schema = `t_${randomBytes(8).toString("hex")}`;
    await db.admin.unsafe(`CREATE SCHEMA "${schema}" AUTHORIZATION abolish_migrator`);
    const url = process.env["TEST_DATABASE_URL"] as string;
    const sql = postgres(url, { max: 1, onnotice: () => {}, connection: { search_path: schema } });
    try {
      await sql.unsafe("SET ROLE abolish_migrator");
      const all = loadMigrations();
      const at = all.findIndex((m) => m.name === "0006_board_subtrees.sql");
      await migrate(sql, schema, all.slice(0, at));
      await sql`INSERT INTO board_entries (election_id, idx, segment, payload, entry_hash, prev_link, link)
        VALUES (${b32()}, 0, 0, ${ballot(0)}, ${b32()}, ${new Uint8Array(32)}, ${b32()})`;
      await expect(migrate(sql, schema, all)).rejects.toThrow(/wipe and rebuild/);
    } finally {
      await sql.end();
      await db.admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });
});
