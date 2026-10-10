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
    expect(() => ds("abolish/v1/display-text", [1, 2] as never)).toThrow(TypeError);
  });
});

describe("record-type registry", () => {
  const rows = table(spec("versioning.md"), "## Record-type registry");

  test("RECORD_TYPES matches docs/spec/versioning.md, number and name", () => {
    // Every row is either the invalid 0x0000, the test range, or an assigned
    // type; a row in any other shape fails rather than being skipped.
    const camel = (name: string) =>
      name.replace(/[ -]([a-z])/g, (_m, c: string) => c.toUpperCase());
    const assigned: [string, number][] = [];
    for (const [number = "", name = ""] of rows) {
      if (number === "`0x0000`" && name === "none") continue;
      if (name === "test") {
        expect(number).toBe(
          `\`0x${TEST_RECORD_TYPES.first.toString(16)}\`–\`0x${TEST_RECORD_TYPES.last.toString(16)}\``,
        );
        continue;
      }
      const m = /^`0x([0-9a-f]{4})`$/.exec(number);
      if (m === null) throw new Error(`unrecognised registry row: ${number} | ${name}`);
      assigned.push([camel(name), Number.parseInt(m[1] ?? "", 16)]);
    }
    expect(assigned.length).toBeGreaterThan(0);
    expect(Object.entries(RECORD_TYPES)).toEqual(assigned);
  });

  test("the exported tables can't be changed at run time", () => {
    expect(Object.isFrozen(RECORD_TYPES)).toBe(true);
    expect(Object.isFrozen(TEST_RECORD_TYPES)).toBe(true);
    expect(Object.isFrozen(TAG_REGISTRY)).toBe(true);
    for (const e of TAG_REGISTRY) expect(Object.isFrozen(e)).toBe(true);
  });
});

describe("DS framing of hostile messages", () => {
  test("uses the message's real bytes, never a Proxy's or subclass's view", () => {
    class Lying extends Uint8Array {
      override get length() {
        return 0;
      }
    }
    const framed = ds("abolish/v1/display-text", new Lying([0xaa]));
    expect(framed.at(-1)).toBe(0xaa);
    expect(framed.length).toBe(1 + 23 + 1);
    expect(() => ds("abolish/v1/display-text", new Proxy(new Uint8Array(1), {}))).toThrow(
      TypeError,
    );
  });
});
