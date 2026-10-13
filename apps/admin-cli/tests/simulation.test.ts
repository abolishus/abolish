import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { CliError, run } from "../src/index.ts";
import { simulationCommandsWith } from "../src/simulation.ts";

const scenario = {
  voters: 6,
  election: "plurality",
  options: 2,
  trustees: { panel: 3, threshold: 2, offline: [3] },
  tiers: { "0": 1, "2": 1 },
  outage: { from: 0.5, to: 1 },
  challenges: 0.5,
  seed: 11,
};

// A simulation never opens the database: this connection throws if it does.
const noDatabase = () => {
  throw new Error("a simulation opened the database");
};

async function cli(...argv: string[]) {
  const out: Record<string, unknown>[] = [];
  const err: Record<string, unknown>[] = [];
  const code = await run(argv, noDatabase, {
    out: (v) => out.push(JSON.parse(JSON.stringify(v))),
    err: (v) => err.push(JSON.parse(JSON.stringify(v))),
  });
  return { code, out, err };
}

describe("simulation", { timeout: 60_000 }, () => {
  test("run prints progress, then a report whose cells open to the plan, without a database", async () => {
    const r = await cli("simulation", "run", "--scenario", JSON.stringify(scenario), "--progress");
    expect(r.code).toBe(0);
    expect(r.err).toEqual([]);
    const report = r.out.at(-1) as { ok: boolean; cells: { tier: number; outcome: string }[] };
    expect(report.ok).toBe(true);
    expect(report.cells.map((c) => [c.tier, c.outcome])).toEqual([
      [0, "opened"],
      [2, "opened"],
    ]);
    const progress = r.out.slice(0, -1).map((l) => (l["progress"] as { stage: string }).stage);
    expect(progress.filter((s) => s === "cast")).toHaveLength(6);
    expect(progress.filter((s) => s === "tally")).toHaveLength(2);
  });

  test("plan reads a scenario file and prints the expected counts and challenges, matching run's", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "sim-")), "scenario.json");
    writeFileSync(file, JSON.stringify(scenario));
    const plan = await cli("simulation", "plan", "--file", file);
    expect(plan.code).toBe(0);
    const out = plan.out[0] as {
      ballots: { challenged: number };
      expected: { tier: number; counts: number[] }[];
    };
    const ran = await cli("simulation", "run", "--file", file);
    const report = ran.out[0] as {
      ballots: { challenged: number };
      cells: { tier: number; counts: number[] }[];
    };
    expect(out.expected).toEqual(report.cells.map((c) => ({ tier: c.tier, counts: c.counts })));
    expect(out.ballots.challenged).toBeGreaterThan(0);
    expect(report.ballots.challenged).toBe(out.ballots.challenged);
  });

  test("refuses a malformed scenario as a usage error naming the field", async () => {
    const r = await cli(
      "simulation",
      "run",
      "--scenario",
      JSON.stringify({ ...scenario, voters: 0 }),
    );
    expect(r.code).toBe(2);
    expect(r.err[0]).toMatchObject({ error: "usage", detail: expect.stringContaining("$.voters") });
    expect((await cli("simulation", "plan", "--scenario", "{")).code).toBe(2);
    expect((await cli("simulation", "plan")).code).toBe(2);
    expect(
      (await cli("simulation", "plan", "--scenario", "{}", "--file", "/nonexistent")).code,
    ).toBe(2);
    expect((await cli("simulation", "plan", "--file", "/nonexistent")).code).toBe(2);
    // An inherited property is no command.
    const inherited = await cli("simulation", "constructor");
    expect(inherited.code).toBe(2);
    expect(inherited.err[0]).toMatchObject({ detail: "unknown command" });
  });

  test("run prints a report that differs from its plan, then refuses with simulation-mismatch", async () => {
    const out: unknown[] = [];
    const differing = simulationCommandsWith(
      () => ({ ok: false }) as ReturnType<Parameters<typeof simulationCommandsWith>[0]>,
    );
    const command = differing["run"];
    await expect(
      command?.run(
        [],
        { scenario: JSON.stringify(scenario) },
        {
          out: (v) => out.push(v),
          err: () => {},
        },
      ),
    ).rejects.toThrow(new CliError("simulation-mismatch"));
    expect(out).toEqual([{ ok: false }]);
  });
});
