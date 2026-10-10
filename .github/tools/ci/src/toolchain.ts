// The proving toolchain is pinned in two places that must agree (AGENTS.md
// "Toolchain pins"): nargo and bb in .github/scripts/install-toolchain.sh, and
// @noir-lang/noir_js and @aztec/bb.js in the pnpm catalog. Circuits compiled by
// one nargo and proved or verified by a mismatched bb or bb.js can fail, or
// verify against a different verification key than the one the spec pins
// (T-05, T-60). bb must also be the version bbup's bb-versions.json maps the Noir
// version to, so the pair is one upstream tested together.
//
// These are pure checks; cli.ts reads the files and fetches bb-versions.json.

import { isMap, isScalar, parseDocument } from "yaml";
import type { LockedPackage } from "./lockfile.ts";

export const BB_VERSIONS_REPO = "AztecProtocol/aztec-packages";
export const BB_VERSIONS_PATH = "barretenberg/bbup/bb-versions.json";
// The branch bbup reads bb-versions.json from.
export const BB_VERSIONS_BRANCH = "next";

export interface ScriptPins {
  readonly noir: string;
  readonly bb: string;
  /** Commit of BB_VERSIONS_REPO whose bb-versions.json was recorded as evidence. */
  readonly bbVersionsCommit: string;
  /** sha256 of that file. */
  readonly bbVersionsSha256: string;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const SCRIPT_VARS = {
  NOIR_VERSION: VERSION,
  BB_VERSION: VERSION,
  BB_VERSIONS_COMMIT: COMMIT,
  BB_VERSIONS_SHA256: SHA256,
} as const;

/**
 * Reads the pins from install-toolchain.sh. Each must be assigned exactly once,
 * as a top-level `NAME="literal"` line: any other assignment (indented,
 * `export`/`readonly`/`declare`, `+=`, a second one later in the script) could
 * make the version the script installs differ from the one checked here.
 */
export function scriptPins(script: string): ScriptPins | string[] {
  const errors: string[] = [];
  const values: Record<string, string> = {};
  for (const [name, shape] of Object.entries(SCRIPT_VARS)) {
    const mentions = script
      .split("\n")
      .filter((l) => new RegExp(`(?:^|[^A-Za-z0-9_$])${name}\\s*\\+?=`).test(l));
    const exact = new RegExp(`^${name}="([^"$\`\\\\]*)"$`);
    const match = mentions.length === 1 ? exact.exec(mentions[0] ?? "") : null;
    if (match === null) {
      errors.push(
        `install-toolchain.sh: ${name} must be assigned exactly once, as a top-level ${name}="..." line (found ${mentions.length} assignment(s))`,
      );
      continue;
    }
    const value = match[1] ?? "";
    if (!shape.test(value)) {
      errors.push(`install-toolchain.sh: ${name}="${value}" is malformed`);
      continue;
    }
    values[name] = value;
  }
  if (errors.length > 0) return errors;
  return {
    noir: values["NOIR_VERSION"] ?? "",
    bb: values["BB_VERSION"] ?? "",
    bbVersionsCommit: values["BB_VERSIONS_COMMIT"] ?? "",
    bbVersionsSha256: values["BB_VERSIONS_SHA256"] ?? "",
  };
}

export interface CatalogPins {
  readonly noirJs: string;
  readonly bbJs: string;
}

/**
 * Reads the default catalog's pins from pnpm-workspace.yaml. Named catalogs may
 * not define either package: `catalog:<name>` would otherwise let a workspace
 * package resolve a version this check never sees.
 */
export function catalogPins(workspaceYaml: string): CatalogPins | string[] {
  const doc = parseDocument(workspaceYaml, { uniqueKeys: true });
  const errors = [...doc.errors, ...doc.warnings].map((e) => `pnpm-workspace.yaml: ${e.message}`);
  if (errors.length > 0) return errors;
  const root = doc.contents;
  if (!isMap(root)) return ["pnpm-workspace.yaml: not a mapping"];

  const pin = (name: string): string | undefined => {
    const catalog = root.get("catalog", true);
    if (!isMap(catalog)) return undefined;
    const node = catalog.get(name, true);
    return isScalar(node) && typeof node.value === "string" ? node.value : undefined;
  };
  const noirJs = pin("@noir-lang/noir_js");
  const bbJs = pin("@aztec/bb.js");
  for (const [name, value] of [
    ["@noir-lang/noir_js", noirJs],
    ["@aztec/bb.js", bbJs],
  ] as const) {
    if (value === undefined || !VERSION.test(value)) {
      errors.push(`pnpm-workspace.yaml: catalog must pin ${name} to an exact version`);
    }
  }

  const named = root.get("catalogs", true);
  if (named !== undefined) {
    if (!isMap(named)) errors.push("pnpm-workspace.yaml: catalogs must be a mapping");
    else {
      for (const item of named.items) {
        const entries = item.value;
        const label = isScalar(item.key) ? String(item.key.value) : "?";
        if (!isMap(entries)) {
          errors.push(`pnpm-workspace.yaml: catalogs.${label} must be a mapping`);
          continue;
        }
        for (const name of ["@noir-lang/noir_js", "@aztec/bb.js"]) {
          if (entries.has(name)) {
            errors.push(
              `pnpm-workspace.yaml: catalogs.${label} may not define ${name}; pin it in the default catalog only`,
            );
          }
        }
      }
    }
  }
  if (errors.length > 0) return errors;
  return { noirJs: noirJs ?? "", bbJs: bbJs ?? "" };
}

/** The four pins (plus AGENTS.md's copy of them) must name one Noir and one bb. */
export function pinErrors(script: ScriptPins, catalog: CatalogPins, agentsMd: string): string[] {
  const errors: string[] = [];
  if (catalog.noirJs !== script.noir) {
    errors.push(
      `@noir-lang/noir_js is ${catalog.noirJs} in the catalog but NOIR_VERSION is ${script.noir}`,
    );
  }
  if (catalog.bbJs !== script.bb) {
    errors.push(`@aztec/bb.js is ${catalog.bbJs} in the catalog but BB_VERSION is ${script.bb}`);
  }
  // Sessions read the pins from AGENTS.md; a stale copy there leads the next
  // upgrade astray.
  for (const line of [
    `  - Noir \`${script.noir}\``,
    `  - bb \`${script.bb}\``,
    `  - \`@noir-lang/noir_js\` \`${catalog.noirJs}\``,
    `  - \`@aztec/bb.js\` \`${catalog.bbJs}\``,
  ]) {
    if (!agentsMd.split("\n").includes(line)) {
      errors.push(`AGENTS.md "Toolchain pins" must list: ${line.trim()}`);
    }
  }
  return errors;
}

/**
 * Every locked @noir-lang/* package ships with the Noir release, and @aztec/bb.js
 * with bb: a second version in the lockfile means some package proves or
 * executes with a toolchain other than the pinned one.
 */
export function lockedErrors(locked: Iterable<LockedPackage>, script: ScriptPins): string[] {
  const errors: string[] = [];
  for (const p of locked) {
    if (p.name.startsWith("@noir-lang/") && p.version !== script.noir) {
      errors.push(`pnpm-lock.yaml: ${p.key} is not at NOIR_VERSION ${script.noir}`);
    }
    if (p.name === "@aztec/bb.js" && p.version !== script.bb) {
      errors.push(`pnpm-lock.yaml: ${p.key} is not at BB_VERSION ${script.bb}`);
    }
  }
  return errors;
}

/**
 * bb-versions.json must map NOIR_VERSION to BB_VERSION. `source` names the copy
 * (pinned commit or branch) for the error message. Duplicate keys are refused:
 * JSON.parse keeps the last one, and bbup's own reader might not.
 */
export function mappingErrors(source: string, json: string, script: ScriptPins): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return [`${source}: not JSON: ${(e as Error).message}`];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [`${source}: not a JSON object`];
  }
  const keys = [...json.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map((m) => m[1]);
  if (new Set(keys).size !== keys.length) return [`${source}: duplicate keys`];
  if (!Object.hasOwn(parsed, script.noir)) {
    return [`${source} does not list Noir ${script.noir}`];
  }
  const mapped = (parsed as Record<string, unknown>)[script.noir];
  if (mapped !== script.bb) {
    return [
      `${source} maps Noir ${script.noir} to bb ${JSON.stringify(mapped)}, but BB_VERSION is ${script.bb}`,
    ];
  }
  return [];
}

export function bbVersionsUrls(script: ScriptPins): { pinned: string; branch: string } {
  const raw = `https://raw.githubusercontent.com/${BB_VERSIONS_REPO}`;
  return {
    pinned: `${raw}/${script.bbVersionsCommit}/${BB_VERSIONS_PATH}`,
    branch: `${raw}/refs/heads/${BB_VERSIONS_BRANCH}/${BB_VERSIONS_PATH}`,
  };
}
