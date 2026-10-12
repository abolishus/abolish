// Stage 9, as far as it goes: packages/verifier runs in a process of its own
// over the bundle directory the fixture wrote, so it sees nothing of the run
// but those files (T-36). It is loaded from its built package, the code a
// third party installs, and the fixture reads only its report.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The verifier's built entry point; the root `reference-election` script builds it first. */
const VERIFIER = new URL("../../../packages/verifier/dist/index.mjs", import.meta.url);

export interface ReportRow {
  readonly id: string;
  readonly status: "pass" | "fail" | "unverifiable";
  readonly code?: string;
}

export interface VerifierRun {
  readonly exitCode: number | null;
  readonly report: {
    readonly verdict: string;
    readonly verdictAgainstInputs?: string;
    readonly checks: readonly ReportRow[];
  };
  readonly stdout: string;
}

export function runVerifier(bundleDir: string): VerifierRun {
  const script = [
    `import { runCli } from ${JSON.stringify(VERIFIER.href)};`,
    "process.exitCode = runCli(process.argv.slice(1), {",
    "  stdout: (t) => process.stdout.write(t),",
    "  stderr: (t) => process.stderr.write(t),",
    "});",
  ].join("\n");
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script, bundleDir], {
    encoding: "utf8",
    // The verifier contacts nothing; an empty environment keeps it from
    // reading anything of the fixture's but its argument.
    env: {},
    cwd: fileURLToPath(new URL(".", VERIFIER)),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error !== undefined) throw run.error;
  if (run.stdout === "")
    throw new Error(`the verifier gave no report (exit ${run.status}): ${run.stderr}`);
  return {
    exitCode: run.status,
    report: JSON.parse(run.stdout) as VerifierRun["report"],
    stdout: run.stdout,
  };
}
