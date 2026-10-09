import fc from "fast-check";
import { expect, test } from "vite-plus/test";
import { findUnpinned } from "../src/actions-pinned.ts";

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const DIGEST = `sha256:${"a".repeat(64)}`;

const reasons = (yml: string) => findUnpinned("w.yml", yml).map((v) => `${v.path} ${v.reason}`);

test("accepts SHA pins with a version comment, local .github actions and digest-pinned images", () => {
  const yml = `
jobs:
  a:
    container: node@${DIGEST}
    services:
      db:
        image: postgres:16@${DIGEST}
    steps:
      - uses: actions/checkout@${SHA} # v7.0.1
      - uses: "owner/repo/sub/path@${SHA}" # v1
      - uses: ./.github/actions/setup
      - uses: docker://alpine@${DIGEST}
  b:
    uses: owner/repo/.github/workflows/x.yml@${SHA} # v2.0.0
`;
  expect(reasons(yml)).toEqual([]);
});

test("rejects tags, branches, short SHAs, missing comments and docker tags", () => {
  const yml = `
jobs:
  a:
    steps:
      - uses: actions/checkout@v7
      - uses: actions/checkout@main
      - uses: actions/checkout@3d3c42e
      - uses: actions/checkout@${SHA}
      - uses: docker://alpine:3
`;
  expect(reasons(yml)).toEqual([
    "jobs.a.steps.0.uses action must be pinned to a 40-character commit SHA",
    "jobs.a.steps.1.uses action must be pinned to a 40-character commit SHA",
    "jobs.a.steps.2.uses action must be pinned to a 40-character commit SHA",
    "jobs.a.steps.3.uses pinned action needs a trailing '# vX.Y.Z' comment on the same line",
    "jobs.a.steps.4.uses docker image must be pinned by sha256 digest",
  ]);
});

test("equivalent YAML spellings cannot hide an unpinned action", () => {
  const yml = `
jobs:
  a:
    steps:
      - {uses: attacker/x@main}
      - {uses: attacker/y@main, with: {t: "\${{ secrets.T }}"}}
      - "uses": attacker/z@main
      - uses : attacker/w@main
`;
  expect(findUnpinned("w.yml", yml).map((v) => v.value)).toEqual([
    "attacker/x@main",
    "attacker/y@main",
    "attacker/z@main",
    "attacker/w@main",
  ]);
});

test("local actions outside .github and path traversal are rejected", () => {
  const yml = `
steps:
  - uses: ./tools/actions/setup
  - uses: ./.github/../tools/x
`;
  expect(findUnpinned("w.yml", yml)).toHaveLength(2);
});

test("container and service images need digests", () => {
  const yml = `
jobs:
  a:
    container: node:24
  b:
    container:
      image: node:24
    services:
      redis:
        image: redis:7
`;
  expect(reasons(yml)).toEqual([
    "jobs.a.container container image must be pinned by sha256 digest",
    "jobs.b.container.image container image must be pinned by sha256 digest",
    "jobs.b.services.redis.image container image must be pinned by sha256 digest",
  ]);
});

test("unparseable, multi-document or duplicate-key files are violations", () => {
  expect(findUnpinned("w.yml", "jobs: [unclosed\n").length).toBeGreaterThan(0);
  expect(findUnpinned("w.yml", "a: 1\n---\nb: 2\n").length).toBeGreaterThan(0);
  expect(
    findUnpinned("w.yml", `steps:\n  - uses: a/b@${SHA} # v1\n    uses: evil/x@main\n`).length,
  ).toBeGreaterThan(0);
  expect(findUnpinned("w.yml", "steps:\n  - uses: [a, b]\n")).toHaveLength(1);
});

test("each pinned occurrence needs its own version comment", () => {
  const yml = `
jobs:
  a:
    steps:
      - uses: actions/checkout@${SHA} # v7.0.1
      - uses: actions/checkout@${SHA}
      - {uses: actions/checkout@${SHA}} # v7.0.1
`;
  expect(reasons(yml)).toEqual([
    "jobs.a.steps.1.uses pinned action needs a trailing '# vX.Y.Z' comment on the same line",
  ]);
});

test("property: an unpinned uses is reported whatever the YAML spelling", () => {
  const ref = fc
    .stringMatching(/^[A-Za-z0-9._-]{1,20}$/)
    .filter((r) => !/^[0-9a-f]{40}$/.test(r))
    .map((r) => `attacker/action@${r}`);
  const spelling = fc.constantFrom(
    (v: string) => `      - uses: ${v}`,
    (v: string) => `      - "uses": ${v}`,
    (v: string) => `      - uses : ${v}`,
    (v: string) => `      - {uses: ${v}}`,
    (v: string) => `      - {name: x, uses: "${v}", with: {a: b}}`,
    (v: string) => `      - name: x\n        'uses': '${v}'`,
  );
  fc.assert(
    fc.property(ref, spelling, (v, spell) => {
      const yml = `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA} # v7.0.1\n${spell(v)}\n`;
      expect(findUnpinned("w.yml", yml).map((x) => x.value)).toEqual([v]);
    }),
    { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 200) },
  );
});
