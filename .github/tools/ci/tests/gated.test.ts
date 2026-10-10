import fc from "fast-check";
import { parseSync } from "vite-plus";
import { describe, expect, test } from "vite-plus/test";
import {
  alternateManifestViolations,
  bareName,
  buildConfigViolations,
  configuresPack,
  closureViolations,
  hasCode,
  inlinedSourceViolations,
  linkViolations,
  lockfileGraphs,
  lockfileViolations,
  manifestViolations,
  moduleReferences,
  provenanceUrls,
  referenceViolation,
  runtimeDependencies,
  tsconfigViolations,
  type LockfileGraph,
} from "../src/gated.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const I = `sha512-${"A".repeat(86)}==`;
const catalog = { "@noble/hashes": "2.4.0", "@noble/curves": "2.4.0", evil: "1.0.0" };

// Shaped like the real published manifests.
const packed = (name: string, extra: Record<string, unknown> = {}) => ({
  name: `@abolishus/${name}`,
  version: "0.0.0",
  license: "Apache-2.0",
  files: ["dist"],
  type: "module",
  exports: {
    ".": { types: "./dist/index.d.mts", default: "./dist/index.mjs" },
    "./package.json": "./package.json",
  },
  publishConfig: { access: "public" },
  scripts: { build: "vp pack", test: "vp test run", check: "vp check" },
  ...extra,
});
const crypto = (extra: Record<string, unknown> = {}) => packed("crypto", extra);

// Shaped like pnpm's output: a first document for pnpm itself, whose importers
// also have a "." key, then the project.
const lockfile = (importer: string, packages: string, snapshots: string) => `---
lockfileVersion: '9.0'

importers:

  .:
    packageManagerDependencies:
      pnpm:
        specifier: 12.8.2
        version: 12.8.2

packages:

  pnpm@12.8.2:
    resolution: {integrity: ${I}}

snapshots:

  pnpm@12.8.2: {}

---
lockfileVersion: '9.0'

importers:

  .:
    devDependencies: {}

  packages/crypto:
${importer}
packages:
${packages}
snapshots:
${snapshots}`;

const NOBLE_PACKAGES = `
  '@noble/curves@2.4.0':
    resolution: {integrity: ${I}}
    engines: {node: '>= 20.19.0'}

  '@noble/hashes@2.4.0':
    resolution: {integrity: ${I}}
    engines: {node: '>= 20.19.0'}
`;
const NOBLE_SNAPSHOTS = `
  '@noble/curves@2.4.0':
    dependencies:
      '@noble/hashes': 2.4.0

  '@noble/hashes@2.4.0': {}
`;
const CURVES_IMPORTER = `    dependencies:
      '@noble/curves':
        specifier: 'catalog:'
        version: 2.4.0
`;

describe("manifestViolations", () => {
  test("accepts @noble/* from the catalog and a vp pack build", () => {
    expect(
      manifestViolations(
        "crypto",
        crypto({ dependencies: { "@noble/curves": "catalog:" } }),
        catalog,
      ),
    ).toEqual([]);
  });

  test("rejects every non-catalog spec for @noble/*", () => {
    for (const spec of [
      "2.4.0",
      "npm:evil@1.0.0",
      "link:../evil",
      "file:../evil",
      "workspace:*",
      "github:paulmillr/noble-hashes",
      "^2.4.0",
    ]) {
      expect(
        manifestViolations("crypto", crypto({ dependencies: { "@noble/hashes": spec } }), catalog),
      ).toHaveLength(1);
    }
  });

  test("rejects a catalog entry that isn't an exact registry version", () => {
    for (const pinned of ["npm:evil@1.0.0", "^2.4.0", "link:../x", undefined]) {
      expect(
        manifestViolations("crypto", crypto({ dependencies: { "@noble/hashes": "catalog:" } }), {
          "@noble/hashes": pinned,
        }),
      ).toHaveLength(1);
    }
  });

  test("rejects non-@noble runtime dependencies, including look-alikes", () => {
    for (const dep of ["evil", "@noble-x/hashes", "@nobIe/hashes", "@abolishus/core"]) {
      expect(
        manifestViolations(
          "crypto",
          crypto({ optionalDependencies: { [dep]: "catalog:" } }),
          catalog,
        ),
      ).toHaveLength(1);
    }
  });

  test("crypto may not depend on any workspace package; the verifier only on gated ones", () => {
    expect(
      manifestViolations(
        "crypto",
        crypto({ dependencies: { "@abolishus/verifier": "workspace:*" } }),
        catalog,
      ),
    ).toHaveLength(1);
    const verifier = (deps: Record<string, string>) => packed("verifier", { dependencies: deps });
    expect(
      manifestViolations("verifier", verifier({ "@abolishus/crypto": "workspace:*" }), catalog),
    ).toEqual([]);
    expect(
      manifestViolations("verifier", verifier({ "@abolishus/crypto": "workspace:^" }), catalog),
    ).toHaveLength(1);
    for (const dep of ["@abolishus/core", "@abolishus/sdk", "@abolishus/api-contract"]) {
      expect(
        manifestViolations("verifier", verifier({ [dep]: "workspace:*" }), catalog),
      ).toHaveLength(1);
    }
  });

  test("rejects peer, bundled and subpath-import fields", () => {
    for (const field of [
      "peerDependencies",
      "bundleDependencies",
      "bundledDependencies",
      "imports",
    ]) {
      // In every gated package, published or not.
      expect(manifestViolations("contracts", { [field]: {} }, catalog)).toHaveLength(1);
      expect(manifestViolations("crypto", crypto({ [field]: {} }), catalog)).not.toEqual([]);
    }
  });

  test("a packed package's build must be exactly vp pack", () => {
    expect(
      manifestViolations(
        "crypto",
        crypto({ scripts: { build: "vp pack --no-sourcemap" } }),
        catalog,
      ),
    ).toHaveLength(1);
    expect(manifestViolations("contracts", { scripts: { build: "forge build" } }, catalog)).toEqual(
      [],
    );
  });

  test("accepts the real manifest shape", () => {
    expect(manifestViolations("crypto", crypto(), catalog)).toEqual([]);
  });

  test("a published package points consumers only at dist", () => {
    const bad: Record<string, unknown>[] = [
      { files: ["dist", "vendor"] },
      { main: "./vendor/evil.js" },
      { module: "./vendor/evil.js" },
      { browser: { "./dist/index.mjs": "./vendor/evil.js" } },
      { bin: { x: "./vendor/x.js" } },
      { publishConfig: { access: "public", exports: "./vendor/x.js" } },
      { exports: { ".": { browser: "./vendor/evil.js", default: "./dist/index.mjs" } } },
      { exports: { ".": { default: "./vendor/evil.js" } } },
      { exports: { ".": { default: "./dist/../vendor/evil.js" } } },
      { exports: { ".": "./dist/index.mjs" } },
      { exports: "./dist/index.mjs" },
    ];
    for (const extra of bad)
      expect(manifestViolations("crypto", crypto(extra), catalog)).not.toEqual([]);
  });

  test("no lifecycle or other scripts beyond build, check and test", () => {
    for (const script of ["postinstall", "prepare", "prepack", "postpack", "prepublishOnly"])
      expect(
        manifestViolations(
          "crypto",
          crypto({ scripts: { build: "vp pack", [script]: "node x.js" } }),
          catalog,
        ),
      ).toHaveLength(1);
    expect(
      manifestViolations("contracts", { scripts: { build: "forge build", install: "x" } }, catalog),
    ).toHaveLength(1);
  });

  test("rejects a dependency listed in both runtime fields", () => {
    expect(
      manifestViolations(
        "crypto",
        crypto({
          dependencies: { "@noble/hashes": "catalog:" },
          optionalDependencies: { "@noble/hashes": "catalog:" },
        }),
        catalog,
      ),
    ).toHaveLength(1);
  });
});

describe("lockfileViolations", () => {
  const manifest = crypto({ dependencies: { "@noble/curves": "catalog:" } });

  test("accepts @noble/curves with its @noble/hashes closure", () => {
    const graphs = lockfileGraphs(lockfile(CURVES_IMPORTER, NOBLE_PACKAGES, NOBLE_SNAPSHOTS));
    expect(lockfileViolations("crypto", manifest, graphs, catalog)).toEqual([]);
  });

  test("reads the importer only with its own document", () => {
    // The first document's "." importer must not collide with the project's.
    const graphs = lockfileGraphs(lockfile(CURVES_IMPORTER, NOBLE_PACKAGES, NOBLE_SNAPSHOTS));
    expect(graphs).toHaveLength(2);
    expect(lockfileViolations("crypto", crypto(), graphs, catalog)).toEqual([
      "pnpm-lock.yaml: importers['packages/crypto']: @noble/curves is locked but not declared",
    ]);
  });

  test("rejects an aliased, linked or peer-suffixed lock of a @noble/* name", () => {
    for (const version of [
      "evil@1.0.0",
      "link:../evil",
      "file:../evil",
      "2.4.0(x@1.0.0)",
      "2.3.0",
    ]) {
      const importer = CURVES_IMPORTER.replace("version: 2.4.0", `version: ${version}`);
      const graphs = lockfileGraphs(lockfile(importer, NOBLE_PACKAGES, NOBLE_SNAPSHOTS));
      expect(lockfileViolations("crypto", manifest, graphs, catalog)).toHaveLength(1);
    }
  });

  test("rejects a declared dependency missing from the importer", () => {
    const graphs = lockfileGraphs(
      lockfile("    devDependencies: {}\n", NOBLE_PACKAGES, NOBLE_SNAPSHOTS),
    );
    expect(lockfileViolations("crypto", manifest, graphs, catalog)).toEqual([
      "pnpm-lock.yaml: importers['packages/crypto']: @noble/curves is declared but not locked",
    ]);
  });

  test("rejects a transitive dependency outside @noble/*", () => {
    const snapshots = NOBLE_SNAPSHOTS.replace(
      "'@noble/hashes': 2.4.0",
      "'@noble/hashes': 2.4.0\n      evil: 1.0.0",
    );
    const packages = `${NOBLE_PACKAGES}\n  evil@1.0.0:\n    resolution: {integrity: ${I}}\n`;
    const graphs = lockfileGraphs(
      lockfile(CURVES_IMPORTER, packages, `${snapshots}\n  evil@1.0.0: {}\n`),
    );
    expect(lockfileViolations("crypto", manifest, graphs, catalog)).toEqual([
      "pnpm-lock.yaml: importers['packages/crypto']: closure reaches evil@1.0.0, which is not an @noble/* package at an exact version",
    ]);
  });

  test("rejects install-time and peer behaviour inside the closure", () => {
    const packages = NOBLE_PACKAGES.replace(
      "  '@noble/hashes@2.4.0':\n    resolution",
      "  '@noble/hashes@2.4.0':\n    requiresBuild: true\n    resolution",
    );
    const snapshots = NOBLE_SNAPSHOTS.replace(
      "'@noble/hashes@2.4.0': {}",
      "'@noble/hashes@2.4.0':\n    transitivePeerDependencies:\n      - x",
    );
    const graphs = lockfileGraphs(lockfile(CURVES_IMPORTER, packages, snapshots));
    expect(lockfileViolations("crypto", manifest, graphs, catalog)).toHaveLength(2);
  });

  test("the verifier's gated workspace dependency must be a link to its directory", () => {
    const verifier = { dependencies: { "@abolishus/crypto": "workspace:*" } };
    const graph = (version: string): LockfileGraph[] => [
      {
        importers: {
          "packages/verifier": {
            dependencies: { "@abolishus/crypto": { specifier: "workspace:*", version } },
          },
        },
        packages: {},
        snapshots: {},
      },
    ];
    expect(lockfileViolations("verifier", verifier, graph("link:../crypto"), catalog)).toEqual([]);
    expect(lockfileViolations("verifier", verifier, graph("link:../core"), catalog)).toHaveLength(
      1,
    );
  });
});

describe("lockfileGraphs", () => {
  test("rejects YAML merge keys, which pnpm's parser may apply", () => {
    expect(() => lockfileGraphs("snapshots:\n  x: {<<: {a: 1}}\n")).toThrow(/merge keys/);
    expect(() => lockfileGraphs("snapshots:\n  x:\n    ? <<\n    : {a: 1}\n")).toThrow(
      /merge keys/,
    );
    expect(() =>
      lockfileGraphs(
        lockfile(CURVES_IMPORTER, NOBLE_PACKAGES, `${NOBLE_SNAPSHOTS}  x:\n    <<: {}\n`),
      ),
    ).toThrow(/merge keys/);
  });
});

describe("closureViolations", () => {
  const nobleName = fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/).map((n) => `@noble/${n}`);
  const anyName = fc.oneof(nobleName, fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/));

  test("passes exactly when every package reachable from the roots is @noble/*", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(anyName, { minLength: 1, maxLength: 8 }),
        fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 16 }),
        (names, edges) => {
          const key = (n: string) => `${n}@1.0.0`;
          const deps = new Map(names.map((n) => [n, new Set<string>()]));
          for (const [a, b] of edges) {
            const from = names[a % names.length] ?? "";
            const to = names[b % names.length] ?? "";
            deps.get(from)?.add(to);
          }
          const graph: LockfileGraph = {
            importers: {},
            packages: Object.fromEntries(names.map((n) => [key(n), { resolution: {} }])),
            snapshots: Object.fromEntries(
              names.map((n) => [
                key(n),
                {
                  dependencies: Object.fromEntries(
                    [...(deps.get(n) ?? [])].map((d) => [d, "1.0.0"]),
                  ),
                },
              ]),
            ),
          };
          const root = names[0] ?? "";
          // A Set's iterator visits elements added during iteration.
          const reachable = new Set([root]);
          for (const n of reachable) for (const d of deps.get(n) ?? []) reachable.add(d);
          const clean = [...reachable].every((n) => n.startsWith("@noble/"));
          expect(closureViolations([key(root)], graph).length === 0).toBe(clean);
        },
      ),
      { numRuns },
    );
  });

  test("terminates on cycles", () => {
    const graph: LockfileGraph = {
      importers: {},
      packages: { "@noble/a@1.0.0": {}, "@noble/b@1.0.0": {} },
      snapshots: {
        "@noble/a@1.0.0": { dependencies: { "@noble/b": "1.0.0" } },
        "@noble/b@1.0.0": { dependencies: { "@noble/a": "1.0.0" } },
      },
    };
    expect(closureViolations(["@noble/a@1.0.0"], graph)).toEqual([]);
  });
});

const refs = (code: string) =>
  moduleReferences(parseSync("m.ts", code, { sourceType: "module" }).program);

describe("moduleReferences", () => {
  test("finds every way a module can name another", () => {
    expect(
      refs(`
        import a from "a";
        import type { B } from "b";
        import "c";
        export * from "./d";
        export { e } from "e";
        export const local = 1;
        const f = await import("f");
        const g = await import(\`g\`);
        type H = import("h").H;
        import i = require("i");
      `).map((r) => r.specifier),
    ).toEqual(["a", "b", "c", "./d", "e", "f", "g", "h", "i"]);
  });

  test("reports non-literal dynamic imports, require and import.meta without a specifier", () => {
    expect(
      refs(
        `const m = "x"; await import(m); await import(\`\${m}\`); require("y"); import.meta.url;`,
      ),
    ).toEqual([
      { specifier: undefined, kind: "ImportExpression" },
      { specifier: undefined, kind: "ImportExpression" },
      { specifier: undefined, kind: "loader name require" },
      { specifier: undefined, kind: "import.meta" },
    ]);
  });

  test("ordinary words that are also loader members are allowed outside member access", () => {
    expect(refs("const binding = 1; const o = { binding, dlopen: 2 }; f(binding);")).toEqual([]);
  });

  test("reports every name that reaches a loader or evaluator without an import", () => {
    for (const code of [
      'process.getBuiltinModule("node:module");',
      'process["getBuiltinModule"]("node:module");',
      "createRequire(x)('y');",
      "eval('1');",
      "new Function('return 1');",
      "new Worker(u);",
      "importScripts(u);",
      "globalThis.require('x');",
      "process.dlopen(m, p);",
      'process.binding("spawn_sync");',
      'process["_linkedBinding"]("x");',
      "process[`getBuiltinModule`](`node:child_process`);",
      "globalThis[`Function`](code)();",
    ])
      expect(refs(code).some((r) => r.specifier === undefined)).toBe(true);
  });
});

describe("referenceViolation", () => {
  const declared = runtimeDependencies({
    dependencies: { "@noble/hashes": "catalog:", evil: "1.0.0" },
  });
  const check = (specifier: string | undefined, name: "crypto" | "verifier" = "crypto") =>
    referenceViolation(
      name,
      `packages/${name}/src/a/b.ts`,
      `packages/${name}/src`,
      { specifier, kind: "ImportDeclaration" },
      declared,
    );

  test("allows relative imports inside src and declared @noble/* (with subpaths)", () => {
    for (const s of ["./c.ts", "../d.ts", "../a/../e.ts", "@noble/hashes", "@noble/hashes/sha2.js"])
      expect(check(s)).toBeUndefined();
  });

  test("rejects escapes from src, undeclared or non-@noble packages, and odd specifiers", () => {
    for (const s of [
      "../../package.json",
      "../../../verifier/src/index.ts",
      "../../src-evil/x.ts",
      "@noble/curves",
      "evil",
      "fs",
      "node:fs",
      "#internal",
      "/abs/path.ts",
      "https://example.com/x.js",
      "data:text/javascript,1",
      undefined,
    ])
      expect(check(s)).toBeTypeOf("string");
  });

  test("node: built-ins only in the verifier, and only the allowlisted ones", () => {
    expect(check("node:fs", "verifier")).toBeUndefined();
    expect(check("node:fs", "crypto")).toBeTypeOf("string");
    for (const s of ["node:module", "node:vm", "node:child_process", "node:worker_threads"])
      expect(check(s, "verifier")).toBeTypeOf("string");
  });

  test("rejects dot segments and escapes in a declared package's subpath", () => {
    for (const s of [
      "@noble/hashes/../../fast-check/lib/fast-check.js",
      "@noble/hashes/./sha2.js",
      "@noble/hashes/sha2.js?x",
      "@noble/hashes/sha2%2ejs",
      "@noble/hashes\\..\\x",
    ])
      expect(check(s)).toBeTypeOf("string");
  });

  test("an import resolving outside src is rejected, whatever the path", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("..", ".", "a", "src", "b"), { minLength: 1, maxLength: 8 }),
        (segments) => {
          const spec = `./${segments.join("/")}/x.ts`;
          // Resolve by hand from the importing file's directory.
          const dir = ["packages", "crypto", "src", "a"];
          let escaped = false;
          for (const s of segments) {
            if (s === "..") escaped ||= dir.pop() === undefined;
            else if (s !== ".") dir.push(s);
          }
          const inside = !escaped && dir.slice(0, 3).join("/") === "packages/crypto/src";
          expect(check(spec) === undefined).toBe(inside);
        },
      ),
      { numRuns },
    );
  });
});

describe("bareName", () => {
  test("extracts the package from scoped and unscoped specifiers", () => {
    expect(bareName("@noble/hashes/sha2.js")).toBe("@noble/hashes");
    expect(bareName("@noble/hashes")).toBe("@noble/hashes");
    expect(bareName("yaml/util")).toBe("yaml");
    expect(bareName("@noble")).toBeUndefined();
    expect(bareName("@noble/Hashes")).toBeUndefined();
  });
});

describe("linkViolations", () => {
  const entry = (mode: string, path: string) => `${mode} ${"0".repeat(40)} 0\t${path}`;

  test("rejects symlinks and submodules under gated packages only", () => {
    const listing = [
      entry("100644", "packages/crypto/src/index.ts"),
      entry("120000", "packages/crypto/src/link.ts"),
      entry("160000", "packages/verifier/vendor"),
      entry("120000", "packages/circuits"),
      entry("120000", "packages/sdk/src/link.ts"),
      entry("120000", "packages/crypto-evil/x"),
      entry("120000", "packages"),
    ].join("\0");
    expect(linkViolations(listing)).toEqual([
      "packages/crypto/src/link.ts: symlinks are not allowed under a gated package",
      "packages/verifier/vendor: submodules are not allowed under a gated package",
      "packages/circuits: symlinks are not allowed under a gated package",
      "packages: symlinks are not allowed under a gated package",
    ]);
  });
});

describe("inlinedSourceViolations", () => {
  const map = "/tmp/out/index.mjs.map";
  const srcRoot = "/repo/packages/crypto/src";
  const disk = new Map([["/repo/packages/crypto/src/a.ts", "export const a = 1;\n"]]);
  const read = (path: string) => disk.get(path);
  const check = (m: Record<string, unknown>) => inlinedSourceViolations(map, m, srcRoot, read);
  const own = "../../repo/packages/crypto/src/a.ts";

  test("accepts the package's own src with its exact content", () => {
    expect(check({ sources: [own], sourcesContent: ["export const a = 1;\n"] })).toEqual([]);
  });

  test("rejects sources outside src", () => {
    const sources = [
      "../../repo/node_modules/.pnpm/@noble+hashes@2.4.0/node_modules/@noble/hashes/sha2.js",
      "../../repo/packages/crypto/src-evil/a.ts",
      "../../repo/packages/verifier/src/a.ts",
      null,
    ];
    expect(check({ sources, sourcesContent: sources.map(() => "") })).toHaveLength(4);
  });

  test("rejects a map whose embedded content differs from src, e.g. a load hook", () => {
    expect(check({ sources: [own], sourcesContent: ["export const a = fetch('x');\n"] })).toEqual([
      `${map}: embedded content of ${own} differs from the file in src`,
    ]);
    expect(
      check({ sources: ["../../repo/packages/crypto/src/gone.ts"], sourcesContent: [""] }),
    ).toHaveLength(1);
  });

  test("rejects a sourceRoot, missing content or a missing sources list", () => {
    expect(check({ sources: [own], sourcesContent: [""], sourceRoot: "/x" })).toHaveLength(1);
    expect(check({ sources: [own] })).toHaveLength(1);
    expect(check({ sources: [own], sourcesContent: [] })).toHaveLength(1);
    expect(check({})).toHaveLength(1);
  });
});

describe("buildConfigViolations and configuresPack", () => {
  test("rejects any build config the gated builds could find, except the root vite.config.ts", () => {
    const rejected = [
      "packages/crypto/vite.config.ts",
      "packages/verifier/tests/vitest.config.mts",
      "packages/crypto/tsdown.config.js",
      "packages/vite.config.ts",
      "packages/vite.config.mts",
      "vite.config.js",
      "vite.config.mjs",
      "vite.config.mts",
      "vite.config.cjs",
      "tsdown.config.ts",
      "rolldown.config.mjs",
      "packages/tsdown.config",
      "tsdown.config",
    ];
    const allowed = [
      "vite.config.ts",
      "packages/sdk/vite.config.ts",
      "apps/web/vite.config.ts",
      "packages/crypto/src/config.ts",
    ];
    expect(buildConfigViolations([...rejected, ...allowed])).toHaveLength(rejected.length);
  });

  test("detects a pack setting in the root config", () => {
    const program = (code: string) =>
      parseSync("vite.config.ts", code, { sourceType: "module" }).program;
    expect(configuresPack(program("export default defineConfig({ fmt: {} });"))).toBe(false);
    expect(configuresPack(program("export default defineConfig({ pack: {} });"))).toBe(true);
    expect(configuresPack(program('export default defineConfig({ "pack": {} });'))).toBe(true);
    expect(configuresPack(program("const c = {}; c.pack = {}; export default c;"))).toBe(true);
  });
});

describe("alternateManifestViolations", () => {
  test("rejects package.yaml, package.json5 and a tsconfig directly in packages/", () => {
    expect(
      alternateManifestViolations([
        "packages/circuits/package.yaml",
        "apps/x/package.json5",
        "packages/tsconfig.json",
        "packages/tsconfig.base.json",
        "packages/crypto/package.json",
        "packages/crypto/tsconfig.json",
        "tsconfig.json",
      ]),
    ).toHaveLength(4);
  });
});

describe("tsconfigViolations", () => {
  test("requires the shared base and no resolution-changing options", () => {
    const ok = { extends: "../../tsconfig.base.json", compilerOptions: { types: ["node"] } };
    expect(tsconfigViolations("t.json", ok)).toEqual([]);
    expect(tsconfigViolations("t.json", { ...ok, extends: "./evil.json" })).toHaveLength(1);
    for (const key of ["paths", "baseUrl", "rootDirs", "plugins", "customConditions"])
      expect(tsconfigViolations("t.json", { ...ok, compilerOptions: { [key]: {} } })).toHaveLength(
        1,
      );
  });
});

describe("hasCode", () => {
  const program = (code: string) => parseSync("m.js", code, { sourceType: "module" }).program;

  test("imports and re-exports alone are not code; anything else is", () => {
    expect(hasCode(program("export {};\n"))).toBe(false);
    expect(hasCode(program("// comment only\n"))).toBe(false);
    expect(hasCode(program('export { a } from "./a.js";'))).toBe(false);
    expect(hasCode(program('import * as x from "@noble/hashes/sha2.js"; export { x };'))).toBe(
      false,
    );
    expect(hasCode(program('export * from "./a.js";'))).toBe(false);
    expect(hasCode(program("export const a = 1;"))).toBe(true);
    expect(hasCode(program("const a = 1; export { a };"))).toBe(true);
    expect(hasCode(program("export default 1;"))).toBe(true);
  });
});

describe("provenanceUrls", () => {
  const sha = "e300bbe2f1bec75e5ee7e0ab7b196958831b3db6";
  const raw = (repo: string, ref = sha) =>
    `https://raw.githubusercontent.com/${repo}/${ref}/vectors/a.rsp`;

  test("fetches an allowlisted publisher's file by commit and by tag", () => {
    expect(provenanceUrls("nist-cavp/a.rsp", raw("pyca/cryptography"), "49.0.0")).toEqual([
      raw("pyca/cryptography"),
      "https://raw.githubusercontent.com/pyca/cryptography/refs/tags/49.0.0/vectors/a.rsp",
    ]);
    expect(
      provenanceUrls("rfc/rfc9380.txt", "https://www.rfc-editor.org/rfc/rfc9380.txt", "rfc9380"),
    ).toEqual(["https://www.rfc-editor.org/rfc/rfc9380.txt"]);
  });

  test("rejects other repositories, unpinned refs, bad tags and unknown publishers", () => {
    const bad: [string, string, string][] = [
      ["nist-cavp/a.rsp", raw("attacker/cryptography"), "49.0.0"],
      ["nist-cavp/a.rsp", raw("C2SP/wycheproof"), "v1"],
      ["wycheproof/a.json", raw("pyca/cryptography"), "49.0.0"],
      ["nist-cavp/a.rsp", raw("pyca/cryptography", "main"), "49.0.0"],
      ["nist-cavp/a.rsp", raw("pyca/cryptography", "49.0.0"), "49.0.0"],
      ["nist-cavp/a.rsp", raw("pyca/cryptography"), "../main"],
      ["nist-cavp/a.rsp", raw("pyca/cryptography"), ""],
      ["nist-cavp/a.rsp", `https://raw.githubusercontent.com/pyca/cryptography/${sha}/../x`, "1"],
      ["other/a.rsp", raw("pyca/cryptography"), "49.0.0"],
      ["nist-cavp/a.rsp", "https://www.rfc-editor.org/rfc/rfc9380.txt", "rfc9380"],
      ["rfc/rfc9380.txt", "https://www.rfc-editor.org/rfc/rfc9380.txt", "rfc1"],
      ["rfc/rfc9380.txt", "https://www.rfc-editor.org/rfc/rfc9380.html", "rfc9380"],
    ];
    for (const [path, source, tag] of bad)
      expect(provenanceUrls(path, source, tag)).toBeTypeOf("string");
  });
});
