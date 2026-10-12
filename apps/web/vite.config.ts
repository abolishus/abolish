import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

const root = fileURLToPath(new URL(".", import.meta.url));

// The server build's route manifest records each route's source file as an
// absolute path, so builds in two checkouts differ (repro-build). Nothing reads
// the path at run time; it is rewritten relative to this package before the
// chunk is hashed.
const relativeSourcePaths: Plugin = {
  name: "relative-source-paths",
  apply: "build",
  renderChunk(code) {
    const absolute = `"${root}`;
    return code.includes(absolute) ? { code: code.replaceAll(absolute, '"./'), map: null } : null;
  },
};

export default defineConfig({
  plugins: [
    tailwindcss(),
    relativeSourcePaths,
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
        extends: false,
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
