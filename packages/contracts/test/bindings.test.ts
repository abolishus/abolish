// The wagmi bindings in src/generated/ (contracts skill, Bindings). They are
// generated and never hand-edited; these tests tie them to the compiled
// artifacts, so a stale or edited binding, or a deployable contract left out
// of wagmi.config.ts, fails here as well as in repro-build (which rejects a
// build that changes a tracked file).

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import * as bindings from "../src/generated/abi.ts";

const SRC = new URL("../src/", import.meta.url);
const OUT = new URL("../out/", import.meta.url);

/** Every concrete contract declared in src/: what gets deployed. */
function deployableContracts(): string[] {
  return readdirSync(SRC)
    .filter((f) => f.endsWith(".sol"))
    .flatMap((f) =>
      [...readFileSync(new URL(f, SRC), "utf8").matchAll(/^contract\s+(\w+)/gm)].map(
        (m) => `${f}/${m[1]}`,
      ),
    )
    .sort();
}

const bindingName = (contract: string) => `${contract[0]?.toLowerCase()}${contract.slice(1)}Abi`;

const deployable = deployableContracts();

describe("wagmi bindings", () => {
  test("cover exactly the deployable contracts", () => {
    expect(deployable.length).toBeGreaterThan(0);
    const expected = deployable.map((p) => bindingName(p.split("/")[1] ?? "")).sort();
    expect(Object.keys(bindings).sort()).toEqual(expected);
  });

  test.each(deployable)("%s matches its compiled ABI", (path) => {
    const [file = "", contract = ""] = path.split("/");
    const artifact = JSON.parse(readFileSync(new URL(`${file}/${contract}.json`, OUT), "utf8")) as {
      abi: unknown;
    };
    expect((bindings as Record<string, unknown>)[bindingName(contract)]).toEqual(artifact.abi);
  });
});
