// Rules for everything under packages/circuits (circuits skill, Rules) that
// no Noir test would notice being broken by the next circuit or dependency.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import { describe, expect, test } from "vite-plus/test";

const ROOT = new URL("../", import.meta.url);
const SELF = "test/source-rules.test.ts";

const files = readdirSync(ROOT, { recursive: true, encoding: "utf8" })
  .filter((f) => !f.split("/").some((p) => p === "node_modules" || p === "target"))
  .filter((f) => /\.(nr|toml|json|ts|sh|md)$/.test(f) && f !== SELF)
  .sort();

const read = (f: string) => readFileSync(new URL(f, ROOT), "utf8");

describe("circuit source rules", () => {
  test("there are files to check", () => {
    expect(files).toContain("lib/abolish/src/pack.nr");
    expect(files).toContain("package.json");
  });

  test.each(files)("%s never asks bb for a proof without zero knowledge", (file) => {
    // A non-ZK proof doesn't hide the witness, and a membership or Tier 2
    // witness identifies the voter (T-13, T-15).
    expect(read(file)).not.toMatch(/disable[_-]zk|no[_-]zk|non[_-]zk|zk\s*=\s*false/i);
  });

  test.each(files.filter((f) => f.endsWith("Nargo.toml")))(
    "%s has only path dependencies inside packages/circuits",
    (file) => {
      // A git dependency resolves a mutable tag at build time; a path outside
      // the package leaves the crypto-review gate (T-55). Dependencies are
      // accepted only as one-line inline tables, so no sub-table or `git` key
      // can hide one.
      const text = read(file);
      expect(text).not.toMatch(/^\s*\[\s*dependencies\s*\.|\bgit\s*=/m);
      const deps = text.split(/^\[dependencies\]$/m)[1]?.split(/^\[/m)[0] ?? "";
      for (const line of deps.split("\n").filter((l) => l.trim() !== "")) {
        const m = /^[a-z0-9_]+ = \{ path = "([^"]+)" \}$/.exec(line);
        expect(m, line).not.toBeNull();
        const path = m?.[1] ?? "/";
        const target = posix.normalize(posix.join(dirname(file), path));
        expect(path.startsWith("/"), line).toBe(false);
        expect(target === ".." || target.startsWith("../"), line).toBe(false);
      }
    },
  );
});
