import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { TABLE_CLASSES } from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// Accounts and ballots never join (.claude/skills/migrations; T-10): every
// table is classified, no foreign key touches a board table, and no board
// table has a column that could name an account or a person.

const ACCOUNT_LIKE = /account|user|voter|person|email|phone|session|passkey|device|ip_?addr|name/;

let db: TestDb;
beforeAll(async () => {
  db = await testDb();
});
afterAll(() => db?.close());

test("every table is classified as board or operational", async () => {
  const tables = await db.admin`
    SELECT table_name FROM information_schema.tables WHERE table_schema = ${db.schema} ORDER BY table_name`;
  const classified = [...TABLE_CLASSES.board, ...TABLE_CLASSES.operational].sort();
  expect(tables.map((t) => t["table_name"])).toEqual(classified);
});

test("no foreign key starts or ends at a board table", async () => {
  const fks = await db.admin`
    SELECT conrelid::regclass::text AS src, confrelid::regclass::text AS dst FROM pg_constraint
    WHERE contype = 'f' AND connamespace = ${db.schema}::regnamespace`;
  const board = new Set<string>(TABLE_CLASSES.board);
  const bare = (t: string) => t.split(".").pop()!.replaceAll('"', "");
  expect(fks.filter((f) => board.has(bare(f["src"])) || board.has(bare(f["dst"])))).toEqual([]);
});

test("no board column looks like an account or a person", async () => {
  const cols = await db.admin`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = ${db.schema} AND table_name = ANY(${[...TABLE_CLASSES.board]})`;
  expect(cols.length).toBeGreaterThan(0);
  expect(cols.filter((c) => ACCOUNT_LIKE.test(c["column_name"]))).toEqual([]);
});
