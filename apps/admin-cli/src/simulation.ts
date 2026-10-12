// Simulation commands (docs/PROJECT_BRIEF.md: "run a 10,000-voter national
// referendum simulation with 7 trustees, two offline, mixed identity tiers,
// our servers down halfway through"). The scenario is JSON, parsed and run by
// @abolishus/sdk; this file only reads it and prints the result.

import { readFileSync } from "node:fs";
import { parseScenario, planElection, runSimulation, type Scenario } from "@abolishus/sdk";
import type { OfflineCommand } from "./cli.ts";
import { CliError, UsageError } from "./errors.ts";

type Values = Parameters<OfflineCommand["run"]>[1];

function scenarioOf(values: Values): Scenario {
  const inline = values["scenario"];
  const file = values["file"];
  if ((inline === undefined) === (file === undefined))
    throw new UsageError("give exactly one of --scenario <json> or --file <path>");
  let text = String(inline);
  // parseArgs gives a string option's value as a string.
  if (typeof file === "string")
    try {
      text = readFileSync(file, "utf8");
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

export const simulationCommands: Readonly<Record<string, OfflineCommand>> = {
  plan: {
    usage: "(--scenario <json> | --file <path>)",
    options: scenarioOptions,
    positionals: 0,
    offline: true,
    async run(_, values, io) {
      const scenario = scenarioOf(values);
      const plan = planElection(scenario);
      io.out({
        scenario,
        ballots: {
          cast: plan.voters.length,
          direct: plan.voters.filter((v) => v.path === "direct").length,
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
      const report = runSimulation(
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
