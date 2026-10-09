// CI entry point. Run with `vp node .github/tools/ci/src/cli.ts <command>` from the repo root.
//
//   affected (--base <ref> | --all) --task <name>
//                           print `vp run <name>` selection args for packages changed
//                           since <ref> (and their dependents) that define the task
//   actions-pinned          fail if any workflow uses an action not pinned by SHA
//   lockfile --base <ref>   enforce lockfile policy, write the diff to lockfile-diff.md
//   pnpm-selftest           prove the pinned pnpm honours our install-script policy

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { findUnpinned } from "./actions-pinned.ts";
import { forTask, selectAffected, toRunArgs, type WorkspacePackage } from "./affected.ts";
import {
  diffPackages,
  parsePackages,
  registryViolations,
  registryOverrides,
  renderDiff,
  structuralViolations,
  type LockedPackage,
  type RegistryFacts,
  unjustifiedAllowBuilds,
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
    : git(
        "-c",
        "core.quotePath=false",
        "diff",
        "--name-only",
        "-z",
        `${arg("--base")}...HEAD`,
      ).split("\0");
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
  for (const v of violations) console.error(`${v.file}: ${v.path}: ${v.value}: ${v.reason}`);
  if (violations.length > 0) process.exit(1);
  console.log("all actions pinned by commit SHA and all images by digest");
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
  if (head.size === 0) {
    console.error("pnpm-lock.yaml: no packages parsed; refusing to pass an empty lockfile");
    process.exit(1);
  }
  const diff = diffPackages(parsePackages(baseText), head);
  const markdown = renderDiff(diff);
  writeFileSync("lockfile-diff.md", markdown);
  summary(markdown);

  const violations = [
    ...registryOverrides(
      git("ls-files", "-z").split("\0"),
      readFileSync("pnpm-workspace.yaml", "utf8"),
    ),
    ...unjustifiedAllowBuilds(readFileSync("pnpm-workspace.yaml", "utf8")),
    ...structuralViolations(head),
  ];
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

// Settings that only make sense for this workspace; everything else (the
// supply-chain policy) is copied into the self-test project verbatim.
const WORKSPACE_ONLY = new Set([
  "packages",
  "catalog",
  "catalogs",
  "catalogMode",
  "overrides",
  "peerDependencyRules",
]);
// An old, well-known package whose install runs a postinstall script.
const SCRIPTED_DEPENDENCY = { esbuild: "0.25.0" };

function install(dir: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync("vp", ["install"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/**
 * The install-script policy is configuration only, so prove the pinned pnpm
 * enforces it: (1) with our settings, installing a package that has a
 * postinstall script must fail as an unapproved build; (2) an unknown setting
 * must be rejected, which shows pnpm validates every key, so the keys our real
 * installs accept are recognised rather than silently ignored.
 */
function pnpmSelftest(): void {
  const settings = parseDocument(readFileSync("pnpm-workspace.yaml", "utf8")).toJS() as Record<
    string,
    unknown
  >;
  const policy = Object.fromEntries(
    Object.entries(settings).filter(([k]) => !WORKSPACE_ONLY.has(k)),
  );
  const root = JSON.parse(readFileSync("package.json", "utf8")) as { devEngines?: unknown };
  const dir = mkdtempSync(join(tmpdir(), "pnpm-selftest-"));
  const failures: string[] = [];
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "pnpm-selftest",
        private: true,
        devEngines: root.devEngines,
        dependencies: SCRIPTED_DEPENDENCY,
      }),
    );
    writeFileSync(join(dir, "pnpm-workspace.yaml"), JSON.stringify(policy));
    const scripted = install(dir);
    if (scripted.ok || !/Ignored build scripts/.test(scripted.output)) {
      failures.push(
        `install with a postinstall dependency did not fail as an unapproved build:\n${scripted.output}`,
      );
    }
    writeFileSync(
      join(dir, "pnpm-workspace.yaml"),
      JSON.stringify({ ...policy, abolishSelftestUnknownSetting: true }),
    );
    const unknown = install(dir);
    if (unknown.ok || !/UNRECOGNIZED_WORKSPACE_SETTINGS/.test(unknown.output)) {
      failures.push(`pnpm accepted an unknown workspace setting:\n${unknown.output}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const f of failures) console.error(f);
  if (failures.length > 0) process.exit(1);
  console.log(
    `pnpm enforces the policy: unapproved build scripts fail the install; unknown settings are rejected (${Object.keys(policy).join(", ")})`,
  );
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
  case "pnpm-selftest":
    pnpmSelftest();
    break;
  default:
    console.error(`unknown command: ${command ?? "(none)"}`);
    process.exit(2);
}
