import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

export default defineConfig({
  plugins: [
    tailwindcss(),
    tanstackStart({
      // src/routeTree.gen.ts is generated: written in the repo's own style,
      // so it passes `vp check` as generated.
      router: { quoteStyle: "double", semicolons: true, addExtensions: true },
    }),
  ],
  build: { sourcemap: false },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          environment: "node",
          // tests/ssr.test.ts builds the app first.
          hookTimeout: 120_000,
        },
      },
      {
        // Every story in a real browser: its play function, then axe
        // (`test:storybook`). Components only, so without the Start plugin.
        plugins: [tailwindcss(), storybookTest({ configDir: ".storybook" })],
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
