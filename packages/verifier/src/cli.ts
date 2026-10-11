// The verifier's command line (docs/spec/verifier.md, Command line): reads one
// bundle, prints the JSON report on stdout and a summary on stderr, and exits
// with a code that depends on `verdict` alone. `verdictAgainstInputs` never
// decides the exit code and is never printed without `verdict` and the
// unauthenticated inputs beside it, so a crafted bundle can't make a script
// read "failed" or "verified" (T-53, T-24).

import { parseArgs } from "node:util";
import { BundleError } from "./bundle.ts";
import { readBundle } from "./files.ts";
import { authenticated, type Report, type Verdict, verifyBundle } from "./verify.ts";

export interface CliOutput {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/**
 * Exit codes. 0 means verified and nothing else: help and usage errors exit
 * 2. None is 1, which Node uses for an uncaught error, so a crash never reads
 * as a verdict; any code not listed here is the verifier's own failure and
 * says nothing about the election.
 */
export const EXIT_CODES = Object.freeze({
  verified: 0,
  usage: 2,
  failed: 3,
  unverifiable: 4,
  bundleRejected: 5,
} as const);

const USAGE = `Usage: abolish-verify [--] <bundle-directory>

Verifies one election from a bundle (board.bin and bundle.json; see
docs/spec/verifier.md, Inputs, procedure and report). Prints the JSON report
on stdout and a summary on stderr.

Exit codes: 0 verified, 3 failed, 4 unverifiable, 5 bundle rejected,
2 usage. Any other code is an error of the verifier, not a verdict.
`;

function exitCode(verdict: Verdict): number {
  switch (verdict) {
    case "verified":
      return EXIT_CODES.verified;
    case "failed":
      return EXIT_CODES.failed;
    case "unverifiable":
      return EXIT_CODES.unverifiable;
    default: {
      const unhandled: never = verdict;
      throw new Error(`unknown verdict ${String(unhandled)}`);
    }
  }
}

/**
 * Escapes everything outside printable ASCII, and the backslash, so an
 * escape in the output is always one this made. A bundle error can quote a
 * member name from bundle.json, which is attacker-chosen: control, C1 and
 * bidirectional characters could rewrite what a terminal shows.
 */
export function printable(text: string): string {
  return text.replace(
    /[^\x20-\x5b\x5d-\x7e]/gu,
    (c) => `\\u{${(c.codePointAt(0) as number).toString(16)}}`,
  );
}

function summary(report: Report): string {
  const unauthenticated = Object.entries(report.inputs)
    .filter(([, source]) => !authenticated(source))
    .map(([name]) => name);
  // verdictAgainstInputs only ever appears after verdict and the inputs it
  // rests on (docs/spec/verifier.md, Verdicts).
  const lines = [
    unauthenticated.length === 0
      ? `verdict: ${report.verdict}`
      : `verdict: ${report.verdict} (unauthenticated inputs: ${unauthenticated.join(", ")}; ` +
        `against those inputs: ${report.verdictAgainstInputs})`,
  ];
  for (const c of report.checks)
    if (c.status === "fail")
      lines.push(
        `  ${c.id} fail ${c.code ?? ""}${c.at === undefined ? "" : ` ${JSON.stringify(c.at)}`}`,
      );
  return lines.join("\n") + "\n";
}

/** Runs the command line over `args` (without the node and script paths) and returns the exit code. */
export function runCli(args: readonly string[], out: CliOutput): number {
  let positionals: string[];
  let help: boolean | undefined;
  try {
    ({
      positionals,
      values: { help },
    } = parseArgs({
      args: [...args],
      options: { help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    }));
  } catch (e) {
    out.stderr(`${printable(e instanceof Error ? e.message : String(e))}\n${USAGE}`);
    return EXIT_CODES.usage;
  }
  if (help === true) {
    out.stdout(USAGE);
    return EXIT_CODES.usage;
  }
  const [dir] = positionals;
  if (dir === undefined || positionals.length !== 1) {
    out.stderr(USAGE);
    return EXIT_CODES.usage;
  }
  let report: Report;
  try {
    report = verifyBundle(readBundle(dir));
  } catch (e) {
    if (!(e instanceof BundleError)) throw e;
    // A rejected bundle has no report: it isn't evidence about any election.
    out.stderr(`bundle rejected: ${printable(e.message)}\n`);
    return EXIT_CODES.bundleRejected;
  }
  out.stdout(JSON.stringify(report, null, 2) + "\n");
  out.stderr(summary(report));
  return exitCode(report.verdict);
}
