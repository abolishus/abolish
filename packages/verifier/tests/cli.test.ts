import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { exitCode, printable, summary } from "../src/cli.ts";
import {
  type CellReport,
  EXIT_CODES,
  readBundle,
  type QuestionReport,
  type Report,
  runCli,
  type TierReport,
  verifyBundle,
} from "../src/index.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

// Fixtures: boards of docs/spec/vectors/board.json, from the independent
// Python implementation (never from the code under test).
interface BoardFile {
  readonly clock: Readonly<Record<string, string>>;
  readonly boards: readonly {
    readonly id: string;
    readonly electionId: string;
    readonly now: string;
    readonly entries: readonly string[];
    readonly checkpoints: readonly Readonly<Record<string, string>>[];
    readonly result: "ok" | { readonly code: string };
  }[];
}
const vectors = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/board.json", import.meta.url), "utf8"),
) as BoardFile;

const BIN = new URL("../src/bin.ts", import.meta.url).pathname;

const root = mkdtempSync(join(tmpdir(), "abolish-verify-cli-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dirs = 0;

function bundleDir(json: string, board: Uint8Array): string {
  const dir = join(root, String(dirs++));
  mkdirSync(dir);
  writeFileSync(join(dir, "bundle.json"), json);
  writeFileSync(join(dir, "board.bin"), board);
  return dir;
}

function vectorDir(id: string): string {
  const v = vectors.boards.find((b) => b.id === id);
  if (v === undefined) throw new Error(`no board vector ${id}`);
  const json = JSON.stringify({
    format: "abolish-verifier-bundle/1",
    electionId: v.electionId,
    boardEntryVersion: 1,
    clock: vectors.clock,
    now: v.now,
    anchors: v.checkpoints.map((c) => ({
      electionId: c["electionId"],
      segment: c["segment"],
      size: c["size"],
      head: c["head"],
      root: c["root"],
      objectCid: c["objectCid"],
      hashesCid: c["hashesCid"],
      anchoredAt: c["anchoredAt"],
    })),
  });
  return bundleDir(json, Buffer.concat(v.entries.map((e) => Buffer.from(e, "hex"))));
}

async function run(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
  });
  return { code, stdout, stderr };
}

const okId = vectors.boards.find((b) => b.result === "ok")?.id as string;
const failedId = vectors.boards.find(
  (b) => b.result !== "ok" && b.result.code === "checkpoint-equivocation",
)?.id as string;

// Codes Node exits with on its own: an uncaught error, its internal
// failures, and signals (128 + n).
const NODE_CODES = [1, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14];

describe("exit codes", () => {
  test("are distinct, 0 is verified only, and none is a code Node exits with on its own", () => {
    const codes = Object.values(EXIT_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) {
      expect(NODE_CODES).not.toContain(c);
      expect(c).toBeLessThan(128);
    }
    expect(Object.entries(EXIT_CODES).filter(([, c]) => c === 0)).toEqual([["verified", 0]]);
  });

  test("each verdict exits with its own code", () => {
    expect(exitCode("verified")).toBe(EXIT_CODES.verified);
    expect(exitCode("failed")).toBe(EXIT_CODES.failed);
    expect(exitCode("unverifiable")).toBe(EXIT_CODES.unverifiable);
  });
});

describe("a bundle that parses", () => {
  test("prints the library's report on stdout and exits on verdict, not verdictAgainstInputs", async () => {
    for (const id of [okId, failedId]) {
      const dir = vectorDir(id);
      const r = await run(dir);
      const report = JSON.parse(r.stdout) as Report;
      expect(report).toEqual(JSON.parse(JSON.stringify(verifyBundle(readBundle(dir)))));
      // Local inputs authenticate nothing, so the verdict is unverifiable
      // even where the checks failed the bundle's inputs (T-53).
      expect(report.verdict).toBe("unverifiable");
      expect(r.code).toBe(EXIT_CODES.unverifiable);
    }
  });

  test("never shows verdictAgainstInputs without the verdict and the unauthenticated inputs", async () => {
    const r = await run(vectorDir(failedId));
    expect(r.stderr.split("\n")[0]).toBe(
      "verdict: unverifiable (unauthenticated inputs: electionId, boardEntryVersion, clock, now, anchors; against those inputs: failed)",
    );
    expect(r.stderr).toMatch(/^ {2}4\.2 fail checkpoint-equivocation \{"checkpoint":\d+\}$/m);
  });

  test("reads a directory named like an option only after --", () => {
    const dir = vectorDir(okId);
    mkdirSync(join(root, "-h"));
    writeFileSync(join(root, "-h", "bundle.json"), readFileSync(join(dir, "bundle.json")));
    writeFileSync(join(root, "-h", "board.bin"), readFileSync(join(dir, "board.bin")));
    // From the bundle's parent, so the argument really starts with "-".
    const spawn = (...args: string[]) =>
      spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: "utf8" });
    expect(spawn("--", "-h").status).toBe(EXIT_CODES.unverifiable);
    expect(spawn("-h")).toMatchObject({ status: EXIT_CODES.usage, stderr: "" });
  });
});

describe("a rejected bundle", () => {
  test("prints no report and exits bundleRejected", async () => {
    const missing = await run(join(root, "does-not-exist"));
    expect(missing).toEqual({
      code: EXIT_CODES.bundleRejected,
      stdout: "",
      stderr: "bundle rejected: bundle.json: can't be read\n",
    });
    const malformed = await run(bundleDir("{}", new Uint8Array()));
    expect(malformed.code).toBe(EXIT_CODES.bundleRejected);
    expect(malformed.stdout).toBe("");
  });

  test("rejects a format-2 bundle whose header isn't one, as a bundle and not a crash", async () => {
    const l1 = JSON.stringify({
      format: "abolish-verifier-bundle/2",
      electionId: "ab".repeat(32),
      boardEntryVersion: 1,
      clock: { epoch: "0", period: "1", deadline: "0", lastSegment: "0" },
      l1: { anchor: "00".repeat(20), firstSegment: "0", header: "c0", nodes: [], checkpoints: [] },
    });
    const r = await run(bundleDir(l1, new Uint8Array()));
    expect(r.code).toBe(EXIT_CODES.bundleRejected);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^bundle rejected: l1\.header: /);
  });

  test("rejects a board.bin that isn't a regular file instead of reading it forever", async () => {
    const ok = vectorDir(okId);
    const json = readFileSync(join(ok, "bundle.json"));
    const zero = join(root, String(dirs++));
    mkdirSync(zero);
    writeFileSync(join(zero, "bundle.json"), json);
    symlinkSync("/dev/zero", join(zero, "board.bin"));
    const fifo = join(root, String(dirs++));
    mkdirSync(fifo);
    writeFileSync(join(fifo, "bundle.json"), json);
    execFileSync("mkfifo", [join(fifo, "board.bin")]);
    for (const dir of [zero, fifo])
      expect(await run(dir)).toEqual({
        code: EXIT_CODES.bundleRejected,
        stdout: "",
        stderr: "bundle rejected: board.bin: not a regular file\n",
      });
    // A link to a regular file is read like the file.
    const linked = join(root, String(dirs++));
    mkdirSync(linked);
    symlinkSync(join(ok, "bundle.json"), join(linked, "bundle.json"));
    symlinkSync(join(ok, "board.bin"), join(linked, "board.bin"));
    expect((await run(linked)).stdout).toBe((await run(ok)).stdout);
  });

  test("can't put terminal control characters on stderr through a member name", async () => {
    const hostile = "a\u001b[2J\u009b31m\u202eb\\u{1b}\r\n\u0000";
    const r = await run(
      bundleDir(
        JSON.stringify({ format: "abolish-verifier-bundle/1", [hostile]: 1 }),
        new Uint8Array(),
      ),
    );
    expect(r.code).toBe(EXIT_CODES.bundleRejected);
    expect(r.stderr).toBe(
      "bundle rejected: bundle.json: unknown member a\\u{1b}[2J\\u{9b}31m\\u{202e}b\\u{5c}u{1b}\\u{d}\\u{a}\\u{0}\n",
    );
  });
});

describe("the summary's results", () => {
  // No vector's bundle reaches a counted tally (counted.test.ts builds those
  // in process), so the tiers and cells are set on a real report here.
  const base = verifyBundle(readBundle(vectorDir(okId)));
  const results = (report: Report) => {
    const lines = summary(report).split("\n");
    const at = lines.findIndex((l) => l.startsWith("results per tier"));
    return at === -1 ? [] : lines.slice(at, -1);
  };
  const cells: CellReport[] = [
    { cell: 0, tier: 0, counted: 2, counts: ["1", "1", "0"], signers: [1] },
    { cell: 1, tier: 1, counted: 3, counts: ["2", "1", "0"], signers: [1, 2] },
    { cell: 2, tier: 1, counted: 1, counts: ["0", "0", "1"], signers: [2] },
    { cell: 3, tier: 2, counted: 4, code: "tally-missing", signers: [] },
  ];
  const tiers: TierReport[] = [
    { tier: 0, counted: 2, counts: ["1", "1", "0"] },
    { tier: 1, counted: 4, counts: ["2", "1", "1"] },
    { tier: 2, counted: 4 },
  ];

  test("are absent until the report has tiers", () => {
    expect(base.tiers).toBeUndefined();
    expect(results(base)).toEqual([]);
  });

  test("give each tier its own line, never a sum across tiers, and Tier 0 its label", () => {
    expect(results({ ...base, verdict: "verified", cells, tiers })).toEqual([
      "results per tier, never summed across tiers:",
      "  tier 0 (not Sybil-resistant): 2 counted; counts 1, 1, 0",
      "  tier 1: 4 counted; counts 2, 1, 1",
      "    cell 1: 3 counted; counts 2, 1, 0",
      "    cell 2: 1 counted; counts 0, 0, 1",
      "  tier 2: 4 counted; no counts (an opening of its cells didn't pass 7.2)",
    ]);
  });

  test("say they aren't verified unless the verdict is (T-53)", () => {
    for (const verdict of ["failed", "unverifiable"] as const)
      expect(results({ ...base, verdict, cells, tiers })[0]).toBe(
        `results per tier, not verified (verdict: ${verdict}):`,
      );
  });

  test("show a cell without counts by its code", () => {
    const split: CellReport[] = [
      { cell: 0, tier: 2, counted: 1, counts: ["1", "0"], signers: [1] },
      { cell: 1, tier: 2, counted: 2, code: "tally-opening", option: 1, signers: [] },
    ];
    expect(
      results({ ...base, verdict: "verified", cells: split, tiers: [{ tier: 2, counted: 3 }] }),
    ).toEqual([
      "results per tier, never summed across tiers:",
      "  tier 2: 3 counted; no counts (an opening of its cells didn't pass 7.2)",
      "    cell 0: 1 counted; counts 1, 0",
      "    cell 1: 2 counted; no counts (tally-opening)",
    ]);
  });

  test("give each question its own line with its method, under definition versions 5 and 6", () => {
    const questions: QuestionReport[] = [
      { question: 0, options: 2, minSelections: 0, maxSelections: 1, method: "pick one" },
      { question: 1, options: 3, minSelections: 2, maxSelections: 2, method: "pick exactly 2" },
    ];
    const qCells: CellReport[] = [
      {
        cell: 0,
        tier: 1,
        counted: 3,
        counts: ["2", "1", "3", "2", "1"],
        byQuestion: [
          ["2", "1"],
          ["3", "2", "1"],
        ],
        signers: [1],
      },
      { cell: 1, tier: 1, counted: 1, code: "tally-question-range", question: 1, signers: [] },
      {
        cell: 2,
        tier: 0,
        counted: 1,
        counts: ["1", "0", "1", "1", "0"],
        byQuestion: [
          ["1", "0"],
          ["1", "1", "0"],
        ],
        signers: [2],
      },
    ];
    const qTiers: TierReport[] = [
      {
        tier: 0,
        counted: 1,
        counts: ["1", "0", "1", "1", "0"],
        byQuestion: [
          ["1", "0"],
          ["1", "1", "0"],
        ],
      },
      { tier: 1, counted: 4 },
    ];
    expect(
      results({ ...base, verdict: "verified", cells: qCells, tiers: qTiers, questions }),
    ).toEqual([
      "results per tier, never summed across tiers:",
      "  tier 0 (not Sybil-resistant): 1 counted; counts per question:",
      "    question 0 (pick one): counts 1, 0",
      "    question 1 (pick exactly 2): counts 1, 1, 0",
      "  tier 1: 4 counted; no counts (an opening of its cells didn't pass 7.2)",
      "    cell 0: 3 counted; counts per question:",
      "      question 0 (pick one): counts 2, 1",
      "      question 1 (pick exactly 2): counts 3, 2, 1",
      "    cell 1: 1 counted; no counts (tally-question-range)",
    ]);
  });

  test("print every tier's own figures once, in order, and nothing else at tier level", () => {
    const counts = fc.array(fc.nat({ max: 10_000 }), { minLength: 1, maxLength: 4 });
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.nat({ max: 5 }), { minLength: 1, maxLength: 3 }),
        fc.array(counts, { minLength: 3, maxLength: 3 }),
        (ids, figures) => {
          const ts: TierReport[] = ids.map((tier, i) => ({
            tier,
            counted: (figures[i] as number[]).reduce((a, b) => a + b, 0),
            counts: (figures[i] as number[]).map(String),
          }));
          const lines = results({ ...base, verdict: "verified", cells: [], tiers: ts });
          expect(lines.slice(1)).toEqual(
            ts.map(
              (t) =>
                `  ${t.tier === 0 ? "tier 0 (not Sybil-resistant)" : `tier ${t.tier}`}: ` +
                `${t.counted} counted; counts ${(t.counts as string[]).join(", ")}`,
            ),
          );
        },
      ),
      { numRuns },
    );
  });
});

describe("printable", () => {
  test("emits printable ASCII only, and is the identity on it except for the backslash", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (s) => {
        expect(printable(s)).toMatch(/^[\x20-\x7e]*$/);
      }),
      { numRuns },
    );
    fc.assert(
      fc.property(fc.stringMatching(/^[\x20-\x5b\x5d-\x7e]*$/), (s) => {
        expect(printable(s)).toBe(s);
      }),
      { numRuns },
    );
  });

  test("is injective, so two different messages never print the same", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), fc.string({ unit: "binary" }), (a, b) => {
        if (a !== b) expect(printable(a)).not.toBe(printable(b));
      }),
      { numRuns },
    );
  });
});

describe("usage", () => {
  test("help, no bundle, two bundles and unknown options exit usage with no report", async () => {
    for (const args of [["--help"], ["-h"], [], [""], ["--", ""], ["a", "b"], ["--json", "a"]]) {
      const r = await run(...args);
      expect(r.code).toBe(EXIT_CODES.usage);
      expect(r.stdout).not.toMatch(/"format"/);
      expect(r.stdout + r.stderr).toMatch(/^Usage: abolish-verify/m);
    }
  });
});

describe("the entry point", () => {
  test("runs as a process and sets the exit code", () => {
    const p = spawnSync(process.execPath, [BIN, vectorDir(failedId)], { encoding: "utf8" });
    expect(p.stderr).toMatch(/^verdict: unverifiable /);
    expect(p.status).toBe(EXIT_CODES.unverifiable);
    expect((JSON.parse(p.stdout) as Report).verdictAgainstInputs).toBe("failed");
  });
});
