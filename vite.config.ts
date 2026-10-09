import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    // Kept verbatim: the owner's brief and the FSF license text.
    ignorePatterns: ["docs/PROJECT_BRIEF.md", "pnpm-lock.yaml", "LICENSE"],
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
