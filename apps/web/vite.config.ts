import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { execFileSync } from "node:child_process";
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

// The built server is one self-contained module tree: every dependency is
// inlined, so the deployable is Node and dist/ with nothing from node_modules
// (src/node/main.ts). Build only: the tests' module runner loads sources.
const bundleServer: Plugin = {
  name: "bundle-server",
  apply: "build",
  configEnvironment: (name) => (name === "ssr" ? { resolve: { noExternal: true } } : undefined),
};

// The route generator writes src/routeTree.gen.ts formatted by Prettier at
// its default 80 columns, which `vp check` reflows to the repo's 100. It
// writes whenever this config resolves (`vp pack` included, which is why the
// build packs first), so the build formats the file in the repo's style once
// it is done, leaving the committed file unchanged (repro-build rejects a
// build that modifies a tracked file).
const formatRouteTree: Plugin = {
  name: "format-route-tree",
  apply: "build",
  closeBundle() {
    execFileSync("vp", ["fmt", "src/routeTree.gen.ts"], { cwd: root, stdio: "ignore" });
  },
};

// Every story in a real browser: its play function, then axe
// (`test:storybook`). Components only, so without the Start plugin.
// `viewport` names one of the preview's viewports (none: the default).
function storybook(name: string, viewport?: string) {
  return {
    extends: false,
    plugins: [tailwindcss(), storybookTest({ configDir: ".storybook" })],
    define: { "import.meta.env.VITE_STORYBOOK_VIEWPORT": JSON.stringify(viewport ?? "") },
    test: {
      name,
      // The page mockups' play functions type whole sentences through
      // userEvent and walk several steps, which on CI's runners can pass the
      // 15-second default.
      testTimeout: 60_000,
      browser: {
        enabled: true,
        headless: true,
        // Motion is decorative and every animated element settles in its final
        // state under reduced motion, so axe judges what a reader ends up seeing.
        provider: playwright({ contextOptions: { reducedMotion: "reduce" } }),
        instances: [{ browser: "chromium" as const }],
      },
    },
  };
}

export default defineConfig({
  plugins: [
    tailwindcss(),
    relativeSourcePaths,
    bundleServer,
    formatRouteTree,
    tanstackStart({
      // src/routeTree.gen.ts is generated: written in the repo's own style,
      // so it passes `vp check` as generated.
      router: { quoteStyle: "double", semicolons: true, addExtensions: true },
    }),
  ],
  build: { sourcemap: false },
  // The Node entry (src/node/main.ts), every dependency inlined as for the
  // Start server, beside the Vite build's output: dist/node/main.mjs loads
  // dist/server/server.js and serves dist/client/assets.
  pack: {
    entry: { main: "src/node/main.ts" },
    outDir: "dist/node",
    platform: "node",
    dts: false,
    deps: { alwaysBundle: [/.*/] },
  },
  run: {
    tasks: {
      // tests/serve.test.ts runs against a live Postgres (TEST_DATABASE_URL),
      // so the tests are never cached; a cached task wouldn't see the variable.
      "test:db": { command: "vp test run --project unit", cache: false },
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          environment: "node",
          // tests/ssr.test.ts and tests/deployable.test.ts each build the app
          // into dist/ first, so the files run one at a time.
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
      storybook("storybook"),
      // The same stories at a small phone's width, where the preview fails any
      // page that scrolls sideways.
      storybook("storybook-phone", "phone"),
    ],
  },
});
