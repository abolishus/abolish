import { expect, test } from "vite-plus/test";
import { findUnpinned } from "../src/actions-pinned.ts";

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

test("accepts SHA pins with a version comment and local actions", () => {
  const yml = [
    `      - uses: actions/checkout@${SHA} # v7.0.1`,
    `        uses: "owner/repo/sub/path@${SHA}" # v1`,
    "      - uses: ./.github/actions/setup",
    `      - uses: docker://alpine@sha256:${"a".repeat(64)}`,
  ].join("\n");
  expect(findUnpinned("w.yml", yml)).toEqual([]);
});

test("rejects tags, branches, short SHAs, missing comments and docker tags", () => {
  const yml = [
    "      - uses: actions/checkout@v7",
    "      - uses: actions/checkout@main",
    "      - uses: actions/checkout@3d3c42e",
    `      - uses: actions/checkout@${SHA}`,
    "      - uses: docker://alpine:3",
  ].join("\n");
  expect(findUnpinned("w.yml", yml).map((v) => v.line)).toEqual([1, 2, 3, 4, 5]);
});
