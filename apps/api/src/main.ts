import postgres from "postgres";
import * as z from "zod";
import { createApiServer } from "./server.ts";

// Entry point: reads the environment, connects as a user granted abolish_app
// (never the owner; packages/core, Database) and listens.

const Env = z.strictObject({
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  // Loopback unless told otherwise: the deployment's proxy terminates TLS.
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
});

const env = Env.parse({
  DATABASE_URL: process.env["DATABASE_URL"],
  API_HOST: process.env["API_HOST"],
  API_PORT: process.env["API_PORT"],
});

const sql = postgres(env.DATABASE_URL, { onnotice: () => {} });
const server = createApiServer({
  sql,
  log: (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
});
server.listen(env.API_PORT, env.API_HOST);

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    server.close(() => void sql.end());
  });
