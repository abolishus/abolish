import { fillDisplayTextSearch, fillElectionSchedules, migrate } from "@abolishus/core";
import postgres from "postgres";
import * as z from "zod";

// Applies pending migrations, then exits. The deploy workflow runs it from the
// image before deploying the API, with a user granted abolish_migrator that
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
// the login, and a rotated login can still migrate. So is the search path,
// which the fills' unqualified table names resolve through.
const sql = postgres(env.DATABASE_URL, {
  max: 1,
  onnotice: () => {},
  connection: { role: "abolish_migrator", search_path: env.DATABASE_SCHEMA },
});
try {
  const applied = await migrate(sql, env.DATABASE_SCHEMA);
  // Data a migration's SQL can't derive: the times of definitions stored
  // before 0023 added their table, and the search text of display texts
  // stored before 0028 added theirs, decoded by @abolishus/crypto.
  // Idempotent, so every run checks and a run that finds none writes nothing.
  const schedules = await fillElectionSchedules(sql);
  const search = await fillDisplayTextSearch(sql);
  process.stdout.write(`${JSON.stringify({ migrations: applied, schedules, search })}\n`);
} finally {
  await sql.end();
}
