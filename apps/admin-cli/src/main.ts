import postgres, { type Sql } from "postgres";
import * as z from "zod";
import { run } from "./cli.ts";

// Entry point: runs one command and exits with its code. A command on the
// database connects as a user granted abolish_app (never the owner;
// packages/core, Database); a simulation needs no database.

const Env = z.strictObject({
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
});

const line = (stream: NodeJS.WriteStream) => (value: unknown) =>
  stream.write(`${JSON.stringify(value)}\n`);

let sql: Sql | undefined;
try {
  process.exitCode = await run(
    process.argv.slice(2),
    () => {
      const env = Env.parse({ DATABASE_URL: process.env["DATABASE_URL"] });
      sql = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
      return sql;
    },
    { out: line(process.stdout), err: line(process.stderr) },
  );
} finally {
  await sql?.end();
}
