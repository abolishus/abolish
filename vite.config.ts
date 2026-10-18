import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    // Kept verbatim: the owner's brief, the FSF license text and the Noir
    // sources vendored by git object id (packages/circuits/test/vendored.test.ts).
    ignorePatterns: [
      "docs/PROJECT_BRIEF.md",
      "pnpm-lock.yaml",
      "LICENSE",
      "packages/circuits/vendor/**",
    ],
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  run: {
    cache: true,
  },
});
