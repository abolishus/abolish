import { defineConfig } from "vite-plus";

export default defineConfig({
  // The deployable: one self-contained file per entry, every dependency
  // inlined, so the image holds Node and dist/ and nothing from node_modules
  // (Dockerfile). Core finds its migrations next to the module that loads
  // them (import.meta.url), which in the bundle is dist/, hence the copy.
  pack: {
    entry: { main: "src/main.ts", migrate: "src/migrate.ts" },
    platform: "node",
    dts: false,
    deps: { alwaysBundle: [/.*/] },
    copy: [{ from: "../../packages/core/src/db/migrations", to: "dist" }],
  },
  run: {
    tasks: {
      // The tests run against a live Postgres (TEST_DATABASE_URL), so they are
      // never cached; a cached task wouldn't see the variable either.
      "test:db": { command: "vp test run", cache: false },
    },
  },
});
