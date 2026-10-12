import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/**/*.test.ts"], environment: "node" },
      },
      {
        // Every story renders in a real browser, runs its play function and
        // then axe (`test:storybook`).
        extends: true,
        plugins: [storybookTest({ configDir: ".storybook" })],
        test: {
          name: "storybook",
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
