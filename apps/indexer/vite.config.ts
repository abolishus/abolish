import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      // The tests run Anvil and a live Postgres (TEST_DATABASE_URL), so they
      // are never cached; a cached task wouldn't see the variable either.
      "test:services": { command: "vp test run", cache: false },
    },
  },
});
