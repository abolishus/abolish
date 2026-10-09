import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { snapshotReleases } from "../src/release.ts";

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
