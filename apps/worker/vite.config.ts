import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      // The tests run against a live Postgres (TEST_DATABASE_URL) and Redis
      // (REDIS_URL), so they are never cached; a cached task wouldn't see the
      // variables either.
      "test:services": { command: "vp test run", cache: false },
    },
  },
});
