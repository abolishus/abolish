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
   * Published with `vp pack`: its build must be exactly that, its manifest
   * may point consumers only at `dist`, and the packed bundle is checked for
   * inlined third-party code.
   */
  readonly packed: boolean;
}

/**
 * `node:` built-ins the verifier may import. Not `node:module`, `vm`,
 * `child_process`, `worker_threads` or the like: each can load or run code the
 * import graph doesn't show.
 */
export const VERIFIER_BUILTINS = new Set([
  "node:fs",
  "node:fs/promises",
  "node:path",
  "node:process",
  "node:url",
  "node:util",
]);

/**
 * Names that reach a module loader or evaluator without an import
 * (`process.getBuiltinModule("node:module")`, `createRequire`, `eval`,
 * `new Function`, workers, `process.dlopen` and `process.binding`). Any
 * identifier, property or string literal equal to one of them is rejected; a
 * gated package has no honest use for them. This is a tripwire for the common
 * names, not a sandbox: evaluator gadgets such as a function's `.constructor`,
 * string timers, script elements and WebAssembly are left to review (T-55).
 */
const LOADER_NAMES = new Set([
  "require",
  "createRequire",
  "getBuiltinModule",
  "eval",
  "Function",
  "Worker",
  "SharedWorker",
  "importScripts",
]);

/**
 * Loader names that are also ordinary words (a commitment's "binding"), so
 * they are rejected only as a member access: `process.binding(...)`,
 * `x["dlopen"]`.
 */
const MEMBER_LOADER_NAMES = new Set(["dlopen", "binding", "_linkedBinding"]);

/** Top-level manifest keys a packed gated package may have. */
const PACKED_MANIFEST_KEYS = new Set([
  "name",
  "version",
  "description",
  "license",
  "repository",
  "files",
  "type",
  "exports",
  "publishConfig",
  "scripts",
  "dependencies",
  "optionalDependencies",
  "devDependencies",
  "abolish",
]);

/** Scripts a gated package may define; no lifecycle script runs on install or pack. */
const SCRIPT_NAME = /^(?:build|check|test|test:[a-z0-9-]+)$/;

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
  for (const script of Object.keys(record(manifest["scripts"]) ?? {}))
    if (!SCRIPT_NAME.test(script))
      out.push(`${file}: script "${script}" is not allowed (only build, check, test, test:*)`);
  if (rule.packed) out.push(...packedManifestViolations(file, manifest));
  for (const field of RUNTIME_FIELDS) {
    if (field in manifest && record(manifest[field]) === undefined)
      out.push(`${file}: "${field}" must be an object`);
  }
  const [first, second] = RUNTIME_FIELDS.map((f) => Object.keys(record(manifest[f]) ?? {}));
  for (const dep of first ?? [])
    if (second?.includes(dep))
      out.push(`${file}: ${dep} is listed in more than one dependency field`);
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

/**
 * A packed package must point consumers at its build output and nothing else:
 * otherwise an `exports` condition, `browser` or `bin` field, or an extra
 * `files` entry could ship modules that the src import lint and the bundle
 * check never see.
 */
function packedManifestViolations(file: string, manifest: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of Object.keys(manifest))
    if (!PACKED_MANIFEST_KEYS.has(key))
      out.push(`${file}: "${key}" is not allowed in a published gated package`);
  if (record(manifest["scripts"])?.["build"] !== "vp pack")
    out.push(
      `${file}: the build script must be exactly "vp pack" (the bundle check reproduces it)`,
    );
  if (JSON.stringify(manifest["files"]) !== '["dist"]')
    out.push(`${file}: "files" must be exactly ["dist"]`);
  if (JSON.stringify(manifest["publishConfig"]) !== '{"access":"public"}')
    out.push(`${file}: "publishConfig" must be exactly {"access":"public"}`);
  const exportsMap = record(manifest["exports"]);
  if (exportsMap === undefined) {
    out.push(`${file}: "exports" must be an object`);
    return out;
  }
  for (const [subpath, target] of Object.entries(exportsMap)) {
    if (subpath === "./package.json" && target === "./package.json") continue;
    const conditions = record(target);
    if (!subpath.startsWith(".") || conditions === undefined) {
      out.push(`${file}: exports["${subpath}"] must map the conditions types and default`);
      continue;
    }
    for (const [condition, path] of Object.entries(conditions)) {
      if (condition !== "types" && condition !== "default")
        out.push(`${file}: exports["${subpath}"].${condition}: only types and default are allowed`);
      else if (
        typeof path !== "string" ||
        !/^\.\/dist\/[A-Za-z0-9._/-]+$/.test(path) ||
        path.includes("..")
      )
        out.push(`${file}: exports["${subpath}"].${condition} must be a path under ./dist/`);
    }
  }
  return out;
}

function hasMergeKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasMergeKey);
  const r = record(value);
  return r !== undefined && Object.entries(r).some(([k, v]) => k === "<<" || hasMergeKey(v));
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
    // The yaml library reads `<<` as a plain key; pnpm's parser may merge it.
    if (hasMergeKey(js)) throw new Error("pnpm-lock.yaml: YAML merge keys (<<) are not allowed");
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
 * types, `import x = require("x")`, every `import.meta` use and every
 * identifier, property or string naming a loader or evaluator (LOADER_NAMES).
 * The last two are always violations: they can load or locate code the
 * static graph doesn't show.
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
      case "Identifier":
        if (LOADER_NAMES.has(String(n["name"])))
          out.push({ specifier: undefined, kind: `loader name ${String(n["name"])}` });
        break;
      case "Literal":
      case "TemplateLiteral": {
        // A template with no substitutions is the same string.
        const value = literal(n);
        if (value !== undefined && LOADER_NAMES.has(value))
          out.push({ specifier: undefined, kind: `loader name "${value}"` });
        break;
      }
      case "MemberExpression": {
        const property = record(n["property"]);
        const name =
          n["computed"] === true ? literal(property) : (property?.["name"] as string | undefined);
        if (name !== undefined && MEMBER_LOADER_NAMES.has(name))
          out.push({ specifier: undefined, kind: `loader member .${name}` });
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
    return RULES[name].nodeBuiltins && VERIFIER_BUILTINS.has(spec)
      ? undefined
      : `${where} ${JSON.stringify(spec)}: this node built-in is not allowed in packages/${name}`;
  }
  const dep = bareName(spec);
  if (dep === undefined) return `${where} ${JSON.stringify(spec)}: not a package specifier`;
  // Subpaths are resolved through the package's exports map; `..`, `.` and
  // escapes would lean on that alone to stay inside the package.
  if (
    spec
      .slice(dep.length)
      .split("/")
      .some((seg) => seg === "." || seg === "..") ||
    /[\\%?#]/.test(spec)
  )
    return `${where} ${JSON.stringify(spec)}: subpath must not contain ., .., \\, %, ? or #`;
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
    const gated = GATED_PACKAGES.some(
      (n) => path.startsWith(`${gatedDir(n)}/`) || path === gatedDir(n) || path === "packages",
    );
    if (!gated) continue;
    if (mode === "120000") out.push(`${path}: symlinks are not allowed under a gated package`);
    if (mode === "160000") out.push(`${path}: submodules are not allowed under a gated package`);
  }
  return out;
}

/**
 * Source-map sources of a packed build, each relative to its map file. Every
 * one must be a file of the package's own `src`, and the map's embedded copy
 * of it must equal that file on disk; anything else (above all
 * `node_modules`) is code inlined into the published bundle, where no
 * manifest or lockfile check sees it. `readSource` returns a file's text, or
 * undefined if it doesn't exist.
 */
export function inlinedSourceViolations(
  mapFile: string,
  map: Record<string, unknown>,
  srcRoot: string,
  readSource: (path: string) => string | undefined,
): string[] {
  const { sources, sourcesContent, sourceRoot } = map;
  if (sourceRoot !== undefined && sourceRoot !== "")
    return [`${mapFile}: source maps must not set sourceRoot`];
  if (!Array.isArray(sources)) return [`${mapFile}: source map has no sources list`];
  if (!Array.isArray(sourcesContent) || sourcesContent.length !== sources.length)
    return [`${mapFile}: source map must embed the content of every source`];
  return sources.flatMap((source, i) => {
    if (typeof source !== "string") return [`${mapFile}: non-string source`];
    const resolved = posix.normalize(posix.join(posix.dirname(mapFile), source));
    if (!resolved.startsWith(`${srcRoot}/`))
      return [`${mapFile}: bundle inlines ${source}, which is outside ${srcRoot}`];
    return readSource(resolved) === sourcesContent[i]
      ? []
      : [`${mapFile}: embedded content of ${source} differs from the file in src`];
  });
}

// Extension optional: tsdown's discovery also tries a bare `tsdown.config`.
const CONFIG_FILE = /^(?:vite|vitest|vite-plus|tsdown|rolldown|rollup)\.config(?:\.[^/]*)?$/;

/**
 * Build configuration that `vp pack` could load for a gated package: any
 * config file inside a gated package, or in a directory the build searches
 * on its way up (`packages/` and the repository root), except the root
 * `vite.config.ts`, which CODEOWNERS covers and which may not configure
 * `pack`. A config runs during the build and can rewrite modules and source
 * maps (a `load` or `renderChunk` hook), so it could forge the evidence the
 * bundle check reads; a root `vite.config.js` would even take precedence over
 * the reviewed `.ts` one.
 */
export function buildConfigViolations(trackedFiles: readonly string[]): string[] {
  return trackedFiles
    .filter((f) => {
      const slash = f.lastIndexOf("/");
      const dir = slash === -1 ? "" : f.slice(0, slash);
      if (!CONFIG_FILE.test(f.slice(slash + 1)) || f === "vite.config.ts") return false;
      return (
        dir === "" ||
        dir === "packages" ||
        GATED_PACKAGES.some((n) => f.startsWith(`${gatedDir(n)}/`))
      );
    })
    .map((f) => `${f}: build configuration is not allowed where a gated package's build finds it`);
}

/**
 * Workspace manifests pnpm accepts besides package.json. CI's tooling reads
 * only package.json, so a project defined by one of these (a gated package
 * among them) would escape the required-scripts, affected and gated checks.
 * A tsconfig directly in `packages/` would be what a gated build finds if the
 * package's own one were removed.
 */
export function alternateManifestViolations(trackedFiles: readonly string[]): string[] {
  return trackedFiles
    .filter(
      (f) =>
        /(?:^|\/)package\.(?:yaml|json5)$/.test(f) || /^packages\/tsconfig[^/]*\.json$/.test(f),
    )
    .map((f) => `${f}: not allowed (CI reads only package.json and each package's own tsconfig)`);
}

/** Whether a config module's AST has any property or key named `pack`. */
export function configuresPack(program: unknown): boolean {
  let found = false;
  const visit = (node: unknown): void => {
    if (found || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const n = node as Record<string, unknown>;
    const key = record(n["key"]) ?? record(n["property"]);
    if (key?.["name"] === "pack" || key?.["value"] === "pack") found = true;
    for (const child of Object.values(n)) visit(child);
  };
  visit(program);
  return found;
}

/**
 * compilerOptions that change how imports resolve (path mapping, root
 * merging, plugins), which the bundler honours but the import lint doesn't.
 */
export function tsconfigViolations(file: string, tsconfig: Record<string, unknown>): string[] {
  const options = record(tsconfig["compilerOptions"]) ?? {};
  return [
    // The shared base (CODEOWNERS) sets none of these; another base could.
    ...(tsconfig["extends"] === "../../tsconfig.base.json"
      ? []
      : [`${file}: must extend exactly ../../tsconfig.base.json`]),
    ...["paths", "baseUrl", "rootDirs", "plugins", "customConditions"]
      .filter((key) => key in options)
      .map((key) => `${file}: compilerOptions.${key} is not allowed in a gated package`),
  ];
}

/**
 * Whether a packed module has code a source map must account for: anything
 * but imports and re-exports (whose specifiers the import lint checks). A module with code and no map can't be
 * checked for inlined dependencies, so it is a violation.
 */
export function hasCode(program: unknown): boolean {
  const body = record(program)?.["body"];
  if (!Array.isArray(body)) return true;
  return body.some((statement) => {
    const s = record(statement);
    if (s?.["type"] === "ImportDeclaration" || s?.["type"] === "ExportAllDeclaration") return false;
    return !(s?.["type"] === "ExportNamedDeclaration" && s["declaration"] == null);
  });
}

/**
 * Publishers whose vectors may be vendored, by directory under
 * test-vectors/, with the repositories each may come from. Adding one is a
 * `.github/` change, so the owner reviews it.
 */
export const VECTOR_PUBLISHERS: Readonly<Record<string, readonly string[]>> = {
  // NIST CAVP files, as redistributed unmodified by pyca/cryptography.
  "nist-cavp": ["pyca/cryptography"],
  wycheproof: ["C2SP/wycheproof"],
  noble: ["paulmillr/noble-hashes", "paulmillr/noble-curves", "paulmillr/noble-ciphers"],
  rfc: [],
};

const RAW =
  /^https:\/\/raw\.githubusercontent\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/([0-9a-f]{40})\/([A-Za-z0-9_./-]+)$/;
const RFC = /^https:\/\/www\.rfc-editor\.org\/rfc\/(rfc[0-9]+)\.txt$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The URLs a vendored vector must be fetched from, all of which must serve
 * the manifest's bytes, or why there are none. A GitHub source must be in an
 * allowlisted repository for its directory, pinned to a commit, and named
 * with a tag of that repository: GitHub serves any commit in a repository's
 * fork network under the parent's name, so the commit alone doesn't show the
 * publisher made it, but a tag resolves only against the repository's own
 * refs. An RFC's text is never revised in place; its tag is the RFC name.
 */
export function provenanceUrls(path: string, source: string, tag: string): string[] | string {
  const publisher = path.split("/")[0] ?? "";
  const repos = VECTOR_PUBLISHERS[publisher];
  if (repos === undefined) return `${path}: no allowlisted publisher for directory ${publisher}/`;
  const rfc = RFC.exec(source);
  if (rfc !== null)
    return publisher === "rfc" && tag === rfc[1]
      ? [source]
      : `${path}: an RFC goes under rfc/ with its name as the tag`;
  const raw = RAW.exec(source);
  if (raw === null || source.split("/").includes(".."))
    return `${path}: source must be a raw.githubusercontent.com URL pinned to a full commit hash`;
  const [, repo = "", , file = ""] = raw;
  if (!repos.includes(repo))
    return `${path}: ${repo} is not an allowlisted repository for ${publisher}/`;
  if (!TAG.test(tag)) return `${path}: tag ${JSON.stringify(tag)} is not a tag name`;
  return [source, `https://raw.githubusercontent.com/${repo}/refs/tags/${tag}/${file}`];
}
