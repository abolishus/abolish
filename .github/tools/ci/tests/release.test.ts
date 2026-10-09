import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { snapshotReleases } from "../src/release.ts";

const commit = "7ca807bb8835312c5ff1ec4afcd89f463ea7faff";
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

function published(name: string, version: string, extra = {}) {
  return { name, version, license: "Apache-2.0", ...extra };
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

  test("every release is a published package with a snapshot version of this commit", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), (crypto, verifier, sdk) => {
        const { releases } = snapshotReleases(
          [
            candidate("packages/crypto", "@abolishus/crypto", "0.0.0", crypto),
            candidate("packages/verifier", "@abolishus/verifier", "0.0.0", verifier),
            candidate("packages/sdk", "@abolishus/sdk", "0.0.0", sdk),
          ],
          commit,
        );
        for (const r of releases) expect(r.version.endsWith(`-next-${commit}`)).toBe(true);
      }),
      { numRuns },
    );
  });
});
