import { Redis } from "ioredis";
import postgres from "postgres";
import * as z from "zod";
import { startWorker } from "./worker.ts";

// Entry point: reads the environment, connects to Redis (or Dragonfly) and to
// Postgres as a user granted abolish_app (never the owner; packages/core,
// Database), and runs every queue.

const Env = z.strictObject({
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  AUDIT_EVERY_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(10 * 60_000),
});

const env = Env.parse({
  DATABASE_URL: process.env["DATABASE_URL"],
  REDIS_URL: process.env["REDIS_URL"],
  AUDIT_EVERY_MS: process.env["AUDIT_EVERY_MS"],
});

const sql = postgres(env.DATABASE_URL, { onnotice: () => {} });
// BullMQ's workers block on Redis, so commands must wait out a reconnect
// rather than fail after a retry count.
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const worker = await startWorker({
  connection,
  sql,
  log: (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
  auditEveryMs: env.AUDIT_EVERY_MS,
});

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    worker
      .close()
      .then(() => Promise.all([sql.end(), connection.quit()]))
      .catch(() => process.exit(1));
  });
