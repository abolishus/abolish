// Vendored dependencies (contracts skill, Layout): plain files copied from an
// audited release, recorded in the README with their sha256 sums and a tree
// hash. This catches a vendored file edited, added or removed after the fact
// without the README changing with it; whether the recorded files match
// upstream is for review and, later, a CI re-derivation (README, Vendored code).

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

const ROOT = new URL("../", import.meta.url);
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** The README's `sha256sum` block and tree hash for one vendored directory. */
function recorded(name: string): { lines: string; tree: string } {
  const readme = readFileSync(new URL("README.md", ROOT), "utf8");
  const at = readme.indexOf(`<!-- vendored:${name} -->`);
  expect(at).toBeGreaterThan(-1);
  const block = /```text\n([\s\S]*?)```\n\nTree hash: `([0-9a-f]{64})`\./.exec(readme.slice(at));
  expect(block).not.toBeNull();
  return { lines: block![1]!, tree: block![2]! };
}

/** `sha256sum` lines for every file under `dir`, sorted by path. */
function actual(dir: URL): string {
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => statSync(new URL(f, dir)).isFile())
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return files.map((f) => `${sha256(readFileSync(new URL(f, dir)))}  ${f}\n`).join("");
}

describe("vendored code", () => {
  test("vendor/ holds only the recorded directories", () => {
    expect(readdirSync(new URL("vendor/", ROOT)).sort()).toEqual([
      "account-abstraction",
      "openzeppelin-contracts",
      "safe-smart-account",
    ]);
  });

  test.each(["account-abstraction", "openzeppelin-contracts", "safe-smart-account"])(
    "%s matches its recorded sums and tree hash",
    (name) => {
      const { lines, tree } = recorded(name);
      expect(actual(new URL(`vendor/${name}/`, ROOT))).toBe(lines);
      expect(sha256(lines)).toBe(tree);
    },
  );

  test("foundry.toml maps only the vendored directories", () => {
    const toml = readFileSync(new URL("foundry.toml", ROOT), "utf8");
    expect(toml.match(/^remappings\b/gm)).toHaveLength(1);
    expect(toml.match(/^remappings = \[[^\]]*\]$/gm)).toEqual([
      [
        "remappings = [",
        '  "@account-abstraction/contracts/=vendor/account-abstraction/contracts/",',
        '  "@openzeppelin/contracts/=vendor/openzeppelin-contracts/contracts/",',
        "]",
      ].join("\n"),
    ]);
    expect(toml).toMatch(/^libs = \[\]$/m);
  });
});
