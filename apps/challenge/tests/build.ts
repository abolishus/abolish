// Builds the page for a deployment into a directory of its own, with the
// app's own settings (`page-build.ts`) and nothing from `vite.config.ts`, so
// a test can pin a site key and entry points staging doesn't have.

import { join, relative } from "node:path";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { build, type Rollup } from "vite-plus";

import { pageBuild } from "../page-build.ts";
import type { ChallengeDeployment } from "../src/deployment.ts";

export const root = fileURLToPath(new URL("..", import.meta.url));

/** A deployment with Cloudflare's always-passing test site key. */
export const TEST: ChallengeDeployment = {
  siteKey: "1x00000000000000000000AA",
  entryPoints: ["https://ballot.test", "https://ballot-2.test:8443"],
};

/** The modules bundled and the files written, relative to `outDir`. */
export async function buildPage(
  deployment: ChallengeDeployment,
  outDir: string,
): Promise<{ modules: string[]; files: string[] }> {
  const config = pageBuild(deployment);
  const out = (await build({
    ...config,
    root,
    configFile: false,
    logLevel: "silent",
    mode: "production",
    build: { ...config.build, outDir, emptyOutDir: true },
  })) as Rollup.RollupOutput;
  const modules = out.output.flatMap((chunk) =>
    chunk.type === "chunk" ? Object.keys(chunk.modules) : [],
  );
  const entries = await readdir(outDir, { withFileTypes: true, recursive: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => relative(outDir, join(e.parentPath, e.name)))
    .sort();
  return { modules, files };
}
