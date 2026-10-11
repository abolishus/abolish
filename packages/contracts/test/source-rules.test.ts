// Source rules every contract in src/ must follow (contracts skill, Rules;
// docs/spec/contracts.md). Each one is a property of the source text that no
// Foundry test of a single contract would notice being broken by the next
// contract added.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

const SRC = new URL("../src/", import.meta.url);

function solidityFiles(dir: URL): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".sol"))
    .sort();
}

/** The source with comments and string literals blanked, so only code is matched. */
function code(path: string): string {
  return readFileSync(new URL(path, SRC), "utf8").replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g,
    (m) => m.replace(/[^\n]/g, " "),
  );
}

const files = solidityFiles(SRC);

describe("contract source rules", () => {
  test("src/ has contracts to check", () => {
    expect(files).toContain("EventAccumulator.sol");
  });

  test.each(files)("%s emits only through the event accumulator", (file) => {
    // T-71, T-25: a log that skips the accumulator could be left off the
    // board without the verifier's 4.4 replay noticing.
    const src = code(file);
    expect(src).not.toMatch(/\bemit\s/);
    expect(src).not.toMatch(/\banonymous\b/);
    if (file !== "EventAccumulator.sol") expect(src).not.toMatch(/\blog[0-4]\s*\(/);
  });

  test.each(files)("%s has no self-destruct, delegatecall or proxy hook", (file) => {
    // Contracts skill: bulletin-board contracts are immutable.
    const src = code(file);
    expect(src).not.toMatch(/\bselfdestruct\b/);
    expect(src).not.toMatch(/\bdelegatecall\b/);
    expect(src).not.toMatch(/\bcallcode\b/);
  });

  test.each(files)("%s pins the compiler exactly", (file) => {
    const pragmas = code(file).match(/pragma\s+solidity\s+[^;]*;/g) ?? [];
    expect(pragmas).toEqual(["pragma solidity 0.8.30;"]);
    const toml = readFileSync(new URL("../foundry.toml", import.meta.url), "utf8");
    expect(toml).toMatch(/^solc_version = "0\.8\.30"$/m);
  });
});
