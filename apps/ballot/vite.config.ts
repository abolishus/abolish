import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

export default defineConfig({
  plugins: [tailwindcss()],
  // Relative URLs, so the same bytes work at any path: abolishus.eth, a
  // subdomain IPFS gateway and our domains serve one hash (T-41, T-49). Path
  // gateways share one origin across every CID, so the client refuses to run
  // on one (src/origin.ts; T-43).
  base: "./",
  build: {
    // The polyfill is the only code Vite would add of its own; every browser
    // the client supports has modulepreload.
    modulePreload: { polyfill: false },
    // Nothing is inlined as a data: URL, so the CSP needs no data: source.
    assetsInlineLimit: 0,
    sourcemap: false,
    // React's MIT notice, which minification strips from the bundle, ships
    // beside it.
    license: { fileName: "third-party-licenses.md" },
  },
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
      {
        // Every story in a real browser: its play function, then axe (`test:storybook`).
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
