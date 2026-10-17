// Simulation commands (docs/PROJECT_BRIEF.md: "run a 10,000-voter national
// referendum simulation with 7 trustees, two offline, mixed identity tiers,
// our servers down halfway through"). The scenario is JSON, parsed and run by
// @abolishus/sdk; this file only reads it, hands the run the ballot client's
// own membership prover, and prints the result.

import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { proveMembership } from "@abolishus/membership-prover";
import {
  deliveredAt,
  downAt,
  MAX_INTAKE_WORKERS,
  type MembershipProver,
  parseScenario,
  planElection,
  runSimulation,
  type Scenario,
} from "@abolishus/sdk";
import type { OfflineCommand } from "./cli.ts";
import { CliError, UsageError } from "./errors.ts";

type Values = Parameters<OfflineCommand["run"]>[1];

function scenarioOf(values: Values): Scenario {
  const inline = values["scenario"];
  const file = values["file"];
  if ((inline === undefined) === (file === undefined))
    throw new UsageError("give exactly one of --scenario <json> or --file <path>");
  let text: string;
  try {
    // parseArgs gives a string option's value as a string.
    text = typeof file === "string" ? readFileSync(file, "utf8") : String(inline);
  } catch {
    throw new UsageError("--file can't be read");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UsageError("the scenario isn't JSON");
  }
  const parsed = parseScenario(json);
  if (!parsed.ok) throw new UsageError(`scenario ${parsed.path}: ${parsed.error}`);
  return parsed.scenario;
}

// Worker threads for the seats' intake (0, the default, runs it in this thread).
function workersOf(values: Values): number {
  const given = values["workers"];
  if (given === undefined) return 0;
  const text = String(given);
  const workers = Number(text);
  if (!/^[0-9]+$/.test(text) || workers > MAX_INTAKE_WORKERS)
    throw new UsageError(`--workers must be an integer from 0 to ${MAX_INTAKE_WORKERS}`);
  return workers;
}

// The directory for the run's verifier bundle (docs/spec/verifier.md,
// Bundle): bundle.json and board.bin, which packages/verifier reads.
// Neither may exist yet, so a run never overwrites another's evidence.
const BUNDLE_FILES = ["bundle.json", "board.bin"] as const;

function bundleDirOf(values: Values): string | undefined {
  const dir = values["bundle"];
  if (dir === undefined) return undefined;
  const path = String(dir);
  if (path === "") throw new UsageError("--bundle needs a directory");
  if (BUNDLE_FILES.some((f) => existsSync(join(path, f))))
    throw new UsageError(`--bundle: ${path} already holds a bundle`);
  // Made before the run, so a path that can't hold the bundle is refused
  // now rather than after hours of simulation.
  try {
    mkdirSync(path, { recursive: true });
    accessSync(path, constants.W_OK);
  } catch {
    throw new UsageError(`--bundle: ${path} isn't a writable directory`);
  }
  return path;
}

// The vendored proving key and witness calculator, which the prover checks
// by sha256 before every proof (T-07, T-12); read once, on the first proof.
const ARTIFACTS = new URL(
  "../../../packages/membership-prover/artifacts/snark-artifacts/",
  import.meta.url,
);

function clientProver(): MembershipProver {
  let artifacts: { readonly zkey: Uint8Array; readonly wasm: Uint8Array } | undefined;
  return (witness) => {
    artifacts ??= {
      zkey: readFileSync(new URL("semaphore-32.zkey", ARTIFACTS)),
      wasm: readFileSync(new URL("semaphore-32.wasm", ARTIFACTS)),
    };
    return proveMembership(witness, artifacts);
  };
}

const scenarioOptions = { scenario: { type: "string" }, file: { type: "string" } } as const;

/** The commands over a given runner: the sdk's, or a test's stand-in for a report that differs from its plan. */
export function simulationCommandsWith(
  run: typeof runSimulation,
): Readonly<Record<string, OfflineCommand>> {
  return {
    plan: {
      usage: "(--scenario <json> | --file <path>)",
      options: scenarioOptions,
      positionals: 0,
      offline: true,
      async run(_, values, io) {
        const scenario = scenarioOf(values);
        const plan = planElection(scenario);
        // Every ballot cast: a re-voter's earlier one, each voter's last, and
        // its recast after a reorganisation, which posts nothing again.
        const recasts = plan.voters.flatMap((v) =>
          v.reorg?.recast == null ? [] : [v.reorg.recast],
        );
        const ballots = plan.voters.flatMap((v) => (v.earlier === null ? [v] : [v.earlier, v]));
        const casts = [...ballots, ...recasts];
        const selected = plan.voters.filter((v) => v.selected !== null);
        io.out({
          scenario,
          ballots: {
            cast: casts.length,
            direct: casts.filter((b) => b.path === "direct").length,
            superseded: plan.voters.filter((v) => v.earlier !== null && v.selected !== "earlier")
              .length,
            reorged: plan.voters.filter((v) => v.reorg !== null).length,
            recast: recasts.length,
            challenged: plan.voters.filter((v) => v.challenged).length,
            published: plan.voters.filter((v) => v.published).length,
            // Each ballot its voter posts carries one posting per seat down at its cast.
            postings: ballots
              .filter((b) => b.posts)
              .reduce((a, b) => a + downAt(scenario, b.at).length, 0),
            // A selected ballot with a seat down at its cast that its voter didn't post.
            undelivered: selected.filter((v) =>
              v.selected === "earlier" && v.earlier !== null
                ? !deliveredAt(scenario, v.earlier)
                : !v.delivered,
            ).length,
          },
          expected: plan.tiers.map((tier) => ({ tier, counts: plan.expected.get(tier) })),
        });
      },
    },
    run: {
      usage:
        "(--scenario <json> | --file <path>) [--progress] [--workers <n>] [--bundle <dir>] [--placeholder-proofs]",
      options: {
        ...scenarioOptions,
        progress: { type: "boolean" },
        "placeholder-proofs": { type: "boolean" },
        workers: { type: "string" },
        bundle: { type: "string" },
      },
      positionals: 0,
      offline: true,
      async run(_, values, io) {
        const scenario = scenarioOf(values);
        const workers = workersOf(values);
        const bundleDir = bundleDirOf(values);
        // At most about a hundred progress lines, whatever the electorate.
        let shown = -1;
        const report = await run(scenario, {
          workers,
          // Each ballot proved as the client proves it, a few seconds each;
          // --placeholder-proofs skips proving for a quick run whose ballots
          // the verifier's admission rejects (SIMULATION_STUBS).
          ...(values["placeholder-proofs"] === true ? {} : { prover: clientProver() }),
          // Written before the verifier judges it, so a disagreement can be inspected.
          ...(bundleDir !== undefined
            ? {
                onBundle: (b) => {
                  writeFileSync(join(bundleDir, "bundle.json"), b.json, { flag: "wx" });
                  writeFileSync(join(bundleDir, "board.bin"), b.board, { flag: "wx" });
                },
              }
            : {}),
          ...(values["progress"] === true
            ? {
                onProgress: (p) => {
                  const percent = Math.floor((100 * p.done) / p.total);
                  if (p.stage === "cast" && percent === shown) return;
                  shown = p.stage === "cast" ? percent : -1;
                  io.out({ progress: p });
                },
              }
            : {}),
        });
        io.out(report);
        // The report says which cell differed from the plan.
        if (!report.ok) throw new CliError("simulation-mismatch");
      },
    },
  };
}

export const simulationCommands = simulationCommandsWith(runSimulation);
