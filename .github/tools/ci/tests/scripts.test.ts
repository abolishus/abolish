// The scripts that decide required checks: review-verdict.py (claude-review,
// crypto-review), hash-outputs.py (repro-build) and crypto-scope.sh (whether
// crypto-review applies). They run as subprocesses exactly as the workflows
// run them (Python under `python3 -I`).

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
    ["an empty non-list findings value", review("pass", {}), "success"],
    ["an empty-string findings value", review("pass", ""), "success"],
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

describe("crypto-scope.sh", () => {
  let dir: string;
  let base: string;
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: dir,
      stdio: "pipe",
    }).toString();
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "crypto-scope-"));
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "README.md"), "base\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    base = git("rev-parse", "HEAD").trim();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // Each case is a commit on a fresh branch from base; paths may be raw bytes.
  const change = (paths: (string | Buffer)[], symlinks: [string, string][] = []) => {
    git("checkout", "-q", "-f", "-B", "case", base);
    git("clean", "-qfdx");
    for (const p of paths) {
      const full = Buffer.concat([Buffer.from(`${dir}/`), Buffer.isBuffer(p) ? p : Buffer.from(p)]);
      const parent = full.subarray(0, full.lastIndexOf(0x2f));
      mkdirSync(parent, { recursive: true });
      writeFileSync(full, "x\n");
    }
    for (const [link, target] of symlinks) {
      mkdirSync(join(dir, link, ".."), { recursive: true });
      symlinkSync(target, join(dir, link));
    }
    git("add", "-A");
    git("commit", "-qm", "change", "--allow-empty");
    const r = spawnSync("bash", [join(scripts, "crypto-scope.sh"), base], {
      cwd: dir,
      encoding: "utf8",
    });
    return { status: r.status, last: r.stdout.trim().split("\n").at(-1) };
  };

  test.each([
    ["a protocol package", ["packages/crypto/src/a.ts"], true],
    ["docs/spec", ["docs/spec/encoding.md"], true],
    ["root agent files", ["AGENTS.md"], true],
    ["nested agent files", ["apps/web/CLAUDE.md", "x/.mcp.json"], true],
    ["a .claude directory", [".claude/skills/dev/SKILL.md"], true],
    ["agent files under .github", [".github/x/AGENTS.md", ".github/.claude/y"], false],
    ["workflows only", [".github/workflows/ci.yml"], false],
    ["other packages and docs", ["packages/core/a.ts", "docs/adr/0001.md", "README.md"], false],
    ["a look-alike prefix", ["packages/cryptography/a.ts", "docs/specs/x.md"], false],
  ])("%s", (_, paths, applies) => {
    expect(change(paths)).toEqual({ status: 0, last: `applies=${applies}` });
  });

  test("a non-UTF-8 name sorting first doesn't hide a protocol change", () => {
    const r = change([
      Buffer.from("!caf\xe9.md", "latin1"),
      Buffer.from("docs/caf\xe9.md", "latin1"),
      "packages/crypto/a.ts",
    ]);
    expect(r).toEqual({ status: 0, last: "applies=true" });
  });

  test("a gated root committed as a symlink is in scope", () => {
    const r = change(["tools/verifier/index.ts"], [["packages/verifier", "../tools/verifier"]]);
    expect(r).toEqual({ status: 0, last: "applies=true" });
  });

  test("an empty diff fails closed", () => {
    expect(change([]).status).not.toBe(0);
  });

  test("applies exactly when some changed path is in scope", () => {
    const inScope = [
      "packages/crypto/a.ts",
      "packages/verifier",
      "docs/spec/x.md",
      "CLAUDE.md",
      "a/b/AGENTS.md",
      ".claude/x",
    ];
    const outOfScope = [
      "README.md",
      "packages/core/a.ts",
      "packages/cryptox/a.ts",
      ".github/AGENTS.md",
      ".github/workflows/x.yml",
      "docs/adr/1.md",
    ];
    const weird = [Buffer.from("w\xff.md", "latin1"), Buffer.from("!\xe9", "latin1")];
    fc.assert(
      fc.property(
        fc.subarray(inScope),
        fc.subarray([...outOfScope, ...weird], { minLength: 1 }),
        (a, b) => {
          expect(change([...a, ...b])).toEqual({
            status: 0,
            last: `applies=${a.length > 0}`,
          });
        },
      ),
      { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 30) },
    );
  }, 600_000);
});
