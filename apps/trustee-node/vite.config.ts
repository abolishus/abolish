import { defineConfig } from "vite-plus";

export default defineConfig({
  // The deployable, as apps/api's: one self-contained file, every dependency
  // inlined, so the image holds Node and dist/ and nothing from node_modules
  // (Dockerfile).
  pack: {
    entry: { main: "src/main.ts" },
    platform: "node",
    dts: false,
    deps: { alwaysBundle: [/.*/] },
  },
  test: {
    // Most tests run whole ceremonies (ML-KEM and P-256 for every seat), and
    // CI runs this package's files beside other packages' tests on a shared
    // runner, where a ceremony's first run, warming every precomputation,
    // passes 5 seconds.
    testTimeout: 60_000,
  },
});
