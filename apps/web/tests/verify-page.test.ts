import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

import { CHECK_GROUPS, COMMANDS, EXIT_ROWS, NODE_SERVE } from "../src/components/verify-page.tsx";
import { catalogs } from "../src/messages.ts";
import { recountOne } from "../src/recount.ts";

// The page restates the verifier's own documents, so each statement it
// copies is tied to them here: a page that misstated how to run the verifier
// or what its verdict means would be a claim no one could check (T-53).
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const spec = read("docs/spec/verifier.md");

describe("the verify page", () => {
  test("names every group of checks the specification has, in its order", () => {
    const groups = [...spec.matchAll(/^### (\d+)\. /gm)].map((m) => Number(m[1]));
    expect(CHECK_GROUPS).toEqual(groups);
    for (const messages of Object.values(catalogs))
      for (const n of CHECK_GROUPS) {
        expect(messages[`recountCheck${n}Title`]).toBeTruthy();
        expect(messages[`recountCheck${n}Body`]).toBeTruthy();
      }
  });

  test("gives exactly the exit codes of the specification's command line", () => {
    const line = spec.slice(spec.indexOf("### Command line"));
    const table = line.slice(line.indexOf("| Code |"));
    const codes = [...table.matchAll(/^\| (\d+) +\|/gm)].map((m) => Number(m[1]));
    expect(EXIT_ROWS.map((row) => row.code)).toEqual(codes);
  });

  test("runs only options the node and the verifier take", () => {
    const usage = read("apps/node/README.md") + read("packages/verifier/src/cli.ts");
    for (const command of [...COMMANDS.map((step) => step.command), NODE_SERVE])
      for (const [option] of command.matchAll(/--[a-z][a-z0-9-]*/g))
        expect(usage, option).toMatch(new RegExp(`${option}\\b`));
    // The verifier installs no binary yet, so the page runs it from source.
    expect(read("packages/verifier/package.json")).not.toContain('"bin"');
    expect(COMMANDS.at(-1)?.command).toContain("packages/verifier/src/bin.ts");
  });

  test("serves the directories the copy and verify steps write, on the node's own default host", () => {
    const [, copy, verify] = COMMANDS;
    expect(NODE_SERVE).toContain(" serve --blocks boards --reports reports");
    expect(copy.command).toContain("--blocks boards ");
    expect(verify.command).toContain("--reports reports ");
    // Open to others the node needs a proxy in front (T-52), which the page says instead.
    expect(NODE_SERVE).not.toContain("--host");
    expect(read("apps/node/README.md")).toContain(
      "It listens on loopback unless `--host` says otherwise.",
    );
  });

  test("one poll's command is the last one with that poll's ID, and nothing else changed", () => {
    const id = "ab".repeat(32);
    const one = recountOne(id);
    expect(one).toBe(COMMANDS.at(-1)?.command.replace("$POLL_ID", id));
    expect(one.endsWith(`reports/${id}`)).toBe(true);
    expect(one).not.toContain("$POLL_ID");
  });
});
