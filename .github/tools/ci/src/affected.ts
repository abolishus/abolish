import { execFileSync } from "node:child_process";

// Selects which workspace packages CI must run a task in for a change set.
//
// `vp run --filter` has no "changed since <ref>" selector, so CI computes the
// changed packages and their workspace dependents here, keeps the ones that
// define the task (vp fails if no selected package has it), and passes one
// `--filter <name>` per package. Anything that is not clearly owned by one package widens the run
// to the whole repo: a false "all" costs minutes, a false "none" lets a broken
// change merge.

export interface WorkspacePackage {
  readonly name: string;
  /** Repo-relative directory, no trailing slash, e.g. "packages/crypto". */
  readonly dir: string;
  /** Names of workspace packages this one depends on (any dependency field). */
  readonly dependsOn: readonly string[];
  /** Script names defined in package.json. */
  readonly scripts: readonly string[];
}

export type Selection =
  | { readonly mode: "all" }
  | { readonly mode: "some"; readonly packages: readonly string[] }
  | { readonly mode: "none" };

/** Paths that never affect any build or test result. */
const INERT = [/^docs\/(?!spec\/)/, /^README\.md$/, /^LICENSE[^/]*$/, /^\.claude\//];

export function selectAffected(
  changedFiles: readonly string[],
  packages: readonly WorkspacePackage[],
): Selection {
  const hit = new Set<string>();
  // Longest directory first so nested packages win over their parents.
  const byDepth = [...packages].sort((a, b) => b.dir.length - a.dir.length);
  for (const file of changedFiles) {
    if (file.length === 0) continue;
    const owner = byDepth.find((p) => file === p.dir || file.startsWith(`${p.dir}/`));
    if (owner !== undefined) {
      hit.add(owner.name);
      continue;
    }
    if (INERT.some((re) => re.test(file))) continue;
    // Root config, lockfile, workflows, docs/spec, unknown paths.
    return { mode: "all" };
  }
  if (hit.size === 0) return { mode: "none" };
  return { mode: "some", packages: [...hit].sort() };
}

/** The selected packages plus everything that transitively depends on them. */
export function withDependents(
  names: readonly string[],
  packages: readonly WorkspacePackage[],
): string[] {
  const out = new Set(names);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of packages) {
      if (!out.has(p.name) && p.dependsOn.some((d) => out.has(d))) {
        out.add(p.name);
        grew = true;
      }
    }
  }
  return [...out].sort();
}

/** Narrows a selection to the packages that must run `task`. */
export function forTask(
  selection: Selection,
  task: string,
  packages: readonly WorkspacePackage[],
): Selection {
  const defines = new Set(packages.filter((p) => p.scripts.includes(task)).map((p) => p.name));
  if (defines.size === 0 || selection.mode === "none") return { mode: "none" };
  if (selection.mode === "all") return selection;
  const run = withDependents(selection.packages, packages).filter((n) => defines.has(n));
  return run.length === 0 ? { mode: "none" } : { mode: "some", packages: run };
}

/** Arguments for `vp run <task>`, e.g. ["-r"] or ["--filter", "a", "--filter", "b"]. */
export function toRunArgs(selection: Selection): string[] {
  switch (selection.mode) {
    case "all":
      return ["-r"];
    case "none":
      return [];
    case "some":
      return selection.packages.flatMap((name) => ["--filter", name]);
  }
}

export const REQUIRED_SCRIPTS = ["build", "test", "check"] as const;

/** One message per workspace package missing a script AGENTS.md requires. */
export function missingRequiredScripts(packages: readonly WorkspacePackage[]): string[] {
  return packages.flatMap((p) => {
    const missing = REQUIRED_SCRIPTS.filter((s) => !p.scripts.includes(s));
    return missing.length === 0
      ? []
      : [`${p.dir}/package.json (${p.name}): missing required scripts: ${missing.join(", ")}`];
  });
}

/**
 * Files changed between the merge base of `base` and HEAD. `-z` with
 * quotePath off keeps non-ASCII names intact, and `--no-renames` lists both
 * sides of a move: otherwise moving a file out of a package would report only
 * its new location and the package would look unaffected.
 */
export function changedFiles(base: string, cwd = process.cwd()): string[] {
  return execFileSync(
    "git",
    ["-c", "core.quotePath=false", "diff", "--no-renames", "--name-only", "-z", `${base}...HEAD`],
    { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  )
    .split("\0")
    .filter((f) => f.length > 0);
}
