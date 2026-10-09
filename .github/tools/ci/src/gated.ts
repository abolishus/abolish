// Dependency and import policy for the packages crypto-review gates
// (AGENTS.md, Architecture → Rules; threats T-55 supply chain, T-36 verifier
// independence).
//
// The verifier's trust base must stay inside packages/{crypto,circuits,
// contracts,verifier}. A manifest check by name alone is not enough: a
// dependency named `@noble/x` can resolve to other bytes (an `npm:` alias, a
// `link:` or `file:` spec, a workspace package), pull in non-`@noble`
// transitive code, or be bypassed by importing a dev dependency, a sibling
// package's source by relative path, or a symlink that leaves the gate. Each
// check below closes one of those paths; together they bound what code the
// gated packages can run to the gated directories plus the audited `@noble/*`
// libraries.

import { posix } from "node:path";
import { parseAllDocuments, type Document } from "yaml";
import { GATED_PACKAGES } from "./affected.ts";

export type GatedName = (typeof GATED_PACKAGES)[number];

/** Runtime dependency fields; anything listed here ships to consumers. */
export const RUNTIME_FIELDS = ["dependencies", "optionalDependencies"] as const;

/**
 * Fields a gated package may not use at all: peer dependencies are resolved by
 * the consumer, outside our lockfile, and bundled dependencies ship code the
 * lockfile never pins.
 */
const FORBIDDEN_FIELDS = [
  "peerDependencies",
  "bundleDependencies",
  "bundledDependencies",
  "imports",
] as const;

const NOBLE = /^@noble\/[a-z0-9][a-z0-9._-]*$/;
/** An exact registry version: no ranges, aliases, protocols or peer suffixes. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** What each gated package may depend on and import at runtime. */
export interface GatedRule {
  /** Gated workspace packages it may depend on (by directory name). */
  readonly workspace: readonly GatedName[];
  /** Whether `node:` built-ins may be imported (never in browser-facing code). */
  readonly nodeBuiltins: boolean;
  /**
   * Published with `vp pack`: its build must be exactly that, and the packed
   * bundle is checked for inlined third-party code.
   */
  readonly packed: boolean;
}

// packages/crypto runs in the ballot client, so it gets no built-ins and no
// workspace imports. The verifier is a CLI too, and may use the other gated
// packages. circuits and contracts get their own rule (wider if they need it)
// in the PRs that scaffold them (P1-17, P1-18); until then the strictest one
// applies, so a dependency of the verifier on them can't leave the gate.
export const RULES: Readonly<Record<GatedName, GatedRule>> = {
  crypto: { workspace: [], nodeBuiltins: false, packed: true },
  circuits: { workspace: [], nodeBuiltins: false, packed: false },
  contracts: { workspace: [], nodeBuiltins: false, packed: false },
  verifier: { workspace: ["crypto", "circuits", "contracts"], nodeBuiltins: true, packed: true },
};

const gatedDir = (name: GatedName) => `packages/${name}`;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `@abolishus/<name>` → `<name>` when it names a gated package. */
function gatedByPackageName(dep: string): GatedName | undefined {
  return GATED_PACKAGES.find((n) => dep === `@abolishus/${n}`);
}

/** Declared runtime dependencies, as name → manifest spec. */
export function runtimeDependencies(manifest: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  for (const field of RUNTIME_FIELDS) {
    for (const [name, spec] of Object.entries(record(manifest[field]) ?? {})) {
      out.set(name, typeof spec === "string" ? spec : JSON.stringify(spec));
    }
  }
  return out;
}

/**
 * Manifest rules: only `@noble/*` from the catalog (pinned to an exact
 * version there) and the gated workspace packages the rule allows, as
 * `workspace:*`. Every other spec (`npm:`, `link:`, `file:`, git, a range,
 * a non-gated `workspace:` package) is rejected.
 */
export function manifestViolations(
  name: GatedName,
  manifest: Record<string, unknown>,
  catalog: Readonly<Record<string, unknown>>,
): string[] {
  const file = `${gatedDir(name)}/package.json`;
  const rule = RULES[name];
  const out: string[] = [];
  for (const field of FORBIDDEN_FIELDS) {
    if (field in manifest) out.push(`${file}: "${field}" is not allowed in a gated package`);
  }
  if (rule.packed && record(manifest["scripts"])?.["build"] !== "vp pack")
    out.push(
      `${file}: the build script must be exactly "vp pack" (the bundle check reproduces it)`,
    );
  for (const field of RUNTIME_FIELDS) {
    if (field in manifest && record(manifest[field]) === undefined)
      out.push(`${file}: "${field}" must be an object`);
  }
  for (const [dep, spec] of runtimeDependencies(manifest)) {
    const ws = gatedByPackageName(dep);
    if (NOBLE.test(dep)) {
      if (spec !== "catalog:") {
        out.push(`${file}: ${dep}: spec must be "catalog:", got ${JSON.stringify(spec)}`);
        continue;
      }
      const pinned = catalog[dep];
      if (typeof pinned !== "string" || !EXACT_VERSION.test(pinned))
        out.push(
          `${file}: ${dep}: the catalog must pin an exact registry version, got ${JSON.stringify(pinned)}`,
        );
    } else if (ws !== undefined && rule.workspace.includes(ws)) {
      if (spec !== "workspace:*")
        out.push(`${file}: ${dep}: spec must be "workspace:*", got ${JSON.stringify(spec)}`);
    } else {
      out.push(
        `${file}: runtime dependency ${dep} is not allowed (only @noble/*${rule.workspace.map((w) => `, @abolishus/${w}`).join("")})`,
      );
    }
  }
  return out;
}

export interface LockfileGraph {
  readonly importers: Record<string, unknown>;
  readonly packages: Record<string, unknown>;
  readonly snapshots: Record<string, unknown>;
}

/**
 * The importers, packages and snapshots of each document of a pnpm v9
 * lockfile. pnpm writes its own install (`packageManagerDependencies`) as a
 * separate first document with its own importers, so documents are kept
 * apart and an importer is read only with the document it is in.
 */
export function lockfileGraphs(lockfile: string): LockfileGraph[] {
  const out: LockfileGraph[] = [];
  for (const doc of parseAllDocuments(lockfile, { uniqueKeys: true }) as Document[]) {
    const problems = [...doc.errors, ...doc.warnings];
    if (problems.length > 0)
      throw new Error(`pnpm-lock.yaml: ${problems[0]?.message ?? "unparseable"}`);
    const js = record(doc.toJS({ maxAliasCount: 0 }));
    if (js === undefined) continue;
    const section = (key: string) => {
      const value = js[key];
      if (value === undefined || value === null) return {};
      const entries = record(value);
      if (entries === undefined) throw new Error(`pnpm-lock.yaml: ${key} must be a mapping`);
      return entries;
    };
    out.push({
      importers: section("importers"),
      packages: section("packages"),
      snapshots: section("snapshots"),
    });
  }
  return out;
}

/**
 * Lockfile rules for one gated importer: its runtime dependencies are exactly
 * the manifest's; each `@noble/*` one is locked to the catalog's exact
 * registry version (never an alias, link, file or peer-suffixed snapshot);
 * each gated workspace one is `link:../<name>`; and the whole transitive
 * closure of the `@noble/*` ones, read from `snapshots:`, is `@noble/*` at
 * exact registry versions with no install-time or peer behaviour.
 */
export function lockfileViolations(
  name: GatedName,
  manifest: Record<string, unknown>,
  graphs: readonly LockfileGraph[],
  catalog: Readonly<Record<string, unknown>>,
): string[] {
  const where = `pnpm-lock.yaml: importers['${gatedDir(name)}']`;
  const holding = graphs.filter((g) => gatedDir(name) in g.importers);
  const graph = holding[0];
  if (graph === undefined || holding.length > 1)
    return [`${where}: must appear in exactly one document, found ${holding.length}`];
  const importer = record(graph.importers[gatedDir(name)]);
  if (importer === undefined) return [`${where}: must be a mapping`];
  const out: string[] = [];
  const declared = runtimeDependencies(manifest);
  const locked = new Map<string, Record<string, unknown> | undefined>();
  for (const field of RUNTIME_FIELDS) {
    for (const [dep, entry] of Object.entries(record(importer[field]) ?? {}))
      locked.set(dep, record(entry));
  }
  for (const dep of declared.keys())
    if (!locked.has(dep)) out.push(`${where}: ${dep} is declared but not locked`);
  const roots: string[] = [];
  for (const [dep, entry] of locked) {
    if (!declared.has(dep)) {
      out.push(`${where}: ${dep} is locked but not declared`);
      continue;
    }
    const version = entry?.["version"];
    const ws = gatedByPackageName(dep);
    if (NOBLE.test(dep)) {
      if (entry?.["specifier"] !== "catalog:" || version !== catalog[dep])
        out.push(
          `${where}: ${dep} must be locked to the catalog version ${JSON.stringify(catalog[dep])}, got ${JSON.stringify(version)}`,
        );
      else roots.push(`${dep}@${String(version)}`);
    } else if (ws !== undefined && version !== `link:../${ws}`) {
      out.push(`${where}: ${dep} must be locked as link:../${ws}, got ${JSON.stringify(version)}`);
    }
  }
  out.push(...closureViolations(roots, graph).map((v) => `${where}: ${v}`));
  return out;
}

/** Snapshot fields a `@noble/*` package in the closure may carry. */
const SNAPSHOT_FIELDS = new Set(["dependencies", "optionalDependencies", "optional"]);
/** Package-metadata fields a `@noble/*` package in the closure may carry. */
const PACKAGE_FIELDS = new Set(["resolution", "engines"]);

/** Walks `snapshots:` from each root; every package reached must be `@noble/*`. */
export function closureViolations(roots: readonly string[], graph: LockfileGraph): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [...roots];
  for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
    if (seen.has(key)) continue;
    seen.add(key);
    const at = key.lastIndexOf("@");
    const dep = key.slice(0, at);
    const version = key.slice(at + 1);
    if (at <= 0 || !NOBLE.test(dep) || !EXACT_VERSION.test(version)) {
      out.push(`closure reaches ${key}, which is not an @noble/* package at an exact version`);
      continue;
    }
    const meta = record(graph.packages[key]);
    const snapshot = record(graph.snapshots[key]);
    if (meta === undefined || snapshot === undefined) {
      out.push(`closure reaches ${key}, which has no packages/snapshots entry`);
      continue;
    }
    for (const field of Object.keys(meta))
      if (!PACKAGE_FIELDS.has(field)) out.push(`${key}: package field "${field}" is not allowed`);
    for (const field of Object.keys(snapshot))
      if (!SNAPSHOT_FIELDS.has(field)) out.push(`${key}: snapshot field "${field}" is not allowed`);
    for (const field of ["dependencies", "optionalDependencies"]) {
      for (const [child, childVersion] of Object.entries(record(snapshot[field]) ?? {}))
        queue.push(`${child}@${String(childVersion)}`);
    }
  }
  return out;
}

/** Every import-like reference in a module, found by walking its ESTree AST. */
export interface ModuleReference {
  /** The specifier, or undefined when it isn't a string literal. */
  readonly specifier: string | undefined;
  readonly kind: string;
}

/**
 * Collects static imports and re-exports, dynamic `import()`, `import("x")`
 * types, `import x = require("x")`, and every `require(...)` call and
 * `import.meta` use (the last two are always violations: they can load or
 * locate code the static graph doesn't show).
 */
export function moduleReferences(program: unknown): ModuleReference[] {
  const out: ModuleReference[] = [];
  const literal = (node: unknown) => {
    const n = record(node);
    return n?.["type"] === "Literal" && typeof n["value"] === "string"
      ? n["value"]
      : n?.["type"] === "TemplateLiteral" &&
          Array.isArray(n["expressions"]) &&
          n["expressions"].length === 0 &&
          Array.isArray(n["quasis"]) &&
          n["quasis"].length === 1
        ? (record(record(n["quasis"][0])?.["value"])?.["cooked"] as string | undefined)
        : undefined;
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const n = record(node);
    if (n === undefined) return;
    switch (n["type"]) {
      case "ImportDeclaration":
      case "ExportAllDeclaration":
      case "ExportNamedDeclaration":
      case "ImportExpression":
        if (n["type"] !== "ExportNamedDeclaration" || n["source"] != null)
          out.push({ specifier: literal(n["source"]), kind: String(n["type"]) });
        break;
      case "TSImportType":
        out.push({ specifier: literal(n["argument"] ?? n["source"]), kind: "TSImportType" });
        break;
      case "TSExternalModuleReference":
        out.push({ specifier: literal(n["expression"]), kind: "TSExternalModuleReference" });
        break;
      case "CallExpression": {
        const callee = record(n["callee"]);
        if (callee?.["type"] === "Identifier" && callee["name"] === "require")
          out.push({ specifier: undefined, kind: "require()" });
        break;
      }
      case "MetaProperty":
        if (record(n["meta"])?.["name"] === "import")
          out.push({ specifier: undefined, kind: "import.meta" });
        break;
    }
    for (const [key, child] of Object.entries(n)) {
      if (key !== "type" && child !== null && typeof child === "object") visit(child);
    }
  };
  visit(program);
  return out;
}

/** The package name of a bare specifier (`@scope/name/sub` → `@scope/name`). */
export function bareName(specifier: string): string | undefined {
  const m = /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:\/.*)?$/.exec(
    specifier,
  );
  return m?.[1];
}

/**
 * Checks one module reference from `file` (repo-relative). Relative
 * specifiers must stay inside `root` (the package's `src`, or the build
 * output directory); bare ones must name a declared runtime dependency the
 * rule allows; `node:` built-ins only where the rule allows. Everything else
 * (non-literal specifiers, `require`, `import.meta`, URLs, absolute paths,
 * `#` subpath imports, un-prefixed built-ins) is rejected.
 */
export function referenceViolation(
  name: GatedName,
  file: string,
  root: string,
  ref: ModuleReference,
  declared: ReadonlyMap<string, string>,
): string | undefined {
  const where = `${file}: ${ref.kind}`;
  const spec = ref.specifier;
  if (spec === undefined) return `${where}: only string-literal static imports are allowed`;
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const resolved = posix.normalize(posix.join(posix.dirname(file), spec));
    return resolved.startsWith(`${root}/`)
      ? undefined
      : `${where} ${JSON.stringify(spec)}: resolves outside ${root}`;
  }
  if (spec.startsWith("node:")) {
    return RULES[name].nodeBuiltins
      ? undefined
      : `${where} ${JSON.stringify(spec)}: node built-ins are not allowed in packages/${name}`;
  }
  const dep = bareName(spec);
  if (dep === undefined) return `${where} ${JSON.stringify(spec)}: not a package specifier`;
  if (!declared.has(dep))
    return `${where} ${JSON.stringify(spec)}: ${dep} is not a declared runtime dependency of packages/${name}`;
  const ws = gatedByPackageName(dep);
  return NOBLE.test(dep) || (ws !== undefined && RULES[name].workspace.includes(ws))
    ? undefined
    : `${where} ${JSON.stringify(spec)}: ${dep} is not allowed in packages/${name}`;
}

/**
 * Tracked symlinks and submodules under a gated directory, from
 * `git ls-files -s -z` (`<mode> <object> <stage>\t<path>`). Either could make
 * a gated path serve code from outside the gate.
 */
export function linkViolations(lsFilesStage: string): string[] {
  const out: string[] = [];
  for (const entry of lsFilesStage.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const mode = entry.slice(0, entry.indexOf(" "));
    const path = entry.slice(tab + 1);
    if (!GATED_PACKAGES.some((n) => path.startsWith(`${gatedDir(n)}/`) || path === gatedDir(n)))
      continue;
    if (mode === "120000") out.push(`${path}: symlinks are not allowed under a gated package`);
    if (mode === "160000") out.push(`${path}: submodules are not allowed under a gated package`);
  }
  return out;
}

/**
 * Source-map sources of a packed build, each relative to its map file. Every
 * one must be the package's own `src`; anything else (above all
 * `node_modules`) is third-party code inlined into the published bundle,
 * where no manifest or lockfile check sees it.
 */
export function inlinedSourceViolations(
  mapFile: string,
  sources: readonly unknown[],
  srcRoot: string,
): string[] {
  return sources.flatMap((source) => {
    if (typeof source !== "string") return [`${mapFile}: non-string source`];
    const resolved = posix.normalize(posix.join(posix.dirname(mapFile), source));
    return resolved.startsWith(`${srcRoot}/`)
      ? []
      : [`${mapFile}: bundle inlines ${source}, which is outside ${srcRoot}`];
  });
}

/**
 * Whether a packed module has code a source map must account for: anything
 * but empty `export {}` statements. A module with code and no map can't be
 * checked for inlined dependencies, so it is a violation.
 */
export function hasCode(program: unknown): boolean {
  const body = record(program)?.["body"];
  if (!Array.isArray(body)) return true;
  return body.some((statement) => {
    const s = record(statement);
    return !(
      s?.["type"] === "ExportNamedDeclaration" &&
      s["declaration"] == null &&
      s["source"] == null &&
      Array.isArray(s["specifiers"]) &&
      s["specifiers"].length === 0
    );
  });
}
