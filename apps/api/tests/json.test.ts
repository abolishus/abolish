import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { hasDuplicateKey } from "../src/json.ts";

// T-31: a body whose objects repeat a key reads differently to different
// parsers, so the server refuses it.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

/** A JSON value whose objects are lists of entries, so keys may repeat. */
type Tree = null | boolean | number | string | Tree[] | { readonly entries: [string, Tree][] };

/** A key spelled as JSON, sometimes with every character as a `\u` escape. */
const spell = (key: string, escaped: boolean) =>
  escaped
    ? `"${Array.from({ length: key.length }, (_, j) => `\\u${key.charCodeAt(j).toString(16).padStart(4, "0")}`).join("")}"`
    : JSON.stringify(key);

function serialise(t: Tree, escape: () => boolean): string {
  if (Array.isArray(t)) return `[ ${t.map((v) => serialise(v, escape)).join(" , ")} ]`;
  if (t !== null && typeof t === "object")
    return `{${t.entries.map(([k, v]) => `${spell(k, escape())} :${serialise(v, escape)}`).join(",\n")}}`;
  return JSON.stringify(t);
}

function duplicated(t: Tree): boolean {
  if (Array.isArray(t)) return t.some(duplicated);
  if (t === null || typeof t !== "object") return false;
  const keys = t.entries.map(([k]) => k);
  return new Set(keys).size !== keys.length || t.entries.some(([, v]) => duplicated(v));
}

// Few distinct keys, including ones full of quotes and backslashes, so
// repeats are common and the scan's string skipping is exercised.
const key = fc.constantFrom("a", "b", '"', "\\", 'x\\"y', "{", "}", ",", ":", "", "é", " ");
const { tree } = fc.letrec<{ tree: Tree }>((rec) => ({
  tree: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.constantFrom(null, true, false, 0, -1.5e10),
    fc.string(),
    fc.array(rec("tree"), { maxLength: 4 }),
    fc.array(fc.tuple(key, rec("tree")), { maxLength: 4 }).map((entries) => ({ entries }) as Tree),
  ),
}));

describe("hasDuplicateKey (T-31)", () => {
  test("finds a repeated key at any depth, however it is spelled", () => {
    expect(hasDuplicateKey('{"ballot":"00","ballot":"01"}')).toBe(true);
    expect(hasDuplicateKey('{"a":1,"\\u0061":2}')).toBe(true);
    expect(hasDuplicateKey('[1,{"x":[{"k":{},"k":[]}]}]')).toBe(true);
    expect(hasDuplicateKey('{"__proto__":1,"__proto__":2}')).toBe(true);
  });

  test("keys repeat freely across objects, and strings that look like keys are values", () => {
    expect(hasDuplicateKey('{"a":{"a":1},"b":{"a":2}}')).toBe(false);
    expect(hasDuplicateKey('[{"a":1},{"a":1}]')).toBe(false);
    expect(hasDuplicateKey('{"a":"a","b":["a","a"]}')).toBe(false);
    expect(hasDuplicateKey('{"a\\"":1,"a":2}')).toBe(false);
    expect(hasDuplicateKey('"{\\"a\\":1,\\"a\\":2}"')).toBe(false);
  });

  test("agrees with the tree it was serialised from", () => {
    fc.assert(
      fc.property(tree, fc.infiniteStream(fc.boolean()), (t, flips) => {
        const it = flips[Symbol.iterator]();
        const text = serialise(t, () => it.next().value as boolean);
        JSON.parse(text);
        expect(hasDuplicateKey(text)).toBe(duplicated(t));
      }),
      { numRuns },
    );
  });

  test("JSON.stringify never produces a duplicate", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => !hasDuplicateKey(JSON.stringify(v))),
      { numRuns },
    );
  });

  test("deep nesting costs no call stack", () => {
    const depth = 200_000;
    const text = `${'{"a":['.repeat(depth)}1${"]}".repeat(depth)}`;
    expect(hasDuplicateKey(text)).toBe(false);
  });
});
