// Child process for `cli.ts ballot`: builds apps/ballot with its own Vite
// config and writes the module ids the build resolved. The config is code the
// PR under review controls, so it runs here and never in the process that
// judges the result (T-59); the ids it writes are a hint, not evidence.
//
//   vp node .github/tools/ci/src/ballot-build.ts <outDir> <idsFile>

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { build, type Plugin } from "vite-plus";

const [outDir, idsFile] = process.argv.slice(2);
if (outDir === undefined || idsFile === undefined) {
  console.error("usage: ballot-build.ts <outDir> <idsFile>");
  process.exit(2);
}
const ids: string[] = [];
const collect: Plugin = {
  name: "abolish-ci-collect-module-ids",
  buildEnd() {
    ids.push(...this.getModuleIds());
  },
};
await build({
  root: resolve("apps/ballot"),
  mode: "production",
  logLevel: "warn",
  build: { outDir, emptyOutDir: true },
  plugins: [collect],
});
writeFileSync(idsFile, JSON.stringify(ids));
