// Release selection for release.yml. A separate job runs `changeset version
// --snapshot next` (third-party code, configured from the ungated `.changeset/`)
// and reports the versions it produced. Those reports are untrusted: the build
// jobs check out afresh, never run Changesets, and apply only versions these
// rules accept, by rewriting the `version` field and nothing else. So nothing
// outside the gated sources and this CODEOWNERS-protected file decides the
// bytes that get built, signed and published (T-61, T-57). Pure, so the rules
// are unit-tested; cli.ts does the I/O.

/**
 * The only packages release.yml may publish (AGENTS.md, Architecture → Rules).
 * Adding one needs this file changed, so the owner reviews it (CODEOWNERS).
 */
export const PUBLISHED_PACKAGES = new Map([
  ["@abolishus/crypto", "packages/crypto"],
  ["@abolishus/verifier", "packages/verifier"],
  ["@abolishus/sdk", "packages/sdk"],
]);

export interface ReleaseCandidate {
  dir: string;
  /** package.json at the commit being released; undefined for a new package. */
  before: Record<string, unknown> | undefined;
  /** package.json with the version `changeset version --snapshot next` proposed. */
  after: Record<string, unknown>;
}

export interface Release {
  dir: string;
  name: string;
  version: string;
}

/**
 * Packages to publish, or the reasons none may be. Every version a snapshot
 * produces has the form `<x.y.z>-next-<commit>`. Anything else (a plain
 * release version, which only the owner cuts, or another commit's snapshot)
 * is refused rather than published. T-61.
 */
export function snapshotReleases(
  candidates: readonly ReleaseCandidate[],
  commit: string,
): { releases: Release[]; errors: string[] } {
  const releases: Release[] = [];
  const errors: string[] = [];
  if (!/^[0-9a-f]{40}$/.test(commit))
    return { releases, errors: [`not a full commit SHA: ${JSON.stringify(commit)}`] };
  const snapshot = new RegExp(
    `^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)-next-${commit}$`,
  );
  for (const { dir, before, after } of candidates) {
    const { name, version } = after;
    if (after["private"] === true) {
      if (before !== undefined && before["version"] !== version)
        errors.push(`${dir}: private package ${String(name)} was versioned`);
      continue;
    }
    if (typeof name !== "string" || typeof version !== "string") {
      errors.push(`${dir}/package.json: name and version must be strings`);
      continue;
    }
    if (PUBLISHED_PACKAGES.get(name) !== dir) {
      errors.push(
        `${dir}: ${name} is not private and not a published package at its expected path; mark it private or add it to PUBLISHED_PACKAGES`,
      );
      continue;
    }
    if (before?.["name"] !== name) {
      errors.push(`${dir}: package name changed during versioning`);
      continue;
    }
    if (before["version"] === version) continue;
    if (!snapshot.test(version)) {
      errors.push(`${dir}: ${name}@${version} is not a next snapshot of ${commit}`);
      continue;
    }
    if (after["license"] !== "Apache-2.0") {
      errors.push(`${dir}: ${name} must be Apache-2.0`);
      continue;
    }
    // publishConfig can redirect the registry or set a dist-tag; npm gives
    // the CLI's `--tag next` precedence today, but nothing here relies on it.
    if (JSON.stringify(after["publishConfig"]) !== JSON.stringify({ access: "public" })) {
      errors.push(`${dir}: ${name} publishConfig must be exactly {"access":"public"}`);
      continue;
    }
    releases.push({ dir, name, version });
  }
  releases.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { releases, errors };
}

/**
 * Parses the version job's `<dir> <version>` lines. Every dir must be a
 * workspace package and appear at most once; the versions themselves are
 * judged later by snapshotReleases.
 */
export function proposedVersions(
  text: string,
  dirs: readonly string[],
): { versions: Map<string, string>; errors: string[] } {
  const versions = new Map<string, string>();
  const errors: string[] = [];
  const known = new Set(dirs);
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const m = /^(\S+) (\S+)$/.exec(line);
    if (m === null) {
      errors.push(`malformed version line ${JSON.stringify(line)}`);
      continue;
    }
    const [, dir = "", version = ""] = m;
    if (!known.has(dir)) errors.push(`${dir}: not a workspace package`);
    else if (versions.has(dir)) errors.push(`${dir}: listed twice`);
    else versions.set(dir, version);
  }
  return { versions, errors };
}

/**
 * The manifest text with only its top-level `version` value replaced, or
 * undefined if that can't be done unambiguously. The result must parse to the
 * original object with nothing but `version` changed.
 */
export function setVersion(text: string, version: string): string | undefined {
  const before = JSON.parse(text) as Record<string, unknown>;
  if (typeof before["version"] !== "string") return undefined;
  const field = new RegExp(`^  "version": ${escape(JSON.stringify(before["version"]))},$`, "gm");
  if ((text.match(field) ?? []).length !== 1) return undefined;
  const out = text.replace(field, () => `  "version": ${JSON.stringify(version)},`);
  const after = JSON.parse(out) as Record<string, unknown>;
  return JSON.stringify(after) === JSON.stringify({ ...before, version }) ? out : undefined;
}

function escape(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lifecycle scripts npm runs on every consumer's install. */
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];

/** The file name `pnpm pack` gives a release's tarball. */
export function tarballName(r: { name: string; version: string }): string {
  return `${r.name.replace(/^@/, "").replace("/", "-")}-${r.version}.tgz`;
}

/** Every path a manifest's entry points name: exports (with fallbacks), main, module, types, bin. */
export function entryPoints(manifest: Record<string, unknown>): unknown[] {
  const out: unknown[] = [];
  const walk = (x: unknown): void => {
    if (x === null || x === undefined) return;
    if (Array.isArray(x)) x.forEach(walk);
    else if (typeof x === "object") Object.values(x).forEach(walk);
    else out.push(x);
  };
  walk(manifest["exports"]);
  for (const f of ["main", "module", "types", "typings"])
    if (manifest[f] !== undefined) out.push(manifest[f]);
  walk(manifest["bin"]);
  return out;
}

/** A tarball entry: its `tar -tv` type character (`-` file, `d` directory, ...) and path. */
export interface TarEntry {
  type: string;
  path: string;
}

/**
 * Checks a packed tarball (its package.json and entries): what npm publishes
 * and consumers install, not the workspace manifest it was packed from.
 */
export function shippedErrors(
  manifest: Record<string, unknown>,
  entries: readonly TarEntry[],
  release: Release,
): string[] {
  const errors: string[] = [];
  const at = `${release.name}@${release.version} tarball`;
  // npm strips the first path segment whatever its name, and a later entry
  // wins, so a second `x/package.json` would be what gets installed. Only
  // plain files and directories under `package/`, each once.
  const seen = new Set<string>();
  for (const { type, path } of entries) {
    if (type !== "-" && type !== "d")
      errors.push(`${at}: ${path} is not a regular file or directory`);
    if (!path.startsWith("package/") || path.split("/").includes(".."))
      errors.push(`${at}: entry ${JSON.stringify(path)} is outside package/`);
    if (seen.has(path)) errors.push(`${at}: ${path} appears twice`);
    seen.add(path);
  }
  const files = entries.filter((e) => e.type === "-").map((e) => e.path);
  if (manifest["name"] !== release.name || manifest["version"] !== release.version)
    errors.push(`${at}: ships as ${String(manifest["name"])}@${String(manifest["version"])}`);
  if (manifest["private"] !== undefined) errors.push(`${at}: has a private field`);
  if (manifest["license"] !== "Apache-2.0") errors.push(`${at}: license must be Apache-2.0`);
  if (JSON.stringify(manifest["publishConfig"]) !== JSON.stringify({ access: "public" }))
    errors.push(`${at}: publishConfig must be exactly {"access":"public"}`);
  const scripts = (manifest["scripts"] ?? {}) as Record<string, unknown>;
  for (const s of INSTALL_SCRIPTS)
    if (s in scripts) errors.push(`${at}: runs a ${s} script on consumers' machines`);
  // npm runs `node-gyp rebuild` on install for a package with a binding.gyp.
  if (files.includes("package/binding.gyp") || "gypfile" in manifest)
    errors.push(`${at}: builds native code on consumers' machines (binding.gyp)`);
  for (const f of ["bundleDependencies", "bundledDependencies"])
    if (f in manifest) errors.push(`${at}: ${f} ships third-party code inside the tarball`);
  const shipped = new Set(files);
  for (const target of entryPoints(manifest)) {
    if (typeof target !== "string" || target.includes("*")) {
      errors.push(`${at}: unsupported entry point ${JSON.stringify(target)}`);
      continue;
    }
    if (!shipped.has(`package/${target.replace(/^\.\//, "")}`))
      errors.push(`${at}: entry point ${target} is not in the tarball`);
  }
  return errors;
}

/**
 * The release as both builds produced it: exactly one tarball per planned
 * package and nothing else in each build, byte-identical across the two.
 * `a` and `b` map file name to sha256.
 */
export function reproducedErrors(
  plan: readonly Release[],
  a: ReadonlyMap<string, string>,
  b: ReadonlyMap<string, string>,
): string[] {
  const expected = plan.map(tarballName).sort();
  const errors: string[] = [];
  for (const [label, files] of [
    ["a", a],
    ["b", b],
  ] as const) {
    const actual = [...files.keys()].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      errors.push(
        `build ${label} produced ${actual.join(", ") || "nothing"}; the plan is ${expected.join(", ") || "empty"}`,
      );
  }
  for (const name of expected)
    if (a.has(name) && a.get(name) !== b.get(name))
      errors.push(`${name} differs between builds a and b; the release is not reproducible`);
  return errors;
}
