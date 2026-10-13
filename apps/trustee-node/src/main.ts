import { cli } from "./cli.ts";

const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => stop.abort());
process.exitCode = await cli(process.argv.slice(2), {
  out: (v) => process.stdout.write(`${JSON.stringify(v)}\n`),
  err: (v) => process.stderr.write(`${JSON.stringify(v)}\n`),
  signal: stop.signal,
});
