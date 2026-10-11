import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { loadMigrations, migrate } from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

let db: TestDb;
beforeAll(async () => {
  db = await testDb();
});
afterAll(() => db?.close());

describe("migrate", () => {
  test("a migrated schema has nothing pending", async () => {
    expect(await migrate(await db.as("abolish_migrator"), db.schema)).toEqual([]);
  });

  test("refuses a migration that changed after it was applied", async () => {
    const [first, ...rest] = loadMigrations();
    const changed = { ...first!, sha256: "0".repeat(64) };
    await expect(
      migrate(await db.as("abolish_migrator"), db.schema, [changed, ...rest]),
    ).rejects.toThrow(/changed after it was applied/);
  });

  test("refuses when an applied migration is missing", async () => {
    await expect(migrate(await db.as("abolish_migrator"), db.schema, [])).rejects.toThrow(
      /missing or out of order/,
    );
  });

  test("refuses a schema name that isn't a plain identifier", async () => {
    await expect(migrate(await db.as("abolish_migrator"), 'x"; DROP')).rejects.toThrow(
      /plain identifier/,
    );
  });
});

describe("roles.sql", () => {
  // Every test file runs it at once in CI; unserialized ALTER ROLEs on the same
  // role fail with "tuple concurrently updated".
  test("is safe to run concurrently", async () => {
    const roles = readFileSync(new URL("../src/db/roles.sql", import.meta.url), "utf8");
    const clients = Array.from({ length: 8 }, () =>
      postgres(process.env["TEST_DATABASE_URL"]!, { max: 1, onnotice: () => {} }),
    );
    try {
      await Promise.all(clients.map((c) => c.unsafe(roles)));
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
  });
});

describe("loadMigrations", () => {
  test("names are numbered and in order", () => {
    const names = loadMigrations().map((m) => m.name);
    expect(names[0]).toBe("0000_board.sql");
    expect([...names].sort()).toEqual(names);
  });

  test("rejects a badly named file", () => {
    const dir = mkdtempSync(join(tmpdir(), "abolish-migrations-"));
    writeFileSync(join(dir, "board.sql"), "SELECT 1;");
    expect(() => loadMigrations(pathToFileURL(`${dir}/`))).toThrow(/name must match/);
  });
});
