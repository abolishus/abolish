import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  changedFiles,
  forTask,
  missingRequiredScripts,
  selectAffected,
  toRunArgs,
  withDependents,
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
