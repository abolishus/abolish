import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  changedFiles,
  forTask,
  gatedPackageViolations,
  invalidPackageNames,
  missingRequiredScripts,
  selectAffected,
  toRunArgs,
  withDependents,
  workspaceRoots,
} from "../src/affected.ts";

const pkgs = [
  { name: "@abolishus/crypto", dir: "packages/crypto", dependsOn: [], scripts: ["test", "build"] },
  {
    name: "@abolishus/verifier",
    dir: "packages/verifier",
    dependsOn: ["@abolishus/crypto"],
    scripts: ["test"],
  },
  {
    name: "@abolishus/node",
    dir: "apps/node",
    dependsOn: ["@abolishus/verifier"],
    scripts: ["test", "test:e2e"],
  },
  { name: "@abolishus/ci-tools", dir: ".github/tools/ci", dependsOn: [], scripts: ["test"] },
];

describe("selectAffected", () => {
  test("files inside packages select those packages", () => {
    expect(selectAffected(["packages/crypto/src/a.ts", ".github/tools/ci/src/x.ts"], pkgs)).toEqual(
      {
        mode: "some",
        packages: ["@abolishus/ci-tools", "@abolishus/crypto"],
      },
    );
  });

  test("a sibling directory with a shared prefix is not owned", () => {
    expect(selectAffected(["packages/crypto-extra/a.ts"], pkgs)).toEqual({ mode: "all" });
  });

  test("root config, lockfile and workflows select everything", () => {
    for (const f of [
      "pnpm-lock.yaml",
      "vite.config.ts",
      ".github/workflows/ci.yml",
      "package.json",
    ]) {
      expect(selectAffected([f], pkgs)).toEqual({ mode: "all" });
    }
  });

  test("protocol spec changes select everything", () => {
    expect(selectAffected(["docs/spec/encoding.md"], pkgs)).toEqual({ mode: "all" });
  });

  test("prose-only changes select nothing", () => {
    expect(
      selectAffected(["docs/STATUS.md", "README.md", ".claude/skills/dev/SKILL.md", ""], pkgs),
    ).toEqual({
      mode: "none",
    });
  });

  test("dependents are transitive", () => {
    expect(withDependents(["@abolishus/crypto"], pkgs)).toEqual([
      "@abolishus/crypto",
      "@abolishus/node",
      "@abolishus/verifier",
    ]);
  });

  test("forTask keeps only packages (and dependents) that define the task", () => {
    const crypto = { mode: "some", packages: ["@abolishus/crypto"] } as const;
    expect(forTask(crypto, "test:e2e", pkgs)).toEqual({
      mode: "some",
      packages: ["@abolishus/node"],
    });
    expect(forTask(crypto, "build", pkgs)).toEqual({
      mode: "some",
      packages: ["@abolishus/crypto"],
    });
    const tools = { mode: "some", packages: ["@abolishus/ci-tools"] } as const;
    expect(forTask(tools, "test:e2e", pkgs)).toEqual({ mode: "none" });
    expect(forTask({ mode: "all" }, "test:storybook", pkgs)).toEqual({ mode: "none" });
    expect(forTask({ mode: "all" }, "test", pkgs)).toEqual({ mode: "all" });
    expect(forTask({ mode: "none" }, "test", pkgs)).toEqual({ mode: "none" });
  });

  test("run args", () => {
    expect(toRunArgs({ mode: "some", packages: ["a", "b"] })).toEqual([
      "--filter",
      "a",
      "--filter",
      "b",
    ]);
    expect(toRunArgs({ mode: "all" })).toEqual(["-r"]);
    expect(toRunArgs({ mode: "none" })).toEqual([]);
  });
});

test("every package must define build, test and check", () => {
  const ok = {
    name: "a",
    dir: "packages/a",
    dependsOn: [],
    scripts: ["build", "test", "check", "test:e2e"],
  };
  const bad = { name: "b", dir: "packages/b", dependsOn: [], scripts: ["build"] };
  expect(missingRequiredScripts([ok])).toEqual([]);
  expect(missingRequiredScripts([ok, bad])).toEqual([
    "packages/b/package.json (b): missing required scripts: test, check",
  ]);
});

test("a move out of a package reports both paths, so the package stays affected", () => {
  const dir = mkdtempSync(join(tmpdir(), "affected-"));
  const g = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: dir,
      stdio: "pipe",
    });
  try {
    g("init", "-q", "-b", "main");
    mkdirSync(join(dir, "packages/crypto"), { recursive: true });
    writeFileSync(join(dir, "packages/crypto/vectors.test.ts"), "x".repeat(200));
    writeFileSync(join(dir, "packages/crypto/ɡroup.ts"), "y");
    g("add", "-A");
    g("commit", "-qm", "base");
    g("checkout", "-qb", "change");
    mkdirSync(join(dir, "docs/archive"), { recursive: true });
    g("mv", "packages/crypto/vectors.test.ts", "docs/archive/vectors.test.ts");
    writeFileSync(join(dir, "packages/crypto/ɡroup.ts"), "z");
    g("commit", "-qam", "move");
    const files = changedFiles("main", dir).sort();
    expect(files).toEqual([
      "docs/archive/vectors.test.ts",
      "packages/crypto/vectors.test.ts",
      "packages/crypto/ɡroup.ts",
    ]);
    expect(selectAffected(files, pkgs)).toEqual({ mode: "some", packages: ["@abolishus/crypto"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 200) };

test("property: any path no package owns and no rule marks inert selects everything", () => {
  const segment = fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,8}$/);
  const owned = fc
    .tuple(fc.constantFrom(...pkgs.map((p) => p.dir)), segment)
    .map(([d, f]) => `${d}/${f}`);
  const inert = fc
    .tuple(fc.constantFrom("docs/notes", ".claude/skills/x"), segment)
    .map(([d, f]) => `${d}/${f}`);
  // "zz-" can't collide with a package directory or an inert rule.
  const unknown = fc.tuple(segment, segment).map(([d, f]) => `zz-${d}/${f}`);
  fc.assert(
    fc.property(
      fc.array(fc.oneof(owned, inert)),
      unknown,
      fc.array(fc.oneof(owned, inert)),
      (before, u, after) => {
        expect(selectAffected([...before, u, ...after], pkgs)).toEqual({ mode: "all" });
      },
    ),
    runs,
  );
});

describe("workspaceRoots", () => {
  test("reads <dir>/* globs", () => {
    expect(workspaceRoots("packages:\n  - apps/*\n  - .github/tools/*\ncatalog: {}\n")).toEqual([
      "apps",
      ".github/tools",
    ]);
  });
  test("rejects other glob shapes, traversal and a missing list", () => {
    for (const y of [
      "packages:\n  - apps/**\n",
      "packages:\n  - apps\n",
      "packages:\n  - ../x/*\n",
      "catalog: {}\n",
      "packages: []\n",
    ]) {
      expect(() => workspaceRoots(y), y).toThrow();
    }
  });
  test("matches the repository's own workspace file", () => {
    expect(
      workspaceRoots(
        readFileSync(new URL("../../../../pnpm-workspace.yaml", import.meta.url), "utf8"),
      ),
    ).toContain(".github/tools");
  });
});

describe("invalidPackageNames", () => {
  const pkg = (name: string) => ({ name, dir: "packages/x", dependsOn: [], scripts: [] });

  test("accepts npm package names, scoped or not", () => {
    expect(invalidPackageNames([pkg("@abolishus/crypto"), pkg("ci-tools"), pkg("a.b_c")])).toEqual(
      [],
    );
  });

  test("rejects names that could forge CI output or arguments", () => {
    for (const name of ["x\ntest=", "a b", "--all", "Upper", "@scope", "@s/x/y", "", "x;rm"]) {
      expect(invalidPackageNames([pkg(name)])).toHaveLength(1);
    }
  });

  test("no name containing whitespace or '=' ever passes", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.constantFrom("\n", "\r", " ", "\t", "="),
        fc.string(),
        (a, c, b) => {
          expect(invalidPackageNames([pkg(a + c + b)])).toHaveLength(1);
        },
      ),
      runs,
    );
  });
});

describe("gatedPackageViolations", () => {
  const pkg = (name: string, dir: string) => ({ name, dir, dependsOn: [], scripts: [] });
  const none = () => false;

  test("gated packages at their gated paths pass", () => {
    expect(
      gatedPackageViolations(
        [pkg("@abolishus/crypto", "packages/crypto"), pkg("@abolishus/core", "packages/core")],
        none,
      ),
    ).toEqual([]);
  });

  test("a gated package anywhere else, or under a look-alike name, fails", () => {
    expect(
      gatedPackageViolations(
        [
          pkg("@abolishus/verifier", "apps/verifier"),
          pkg("@abolishus/crypto", "packages/cr\u0443pto"),
        ],
        none,
      ),
    ).toHaveLength(2);
  });

  test("a gated root that is a symlink fails", () => {
    expect(gatedPackageViolations([], (p) => p === "packages/verifier")).toEqual([
      "packages/verifier: must be a real directory, not a symlink",
    ]);
  });
});
