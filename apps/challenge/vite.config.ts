import { defineConfig } from "vite-plus";

import { pageBuild } from "./page-build.ts";
import { STAGING } from "./src/deployment.ts";

export default defineConfig({
  ...pageBuild(STAGING),
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/**/*.test.ts"], environment: "node" },
      },
      {
        extends: true,
        test: {
          name: "e2e",
          include: ["tests/**/*.e2e.ts"],
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
