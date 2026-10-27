// Stage 9, as far as it goes: packages/verifier runs in a process of its own
// over the bundle directory the fixture wrote, so it sees nothing of the run
// but those files (T-36). It is loaded from its built package, the code a
// third party installs, and the fixture reads only its report, and the drop
// judgements it gives for the receipts it is handed (docs/spec/receipts.md,
// Drops).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bytesToHex } from "@noble/hashes/utils.js";

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
    /** Ballot admission's outcome, once 5.1 to 5.4 ran (docs/spec/verifier.md, Report). */
    readonly ballots?: {
      readonly admitted: number;
      readonly rejected: readonly { readonly entry: number; readonly code: string }[];
      /** Format 5, once selection (6.1) passed: each selected ballot in copy order. */
      readonly selected?: readonly { readonly entry: number }[];
    };
    /** Format 5, once 7.1 to 7.3 ran: each cell's counted ballots and, if it passes 7.2, its counts. */
    readonly cells?: readonly {
      readonly cell: number;
      readonly counted: number;
      readonly counts?: readonly string[];
    }[];
    /** Format 5, once 8.5 ran: each registered seat's destruction. */
    readonly destruction?: {
      readonly seats: readonly { readonly seat: number; readonly code?: string }[];
    };
    /** Where the run read the archive: 4.4's replay of each L2 contract's events (docs/spec/verifier.md, Archive). */
    readonly archive?: {
      readonly replay?: {
        readonly contracts: readonly {
          readonly role: string;
          readonly held: string;
          readonly evidence: {
            readonly records: readonly { readonly replay: unknown }[];
            readonly findings: readonly unknown[];
          };
          readonly runs: { readonly complete: boolean; readonly findings: readonly unknown[] };
        }[];
        readonly findings: readonly unknown[];
      };
    };
    /** How a copy read by CID came out (docs/spec/verifier.md, Board by CID). */
    readonly board?: {
      readonly byCid?: {
        readonly storeBlocks?: number;
        readonly storeUnreadableBytes?: number;
        readonly gateways?: { readonly requests: number; readonly blocks: number };
        readonly stopped?: unknown;
      };
    };
  };
  readonly stdout: string;
}

/** Runs the verifier over `bundleDir`, with `options` (such as `--gateway <url>`) before it. */
export function runVerifier(bundleDir: string, options: readonly string[] = []): VerifierRun {
  const script = [
    `import { runCli } from ${JSON.stringify(VERIFIER.href)};`,
    "process.exitCode = await runCli(process.argv.slice(1), {",
    "  stdout: (t) => process.stdout.write(t),",
    "  stderr: (t) => process.stderr.write(t),",
    "});",
  ].join("\n");
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, "--", ...options, "--", bundleDir],
    {
      encoding: "utf8",
      // The verifier contacts nothing but the gateways it is given; an empty
      // environment keeps it from reading anything of the fixture's but its
      // arguments.
      env: {},
      cwd: fileURLToPath(new URL(".", VERIFIER)),
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (run.error !== undefined) throw run.error;
  if (run.stdout === "")
    throw new Error(`the verifier gave no report (exit ${run.status}): ${run.stderr}`);
  return {
    exitCode: run.status,
    report: JSON.parse(run.stdout) as VerifierRun["report"],
    stdout: run.stdout,
  };
}

/** A drop judgement (docs/spec/receipts.md, Drops), as the verifier's `judgeDrop` reports it. */
export interface DropOutcome {
  readonly status: "drop" | "not-drop" | "unjudged";
  readonly code?: string;
  readonly entry?: number;
}

export interface DropReport {
  readonly drop: DropOutcome;
  readonly dropAgainstInputs: DropOutcome;
}

/** A receipt, the payload it covers and its voter's verdict, for `judgeDrops`. */
export interface DropCase {
  readonly receipt: Uint8Array;
  readonly payload: Uint8Array;
  /** `judgeReceipt`'s verdict for them. */
  readonly verdict: unknown;
}

// The verdicts cross to the verifier's process as JSON, their byte strings
// and integers tagged so they come back as they went (a Checkpoint holds
// both).
const replacer = (_: string, v: unknown): unknown =>
  v instanceof Uint8Array
    ? { $bytes: bytesToHex(v) }
    : typeof v === "bigint"
      ? { $bigint: v.toString() }
      : v;

/** `JSON.stringify` of `value` with its byte strings and integers tagged, which `taggedReviver` reads back. */
export function tagged(value: unknown): string {
  return JSON.stringify(value, replacer);
}

/**
 * The reviver `tagged`'s output is parsed with, here and, by its source, in
 * the verifier's process: it uses nothing outside itself.
 */
export function taggedReviver(_: string, v: unknown): unknown {
  if (v === null || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== 1)
    return v;
  if ("$bytes" in v && typeof v.$bytes === "string")
    return Uint8Array.from(v.$bytes.match(/../g) ?? [], (h) => parseInt(h, 16));
  if ("$bigint" in v && typeof v.$bigint === "string") return BigInt(v.$bigint);
  return v;
}

/**
 * The verifier's `judgeDrop` on each case, over the bundle in `bundleDir`
 * read as a run reads it (`loadBundle`: its copy by CID from blocks.car), in
 * a process of its own as `runVerifier` runs, so all it sees of the run is
 * that directory and the cases (T-36).
 */
export function judgeDrops(bundleDir: string, cases: readonly DropCase[]): DropReport[] {
  const script = [
    `import { judgeDrop, loadBundle } from ${JSON.stringify(VERIFIER.href)};`,
    `const revive = ${taggedReviver.toString()};`,
    "const chunks = [];",
    "for await (const c of process.stdin) chunks.push(c);",
    "const cases = JSON.parse(Buffer.concat(chunks).toString('utf8'), revive);",
    "const bundle = await loadBundle(process.argv[1]);",
    "process.stdout.write(JSON.stringify(cases.map((c) => judgeDrop(bundle, c.receipt, c.payload, c.verdict))));",
  ].join("\n");
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script, "--", bundleDir], {
    encoding: "utf8",
    input: tagged(cases),
    env: {},
    cwd: fileURLToPath(new URL(".", VERIFIER)),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error !== undefined) throw run.error;
  if (run.status !== 0) throw new Error(`the drop judge exited ${run.status}: ${run.stderr}`);
  return JSON.parse(run.stdout) as DropReport[];
}
