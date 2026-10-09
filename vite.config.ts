import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    // The brief is kept verbatim as written by the project owner.
    ignorePatterns: ["docs/PROJECT_BRIEF.md", "pnpm-lock.yaml"],
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
