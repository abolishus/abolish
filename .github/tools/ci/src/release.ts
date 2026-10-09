// Release selection for release.yml: which packages a `changeset version
// --snapshot next` run turned into `next` prereleases. Pure, so the rules are
// unit-tested; cli.ts reads the manifests (before from git, after from disk).

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
  /** package.json after `changeset version --snapshot next`. */
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
