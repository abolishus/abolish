import { describe, expect, test } from "vite-plus/test";
import {
  diffPackages,
  parsePackages,
  registryViolations,
  renderDiff,
  splitKey,
  structuralViolations,
} from "../src/lockfile.ts";

const I1 = "sha512-AAAA";
const I2 = "sha512-BBBB";

const lock = (entries: string) => `---
lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      foo:
        specifier: 1.0.0
        version: 1.0.0

packages:

${entries}
snapshots:

  foo@1.0.0: {}
`;

describe("parsePackages", () => {
  test("reads keys, quoted scoped keys and integrity", () => {
    const parsed = parsePackages(
      lock(`  foo@1.0.0:
    resolution: {integrity: ${I1}}
    engines: {node: '>=18'}

  '@scope/bar@2.0.0-rc.1':
    resolution: {integrity: ${I2}}
    cpu: [x64]
`),
    );
    expect([...parsed.keys()]).toEqual(["foo@1.0.0", "@scope/bar@2.0.0-rc.1"]);
    expect(parsed.get("@scope/bar@2.0.0-rc.1")).toMatchObject({
      name: "@scope/bar",
      version: "2.0.0-rc.1",
      integrity: I2,
    });
  });

  test("ignores snapshots and importers", () => {
    expect(parsePackages(lock("")).size).toBe(0);
  });

  test("reads packages from every YAML document", () => {
    const two = `${lock(`  a@1.0.0:\n    resolution: {integrity: ${I1}}\n`)}\n---\npackages:\n\n  b@1.0.0:\n    resolution: {integrity: ${I2}}\n`;
    expect([...parsePackages(two).keys()]).toEqual(["a@1.0.0", "b@1.0.0"]);
  });
});

test("splitKey rejects keys without a version", () => {
  expect(() => splitKey("@scope")).toThrow();
  expect(splitKey("@a/b@1.2.3")).toEqual({ name: "@a/b", version: "1.2.3" });
});

test("structural policy rejects tarball and git resolutions", () => {
  const parsed = parsePackages(
    lock(`  ok@1.0.0:
    resolution: {integrity: ${I1}}

  tar@1.0.0:
    resolution: {integrity: ${I1}, tarball: https://evil.example/tar.tgz}

  gitdep@1.0.0:
    resolution: {commit: abc, repo: https://github.com/x/y, type: git}
`),
  );
  expect(structuralViolations(parsed).map((v) => v.split(":")[0])).toEqual([
    "tar@1.0.0",
    "gitdep@1.0.0",
  ]);
});

test("diff classifies added, removed and re-resolved packages", () => {
  const base = parsePackages(
    lock(
      `  keep@1.0.0:\n    resolution: {integrity: ${I1}}\n\n  gone@1.0.0:\n    resolution: {integrity: ${I1}}\n\n  swapped@1.0.0:\n    resolution: {integrity: ${I1}}\n`,
    ),
  );
  const head = parsePackages(
    lock(
      `  keep@1.0.0:\n    resolution: {integrity: ${I1}}\n\n  new@1.0.0:\n    resolution: {integrity: ${I1}}\n\n  swapped@1.0.0:\n    resolution: {integrity: ${I2}}\n`,
    ),
  );
  const diff = diffPackages(base, head);
  expect(diff.added.map((p) => p.key)).toEqual(["new@1.0.0"]);
  expect(diff.removed.map((p) => p.key)).toEqual(["gone@1.0.0"]);
  expect(diff.changed.map((p) => p.key)).toEqual(["swapped@1.0.0"]);
  expect(renderDiff(diff)).toContain("### Changed resolution (1)");
  expect(renderDiff({ added: [], removed: [], changed: [] })).toBe(
    "No lockfile package changes.\n",
  );
});

describe("registryViolations", () => {
  const pkg = {
    key: "x@1.0.0",
    name: "x",
    version: "1.0.0",
    resolution: `{integrity: ${I1}}`,
    integrity: I1,
  };
  const now = new Date("2026-10-09T00:00:00Z");

  test("passes an old package with matching integrity", () => {
    expect(
      registryViolations(pkg, { integrity: I1, published: "2026-09-01T00:00:00Z" }, now),
    ).toEqual([]);
  });

  test("fails on integrity mismatch, youth, missing version or missing time", () => {
    expect(
      registryViolations(pkg, { integrity: I2, published: "2026-09-01T00:00:00Z" }, now),
    ).toHaveLength(1);
    expect(
      registryViolations(pkg, { integrity: I1, published: "2026-10-05T00:00:00Z" }, now),
    ).toHaveLength(1);
    expect(
      registryViolations(pkg, { integrity: undefined, published: undefined }, now),
    ).toHaveLength(1);
    expect(registryViolations(pkg, { integrity: I1, published: undefined }, now)).toHaveLength(1);
    expect(registryViolations(pkg, { integrity: I1, published: "not a date" }, now)).toHaveLength(
      1,
    );
  });
});
