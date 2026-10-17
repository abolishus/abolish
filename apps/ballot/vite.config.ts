import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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

// The prover's proving key and witness calculator, from
// packages/membership-prover's vendored copies (which vectors-provenance
// re-fetches), beside the scripts under names carrying their own sha256, the
// names src/prover-artifacts.ts derives from the pins. The bundle check
// refuses any other .zkey or .wasm bytes (T-07, T-12).
const ARTIFACTS = new URL(
  "../../packages/membership-prover/artifacts/snark-artifacts/",
  import.meta.url,
);
const proverArtifacts: Plugin = {
  name: "prover-artifacts",
  apply: "build",
  generateBundle() {
    for (const ext of ["zkey", "wasm"]) {
      const source = readFileSync(new URL(`semaphore-32.${ext}`, ARTIFACTS));
      const sha256 = createHash("sha256").update(source).digest("hex");
      this.emitFile({
        type: "asset",
        fileName: `assets/semaphore-32-${sha256.slice(0, 16)}.${ext}`,
        source,
      });
    }
  },
};

// The prover worker bundles snarkjs's and ffjavascript's prebuilt browser
// builds, and each holds one path to an API the worker may not have (T-43):
// fastfile's read of a URL through `fetch`, and ffjavascript's thread pool of
// `blob:` Workers, which the CSP refuses and the client never uses (it
// proves single-threaded and hands snarkjs bytes, never URLs). Each is cut
// out at its exact text in the pinned version; a version whose text differs
// fails the build rather than ship the API. js-sha3's licence comment, which
// the minifier keeps, names its repository as a link the bundle check would
// read as a request; it keeps its text, without the scheme.
const PROVER_STUBS: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  "/snarkjs@0.7.5/node_modules/snarkjs/build/browser.esm.js": [
    [
      `const buff = await fetch(o).then( function(res) {
                return res.arrayBuffer();
            }).then(function (ab) {
                return new Uint8Array(ab);
            });
            o = {
                type: "mem",
                data: buff
            };`,
      `throw new Error("fastfile: the ballot client reads no URLs");`,
    ],
    ["[js-sha3]{@link https://github.com/emn178/js-sha3}", "js-sha3 (github.com/emn178/js-sha3)"],
  ],
  "/ffjavascript@0.3.1/node_modules/ffjavascript/build/browser.esm.js": [
    [
      `{
    if(globalThis?.Blob) {
        const threadBytes= new TextEncoder().encode(threadStr);
        const workerBlob = new Blob([threadBytes], { type: "application/javascript" }) ;
        workerSource = URL.createObjectURL(workerBlob);
    } else {
        workerSource = "data:application/javascript;base64," + globalThis.btoa(threadStr);
    }
}`,
      "",
    ],
    [
      `if(!globalThis?.Worker) {
        singleThread = true;
    }`,
      "singleThread = true;",
    ],
    [
      "tm.workers[i] = new Worker(workerSource);",
      `throw new Error("ffjavascript: the ballot client runs no threads");`,
    ],
  ],
};
// One per worker build: the prover worker's must have cut both files, so a
// module id that stops matching (another version, another store path) fails
// the build too.
const proverStubs = (): Plugin => {
  const cut = new Set<string>();
  return {
    name: "prover-stubs",
    transform(code, id) {
      const file = Object.keys(PROVER_STUBS).find((suffix) => id.endsWith(suffix));
      if (file === undefined) return undefined;
      let out = code;
      for (const [from, to] of PROVER_STUBS[file] ?? []) {
        if (out.split(from).length !== 2) throw new Error(`prover-stubs: ${file} has changed`);
        out = out.replace(from, () => to);
      }
      cut.add(file);
      return { code: out, map: null };
    },
    generateBundle(_, bundle) {
      const prover = Object.keys(bundle).some((name) => /^assets\/prover-[\w-]+\.js$/.test(name));
      if (prover && cut.size !== Object.keys(PROVER_STUBS).length)
        throw new Error(
          "prover-stubs: the prover worker bundled an unstubbed snarkjs or ffjavascript",
        );
    },
  };
};

// build.license sees only the page's build, never a worker's, and snarkjs's
// and ffjavascript's prebuilt bundles inline packages no manifest declares
// (ADR 0009, Amendment). So every package the two bundles carry, at the exact
// version the lockfile pins, gets its notice in third-party-licenses.md: the
// GPL-3.0 code under §13 with the AGPL-3.0-only client, as the owner approved.
// A version missing from the store fails the build.
const PROVER_BUNDLED: readonly (readonly [string, string])[] = [
  ["snarkjs", "0.7.5"],
  ["ffjavascript", "0.3.1"],
  ["@iden3/bigarray", "0.0.2"],
  ["@iden3/binfileutils", "0.0.12"],
  ["blake2b-wasm", "2.4.0"],
  ["circom_runtime", "0.1.28"],
  ["fastfile", "0.0.20"],
  ["js-sha3", "0.8.0"],
  ["r1csfile", "0.0.48"],
  ["wasmbuilder", "0.0.16"],
  ["wasmcurves", "0.2.2"],
  ["web-worker", "1.2.0"],
];
const STORE = new URL("../../node_modules/.pnpm/", import.meta.url);
const LICENCE_FILES = ["COPYING", "LICENSE", "LICENSE.txt", "LICENSE.md"];
function proverNotice([name, version]: readonly [string, string]): string {
  const dir = new URL(`${name.replace("/", "+")}@${version}/node_modules/${name}/`, STORE);
  const manifest = JSON.parse(readFileSync(new URL("package.json", dir), "utf8")) as {
    version?: string;
    license?: string;
  };
  if (manifest.version !== version) throw new Error(`prover-licenses: ${name} isn't ${version}`);
  const file = LICENCE_FILES.find((f) => existsSync(new URL(f, dir)));
  const text =
    file === undefined
      ? `The package ships no licence file; its package.json names ${manifest.license}, whose text is given for snarkjs above.`
      : readFileSync(new URL(file, dir), "utf8").trim();
  return `## ${name} - ${version} (${manifest.license}, in the prover worker)\n\n${text}\n`;
}
const proverLicenses: Plugin = {
  name: "prover-licenses",
  apply: "build",
  generateBundle: {
    // After build.license has written the page's notices.
    order: "post",
    handler(_, bundle) {
      const notices = bundle["third-party-licenses.md"];
      if (notices?.type !== "asset") throw new Error("prover-licenses: no third-party-licenses.md");
      notices.source = `${String(notices.source).trimEnd()}\n\n${PROVER_BUNDLED.map(proverNotice).join("\n")}`;
    },
  },
};

// Every story in a real browser: its play function, then axe (`test:storybook`).
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
  plugins: [tailwindcss(), fontLicenses, proverArtifacts, proverLicenses],
  worker: { plugins: () => [proverStubs()] },
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
      storybook("storybook"),
      // The same stories at a small phone's width, where the preview fails any
      // page that scrolls sideways.
      storybook("storybook-phone", "phone"),
    ],
  },
});
