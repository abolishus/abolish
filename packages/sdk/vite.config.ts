import { defineConfig } from "vite-plus";

export default defineConfig({
  // The intake worker is its own entry: Node starts it by its path beside
  // dist/index.mjs (src/simulation/intake.ts), never through the package's
  // exports.
  pack: {
    entry: { index: "src/index.ts", "intake-worker": "src/simulation/intake-worker.ts" },
  },
});
