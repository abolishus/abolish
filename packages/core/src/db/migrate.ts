import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import type { Sql } from "postgres";

// Forward-only migrations (.claude/skills/migrations). Each file under
// migrations/ runs once, in name order, in one transaction with the rest of
// the run. A ledger records each file's sha256, and a run refuses to continue
// if a recorded file changed or disappeared: merged migrations are immutable,
// so a database never silently diverges from the files that built it.

export interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly sha256: string;
}

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);
const NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

export function loadMigrations(dir: URL = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => {
      if (!NAME.test(name)) throw new Error(`migration ${name}: name must match ${NAME}`);
      const sql = readFileSync(new URL(name, dir), "utf8");
      return { name, sql, sha256: createHash("sha256").update(sql).digest("hex") };
    });
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Applies every pending migration to `schema`, which must already exist and be
 * owned by the connecting role (abolish_migrator). Returns the names applied.
 */
export async function migrate(
  sql: Sql,
  schema: string,
  migrations: readonly Migration[] = loadMigrations(),
): Promise<string[]> {
  if (!IDENT.test(schema))
    throw new Error(`schema ${JSON.stringify(schema)} is not a plain identifier`);
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${schema}))`;
    await tx.unsafe(`SET LOCAL search_path TO "${schema}"`);
    await tx.unsafe(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await tx<{ name: string; sha256: string }[]>`
      SELECT name, sha256 FROM schema_migrations ORDER BY name`;
    applied.forEach((row, i) => {
      const m = migrations[i];
      if (m?.name !== row.name)
        throw new Error(`migration ${row.name} was applied but is missing or out of order`);
      if (m.sha256 !== row.sha256)
        throw new Error(`migration ${row.name} changed after it was applied`);
    });
    const pending = migrations.slice(applied.length);
    for (const m of pending) {
      await tx.unsafe(m.sql);
      await tx`INSERT INTO schema_migrations (name, sha256) VALUES (${m.name}, ${m.sha256})`;
    }
    return pending.map((m) => m.name);
  });
}
