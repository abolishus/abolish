// The verifier's command line (docs/spec/verifier.md, Command line): reads one
// bundle, prints the JSON report on stdout and a summary on stderr, and exits
// with a code that depends on `verdict` alone. `verdictAgainstInputs` never
// decides the exit code and is never printed without `verdict` and the
// unauthenticated inputs beside it, so a crafted bundle can't make a script
// read "failed" or "verified" (T-53, T-24).

import { parseArgs } from "node:util";
import { DEFAULT_MANIFEST_BUDGET, DEFAULT_OBJECT_READS } from "./archive.ts";
import { DEFAULT_EVIDENCE_READS } from "./evidence.ts";
import { DEFAULT_REPLAY_EVIDENCE_READS } from "./replay.ts";
import { DEFAULT_RUN_BYTES, DEFAULT_RUN_READS } from "./runs.ts";
import { arweaveSource } from "./arweave.ts";
import { BundleError } from "./bundle.ts";
import { type ArchiveSources, DEFAULT_MAX_BOARD_BYTES, json, loadBundle } from "./files.ts";
import { type Gateways, gatewaySource, MAX_GATEWAYS, parseGateway } from "./gateways.ts";
import { type KeysReport, keysSummary, parseKeysEvidence, runKeys } from "./keys.ts";
import { PINNED_RELEASE_REGISTRY, type ReleaseRegistryPin } from "./registry.ts";
import type { RollingElectorateReport } from "./rolling-report.ts";
import {
  type ArchiveReadOptions,
  authenticated,
  DEFAULT_ARCHIVE_BYTES,
  type Report,
  type Verdict,
  verifyBundle,
} from "./verify.ts";

export interface CliOutput {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** What a run takes from its surroundings: the run's clock, and the registry the release pins. */
export interface CliContext {
  /** Seconds since the epoch, read once as a run starts. */
  readonly clock: () => bigint;
  readonly registry: ReleaseRegistryPin | undefined;
}

const DEFAULT_CONTEXT: CliContext = {
  clock: () => BigInt(Math.floor(Date.now() / 1000)),
  registry: PINNED_RELEASE_REGISTRY,
};

/**
 * Exit codes. 0 means verified and nothing else: help exits as a usage error.
 * None is a code Node exits with on its own (1 for an uncaught error, 3 to 14
 * for its internal failures, over 128 for a signal), so a crash never reads
 * as a verdict; any code not listed here is the verifier's own failure and
 * says nothing about the election.
 */
export const EXIT_CODES = Object.freeze({
  verified: 0,
  failed: 20,
  unverifiable: 21,
  bundleRejected: 22,
  usage: 64,
} as const);

const USAGE = `Usage: abolish-verify [--max-board-bytes <n>] [--gateway <url>]...
                      [--arweave <url>]... [--max-archive-manifests <n>]
                      [--max-archive-bytes <n>] [--max-archive-reads <n>]
                      [--max-archive-evidence-reads <n>]
                      [--max-archive-replay-evidence-reads <n>]
                      [--max-archive-run-bytes <n>] [--max-archive-run-reads <n>]
                      [--] <bundle-directory>
       abolish-verify keys [--] <evidence-directory>

Verifies one election from a bundle (bundle.json, and board.bin, blocks.car,
or neither with --gateway or --arweave; see docs/spec/verifier.md, Inputs,
procedure and report). Prints the JSON report on stdout and a summary on
stderr.

--max-board-bytes caps what a board copy read by CID may hold, in bytes
(default ${DEFAULT_MAX_BOARD_BYTES}); a copy past it is unverifiable.

--gateway reads the board copy's blocks by CID from an IPFS trustless
gateway (http: or https:), after blocks.car if the bundle holds one; give it
up to ${MAX_GATEWAYS} times, asked in order. Every block is checked against its CID,
but each gateway sees which blocks, and so which election, you read (and,
over http:, so does the network); prefer https:.

--arweave reads the permanent archive (check 4.3) for a bundle of format 3
or later from an Arweave node or ar.io gateway (http: or https:), up to
${MAX_GATEWAYS} times, asked in order; the objects it reads also serve the board
copy, after blocks.car and before any --gateway. Each gateway sees which
manifests and segments, and so which deployment and election, you read.
Its budgets: --max-archive-manifests manifest reads (default
${DEFAULT_MANIFEST_BUDGET}, each up to about 620 KiB from each gateway asked),
--max-archive-bytes for the listed objects' answers (default
${DEFAULT_ARCHIVE_BYTES}) and --max-archive-reads transactions asked for them
(default ${DEFAULT_OBJECT_READS}). A budget run out leaves 4.3 unverifiable,
never failed: raise it for an older deployment or a longer election. For a
bundle of format 6 the run also reads the board contract's archived
evidence, which check 4.6 can take in place of the bundle's: at most
--max-archive-evidence-reads transactions (default ${DEFAULT_EVIDENCE_READS}, each up to
about 35 KiB from each gateway asked).
Check 4.4 replays each of the definition's L2 contracts' archived events
against all of its archived evidence: at most
--max-archive-replay-evidence-reads transactions for the evidence (default
${DEFAULT_REPLAY_EVIDENCE_READS}, each up to about 35 KiB), and
--max-archive-run-bytes held (default ${DEFAULT_RUN_BYTES}) and
--max-archive-run-reads transactions asked (default ${DEFAULT_RUN_READS}) for the
event runs, shared by the four contracts. A budget run out leaves 4.4
unverifiable, never failed. Check 4.6 replays the board's archived events
where the bundle's l2Board.events don't reach the count proven.

keys judges the Tier 0 token keys of every release in the release registry
from keys.json (docs/spec/verifier.md, Token keys across releases), and
contacts nothing.

Exit codes: 0 verified, 20 failed, 21 unverifiable, 22 bundle or evidence
rejected, 64 usage (and --help). Any other code is an error of the
verifier, not a verdict.
`;

/** The archive read's budget options, and the `readArchive` option each sets. */
const ARCHIVE_BUDGETS = {
  "max-archive-manifests": "maxManifests",
  "max-archive-bytes": "maxBytes",
  "max-archive-reads": "maxReads",
  "max-archive-evidence-reads": "maxEvidenceReads",
  "max-archive-replay-evidence-reads": "maxReplayEvidenceReads",
  "max-archive-run-bytes": "maxRunBytes",
  "max-archive-run-reads": "maxRunReads",
} as const satisfies Record<string, keyof ArchiveReadOptions>;
type ArchiveBudget = keyof typeof ARCHIVE_BUDGETS;

// A budget in canonical decimal only, as the bundle's integers: positive,
// no sign or leading zero, below 2^53.
function positive(text: string): number | undefined {
  const n = Number(text);
  return /^[1-9][0-9]*$/.test(text) && Number.isSafeInteger(n) ? n : undefined;
}

/** The exit code for a report's `verdict`. */
export function exitCode(verdict: Verdict): number {
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

/**
 * A rolling tier's turnout: its counted ballots among the people who could
 * answer during the poll, never a share of a fixed population, rounded down
 * so it never reads as a share it didn't reach, and no ratio over none (8.1;
 * T-13, T-16).
 */
function among(counted: number, electorate: RollingElectorateReport | undefined): string {
  if (electorate === undefined) return "";
  const { eligible } = electorate;
  const text = ` among ${eligible} who could answer during the poll`;
  if (eligible === 0) return text;
  const tenths = (BigInt(counted) * 1000n) / BigInt(eligible);
  return `${text} (${tenths / 10n}.${tenths % 10n}%)`;
}

/**
 * The summary's results: each tier on its own line, and its cells under it
 * where it has more than one. No line sums two tiers, so Tier 0's figures
 * never join a Sybil-resistant tier's (T-01), and the header says the
 * figures aren't verified unless `verdict` is, so a crafted bundle's counts
 * never read as the election's result (T-53). Under definition versions 5
 * and 6 a tier's or cell's counts follow one question per line, with the
 * method its limits give, and no line joins two questions (8.1; T-29).
 */
function resultLines(report: Report): string[] {
  if (report.tiers === undefined) return [];
  const lines = [
    report.verdict === "verified"
      ? "results per tier, never summed across tiers:"
      : `results per tier, not verified (verdict: ${report.verdict}):`,
  ];
  const { questions } = report;
  // The line's end and, under definition versions 5 to 7, a line per question.
  const results = (
    indent: string,
    result: {
      readonly counts?: readonly string[];
      readonly byQuestion?: readonly (readonly string[])[];
    },
    none: string,
  ): [string, string[]] => {
    if (result.counts === undefined) return [`; no counts (${none})`, []];
    if (questions === undefined || result.byQuestion === undefined)
      return [`; counts ${result.counts.join(", ")}`, []];
    return [
      "; counts per question:",
      result.byQuestion.map((q, i) => {
        const question = questions[i];
        if (question === undefined) throw new Error("summary: a slice without its question");
        return `${indent}question ${i} (${question.method}): counts ${q.join(", ")}`;
      }),
    ];
  };
  for (const t of report.tiers) {
    const { electorate } = t;
    const label =
      t.tier !== 0
        ? `tier ${t.tier}`
        : electorate === undefined
          ? "tier 0 (not Sybil-resistant)"
          : "tier 0 (not Sybil-resistant; open to new identities during the poll)";
    const [end, perQuestion] = results("    ", t, "an opening of its cells didn't pass 7.2");
    lines.push(
      `  ${label}: ${t.counted} counted${among(t.counted, electorate)}${end}`,
      ...perQuestion,
    );
    if (electorate !== undefined) {
      const small = [
        ...(electorate.flagged.eligible ? [`${electorate.eligible} could answer`] : []),
        ...(electorate.flagged.smallestStep && electorate.smallestStep !== null
          ? [
              `smallest step used ${electorate.smallestStep.step}, ` +
                `${electorate.smallestStep.members} members`,
            ]
          : []),
      ];
      if (small.length > 0)
        lines.push(`    small counts, which can reveal votes: ${small.join(", ")}`);
    }
    const cells = (report.cells ?? []).filter((c) => c.tier === t.tier);
    if (cells.length < 2) continue;
    for (const c of cells) {
      const [cellEnd, cellQuestions] = results("      ", c, c.code ?? "");
      lines.push(`    cell ${c.cell}: ${c.counted} counted${cellEnd}`, ...cellQuestions);
    }
  }
  return lines;
}

/** The summary written to stderr (docs/spec/verifier.md, Command line). */
export function summary(report: Report): string {
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
  lines.push(...resultLines(report));
  return lines.join("\n") + "\n";
}

/** `abolish-verify keys`: the bundle options are usage errors here. */
function runKeysCli(args: readonly string[], out: CliOutput, context: CliContext): number {
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
  if (dir === undefined || dir === "" || positionals.length !== 1) {
    out.stderr(USAGE);
    return EXIT_CODES.usage;
  }
  let report: KeysReport;
  try {
    // `t` is the clock as the run starts, before the evidence is read.
    const runAt = context.clock();
    report = runKeys(parseKeysEvidence(json(dir, "keys.json")), context.registry, runAt);
  } catch (e) {
    if (!(e instanceof BundleError)) throw e;
    out.stderr(`evidence rejected: ${printable(e.message)}\n`);
    return EXIT_CODES.bundleRejected;
  }
  out.stdout(JSON.stringify(report, null, 2) + "\n");
  out.stderr(keysSummary(report));
  return exitCode(report.verdict);
}

/**
 * Runs the command line over `args` (without the node and script paths) and
 * returns the exit code. A first argument `keys` is always the subcommand; a
 * bundle directory of that name is given after `--`.
 */
export async function runCli(
  args: readonly string[],
  out: CliOutput,
  context: CliContext = DEFAULT_CONTEXT,
): Promise<number> {
  if (args[0] === "keys") return runKeysCli(args.slice(1), out, context);
  let positionals: string[];
  let help: boolean | undefined;
  let budget: string | undefined;
  let gatewayArgs: string[] | undefined;
  let arweaveArgs: string[] | undefined;
  let archiveBudgets: Readonly<Record<ArchiveBudget, string | undefined>>;
  try {
    let values;
    ({ positionals, values } = parseArgs({
      args: [...args],
      options: {
        help: { type: "boolean", short: "h" },
        "max-board-bytes": { type: "string" },
        gateway: { type: "string", multiple: true },
        arweave: { type: "string", multiple: true },
        "max-archive-manifests": { type: "string" },
        "max-archive-bytes": { type: "string" },
        "max-archive-reads": { type: "string" },
        "max-archive-evidence-reads": { type: "string" },
        "max-archive-replay-evidence-reads": { type: "string" },
        "max-archive-run-bytes": { type: "string" },
        "max-archive-run-reads": { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    }));
    ({ help, "max-board-bytes": budget, gateway: gatewayArgs, arweave: arweaveArgs } = values);
    archiveBudgets = {
      "max-archive-manifests": values["max-archive-manifests"],
      "max-archive-bytes": values["max-archive-bytes"],
      "max-archive-reads": values["max-archive-reads"],
      "max-archive-evidence-reads": values["max-archive-evidence-reads"],
      "max-archive-replay-evidence-reads": values["max-archive-replay-evidence-reads"],
      "max-archive-run-bytes": values["max-archive-run-bytes"],
      "max-archive-run-reads": values["max-archive-run-reads"],
    };
  } catch (e) {
    out.stderr(`${printable(e instanceof Error ? e.message : String(e))}\n${USAGE}`);
    return EXIT_CODES.usage;
  }
  if (help === true) {
    out.stdout(USAGE);
    return EXIT_CODES.usage;
  }
  const [dir] = positionals;
  // An empty argument (an unset shell variable) would read the working
  // directory, a bundle the caller never named.
  if (dir === undefined || dir === "" || positionals.length !== 1) {
    out.stderr(USAGE);
    return EXIT_CODES.usage;
  }
  const usage = (option: string, problem: string) => {
    out.stderr(`--${option}: ${printable(problem)}\n${USAGE}`);
    return EXIT_CODES.usage;
  };
  const maxBytes = budget === undefined ? DEFAULT_MAX_BOARD_BYTES : positive(budget);
  if (maxBytes === undefined) return usage("max-board-bytes", "expected a positive integer");
  let gateways: Gateways | undefined;
  if (gatewayArgs !== undefined) {
    if (gatewayArgs.length > MAX_GATEWAYS) return usage("gateway", `at most ${MAX_GATEWAYS}`);
    try {
      gateways = gatewaySource(gatewayArgs.map(parseGateway));
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      return usage("gateway", e.message);
    }
  }
  const options: { -readonly [K in keyof ArchiveReadOptions]: number } = {};
  for (const [option, value] of Object.entries(archiveBudgets) as [ArchiveBudget, string][]) {
    if (value === undefined) continue;
    // A budget for an archive the run won't read would read as one it did.
    if (arweaveArgs === undefined) return usage(option, "only with --arweave");
    const n = positive(value);
    if (n === undefined) return usage(option, "expected a positive integer");
    options[ARCHIVE_BUDGETS[option]] = n;
  }
  let archive: ArchiveSources | undefined;
  if (arweaveArgs !== undefined) {
    if (arweaveArgs.length > MAX_GATEWAYS) return usage("arweave", `at most ${MAX_GATEWAYS}`);
    try {
      archive = { source: arweaveSource(arweaveArgs.map(parseGateway)).source, options };
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      return usage("arweave", e.message);
    }
  }
  let report: Report;
  try {
    report = verifyBundle(await loadBundle(dir, maxBytes, gateways, archive));
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
