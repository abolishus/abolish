import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { parsePackages } from "../src/lockfile.ts";
import {
  bbVersionsUrls,
  catalogPins,
  lockedErrors,
  mappingErrors,
  pinErrors,
  scriptPins,
  type ScriptPins,
} from "../src/toolchain.ts";

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };
const repo = (path: string) =>
  readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");

const NOIR = "1.0.0-beta.22";
const BB = "5.0.0-nightly.20260522";
const COMMIT = "bb15fcbbe969f11a892272715fe59f0976b086ca";
const SHA = "26f98a191cfc049521320d077473a12cf141ff9b909392f4685d349063a5b2f8";

const script = (extra = "", lines?: string[]) =>
  [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    ...(lines ?? [
      `NOIR_VERSION="${NOIR}"`,
      `BB_VERSION="${BB}"`,
      `BB_VERSIONS_COMMIT="${COMMIT}"`,
      `BB_VERSIONS_SHA256="${SHA}"`,
    ]),
    'if ! have_version bb "$BB_VERSION"; then',
    "  fetch bb",
    "fi",
    extra,
  ].join("\n");

const pins: ScriptPins = { noir: NOIR, bb: BB, bbVersionsCommit: COMMIT, bbVersionsSha256: SHA };

const workspace = (catalog: string, extra = "") =>
  `packages:\n  - packages/*\ncatalog:\n${catalog}\n${extra}`;
const goodCatalog = `  "@aztec/bb.js": ${BB}\n  "@noir-lang/noir_js": ${NOIR}\n  yaml: 2.9.1`;

const agents = [
  "- Toolchain pins (move all four together):",
  `  - Noir \`${NOIR}\``,
  `  - bb \`${BB}\``,
  `  - \`@noir-lang/noir_js\` \`${NOIR}\``,
  `  - \`@aztec/bb.js\` \`${BB}\``,
].join("\n");

describe("scriptPins", () => {
  test("reads the four pins from top-level literal assignments", () => {
    expect(scriptPins(script())).toEqual(pins);
  });

  test("the repository's install-toolchain.sh parses and agrees with the catalog and AGENTS.md", () => {
    const s = scriptPins(repo(".github/scripts/install-toolchain.sh"));
    const c = catalogPins(repo("pnpm-workspace.yaml"));
    if (Array.isArray(s) || Array.isArray(c)) throw new Error(JSON.stringify([s, c]));
    expect(pinErrors(s, c, repo("AGENTS.md"))).toEqual([]);
    expect(lockedErrors(parsePackages(repo("pnpm-lock.yaml")).values(), s)).toEqual([]);
  });

  test.each([
    ["a second assignment later", script(`BB_VERSION="9.9.9"`)],
    ["an indented reassignment", script(`  BB_VERSION="9.9.9"`)],
    ["an exported reassignment", script(`export BB_VERSION="9.9.9"`)],
    ["a readonly reassignment", script(`readonly NOIR_VERSION=1.0.0`)],
    ["an append", script(`BB_VERSION+="-patched"`)],
    ["an assignment after a command on the same line", script(`true; NOIR_VERSION=1.0.0`)],
  ])("refuses %s", (_, s) => {
    expect(scriptPins(s)).toEqual([expect.stringMatching(/must be assigned exactly once/)]);
  });

  test.each([
    ["unquoted", `NOIR_VERSION=${NOIR}`],
    ["single-quoted", `NOIR_VERSION='${NOIR}'`],
    ["an expansion", `NOIR_VERSION="$(cat v)"`],
    ["a trailing command", `NOIR_VERSION="${NOIR}"; true`],
    ["indented", `  NOIR_VERSION="${NOIR}"`],
  ])("refuses a %s pin", (_, line) => {
    const lines = [
      line,
      `BB_VERSION="${BB}"`,
      `BB_VERSIONS_COMMIT="${COMMIT}"`,
      `BB_VERSIONS_SHA256="${SHA}"`,
    ];
    expect(scriptPins(script("", lines))).toEqual([
      expect.stringMatching(/NOIR_VERSION must be assigned exactly once/),
    ]);
  });

  test.each([
    ["NOIR_VERSION", "1.0"],
    ["BB_VERSION", "latest"],
    ["BB_VERSIONS_COMMIT", "next"],
    ["BB_VERSIONS_COMMIT", COMMIT.slice(0, 12)],
    ["BB_VERSIONS_SHA256", SHA.toUpperCase()],
  ])("refuses a malformed %s (%s)", (name, value) => {
    const s = script().replace(new RegExp(`^${name}=".*"$`, "m"), `${name}="${value}"`);
    expect(scriptPins(s)).toEqual([`install-toolchain.sh: ${name}="${value}" is malformed`]);
  });

  test("reports every missing pin", () => {
    expect(scriptPins("#!/bin/sh\n")).toHaveLength(4);
  });

  test("ignores references that aren't assignments", () => {
    expect(scriptPins(script(`[ "$BB_VERSION" = x ] || echo "$NOIR_VERSION"`))).toEqual(pins);
  });
});

describe("catalogPins", () => {
  test("reads the default catalog", () => {
    expect(catalogPins(workspace(goodCatalog))).toEqual({ noirJs: NOIR, bbJs: BB });
  });

  test.each([
    ["missing", `  yaml: 2.9.1`],
    ["a range", `  "@aztec/bb.js": ^${BB}\n  "@noir-lang/noir_js": ${NOIR}`],
    ["an alias", `  "@aztec/bb.js": npm:evil@1.0.0\n  "@noir-lang/noir_js": ${NOIR}`],
    ["not a string", `  "@aztec/bb.js": ${BB}\n  "@noir-lang/noir_js": [1]`],
  ])("refuses a pin that is %s", (_, catalog) => {
    const r = catalogPins(workspace(catalog));
    expect(Array.isArray(r) && r.length > 0).toBe(true);
  });

  test("refuses either package in a named catalog", () => {
    const r = catalogPins(
      workspace(goodCatalog, `catalogs:\n  old:\n    "@noir-lang/noir_js": 1.0.0-beta.21\n`),
    );
    expect(r).toEqual([
      "pnpm-workspace.yaml: catalogs.old may not define @noir-lang/noir_js; pin it in the default catalog only",
    ]);
  });

  test("refuses duplicate keys", () => {
    const r = catalogPins(workspace(`${goodCatalog}\n  "@aztec/bb.js": 9.9.9`));
    expect(Array.isArray(r) && r.length > 0).toBe(true);
  });
});

describe("pinErrors", () => {
  const catalog = { noirJs: NOIR, bbJs: BB };

  test("accepts matching pins", () => {
    expect(pinErrors(pins, catalog, agents)).toEqual([]);
  });

  test("refuses a catalog that moved without the script, and the reverse", () => {
    expect(pinErrors(pins, { noirJs: "1.0.0-beta.23", bbJs: BB }, agents)).toContain(
      `@noir-lang/noir_js is 1.0.0-beta.23 in the catalog but NOIR_VERSION is ${NOIR}`,
    );
    expect(pinErrors({ ...pins, bb: "6.0.0" }, catalog, agents)).toContain(
      `@aztec/bb.js is ${BB} in the catalog but BB_VERSION is 6.0.0`,
    );
  });

  test("refuses a stale AGENTS.md", () => {
    expect(pinErrors(pins, catalog, agents.replace(`bb \`${BB}\``, "bb `4.0.0`"))).toEqual([
      `AGENTS.md "Toolchain pins" must list: - bb \`${BB}\``,
    ]);
  });

  test("any single disagreement between script and catalog is reported", () => {
    const version = fc.stringMatching(/^\d\.\d\.\d(-beta\.\d{1,2})?$/);
    fc.assert(
      fc.property(version, version, (noirJs, bbJs) => {
        const errors = pinErrors(pins, { noirJs, bbJs }, agents);
        const catalogErrors = errors.filter((e) => e.includes("in the catalog"));
        expect(catalogErrors.length).toBe(Number(noirJs !== NOIR) + Number(bbJs !== BB));
      }),
      runs,
    );
  });
});

describe("lockedErrors", () => {
  const pkg = (name: string, version: string) => ({
    key: `${name}@${version}`,
    name,
    version,
    resolution: "",
    integrity: undefined,
  });

  test("accepts the pinned versions and unrelated packages", () => {
    expect(
      lockedErrors(
        [pkg("@noir-lang/noir_js", NOIR), pkg("@noir-lang/acvm_js", NOIR), pkg("@aztec/bb.js", BB)],
        pins,
      ),
    ).toEqual([]);
    expect(lockedErrors([pkg("@aztec/other", "1.0.0"), pkg("noir", "0.1.0")], pins)).toEqual([]);
  });

  test("refuses a second Noir or bb.js version anywhere in the lockfile", () => {
    expect(
      lockedErrors(
        [pkg("@noir-lang/acvm_js", "1.0.0-beta.21"), pkg("@aztec/bb.js", "4.0.0")],
        pins,
      ),
    ).toEqual([
      `pnpm-lock.yaml: @noir-lang/acvm_js@1.0.0-beta.21 is not at NOIR_VERSION ${NOIR}`,
      `pnpm-lock.yaml: @aztec/bb.js@4.0.0 is not at BB_VERSION ${BB}`,
    ]);
  });
});

describe("mappingErrors", () => {
  const file = JSON.stringify({ [NOIR]: BB, "1.0.0-beta.21": "5.0.0-nightly.20260324" }, null, 2);

  test("accepts a file mapping the pinned Noir to the pinned bb", () => {
    expect(mappingErrors("f", file, pins)).toEqual([]);
  });

  test.each([
    ["not JSON", "{", /not JSON/],
    ["an array", "[]", /not a JSON object/],
    ["missing the version", JSON.stringify({ "1.0.0-beta.21": BB }), /does not list Noir/],
    ["mapping elsewhere", JSON.stringify({ [NOIR]: "5.0.0" }), /maps Noir .* to bb "5.0.0"/],
    ["a non-string value", JSON.stringify({ [NOIR]: 5 }), /maps Noir .* to bb 5,/],
    ["duplicate keys", `{"${NOIR}": "x", "${NOIR}": "${BB}"}`, /duplicate keys/],
  ])("refuses %s", (_, json, error) => {
    expect(mappingErrors("f", json, pins)).toEqual([expect.stringMatching(error)]);
  });

  test("an inherited property is not a mapping", () => {
    expect(mappingErrors("f", "{}", { ...pins, noir: "constructor" })).toEqual([
      "f does not list Noir constructor",
    ]);
  });
});

test("bb-versions.json is fetched by pinned commit and from the branch bbup reads", () => {
  expect(bbVersionsUrls(pins)).toEqual({
    pinned: `https://raw.githubusercontent.com/AztecProtocol/aztec-packages/${COMMIT}/barretenberg/bbup/bb-versions.json`,
    branch:
      "https://raw.githubusercontent.com/AztecProtocol/aztec-packages/refs/heads/next/barretenberg/bbup/bb-versions.json",
  });
});
