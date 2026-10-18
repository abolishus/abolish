import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      // Each run starts its own Anvil and a fresh ceremony, and writes
      // reference-election-output/ at the repository root, so it is never
      // cached: a cache hit would prove nothing.
      "reference-election": { command: "node src/main.ts", cache: false },
      // The API's tests run against a live Postgres and Redis
      // (TEST_DATABASE_URL, REDIS_URL), so they are never cached; a cached
      // task wouldn't see the variables either.
      "test:db": { command: "vp test run", cache: false },
    },
  },
});
