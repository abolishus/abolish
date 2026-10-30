import { defineConfig } from "vite-plus";

export default defineConfig({
  // The deployable, as apps/trustee-node's: one self-contained file, every
  // dependency inlined, so the image holds Node and dist/ and nothing from
  // node_modules (Dockerfile).
  pack: {
    entry: { main: "src/main.ts" },
    platform: "node",
    dts: false,
    deps: { alwaysBundle: [/.*/] },
  },
});
