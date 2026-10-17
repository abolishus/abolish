// Child process for `cli.ts ballot`: builds apps/ballot with its own Vite
// config and writes, for each build, the chunks it emitted and the module ids
// it resolved. The config is code the PR under review controls, so it runs
// here and never in the process that judges the result (T-59); the report it
// writes is a hint, not evidence. Vite bundles each Web Worker in a build of
// its own that runs only `worker.plugins`, so a collector goes there too:
// without it, whatever a worker imports would never reach the report, and
// the prover worker's code couldn't be told from the page's.
//
//   vp node .github/tools/ci/src/ballot-build.ts <outDir> <reportFile>

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { build, type Plugin } from "vite-plus";

const [outDir, reportFile] = process.argv.slice(2);
if (outDir === undefined || reportFile === undefined) {
  console.error("usage: ballot-build.ts <outDir> <reportFile>");
  process.exit(2);
}
const builds: { worker: boolean; chunks: string[]; modules: string[] }[] = [];
const collect = (worker: boolean): Plugin => {
  const report = { worker, chunks: [] as string[], modules: [] as string[] };
  builds.push(report);
  return {
    name: "abolish-ci-collect-module-ids",
    buildEnd() {
      report.modules.push(...this.getModuleIds());
    },
    generateBundle(_, bundle) {
      for (const output of Object.values(bundle))
        if (output.type === "chunk") report.chunks.push(output.fileName);
    },
  };
};
await build({
  root: resolve("apps/ballot"),
  mode: "production",
  logLevel: "warn",
  build: { outDir, emptyOutDir: true },
  plugins: [collect(false)],
  // Vite appends these to the config's own worker plugins, once per worker.
  worker: { plugins: () => [collect(true)] },
});
writeFileSync(reportFile, JSON.stringify(builds));
