import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

// The image runs dist/ as deployable.test.ts does; this checks only its base.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const from = (dockerfile: string) => dockerfile.match(/^FROM (\S+)$/m)?.[1] ?? "";

describe("the Dockerfile", () => {
  const dockerfile = read("../Dockerfile");

  test("builds on the repository's Node, pinned by digest", () => {
    const node = read("../../../.node-version").trim();
    expect(from(dockerfile)).toMatch(
      new RegExp(`:${node.replaceAll(".", "\\.")}-[a-z-]+@sha256:[0-9a-f]{64}$`),
    );
  });

  test("uses the API image's base, so one pin moves both", () => {
    expect(from(dockerfile)).toBe(from(read("../../api/Dockerfile")));
  });
});
