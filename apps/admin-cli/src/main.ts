import postgres from "postgres";
import * as z from "zod";
import { run } from "./cli.ts";

// Entry point: connects to Postgres as a user granted abolish_app (never the
// owner; packages/core, Database), runs one command and exits with its code.

const Env = z.strictObject({
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
});
const env = Env.parse({ DATABASE_URL: process.env["DATABASE_URL"] });

const line = (stream: NodeJS.WriteStream) => (value: unknown) =>
  stream.write(`${JSON.stringify(value)}\n`);

const sql = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
try {
  process.exitCode = await run(process.argv.slice(2), sql, {
    out: line(process.stdout),
    err: line(process.stderr),
  });
} finally {
  await sql.end();
}
