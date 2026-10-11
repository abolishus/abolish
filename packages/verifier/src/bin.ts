// The `abolish-verify` entry point. An unexpected error exits 1, which is no
// verdict (EXIT_CODES).

import process from "node:process";
import { runCli } from "./cli.ts";

process.exitCode = runCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
