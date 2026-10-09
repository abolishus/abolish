// Minimal reader for the `packages:` section of a pnpm v9 lockfile, plus the
// policy CI applies to it.
//
// Policy (threat: supply-chain attack via dependency or lockfile tampering):
// - every package resolution is exactly `{integrity: sha512-…}` (no tarball,
//   git or directory resolutions, no extra keys);
// - no `.npmrc` and no registry override in pnpm-workspace.yaml, so the
//   registry pnpm fetches from is the one the integrity was checked against;
// - every added or changed package's integrity matches what the registry
//   publishes (catches a hand-edited lockfile pointing at other bytes);
// - every added or changed package is at least MIN_AGE_DAYS old.
// The diff is also rendered as Markdown so the review workflows can review it.
// Scope: the `packages:` section, i.e. which bytes can be installed at all.
// `importers:` drift from the manifests is caught by `--frozen-lockfile`;
// `snapshots:` (which already-present version each edge uses) is not checked
// here, so rewiring an edge to another version already in `packages:` passes.

import { isMap, isScalar, parseAllDocuments, parseDocument, type Document, type Node } from "yaml";

export interface LockedPackage {
  /** "name@version" exactly as the lockfile key, without quotes. */
  readonly key: string;
  readonly name: string;
  readonly version: string;
  /** Raw resolution object text, e.g. "{integrity: sha512-...}". */
  readonly resolution: string;
  readonly integrity: string | undefined;
}

export const MIN_AGE_DAYS = 7;

const KEY_LINE = /^ {2}(['"]?)([^'"\s][^'"]*?)\1:\s*$/;
const RESOLUTION_LINE = /^ {4}resolution:(.*)$/;
const FLOW_MAP = /^\s*(\{.*\})\s*$/;
// The only resolution a registry-only policy permits: exactly one key. Anything
// else (extra keys, a decoy like `xintegrity`, tarball, git, directory) leaves
// `integrity` undefined and is rejected by structuralViolations.
const REGISTRY_RESOLUTION = /^\{integrity: (sha512-[A-Za-z0-9+/]{86}==)\}$/;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;

export function splitKey(key: string): { name: string; version: string } {
  const at = key.lastIndexOf("@");
  if (at <= 0) throw new Error(`malformed lockfile package key: ${key}`);
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

export class LockfileParseError extends Error {
  constructor(line: number, reason: string) {
    super(`pnpm-lock.yaml:${line}: ${reason}`);
  }
}

/**
 * Parses every top-level `packages:` section (pnpm may emit several YAML
 * documents). Total by construction: the gate must never pass a package it
 * failed to see, so any shape pnpm does not emit (block-style resolution,
 * flow-style section, comments, odd indentation, a key without a resolution,
 * duplicates) throws instead of being skipped.
 */
export function parsePackages(lockfile: string): Map<string, LockedPackage> {
  const out = new Map<string, LockedPackage>();
  let inPackages = false;
  let current: { key: string; line: number } | undefined;

  const closeCurrent = () => {
    if (current !== undefined && !out.has(current.key)) {
      throw new LockfileParseError(
        current.line,
        `package ${current.key} has no flow-style resolution`,
      );
    }
    current = undefined;
  };

  const lines = lockfile.split("\n");
  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = raw.replace(/\r$/, "");
    if (/^\S/.test(line)) {
      closeCurrent();
      // Top-level lines must be exactly what pnpm writes: a document marker or
      // a bare `key:` / `key: value`. A quoted or explicit (`? key`) spelling of
      // `packages` would otherwise hide the whole section from this parser.
      const top = /^([A-Za-z][A-Za-z0-9]*):(?: (.*))?$/.exec(line.trimEnd());
      if (top === null) {
        if (line.trimEnd() === "---") return;
        throw new LockfileParseError(n, `unexpected top-level line: ${line.trim()}`);
      }
      inPackages = top[1] === "packages" && top[2] === undefined;
      if (top[1] === "packages" && !inPackages && top[2] !== "{}") {
        throw new LockfileParseError(n, "packages section must be a block mapping");
      }
      return;
    }
    if (!inPackages || line.trim() === "") return;
    if (/^\s*#/.test(line)) throw new LockfileParseError(n, "comments are not allowed in packages");
    if (/\t/.test(line.slice(0, line.length - line.trimStart().length))) {
      throw new LockfileParseError(n, "tab indentation");
    }
    const indent = line.length - line.trimStart().length;
    if (indent === 2) {
      closeCurrent();
      const key = KEY_LINE.exec(line);
      if (key === null)
        throw new LockfileParseError(n, `unrecognised package key line: ${line.trim()}`);
      const name = key[2] ?? "";
      if (out.has(name)) throw new LockfileParseError(n, `duplicate package ${name}`);
      current = { key: name, line: n };
      return;
    }
    if (indent < 4 || current === undefined) {
      throw new LockfileParseError(n, `unexpected line outside a package entry: ${line.trim()}`);
    }
    const res = indent === 4 ? RESOLUTION_LINE.exec(line) : null;
    if (res === null) return; // another field of the current package
    const flow = FLOW_MAP.exec(res[1] ?? "");
    if (flow === null)
      throw new LockfileParseError(n, `resolution of ${current.key} must be a flow mapping`);
    if (out.has(current.key))
      throw new LockfileParseError(n, `second resolution for ${current.key}`);
    const resolution = flow[1] ?? "";
    const { name, version } = splitKey(current.key);
    out.set(current.key, {
      key: current.key,
      name,
      version,
      resolution,
      integrity: REGISTRY_RESOLUTION.exec(resolution)?.[1],
    });
  });
  closeCurrent();
  crossCheck(lockfile, out);
  return out;
}

/**
 * Second, independent reading of the same file with a real YAML parser, which
 * sees what pnpm sees whatever the spelling. The two readings must agree
 * exactly on which packages exist and on each resolution, so a shape the line
 * parser misreads is an error rather than a silent pass. Aliases, merge keys
 * and parse warnings are rejected outright.
 */
function crossCheck(lockfile: string, lineParsed: Map<string, LockedPackage>): void {
  const semantic = new Map<string, unknown>();
  for (const doc of parseAllDocuments(lockfile, { uniqueKeys: true }) as Document[]) {
    const problems = [...doc.errors, ...doc.warnings];
    if (problems.length > 0)
      throw new LockfileParseError(0, `YAML: ${problems[0]?.message ?? "unknown"}`);
    let js: unknown;
    try {
      js = doc.toJS({ maxAliasCount: 0 });
    } catch (e) {
      throw new LockfileParseError(0, `YAML: ${(e as Error).message}`);
    }
    if (js === null || typeof js !== "object") continue;
    const packages = (js as Record<string, unknown>)["packages"];
    if (packages === undefined || packages === null) continue; // absent or empty section
    if (packages === null || typeof packages !== "object" || Array.isArray(packages)) {
      throw new LockfileParseError(0, "packages must be a mapping");
    }
    for (const [key, entry] of Object.entries(packages)) {
      if (semantic.has(key))
        throw new LockfileParseError(0, `duplicate package ${key} across documents`);
      semantic.set(key, (entry as { resolution?: unknown } | null)?.resolution);
    }
  }
  const lineKeys = [...lineParsed.keys()].sort();
  const yamlKeys = [...semantic.keys()].sort();
  if (lineKeys.length !== yamlKeys.length || lineKeys.some((k, i) => k !== yamlKeys[i])) {
    const missing = yamlKeys.filter((k) => !lineParsed.has(k)).slice(0, 5);
    throw new LockfileParseError(
      0,
      `parsers disagree on the package set (unseen by the line parser: ${missing.join(", ") || "none"})`,
    );
  }
  for (const [key, pkg] of lineParsed) {
    const res = semantic.get(key);
    const keys = res !== null && typeof res === "object" ? Object.keys(res) : [];
    const integrity = (res as { integrity?: unknown } | undefined)?.integrity;
    const semanticIntegrity =
      keys.length === 1 && typeof integrity === "string" && SHA512.test(integrity)
        ? integrity
        : undefined;
    const agrees = semanticIntegrity === pkg.integrity;
    if (!agrees) throw new LockfileParseError(0, `parsers disagree on the resolution of ${key}`);
  }
}

export interface LockfileDiff {
  readonly added: readonly LockedPackage[];
  readonly removed: readonly LockedPackage[];
  /** Same key, different resolution. Always suspicious: versions are immutable. */
  readonly changed: readonly LockedPackage[];
}

export function diffPackages(
  base: Map<string, LockedPackage>,
  head: Map<string, LockedPackage>,
): LockfileDiff {
  const added: LockedPackage[] = [];
  const changed: LockedPackage[] = [];
  const removed: LockedPackage[] = [];
  for (const [key, pkg] of head) {
    const before = base.get(key);
    if (before === undefined) added.push(pkg);
    else if (before.resolution !== pkg.resolution) changed.push(pkg);
  }
  for (const [key, pkg] of base) if (!head.has(key)) removed.push(pkg);
  const byKey = (a: LockedPackage, b: LockedPackage) => (a.key < b.key ? -1 : 1);
  return { added: added.sort(byKey), removed: removed.sort(byKey), changed: changed.sort(byKey) };
}

/** Structural violations that need no network. */
export function structuralViolations(head: Map<string, LockedPackage>): string[] {
  const out: string[] = [];
  for (const pkg of head.values()) {
    if (pkg.integrity === undefined) {
      out.push(
        `${pkg.key}: resolution must be exactly {integrity: sha512-…}, got ${pkg.resolution}`,
      );
    }
  }
  return out;
}

export interface RegistryFacts {
  /** Whether the registry lists this version at all. */
  readonly exists: boolean;
  /** dist.integrity published for this version (absent for pre-SRI publishes). */
  readonly integrity: string | undefined;
  /** ISO publish time for this version. */
  readonly published: string | undefined;
}

export function registryViolations(
  pkg: LockedPackage,
  facts: RegistryFacts,
  now: Date,
  minAgeDays = MIN_AGE_DAYS,
): string[] {
  const out: string[] = [];
  if (!facts.exists) {
    out.push(`${pkg.key}: version not found on the npm registry`);
    return out;
  }
  if (facts.integrity === undefined) {
    out.push(
      `${pkg.key}: the registry publishes no sha512 integrity for this version (pre-SRI publish); the policy requires sha512`,
    );
    return out;
  }
  if (facts.integrity !== pkg.integrity) {
    out.push(`${pkg.key}: lockfile integrity ${pkg.integrity} != registry ${facts.integrity}`);
  }
  if (facts.published === undefined) {
    out.push(`${pkg.key}: registry has no publish time`);
  } else {
    const ageDays = (now.getTime() - Date.parse(facts.published)) / 86_400_000;
    if (!(ageDays >= minAgeDays)) {
      out.push(`${pkg.key}: published ${facts.published}, younger than ${minAgeDays} days`);
    }
  }
  return out;
}

export function renderDiff(diff: LockfileDiff): string {
  if (diff.added.length + diff.removed.length + diff.changed.length === 0) {
    return "No lockfile package changes.\n";
  }
  const lines = ["## Lockfile changes", ""];
  const section = (title: string, list: readonly LockedPackage[]) => {
    if (list.length === 0) return;
    lines.push(`### ${title} (${list.length})`, "");
    for (const p of list) lines.push(`- \`${p.key}\``);
    lines.push("");
  };
  section("Added", diff.added);
  section("Changed resolution", diff.changed);
  section("Removed", diff.removed);
  return lines.join("\n");
}

/**
 * Settings that would make pnpm fetch from somewhere other than the npm
 * registry the integrity was checked against. Any `.npmrc` (tracked anywhere)
 * and any registry, auth-file or scoped-registry key in pnpm-workspace.yaml is
 * a violation; an unparseable workspace file is too.
 */
export function registryOverrides(
  trackedFiles: readonly string[],
  workspaceYaml: string,
): string[] {
  const out = trackedFiles
    .filter((f) => f === ".npmrc" || f.endsWith("/.npmrc"))
    .map(
      (f) =>
        `${f}: .npmrc files are not allowed (registry and auth config would bypass the lockfile policy)`,
    );
  const doc = parseDocument(workspaceYaml, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    out.push(`pnpm-workspace.yaml: does not parse: ${doc.errors[0]?.message ?? "unknown error"}`);
    return out;
  }
  const settings = doc.toJS() as unknown;
  if (settings !== null && typeof settings === "object") {
    for (const key of Object.keys(settings)) {
      if (/registr|npmrc/i.test(key))
        out.push(`pnpm-workspace.yaml: setting "${key}" is not allowed`);
    }
  }
  return out;
}

/**
 * AGENTS.md: install scripts run only for packages in `allowBuilds`, and each
 * entry needs a justification comment (on the line above, or trailing).
 */
export function unjustifiedAllowBuilds(workspaceYaml: string): string[] {
  const doc = parseDocument(workspaceYaml, { uniqueKeys: true });
  if (doc.errors.length > 0)
    return [`pnpm-workspace.yaml: does not parse: ${doc.errors[0]?.message ?? "unknown error"}`];
  const allow = doc.get("allowBuilds", true) as Node | undefined;
  if (allow === undefined) return [];
  if (!isMap(allow)) return ["pnpm-workspace.yaml: allowBuilds must be a mapping"];
  return allow.items.flatMap((pair, i) => {
    const key = pair.key as Node | null;
    const value = pair.value as Node | null;
    const name = isScalar(key) ? String(key.value) : "?";
    const justified =
      (key?.commentBefore ?? "").trim() !== "" ||
      (value?.comment ?? "").trim() !== "" ||
      (i === 0 && (allow.commentBefore ?? "").trim() !== "");
    return justified
      ? []
      : [`pnpm-workspace.yaml: allowBuilds entry "${name}" needs a justification comment`];
  });
}
