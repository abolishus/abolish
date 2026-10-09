// CI entry point. Run with `vp node .github/tools/ci/src/cli.ts <command>` from the repo root.
//
//   affected (--base <ref> | --all) --task <name>
//                           print `vp run <name>` selection args for packages changed
//                           since <ref> (and their dependents) that define the task
//   actions-pinned          fail if any workflow uses an action not pinned by SHA
//   lockfile --base <ref>   enforce lockfile policy, write the diff to lockfile-diff.md

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findUnpinned } from "./actions-pinned.ts";
import { forTask, selectAffected, toRunArgs, type WorkspacePackage } from "./affected.ts";
import {
  diffPackages,
  parsePackages,
  registryViolations,
  renderDiff,
  structuralViolations,
  type LockedPackage,
  type RegistryFacts,
} from "./lockfile.ts";

const WORKSPACE_GLOBS = ["apps", "packages", "tools", ".github/tools"];

function git(...args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const value = i === -1 ? undefined : process.argv[i + 1];
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
}

function output(name: string, value: string): void {
  const file = process.env["GITHUB_OUTPUT"];
  if (file !== undefined) appendFileSync(file, `${name}=${value}\n`);
}

function summary(markdown: string): void {
  const file = process.env["GITHUB_STEP_SUMMARY"];
  if (file !== undefined) appendFileSync(file, `${markdown}\n`);
}

function workspacePackages(): WorkspacePackage[] {
  const out: WorkspacePackage[] = [];
  for (const root of WORKSPACE_GLOBS) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = `${root}/${entry.name}`;
      const manifest = join(dir, "package.json");
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
      if (typeof pkg["name"] !== "string") throw new Error(`${manifest} has no name`);
      const deps = [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ].flatMap((field) =>
        Object.entries((pkg[field] ?? {}) as Record<string, string>)
          .filter(([, spec]) => spec.startsWith("workspace:"))
          .map(([name]) => name),
      );
      out.push({
        name: pkg["name"],
        dir,
        dependsOn: deps,
        scripts: Object.keys((pkg["scripts"] ?? {}) as Record<string, string>),
      });
    }
  }
  return out;
}

function affected(): void {
  const task = arg("--task");
  const packages = workspacePackages();
  const changed = process.argv.includes("--all")
    ? undefined
    : git("diff", "--name-only", `${arg("--base")}...HEAD`).split("\n");
  const affectedSelection =
    changed === undefined ? ({ mode: "all" } as const) : selectAffected(changed, packages);
  const selection = forTask(affectedSelection, task, packages);
  const args = toRunArgs(selection);
  output("mode", selection.mode);
  output("args", args.join(" "));
  summary(`\`${task}\`: \`${selection.mode}\` ${args.join(" ")}`);
  process.stdout.write(`${args.join(" ")}\n`);
}

function actionsPinned(): void {
  const violations = [".github/workflows", ".github/actions"]
    .filter((d) => existsSync(d))
    .flatMap((d) =>
      readdirSync(d, { recursive: true, encoding: "utf8" })
        .filter((f) => /\.ya?ml$/.test(f))
        .flatMap((f) => findUnpinned(join(d, f), readFileSync(join(d, f), "utf8"))),
    );
  for (const v of violations) console.error(`${v.file}:${v.line}: ${v.uses}: ${v.reason}`);
  if (violations.length > 0) process.exit(1);
  console.log("all actions pinned by commit SHA");
}

async function registryFacts(
  pkg: LockedPackage,
  cache: Map<string, Promise<unknown>>,
): Promise<RegistryFacts> {
  let doc = cache.get(pkg.name);
  if (doc === undefined) {
    const url = `https://registry.npmjs.org/${pkg.name.replace("/", "%2F")}`;
    doc = fetch(url).then(async (r) => {
      if (r.status === 404) return undefined;
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return r.json();
    });
    cache.set(pkg.name, doc);
  }
  const packument = (await doc) as
    | {
        time?: Record<string, string>;
        versions?: Record<string, { dist?: { integrity?: string } }>;
      }
    | undefined;
  return {
    integrity: packument?.versions?.[pkg.version]?.dist?.integrity,
    published: packument?.time?.[pkg.version],
  };
}

async function lockfile(): Promise<void> {
  const base = arg("--base");
  let baseText = "";
  try {
    baseText = git("show", `${base}:pnpm-lock.yaml`);
  } catch {
    // No lockfile on the base branch: every package counts as added.
  }
  const head = parsePackages(readFileSync("pnpm-lock.yaml", "utf8"));
  const diff = diffPackages(parsePackages(baseText), head);
  const markdown = renderDiff(diff);
  writeFileSync("lockfile-diff.md", markdown);
  summary(markdown);

  const violations = structuralViolations(head);
  const cache = new Map<string, Promise<unknown>>();
  const now = new Date();
  const toCheck = [...diff.added, ...diff.changed];
  for (let i = 0; i < toCheck.length; i += 16) {
    const batch = toCheck.slice(i, i + 16);
    const results = await Promise.all(
      batch.map(async (pkg) => registryViolations(pkg, await registryFacts(pkg, cache), now)),
    );
    violations.push(...results.flat());
  }
  for (const v of violations) console.error(v);
  console.log(
    `${head.size} packages; +${diff.added.length} ~${diff.changed.length} -${diff.removed.length}`,
  );
  if (violations.length > 0) process.exit(1);
}

const command = process.argv[2];
switch (command) {
  case "affected":
    affected();
    break;
  case "actions-pinned":
    actionsPinned();
    break;
  case "lockfile":
    await lockfile();
    break;
  default:
    console.error(`unknown command: ${command ?? "(none)"}`);
    process.exit(2);
}
