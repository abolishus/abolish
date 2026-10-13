import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

// Every story renders in a real browser, runs its play function and then axe
// (`test:storybook`).
// `viewport` names one of the preview's viewports (none: the default).
function storybook(name: string, viewport?: string) {
  return {
    extends: true,
    plugins: [storybookTest({ configDir: ".storybook" })],
    define: { "import.meta.env.VITE_STORYBOOK_VIEWPORT": JSON.stringify(viewport ?? "") },
    test: {
      name,
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
  plugins: [tailwindcss()],
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/**/*.test.{ts,tsx}"], environment: "node" },
      },
      storybook("storybook"),
      // The same stories at a small phone's width, where the preview fails any
      // page that scrolls sideways.
      storybook("storybook-phone", "phone"),
    ],
  },
});
