// Minimal, dependency-free reader for the `packages:` section of a pnpm v9
// lockfile, plus the policy CI applies to it.
//
// Policy (threat: supply-chain attack via dependency or lockfile tampering):
// - every package resolves from the npm registry with a sha512 integrity hash
//   (no tarball URLs, git or directory resolutions);
// - every added or changed package's integrity matches what the registry
//   publishes (catches a hand-edited lockfile pointing at other bytes);
// - every added or changed package is at least MIN_AGE_DAYS old.
// The diff is also rendered as Markdown so the review workflows can review it.

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

const KEY_LINE = /^ {2}('?)(.+?)\1:\s*$/;
const RESOLUTION_LINE = /^ {4}resolution:\s*(\{.*\})\s*$/;
const INTEGRITY = /integrity:\s*(sha512-[A-Za-z0-9+/]+={0,2})/;

export function splitKey(key: string): { name: string; version: string } {
  const at = key.lastIndexOf("@");
  if (at <= 0) throw new Error(`malformed lockfile package key: ${key}`);
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

/** Parses every top-level `packages:` section (pnpm may emit several YAML documents). */
export function parsePackages(lockfile: string): Map<string, LockedPackage> {
  const out = new Map<string, LockedPackage>();
  let inPackages = false;
  let current: string | undefined;
  for (const line of lockfile.split("\n")) {
    if (/^\S/.test(line)) {
      inPackages = line.trimEnd() === "packages:";
      current = undefined;
      continue;
    }
    if (!inPackages) continue;
    const key = KEY_LINE.exec(line);
    if (key !== null) {
      current = key[2];
      continue;
    }
    const res = RESOLUTION_LINE.exec(line);
    if (res !== null && current !== undefined) {
      const resolution = res[1] ?? "";
      const { name, version } = splitKey(current);
      out.set(current, {
        key: current,
        name,
        version,
        resolution,
        integrity: INTEGRITY.exec(resolution)?.[1],
      });
      current = undefined;
    }
  }
  return out;
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
    if (pkg.integrity === undefined || /tarball:|type:\s*git|directory:/.test(pkg.resolution)) {
      out.push(
        `${pkg.key}: resolution must be a registry package with sha512 integrity, got ${pkg.resolution}`,
      );
    }
  }
  return out;
}

export interface RegistryFacts {
  /** dist.integrity published for this version, undefined if the version does not exist. */
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
  if (facts.integrity === undefined) {
    out.push(`${pkg.key}: version not found on the npm registry`);
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
