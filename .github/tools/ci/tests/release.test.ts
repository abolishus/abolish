import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  buildJobErrors,
  entryPoints,
  proposedVersions,
  reproducedErrors,
  setVersion,
  shippedErrors,
  snapshotReleases,
  tarballName,
} from "../src/release.ts";

const commit = "7ca807bb8835312c5ff1ec4afcd89f463ea7faff";
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

function published(name: string, version: string, extra = {}) {
  return { name, version, license: "Apache-2.0", publishConfig: { access: "public" }, ...extra };
}

function candidate(dir: string, name: string, from: string, to: string, extra = {}) {
  return { dir, before: published(name, from, extra), after: published(name, to, extra) };
}

describe("snapshotReleases", () => {
  test("selects only the published packages a snapshot versioned, sorted by name", () => {
    const { releases, errors } = snapshotReleases(
      [
        candidate("packages/verifier", "@abolishus/verifier", "0.0.0", `0.0.1-next-${commit}`),
        candidate("packages/sdk", "@abolishus/sdk", "0.0.0", "0.0.0"),
        candidate("packages/crypto", "@abolishus/crypto", "0.0.0", `0.1.0-next-${commit}`),
        {
          dir: "apps/api",
          before: { name: "@abolishus/api", version: "0.0.0", private: true },
          after: { name: "@abolishus/api", version: "0.0.0", private: true },
        },
      ],
      commit,
    );
    expect(errors).toEqual([]);
    expect(releases).toEqual([
      { dir: "packages/crypto", name: "@abolishus/crypto", version: `0.1.0-next-${commit}` },
      { dir: "packages/verifier", name: "@abolishus/verifier", version: `0.0.1-next-${commit}` },
    ]);
  });

  test("nothing to publish when no changesets moved a version", () => {
    expect(
      snapshotReleases([candidate("packages/sdk", "@abolishus/sdk", "0.0.0", "0.0.0")], commit),
    ).toEqual({ releases: [], errors: [] });
  });

  test("refuses any version that is not a next snapshot of this commit", () => {
    const other = "0".repeat(40);
    for (const version of [
      "0.0.1",
      "1.0.0",
      `0.0.1-beta-${commit}`,
      `0.0.1-next-${other}`,
      `0.0.1-next-${commit}.1`,
      `01.0.0-next-${commit}`,
    ]) {
      const { releases, errors } = snapshotReleases(
        [candidate("packages/sdk", "@abolishus/sdk", "0.0.0", version)],
        commit,
      );
      expect(releases, version).toEqual([]);
      expect(errors, version).toHaveLength(1);
    }
  });

  test("refuses a public package that is not on the published list or not at its path", () => {
    for (const [dir, name] of [
      ["packages/core", "@abolishus/core"],
      ["packages/crypto2", "@abolishus/crypto"],
      ["apps/api", "@abolishus/api"],
    ] as const) {
      const { errors } = snapshotReleases(
        [candidate(dir, name, "0.0.0", `0.0.1-next-${commit}`)],
        commit,
      );
      expect(errors, dir).toHaveLength(1);
    }
  });

  test("refuses a renamed package, a versioned private package and a non-Apache license", () => {
    const cases = [
      {
        dir: "packages/sdk",
        before: published("@abolishus/sdk-old", "0.0.0"),
        after: published("@abolishus/sdk", `0.0.1-next-${commit}`),
      },
      {
        dir: "packages/sdk",
        before: undefined,
        after: published("@abolishus/sdk", `0.0.1-next-${commit}`),
      },
      {
        dir: "apps/api",
        before: { name: "@abolishus/api", version: "0.0.0", private: true },
        after: { name: "@abolishus/api", version: `0.0.1-next-${commit}`, private: true },
      },
      candidate("packages/sdk", "@abolishus/sdk", "0.0.0", `0.0.1-next-${commit}`, {
        license: "MIT",
      }),
    ];
    for (const c of cases) {
      const { releases, errors } = snapshotReleases([c], commit);
      expect(releases).toEqual([]);
      expect(errors).toHaveLength(1);
    }
  });

  test("refuses a commit that is not a full SHA", () => {
    expect(snapshotReleases([], "7ca807b").errors).toHaveLength(1);
  });

  test("accepts exactly the canonical x.y.z-next-<commit> versions", () => {
    const part = fc.nat({ max: 10_000 });
    const mutation = fc.constantFrom(
      "none",
      "leading-zero",
      "build-metadata",
      "other-commit",
      "uppercase-commit",
      "short-commit",
      "other-tag",
    );
    fc.assert(
      fc.property(part, part, part, mutation, (x, y, z, m) => {
        let version = `${x}.${y}.${z}-next-${commit}`;
        if (m === "leading-zero") version = `0${x}.${y}.${z}-next-${commit}`;
        if (m === "build-metadata") version += "+1";
        if (m === "other-commit") version = `${x}.${y}.${z}-next-${"a".repeat(40)}`;
        if (m === "uppercase-commit") version = `${x}.${y}.${z}-next-${commit.toUpperCase()}`;
        if (m === "short-commit") version = `${x}.${y}.${z}-next-${commit.slice(0, 7)}`;
        if (m === "other-tag") version = `${x}.${y}.${z}-beta-${commit}`;
        const { releases, errors } = snapshotReleases(
          [candidate("packages/sdk", "@abolishus/sdk", "0.0.0", version)],
          commit,
        );
        const accepted = m === "none";
        expect(releases.map((r) => r.version)).toEqual(accepted ? [version] : []);
        expect(errors).toHaveLength(accepted ? 0 : 1);
      }),
      { numRuns },
    );
  });

  test("refuses any publishConfig beyond public access", () => {
    for (const publishConfig of [
      undefined,
      { access: "public", tag: "latest" },
      { access: "public", registry: "https://evil.example/" },
      { access: "restricted" },
    ]) {
      const { releases, errors } = snapshotReleases(
        [
          candidate("packages/sdk", "@abolishus/sdk", "0.0.0", `0.0.1-next-${commit}`, {
            publishConfig,
          }),
        ],
        commit,
      );
      expect(releases).toEqual([]);
      expect(errors).toHaveLength(1);
    }
  });
});

describe("proposedVersions", () => {
  const dirs = ["packages/crypto", "packages/sdk", ".github/tools/ci"];

  test("reads one version per known workspace package", () => {
    expect(proposedVersions("packages/sdk 0.1.0\n.github/tools/ci 0.0.0\n", dirs)).toEqual({
      versions: new Map([
        ["packages/sdk", "0.1.0"],
        [".github/tools/ci", "0.0.0"],
      ]),
      errors: [],
    });
  });

  test("refuses unknown dirs, duplicates and malformed lines", () => {
    for (const text of [
      "packages/core 0.1.0",
      "../packages/sdk 0.1.0",
      "packages/sdk 0.1.0\npackages/sdk 0.2.0",
      "packages/sdk",
      "packages/sdk 0.1.0 extra",
      "packages/sdk  0.1.0",
    ]) {
      expect(proposedVersions(text, dirs).errors, text).toHaveLength(1);
    }
  });
});

describe("setVersion", () => {
  const manifest = `{
  "name": "@abolishus/sdk",
  "version": "0.0.0",
  "description": "mentions \\"version\\": \\"0.0.0\\"",
  "scripts": {
    "version": "echo"
  }
}
`;

  test("rewrites only the top-level version field", () => {
    const out = setVersion(manifest, `0.0.1-next-${commit}`);
    expect(out).toBe(manifest.replace(`"version": "0.0.0"`, `"version": "0.0.1-next-${commit}"`));
    expect(JSON.parse(out ?? "")).toEqual({
      ...(JSON.parse(manifest) as object),
      version: `0.0.1-next-${commit}`,
    });
  });

  test("refuses a manifest whose version field isn't a single top-level line", () => {
    for (const text of [
      `{"name": "x", "version": "0.0.0"}`,
      `{\n  "name": "x"\n}\n`,
      `{\n  "version": "0.0.0",\n  "x": {\n  "version": "0.0.0",\n  "y": 1\n  }\n}\n`,
    ]) {
      expect(setVersion(text, "0.0.1"), text).toBeUndefined();
    }
  });

  test("any accepted rewrite changes nothing but the version", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (description, version) => {
        const text = `{\n  "name": "x",\n  "version": "0.0.0",\n  "description": ${JSON.stringify(description)}\n}\n`;
        const out = setVersion(text, version);
        if (out === undefined) return;
        expect(JSON.parse(out)).toEqual({ name: "x", version, description });
      }),
      { numRuns },
    );
  });
});

describe("shippedErrors", () => {
  const release = {
    dir: "packages/sdk",
    name: "@abolishus/sdk",
    version: `0.0.1-next-${commit}`,
  };
  const shipped = {
    name: release.name,
    version: release.version,
    license: "Apache-2.0",
    exports: { ".": { types: "./dist/index.d.mts", default: "./dist/index.mjs" } },
    publishConfig: { access: "public" },
    scripts: { build: "vp pack", test: "vp test run" },
  };
  const files = [
    { type: "-", path: "package/package.json" },
    { type: "-", path: "package/dist/index.mjs" },
    { type: "-", path: "package/dist/index.d.mts" },
  ];

  test("accepts the planned release with every entry point shipped", () => {
    expect(shippedErrors(shipped, files, release)).toEqual([]);
    const withDir = [{ type: "d", path: "package/dist/" }, ...files];
    expect(shippedErrors(shipped, withDir, release)).toEqual([]);
  });

  test("refuses a tarball that differs from the plan or could run code on install", () => {
    for (const change of [
      { name: "@abolishus/crypto" },
      { version: "0.0.1" },
      { private: false },
      { license: "MIT" },
      { publishConfig: { access: "public", tag: "latest" } },
      { scripts: { postinstall: "node x.js" } },
      { scripts: { preinstall: "x" } },
      { scripts: { install: "x" } },
      { gypfile: true },
      { bundleDependencies: ["x"] },
      { bundledDependencies: true },
      { main: "./dist/index.cjs" },
      { bin: { abolish: "./bin/cli.mjs" } },
      { exports: { ".": ["./dist/index.mjs", "./dist/missing.mjs"] } },
      { exports: { "./*": "./dist/*.mjs" } },
    ]) {
      expect(
        shippedErrors({ ...shipped, ...change }, files, release),
        JSON.stringify(change),
      ).toHaveLength(1);
    }
    for (const extra of [
      { type: "-", path: "package/binding.gyp" },
      { type: "-", path: "x/package.json" },
      { type: "-", path: "package/../x.js" },
      { type: "-", path: "package/dist/index.mjs" },
      { type: "l", path: "package/link" },
      { type: "h", path: "package/hard" },
      { type: "-", path: "package/./package.json" },
      { type: "-", path: "package//package.json" },
      { type: "-", path: "package/PACKAGE.JSON" },
    ]) {
      expect(shippedErrors(shipped, [...files, extra], release), extra.path).toHaveLength(1);
    }
  });

  test("entry points cover exports fallbacks, main, types and bin", () => {
    expect(
      entryPoints({
        exports: { ".": [{ import: "./a.mjs" }, "./b.mjs"], "./x": null },
        main: "./c.js",
        types: "./d.d.ts",
        bin: "./e.js",
      }),
    ).toEqual(["./a.mjs", "./b.mjs", "./c.js", "./d.d.ts", "./e.js"]);
  });
});

describe("reproducedErrors", () => {
  const plan = [
    { dir: "packages/crypto", name: "@abolishus/crypto", version: `0.1.0-next-${commit}` },
    { dir: "packages/sdk", name: "@abolishus/sdk", version: `0.0.1-next-${commit}` },
  ];
  const names = plan.map(tarballName);
  const same = new Map(names.map((n) => [n, "aa"]));

  test("names tarballs as pnpm pack does", () => {
    expect(names).toEqual([
      `abolishus-crypto-0.1.0-next-${commit}.tgz`,
      `abolishus-sdk-0.0.1-next-${commit}.tgz`,
    ]);
  });

  test("accepts identical builds of exactly the plan, including an empty one", () => {
    expect(reproducedErrors(plan, same, new Map(same))).toEqual([]);
    expect(reproducedErrors([], new Map(), new Map())).toEqual([]);
  });

  test("refuses a missing, extra or differing tarball", () => {
    const missing = new Map([[names[0] ?? "", "aa"]]);
    const extra = new Map([...same, ["evil.tgz", "bb"]]);
    const differs = new Map([...same, [names[1] ?? "", "bb"]]);
    expect(reproducedErrors(plan, missing, same)).toHaveLength(1);
    expect(reproducedErrors(plan, same, extra)).toHaveLength(1);
    expect(reproducedErrors(plan, same, differs)).toHaveLength(1);
  });
});

describe("buildJobErrors", () => {
  const plan = [
    { dir: "packages/crypto", name: "@abolishus/crypto", version: `0.1.0-next-${commit}` },
  ];
  const file = tarballName(plan[0] ?? { name: "", version: "" });
  const hashes = { a: new Map([[file, "aa"]]), b: new Map([[file, "aa"]]) };
  const job = (sha256: string, result = "success") => ({ result, outputs: { sha256 } });
  const needs = {
    plan: { result: "success" },
    "build-crypto-a": job("aa"),
    "build-crypto-b": job("aa"),
  };

  test("accepts tarballs that hash to what their build jobs reported", () => {
    expect(buildJobErrors(plan, needs, hashes)).toEqual([]);
  });

  test("refuses a tarball replaced after its job built it, or a job that didn't succeed", () => {
    expect(buildJobErrors(plan, { ...needs, "build-crypto-b": job("bb") }, hashes)).toHaveLength(1);
    expect(
      buildJobErrors(plan, { ...needs, "build-crypto-a": job("aa", "skipped") }, hashes),
    ).toHaveLength(1);
    const { "build-crypto-a": _, ...missing } = needs;
    expect(buildJobErrors(plan, missing, hashes)).toHaveLength(1);
    expect(buildJobErrors(plan, needs, { ...hashes, a: new Map() })).toHaveLength(1);
  });
});
