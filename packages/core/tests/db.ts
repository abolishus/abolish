import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres, { type Sql } from "postgres";
import { migrate } from "../src/index.ts";

// Each test file gets its own schema (AGENTS.md, Testing: Database), migrated
// as abolish_migrator, and clients that act as each role through SET ROLE.
// The connecting user must be able to create roles: the CI service user is a
// superuser.

const url = process.env["TEST_DATABASE_URL"];
if (!url) throw new Error("TEST_DATABASE_URL is not set");

export interface TestDb {
  readonly schema: string;
  readonly admin: Sql;
  as(role: "abolish_migrator" | "abolish_app"): Promise<Sql>;
  close(): Promise<void>;
}

export async function testDb(): Promise<TestDb> {
  const schema = `t_${randomBytes(8).toString("hex")}`;
  const admin = postgres(url!, { max: 1, onnotice: () => {}, connection: { search_path: schema } });
  await admin.unsafe(readFileSync(new URL("../src/db/roles.sql", import.meta.url), "utf8"));
  await admin.unsafe(`CREATE SCHEMA "${schema}" AUTHORIZATION abolish_migrator`);
  const clients: Sql[] = [];
  const as = async (role: string) => {
    const c = postgres(url!, {
      max: 1,
      onnotice: () => {},
      connection: { search_path: schema },
    });
    await c.unsafe(`SET ROLE ${role}`);
    clients.push(c);
    return c;
  };
  await migrate(await as("abolish_migrator"), schema);
  return {
    schema,
    admin,
    as,
    async close() {
      await Promise.all(clients.map((c) => c.end()));
      await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    },
  };
}
