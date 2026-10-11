import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { printable } from "../src/cli.ts";
import { EXIT_CODES, readBundle, type Report, runCli, verifyBundle } from "../src/index.ts";

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
      anchoredAt: c["anchoredAt"],
    })),
  });
  return bundleDir(json, Buffer.concat(v.entries.map((e) => Buffer.from(e, "hex"))));
}

function run(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const code = runCli(args, {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
  });
  return { code, stdout, stderr };
}

const okId = vectors.boards.find((b) => b.result === "ok")?.id as string;
const failedId = vectors.boards.find(
  (b) => b.result !== "ok" && b.result.code === "checkpoint-equivocation",
)?.id as string;

describe("exit codes", () => {
  test("are distinct, 0 is verified only, and none is Node's uncaught-error code 1", () => {
    const codes = Object.values(EXIT_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).not.toContain(1);
    expect(Object.entries(EXIT_CODES).filter(([, c]) => c === 0)).toEqual([["verified", 0]]);
  });
});

describe("a bundle that parses", () => {
  test("prints the library's report on stdout and exits on verdict, not verdictAgainstInputs", () => {
    for (const id of [okId, failedId]) {
      const dir = vectorDir(id);
      const r = run(dir);
      const report = JSON.parse(r.stdout) as Report;
      expect(report).toEqual(JSON.parse(JSON.stringify(verifyBundle(readBundle(dir)))));
      // Local inputs authenticate nothing, so the verdict is unverifiable
      // even where the checks failed the bundle's inputs (T-53).
      expect(report.verdict).toBe("unverifiable");
      expect(r.code).toBe(EXIT_CODES.unverifiable);
    }
  });

  test("never shows verdictAgainstInputs without the verdict and the unauthenticated inputs", () => {
    const r = run(vectorDir(failedId));
    expect(r.stderr.split("\n")[0]).toBe(
      "verdict: unverifiable (unauthenticated inputs: electionId, boardEntryVersion, clock, now, anchors; against those inputs: failed)",
    );
    expect(r.stderr).toMatch(/^ {2}4\.2 fail checkpoint-equivocation \{"checkpoint":\d+\}$/m);
  });

  test("accepts a bundle directory named like an option after --", () => {
    const dir = vectorDir(okId);
    const dashed = join(root, "-h");
    mkdirSync(dashed);
    writeFileSync(join(dashed, "bundle.json"), readFileSync(join(dir, "bundle.json")));
    writeFileSync(join(dashed, "board.bin"), readFileSync(join(dir, "board.bin")));
    expect(run("--", dashed).code).toBe(EXIT_CODES.unverifiable);
  });
});

describe("a rejected bundle", () => {
  test("prints no report and exits bundleRejected", () => {
    const missing = run(join(root, "does-not-exist"));
    expect(missing).toEqual({
      code: EXIT_CODES.bundleRejected,
      stdout: "",
      stderr: "bundle rejected: bundle.json: can't be read\n",
    });
    const malformed = run(bundleDir("{}", new Uint8Array()));
    expect(malformed.code).toBe(EXIT_CODES.bundleRejected);
    expect(malformed.stdout).toBe("");
  });

  test("can't put terminal control characters on stderr through a member name", () => {
    const hostile = "a\u001b[2J\u009b31m\u202eb\\u{1b}\r\n\u0000";
    const r = run(bundleDir(JSON.stringify({ [hostile]: 1 }), new Uint8Array()));
    expect(r.code).toBe(EXIT_CODES.bundleRejected);
    expect(r.stderr).toBe(
      "bundle rejected: bundle.json: unknown member a\\u{1b}[2J\\u{9b}31m\\u{202e}b\\u{5c}u{1b}\\u{d}\\u{a}\\u{0}\n",
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
  test("help, no bundle, two bundles and unknown options exit usage with no report", () => {
    for (const args of [["--help"], ["-h"], [], ["a", "b"], ["--json", "a"]]) {
      const r = run(...args);
      expect(r.code).toBe(EXIT_CODES.usage);
      expect(r.stdout).not.toMatch(/"format"/);
      expect(r.stdout + r.stderr).toMatch(/^Usage: abolish-verify/m);
    }
  });
});

describe("the entry point", () => {
  test("runs as a process and sets the exit code", () => {
    const bin = new URL("../src/bin.ts", import.meta.url).pathname;
    const p = spawnSync(process.execPath, [bin, vectorDir(failedId)], { encoding: "utf8" });
    expect(p.stderr).toMatch(/^verdict: unverifiable /);
    expect(p.status).toBe(EXIT_CODES.unverifiable);
    expect((JSON.parse(p.stdout) as Report).verdictAgainstInputs).toBe("failed");
  });
});
