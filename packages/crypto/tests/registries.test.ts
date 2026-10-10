import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  ds,
  isWellFormedTag,
  RECORD_TYPES,
  TAG_REGISTRY,
  TEST_RECORD_TYPES,
} from "../src/index.ts";

// The tag and record-type tables in src must match the registries in
// docs/spec byte for byte (docs/spec/domain-separation.md, Rules), so code
// and spec can't drift apart (T-31, T-36).
const spec = (name: string) =>
  readFileSync(new URL(`../../../docs/spec/${name}`, import.meta.url), "utf8");

/** The cells of each row of the markdown table under `heading`. */
function table(markdown: string, heading: string): string[][] {
  const start = markdown.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`no section ${heading}`);
  const rows: string[][] = [];
  for (const line of markdown.slice(start + heading.length + 2).split("\n")) {
    if (line.startsWith("#")) break;
    if (!line.startsWith("|")) continue;
    const cells = line
      .slice(1, -1)
      .split(" | ")
      .map((c) => c.trim());
    if (/^-+$/.test(cells[0] ?? "")) continue;
    rows.push(cells);
  }
  return rows.slice(1); // the header row
}

const code = (cell: string) => {
  const m = /^`([^`]+)`$/.exec(cell);
  if (m === null) throw new Error(`expected one code span, got ${cell}`);
  return m[1] ?? "";
};

describe("domain-separation tag registry", () => {
  const rows = table(spec("domain-separation.md"), "## Registry");
  const fromSpec = rows.map((r) => ({
    tag: code(r[0] ?? ""),
    status: (/^(\w+)/.exec(r[4] ?? "")?.[1] ?? "").toLowerCase(),
  }));

  test("TAG_REGISTRY matches docs/spec/domain-separation.md row for row", () => {
    expect(fromSpec.length).toBeGreaterThan(0);
    expect(TAG_REGISTRY).toEqual(fromSpec);
  });

  test("every tag is well formed and none is registered twice", () => {
    for (const { tag } of TAG_REGISTRY) expect(isWellFormedTag(tag), tag).toBe(true);
    expect(new Set(TAG_REGISTRY.map((e) => e.tag)).size).toBe(TAG_REGISTRY.length);
  });

  test("the tag grammar rejects what it doesn't produce", () => {
    for (const bad of [
      "abolish/v1/",
      "abolish/v2/x",
      "abolish/v1/Display",
      "abolish/v1/a--b",
      "abolish/v1/a-",
      "abolish/v1/a//b",
      "abolish/v1/a/",
      "abolish/v1/a_b",
      "abolish/v1/é",
      `abolish/v1/${"a".repeat(245)}`,
    ])
      expect(isWellFormedTag(bad), bad).toBe(false);
    expect(isWellFormedTag("abolish/v1/a")).toBe(true);
    expect(isWellFormedTag(`abolish/v1/${"a".repeat(244)}`)).toBe(true);
  });

  test("DS(tag, m) = u8(len(tag)) ‖ tag ‖ m", () => {
    const m = Uint8Array.of(0xde, 0xad);
    const tag = "abolish/v1/display-text";
    expect(Buffer.from(ds(tag, m)).toString("hex")).toBe(
      `17${Buffer.from(tag, "ascii").toString("hex")}dead`,
    );
  });

  test("only specified tags frame a hash input", () => {
    expect(() => ds("abolish/v1/ballot" as never, new Uint8Array())).toThrow(RangeError);
    expect(() => ds("abolish/v1/unregistered" as never, new Uint8Array())).toThrow(RangeError);
  });
});

describe("record-type registry", () => {
  const rows = table(spec("versioning.md"), "## Record-type registry");

  test("RECORD_TYPES matches docs/spec/versioning.md", () => {
    const assigned = rows
      .map((r) => /^`0x([0-9a-f]{4})`$/.exec(r[0] ?? "")?.[1])
      .filter((n) => n !== undefined && n !== "0000")
      .map((n) => Number.parseInt(n ?? "", 16));
    expect(Object.values(RECORD_TYPES)).toEqual(assigned);
    expect(rows.find((r) => r[1] === "test")?.[0]).toBe(
      `\`0x${TEST_RECORD_TYPES.first.toString(16)}\`–\`0x${TEST_RECORD_TYPES.last.toString(16)}\``,
    );
  });
});
