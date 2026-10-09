import fc from "fast-check";
import { parseSync } from "vite-plus";
import { describe, expect, test } from "vite-plus/test";
import {
  bareName,
  closureViolations,
  hasCode,
  inlinedSourceViolations,
  linkViolations,
  lockfileGraphs,
  lockfileViolations,
  manifestViolations,
  moduleReferences,
  referenceViolation,
  runtimeDependencies,
  type LockfileGraph,
} from "../src/gated.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const I = `sha512-${"A".repeat(86)}==`;
const catalog = { "@noble/hashes": "2.4.0", "@noble/curves": "2.4.0", evil: "1.0.0" };

const crypto = (extra: Record<string, unknown> = {}) => ({
  name: "@abolishus/crypto",
  scripts: { build: "vp pack", test: "vp test run", check: "vp check" },
  ...extra,
});

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
    const verifier = (deps: Record<string, string>) => ({
      scripts: { build: "vp pack" },
      dependencies: deps,
    });
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
      expect(manifestViolations("crypto", crypto({ [field]: {} }), catalog)).toHaveLength(1);
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
      { specifier: undefined, kind: "require()" },
      { specifier: undefined, kind: "import.meta" },
    ]);
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

  test("node: built-ins only in the verifier", () => {
    expect(check("node:fs", "verifier")).toBeUndefined();
    expect(check("node:fs", "crypto")).toBeTypeOf("string");
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
    ].join("\0");
    expect(linkViolations(listing)).toEqual([
      "packages/crypto/src/link.ts: symlinks are not allowed under a gated package",
      "packages/verifier/vendor: submodules are not allowed under a gated package",
      "packages/circuits: symlinks are not allowed under a gated package",
    ]);
  });
});

describe("inlinedSourceViolations", () => {
  test("accepts only the package's own src", () => {
    const map = "/tmp/out/index.mjs.map";
    expect(
      inlinedSourceViolations(
        map,
        ["../../repo/packages/crypto/src/a.ts"],
        "/repo/packages/crypto/src",
      ),
    ).toEqual([]);
    expect(
      inlinedSourceViolations(
        map,
        [
          "../../repo/node_modules/.pnpm/@noble+hashes@2.4.0/node_modules/@noble/hashes/sha2.js",
          "../../repo/packages/crypto/src-evil/a.ts",
          "../../repo/packages/verifier/src/a.ts",
          null,
        ],
        "/repo/packages/crypto/src",
      ),
    ).toHaveLength(4);
  });
});

describe("hasCode", () => {
  const program = (code: string) => parseSync("m.js", code, { sourceType: "module" }).program;

  test("an empty module has no code; anything else does", () => {
    expect(hasCode(program("export {};\n"))).toBe(false);
    expect(hasCode(program("// comment only\n"))).toBe(false);
    expect(hasCode(program("export const a = 1;"))).toBe(true);
    expect(hasCode(program('export { a } from "./a.js";'))).toBe(true);
    expect(hasCode(program("const a = 1; export { a };"))).toBe(true);
  });
});
