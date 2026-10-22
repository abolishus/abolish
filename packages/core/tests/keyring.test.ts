import { randomBytes } from "node:crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { assertDistinctKeyrings, parseKeyring } from "../src/index.ts";

// Server keyrings (ADR 0038, Keys; T-65): the text form, the current key, and
// errors that never quote a key.

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };
const hex = () => randomBytes(32).toString("hex");

describe("parseKeyring", () => {
  test("the last key is current, and every key is found by its ID", () => {
    const [a, b] = [hex(), hex()];
    const ring = parseKeyring(`2026-01:${a},2026-07:${b}`);
    expect(ring.current.id).toBe("2026-07");
    expect(Buffer.from(ring.current.key).toString("hex")).toBe(b);
    expect(ring.keys.map((k) => k.id)).toEqual(["2026-01", "2026-07"]);
    expect(Buffer.from(ring.get("2026-01")!).toString("hex")).toBe(a);
    expect(ring.get("2025-01")).toBeUndefined();
  });

  test("a key marked * is current, ahead of keys staged after it", () => {
    const [a, b, c] = [hex(), hex(), hex()];
    const ring = parseKeyring(`old:${a},now:${b}*,next:${c}`);
    expect(ring.current.id).toBe("now");
    expect(Buffer.from(ring.current.key).toString("hex")).toBe(b);
    expect(ring.keys.map((k) => k.id)).toEqual(["old", "now", "next"]);
    expect(Buffer.from(ring.get("next")!).toString("hex")).toBe(c);
    expect(() => parseKeyring(`a:${a}*,b:${b}*`)).toThrow(/entry 2 is a second current key/);
  });

  test.each([
    ["", 1],
    [`k1:*${hex()}`, 1],
    [`k1:${hex()}**`, 1],
    ["k1", 1],
    [`k1:${hex().slice(2)}`, 1],
    [`k1:${hex()}00`, 1],
    [`K1:${hex()}`, 1],
    [`k1:${hex().toUpperCase()}`, 1],
    [`:${hex()}`, 1],
    [`${"k".repeat(33)}:${hex()}`, 1],
    [`k1:${hex()},`, 2],
    [`k1:${hex()}, k2:${hex()}`, 2],
    [`k1:${hex()},k1:${hex()}`, 2],
  ])("refuses %j at entry %i", (text, entry) => {
    expect(() => parseKeyring(text)).toThrow(new RegExp(`entry ${entry} `));
  });

  test("refuses a key listed twice", () => {
    const k = hex();
    expect(() => parseKeyring(`a:${k},b:${k}`)).toThrow(/entry 2 repeats a key/);
  });

  test("an error never quotes the text it was given", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 8 }), (text) => {
        try {
          parseKeyring(text);
        } catch (e) {
          expect((e as Error).message).not.toContain(text);
        }
      }),
      runs,
    );
  });
});

describe("assertDistinctKeyrings", () => {
  test("passes distinct keyrings, and refuses one key in two of them", () => {
    const k = hex();
    expect(() =>
      assertDistinctKeyrings(parseKeyring(`a:${hex()}`), parseKeyring(`a:${hex()}`)),
    ).not.toThrow();
    expect(() =>
      assertDistinctKeyrings(parseKeyring(`a:${hex()},b:${k}`), parseKeyring(`c:${k}`)),
    ).toThrow(/more than one keyring/);
  });
});
