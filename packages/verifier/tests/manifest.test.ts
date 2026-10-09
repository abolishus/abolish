import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url));
const manifest = JSON.parse(read("package.json").toString("utf8")) as Record<string, unknown>;

// sha256 of https://www.apache.org/licenses/LICENSE-2.0.txt
const APACHE_2_0_SHA256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";

describe("published package manifest", () => {
  it("is public and Apache-2.0 with the unmodified license text", () => {
    expect(manifest["private"]).toBeUndefined();
    expect(manifest["license"]).toBe("Apache-2.0");
    expect(createHash("sha256").update(read("LICENSE")).digest("hex")).toBe(APACHE_2_0_SHA256);
  });

  it("names the source repository and directory npm provenance is checked against", () => {
    expect(manifest["repository"]).toEqual({
      type: "git",
      url: "git+https://github.com/abolishus/abolish.git",
      directory: "packages/verifier",
    });
  });

  it("ships only the build output", () => {
    expect(manifest["files"]).toEqual(["dist"]);
    const exported = JSON.stringify(manifest["exports"]);
    for (const target of exported.match(/"\.\/[^"]*"/g) ?? []) {
      expect(target).toMatch(/^"\.\/(dist\/|package\.json")/);
    }
  });
});
