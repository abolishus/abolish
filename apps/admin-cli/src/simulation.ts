// Simulation commands (docs/PROJECT_BRIEF.md: "run a 10,000-voter national
// referendum simulation with 7 trustees, two offline, mixed identity tiers,
// our servers down halfway through"). The scenario is JSON, parsed and run by
// @abolishus/sdk; this file only reads it and prints the result.

import { readFileSync } from "node:fs";
import {
  deliveredAt,
  downAt,
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
      usage: "(--scenario <json> | --file <path>) [--progress]",
      options: { ...scenarioOptions, progress: { type: "boolean" } },
      positionals: 0,
      offline: true,
      async run(_, values, io) {
        const scenario = scenarioOf(values);
        // At most about a hundred progress lines, whatever the electorate.
        let shown = -1;
        const report = run(
          scenario,
          values["progress"] === true
            ? {
                onProgress: (p) => {
                  const percent = Math.floor((100 * p.done) / p.total);
                  if (p.stage === "cast" && percent === shown) return;
                  shown = p.stage === "cast" ? percent : -1;
                  io.out({ progress: p });
                },
              }
            : {},
        );
        io.out(report);
        // The report says which cell differed from the plan.
        if (!report.ok) throw new CliError("simulation-mismatch");
      },
    },
  };
}

export const simulationCommands = simulationCommandsWith(runSimulation);
