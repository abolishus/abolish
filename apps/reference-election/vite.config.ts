import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      // Each run starts its own Anvil and a fresh ceremony, and writes
      // reference-election-output/ at the repository root, so it is never
      // cached: a cache hit would prove nothing.
      "reference-election": { command: "node src/main.ts", cache: false },
    },
  },
});
