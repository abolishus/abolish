import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

// The fonts (Oxanium, JetBrains Mono) reach the bundle through @abolishus/ui's CSS, which
// build.license doesn't see, and their OFL-1.1 must go with every copy.
const fromUi = createRequire(new URL("../../packages/ui/package.json", import.meta.url));
const FONT_PACKAGES = ["@fontsource-variable/oxanium", "@fontsource-variable/jetbrains-mono"];
const fontLicenses: Plugin = {
  name: "font-licenses",
  apply: "build",
  generateBundle() {
    this.emitFile({
      type: "asset",
      fileName: "font-licenses.txt",
      source: FONT_PACKAGES.map(
        (name) => `${name}\n\n${readFileSync(fromUi.resolve(`${name}/LICENSE`), "utf8")}`,
      ).join("\n\n"),
    });
  },
};

export default defineConfig({
  plugins: [tailwindcss(), fontLicenses],
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
    // beside it; the fonts' licences are in font-licenses.txt.
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
            // Motion is decorative and every animated element settles in its final
            // state under reduced motion, so axe judges what a reader ends up seeing.
            provider: playwright({ contextOptions: { reducedMotion: "reduce" } }),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
