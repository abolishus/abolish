import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    // Most tests run whole ceremonies (ML-KEM and P-256 for every seat), and
    // CI runs this package's files beside other packages' tests on a shared
    // runner, where a ceremony's first run, warming every precomputation,
    // passes 5 seconds.
    testTimeout: 60_000,
  },
});
