import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
