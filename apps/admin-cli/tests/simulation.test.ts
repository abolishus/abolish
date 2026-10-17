import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { CliError, run } from "../src/index.ts";
import type { runSimulation } from "@abolishus/sdk";
import { simulationCommandsWith } from "../src/simulation.ts";

const scenario = {
  voters: 6,
  election: "plurality",
  options: 2,
  trustees: { panel: 3, threshold: 2, offline: [3] },
  tiers: { "0": 1, "2": 1 },
  outage: { from: 0.5, to: 1 },
  challenges: 0.5,
  postings: 0.5,
  seed: 11,
};

// Most runs skip proving, a few seconds per ballot; the --bundle run proves
// every ballot with the client's prover.
const PLACEHOLDER = "--placeholder-proofs";

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
    const r = await cli(
      "simulation",
      "run",
      "--scenario",
      JSON.stringify(scenario),
      "--progress",
      PLACEHOLDER,
    );
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

  test("run with --workers prints the same plan-matching report as in this thread", async () => {
    const json = JSON.stringify(scenario);
    const shape = (out: Record<string, unknown>) => {
      const r = out as { ok: boolean; ballots: unknown; cells: unknown };
      return { ok: r.ok, ballots: r.ballots, cells: r.cells };
    };
    const inWorkers = await cli(
      "simulation",
      "run",
      "--scenario",
      json,
      "--workers",
      "2",
      PLACEHOLDER,
    );
    expect(inWorkers.code).toBe(0);
    const inThread = await cli(
      "simulation",
      "run",
      "--scenario",
      json,
      "--workers",
      "0",
      PLACEHOLDER,
    );
    expect(inThread.code).toBe(0);
    expect(shape(inWorkers.out[0] ?? {})).toMatchObject({ ok: true });
    expect(shape(inWorkers.out[0] ?? {})).toEqual(shape(inThread.out[0] ?? {}));
  });

  test("refuses --workers other than an integer from 0 to the maximum as a usage error", async () => {
    for (const workers of ["-1", "1.5", "two", "", "65", "1e1"]) {
      const r = await cli(
        "simulation",
        "run",
        "--scenario",
        JSON.stringify(scenario),
        `--workers=${workers}`,
      );
      expect(r.code).toBe(2);
      expect(r.err[0]).toMatchObject({
        error: "usage",
        detail: expect.stringContaining("--workers"),
      });
    }
  });

  test(
    "run with --bundle proves every ballot, writes the verifier bundle it reports on, and never overwrites one",
    { timeout: 600_000 },
    async () => {
      const dir = join(mkdtempSync(join(tmpdir(), "sim-")), "bundle");
      const json = JSON.stringify(scenario);
      const r = await cli("simulation", "run", "--scenario", json, "--bundle", dir);
      expect(r.code).toBe(0);
      const report = r.out[0] as {
        board: { entries: number; anchors: unknown[] };
        membershipProofs: string;
        verifier: { block: { number: number }; admittedBallots: number; rejectedBallots: number };
        ballots: { cast: number };
      };
      expect(readdirSync(dir).sort()).toEqual(["board.bin", "bundle.json"]);
      const bundle = JSON.parse(readFileSync(join(dir, "bundle.json"), "utf8")) as {
        format: string;
        l1: { header: string };
        panel: { threshold: string; keys: string[] };
      };
      expect(bundle.format).toBe("abolish-verifier-bundle/4");
      expect(bundle.panel).toMatchObject({ threshold: "2" });
      expect(bundle.panel.keys).toHaveLength(3);
      // Each version-1 entry is 51 bytes and its payload, so the board holds every entry.
      expect(readFileSync(join(dir, "board.bin")).length).toBeGreaterThan(
        51 * report.board.entries,
      );
      // Proved by the client's prover, every ballot is admitted.
      expect(report.membershipProofs).toBe("real");
      expect(report.verifier.admittedBallots).toBe(report.ballots.cast);
      expect(report.verifier.rejectedBallots).toBe(0);
      // A second run into the same directory is refused before it starts.
      const again = await cli("simulation", "run", "--scenario", json, "--bundle", dir);
      expect(again.code).toBe(2);
      expect(again.err[0]).toMatchObject({
        error: "usage",
        detail: expect.stringContaining("already holds a bundle"),
      });
      expect(again.out).toEqual([]);
      // So is a path that can't be a directory.
      const file = join(dir, "board.bin", "x");
      const blocked = await cli("simulation", "run", "--scenario", json, "--bundle", file);
      expect(blocked.code).toBe(2);
      expect(blocked.err[0]).toMatchObject({
        detail: expect.stringContaining("isn't a writable directory"),
      });
    },
  );

  test("plan reads a scenario file and prints the expected counts, ballots, challenges, re-votes, publications and postings, matching run's", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "sim-")), "scenario.json");
    // Seat 4 goes down halfway, so later ballots need one more posting.
    const trustees = { panel: 4, threshold: 2, offline: [3], departures: [{ seat: 4, at: 0.5 }] };
    writeFileSync(
      file,
      JSON.stringify({ ...scenario, trustees, revotes: 0.5, publications: 1, reorgs: 0.5 }),
    );
    const plan = await cli("simulation", "plan", "--file", file);
    expect(plan.code).toBe(0);
    type Ballots = {
      cast: number;
      direct: number;
      superseded: number;
      reorged: number;
      recast: number;
      challenged: number;
      published: number;
      postings: number;
      undelivered: number;
    };
    const out = plan.out[0] as {
      ballots: Ballots;
      expected: { tier: number; counts: number[] }[];
    };
    const ran = await cli("simulation", "run", "--file", file, PLACEHOLDER);
    const report = ran.out[0] as {
      ballots: Ballots & { server: number };
      cells: { tier: number; counts: number[] }[];
    };
    expect(out.expected).toEqual(report.cells.map((c) => ({ tier: c.tier, counts: c.counts })));
    expect(out.ballots.challenged).toBeGreaterThan(0);
    expect(out.ballots.superseded).toBeGreaterThan(0);
    expect(out.ballots.recast).toBeGreaterThan(0);
    // Every challenger publishes at share 1.
    expect(out.ballots.published).toBe(out.ballots.challenged);
    // Some voters post the down seats and the rest leave their ballots undelivered.
    expect(out.ballots.postings).toBeGreaterThan(0);
    expect(out.ballots.undelivered).toBeGreaterThan(0);
    const { server: _, ...ballots } = report.ballots;
    expect(ballots).toEqual(out.ballots);
  });

  test("plan agrees with run when a reorganisation near close loses a re-voter's last ballot", async () => {
    // The first seed whose plan has a voter whose block is finalized after close.
    const at = { ...scenario, revotes: 1, reorgs: 1, challenges: 0 };
    let seed = 0;
    for (; ; seed++) {
      const out = (await cli("simulation", "plan", "--scenario", JSON.stringify({ ...at, seed })))
        .out[0] as { ballots: { reorged: number; recast: number } };
      if (out.ballots.recast < out.ballots.reorged) break;
    }
    const json = JSON.stringify({ ...at, seed });
    const plan = (await cli("simulation", "plan", "--scenario", json)).out[0] as {
      ballots: Record<string, number>;
      expected: { tier: number; counts: number[] }[];
    };
    const ran = await cli("simulation", "run", "--scenario", json, PLACEHOLDER);
    expect(ran.code).toBe(0);
    const report = ran.out[0] as {
      ballots: Record<string, number>;
      cells: { tier: number; counts: number[] }[];
    };
    expect(plan.expected).toEqual(report.cells.map((c) => ({ tier: c.tier, counts: c.counts })));
    const { server: _, ...ballots } = report.ballots;
    expect(ballots).toEqual(plan.ballots);
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

  test("run hands the sdk the client's prover, unless --placeholder-proofs", async () => {
    const given: (keyof NonNullable<Parameters<typeof runSimulation>[1]>)[][] = [];
    const commands = simulationCommandsWith(async (_, options) => {
      given.push(Object.keys(options ?? {}) as (typeof given)[number]);
      return { ok: true } as Awaited<ReturnType<typeof runSimulation>>;
    });
    const io = { out: () => {}, err: () => {} };
    await commands["run"]?.run([], { scenario: JSON.stringify(scenario) }, io);
    await commands["run"]?.run(
      [],
      { scenario: JSON.stringify(scenario), "placeholder-proofs": true },
      io,
    );
    expect(given.map((keys) => keys.includes("prover"))).toEqual([true, false]);
  });

  test("run prints a report that differs from its plan, then refuses with simulation-mismatch", async () => {
    const out: unknown[] = [];
    const differing = simulationCommandsWith(
      async () =>
        ({ ok: false }) as Awaited<ReturnType<Parameters<typeof simulationCommandsWith>[0]>>,
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
