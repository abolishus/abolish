import { migrate } from "@abolishus/core";
import postgres from "postgres";
import * as z from "zod";

// Applies pending migrations, then exits. The deployment runs it as its own
// one-shot service before the API, with a user granted abolish_migrator that
// the API never holds (packages/core, Database; T-23, T-65).

const Env = z.strictObject({
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  DATABASE_SCHEMA: z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/)
    .default("abolish"),
});

const env = Env.parse({
  DATABASE_URL: process.env["DATABASE_URL"],
  DATABASE_SCHEMA: process.env["DATABASE_SCHEMA"],
});

// The role is a startup parameter, so every connection, a reconnect included,
// acts as abolish_migrator: objects then belong to the group role rather than
// the login, and a rotated login can still migrate.
const sql = postgres(env.DATABASE_URL, {
  max: 1,
  onnotice: () => {},
  connection: { role: "abolish_migrator" },
});
try {
  const applied = await migrate(sql, env.DATABASE_SCHEMA);
  process.stdout.write(`${JSON.stringify({ migrations: applied })}\n`);
} finally {
  await sql.end();
}
