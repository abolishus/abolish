import { defineConfig } from "vite-plus";

export default defineConfig({
  // The deployable, as apps/api's: one self-contained file per entry, every
  // dependency inlined, so the image holds Node and dist/ and nothing from
  // node_modules (Dockerfile). The worker never migrates, so core's
  // migrations stay out. `creation-key` is the poll-creation runbook's
  // commands, run in the creation worker's service; `posting` is the posting
  // worker, a deployment of its own (docs/runbooks/posting-relay.md).
  pack: {
    entry: {
      main: "src/main.ts",
      "creation-key": "src/creation-key-cli.ts",
      posting: "src/posting-main.ts",
    },
    platform: "node",
    dts: false,
    deps: { alwaysBundle: [/.*/] },
  },
  run: {
    tasks: {
      // The tests run against a live Postgres (TEST_DATABASE_URL) and Redis
      // (REDIS_URL), so they are never cached; a cached task wouldn't see the
      // variables either.
      "test:services": { command: "vp test run", cache: false },
    },
  },
});
