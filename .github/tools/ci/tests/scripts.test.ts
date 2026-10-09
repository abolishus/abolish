// The Python scripts that decide required checks: review-verdict.py
// (claude-review, crypto-review) and hash-outputs.py (repro-build). They run
// as subprocesses exactly as the workflows run them, under `python3 -I`.

import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

const scripts = fileURLToPath(new URL("../../../scripts/", import.meta.url));
const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 50) };

describe("review-verdict.py", () => {
  const out = mkdtempSync(join(tmpdir(), "verdict-"));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  const verdict = (json: string, outcome = "success") => {
    const r = spawnSync("python3", ["-I", join(scripts, "review-verdict.py")], {
      env: {
        PATH: process.env["PATH"],
        REVIEW_NAME: "claude-review",
        REVIEW_JSON: json,
        REVIEW_OUTCOME: outcome,
        OUT_FILE: join(out, "body.md"),
      },
      encoding: "utf8",
    });
    return { status: r.status, body: readFileSync(join(out, "body.md"), "utf8") };
  };
  const review = (verdict: string, findings: unknown) =>
    JSON.stringify({ verdict, summary: "s", findings });
  const nit = { severity: "non-blocking", title: "nit", file: "a", line: 1, detail: "d" };

  test("a clean pass with non-blocking findings passes", () => {
    const r = verdict(review("pass", [nit]));
    expect(r.status).toBe(0);
    expect(r.body).toContain("<!-- abolish:claude-review -->");
    expect(r.body).toContain("Non-blocking (1)");
  });

  test.each([
    ["malformed JSON", "{", "success"],
    ["empty output", "", "success"],
    ["a run that did not succeed", review("pass", []), "failure"],
    ["a cancelled run", review("pass", []), "cancelled"],
    ["no verdict", JSON.stringify({ summary: "s", findings: [] }), "success"],
    ["an unknown verdict", review("approve", []), "success"],
    ["verdict fail with no findings", review("fail", []), "success"],
    ["pass with a blocking finding", review("pass", [{ ...nit, severity: "blocking" }]), "success"],
    [
      "pass with an unknown severity",
      review("pass", [{ ...nit, severity: "critical" }]),
      "success",
    ],
    ["pass with a missing severity", review("pass", [{ title: "x" }]), "success"],
    ["pass with a non-object finding", review("pass", ["looks fine"]), "success"],
    ["a findings value that isn't a list", review("pass", { a: nit }), "success"],
  ])("fails closed on %s", (_, json, outcome) => {
    expect(verdict(json, outcome).status).toBe(1);
  });

  test("passes exactly when the verdict is pass and every finding is a non-blocking object", () => {
    const finding = fc.oneof(
      fc.record({
        severity: fc.constantFrom("blocking", "non-blocking", "Non-blocking", "critical", ""),
        title: fc.string(),
      }),
      fc.jsonValue(),
    );
    fc.assert(
      fc.property(fc.constantFrom("pass", "fail"), fc.array(finding, { maxLength: 4 }), (v, fs) => {
        const nonBlocking = (f: unknown) =>
          typeof f === "object" &&
          f !== null &&
          !Array.isArray(f) &&
          (f as { severity?: unknown }).severity === "non-blocking";
        const expected = v === "pass" && fs.every(nonBlocking) ? 0 : 1;
        expect(verdict(review(v, fs)).status).toBe(expected);
      }),
      runs,
    );
  }, 600_000);
});

describe("hash-outputs.py", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "hash-outputs-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const repo = (name: string, buildOutputs: unknown = ["dist"]) => {
    const dir = join(root, name);
    mkdirSync(join(dir, "packages/a"), { recursive: true });
    writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    writeFileSync(
      join(dir, "packages/a/package.json"),
      JSON.stringify({
        name: "a",
        scripts: { build: "x" },
        abolish: buildOutputs === "omit" ? {} : { buildOutputs },
      }),
    );
    writeFileSync(join(dir, "packages/a/src.ts"), "export {};\n");
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    return dir;
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd,
      stdio: "pipe",
    });
  const build = (dir: string) => {
    mkdirSync(join(dir, "packages/a/dist"), { recursive: true });
    writeFileSync(join(dir, "packages/a/dist/index.js"), "built\n");
  };
  const hash = (cwd: string) => {
    const r = spawnSync("python3", ["-I", join(scripts, "hash-outputs.py")], {
      cwd,
      encoding: "utf8",
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const paths = (stdout: string) =>
    stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("  ")[1]);

  test("hashes every created file, sorted and repo-relative; identical across checkout paths", () => {
    const a = repo("same-a");
    const b = repo("same-b");
    for (const dir of [a, b]) {
      build(dir);
      mkdirSync(join(dir, "stray"));
      writeFileSync(join(dir, "stray/z.txt"), "z");
      mkdirSync(join(dir, "node_modules/x"), { recursive: true });
      writeFileSync(join(dir, "node_modules/x/i.js"), "ignored");
    }
    const ra = hash(a);
    expect(ra.status).toBe(0);
    expect(paths(ra.stdout)).toEqual(["packages/a/dist/index.js", "stray/z.txt"]);
    expect(hash(b).stdout).toBe(ra.stdout);
  });

  test("a build that modifies a tracked file fails", () => {
    const dir = repo("modified");
    build(dir);
    writeFileSync(join(dir, "packages/a/src.ts"), "export const x = 1;\n");
    const r = hash(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("build modified tracked file packages/a/src.ts");
  });

  test("a renamed tracked file fails, and its source path isn't read as an entry", () => {
    const dir = repo("renamed");
    build(dir);
    git(dir, "mv", "packages/a/src.ts", "packages/a/moved.ts");
    const r = hash(dir);
    expect(r.status).toBe(1);
    expect(r.stderr.trim().split("\n")).toEqual([
      "::error::build modified tracked file packages/a/moved.ts (status R); commit the regenerated output",
    ]);
  });

  test.each([
    ["a missing buildOutputs list", "omit", "no abolish.buildOutputs list"],
    ["a non-string output", [1], "no abolish.buildOutputs list"],
    ["an escaping output", ["../escape"], "must be a relative path inside the package"],
    ["an absolute output", ["/tmp"], "must be a relative path inside the package"],
    [
      "an output under node_modules",
      ["node_modules/.out"],
      "must be a relative path inside the package",
    ],
    ["an empty output directory", ["empty"], "missing or empty after the build"],
    ["an absent output directory", ["absent"], "missing or empty after the build"],
  ])("fails on %s", (name, outputs, message) => {
    const dir = repo(`outputs-${name.replaceAll(" ", "-")}`, outputs);
    build(dir);
    mkdirSync(join(dir, "packages/a/empty"));
    mkdirSync(join(dir, "packages/a/node_modules/.out"), { recursive: true });
    writeFileSync(join(dir, "packages/a/node_modules/.out/x.js"), "x");
    const r = hash(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
  });

  test("an output that is a symlink out of the package fails", () => {
    const outside = mkdtempSync(join(root, "outside-"));
    writeFileSync(join(outside, "x.js"), "x");
    const dir = repo("symlinked", ["out"]);
    symlinkSync(outside, join(dir, "packages/a/out"));
    const r = hash(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("resolves outside the package");
  });

  test("reads exactly the <dir>/* workspace roots, and rejects any other packages entry", () => {
    const dir = mkdtempSync(join(root, "roots-"));
    git(dir, "init", "-q", "-b", "main");
    const segment = fc
      .stringMatching(/^[a-z][a-z0-9._-]{0,7}$/)
      .filter((s) => s !== "node_modules");
    const valid = fc.array(segment, { minLength: 1, maxLength: 2 }).map((s) => s.join("/"));
    const invalid = fc.constantFrom("apps/**", "../up/*", "apps", "'apps/*'", "apps/*/x", "a b/*");
    fc.assert(
      fc.property(
        fc.uniqueArray(valid, { minLength: 1, maxLength: 3 }),
        fc.option(invalid, { nil: undefined }),
        (roots, bad) => {
          for (const e of readdirSync(dir)) {
            if (e !== ".git") rmSync(join(dir, e), { recursive: true, force: true });
          }
          const entries = [...roots.map((r) => `${r}/*`), ...(bad === undefined ? [] : [bad])];
          const yaml = `packages:\n${entries.map((e) => `  - ${e}\n`).join("")}`;
          writeFileSync(join(dir, "pnpm-workspace.yaml"), yaml);
          const expected = ["pnpm-workspace.yaml"];
          roots.forEach((r, i) => {
            const pkg = join(r, `p${i}`);
            mkdirSync(join(dir, pkg, "dist"), { recursive: true });
            writeFileSync(
              join(dir, pkg, "package.json"),
              JSON.stringify({ scripts: { build: "x" }, abolish: { buildOutputs: ["dist"] } }),
            );
            writeFileSync(join(dir, pkg, "dist/o.js"), r);
            expected.push(`${pkg}/package.json`, `${pkg}/dist/o.js`);
          });
          const r = hash(dir);
          if (bad === undefined) {
            expect(r.status).toBe(0);
            expect(paths(r.stdout)).toEqual(expected.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
          } else {
            expect(r.status).toBe(1);
            expect(r.stderr).toContain("unsupported packages entry");
          }
        },
      ),
      runs,
    );
  }, 600_000);
});
