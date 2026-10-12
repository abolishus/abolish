import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { formatMessage, MessageFormatError, placeholders, templates } from "../src/i18n/format.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const name = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,8}$/);

describe("formatMessage", () => {
  it("substitutes string parameters", () => {
    expect(formatMessage("en-US", "Hello, {name}.", { name: "Ada" })).toBe("Hello, Ada.");
  });

  it("formats numbers for the locale", () => {
    expect(formatMessage("en-US", "{n} voters", { n: 40112 })).toBe("40,112 voters");
    expect(formatMessage("de-DE", "{n} Stimmen", { n: 40112 })).toBe("40.112 Stimmen");
    expect(formatMessage("en-US", "{n}", { n: 2n ** 64n })).toBe("18,446,744,073,709,551,616");
  });

  it("selects the plural category for the locale", () => {
    const voters = { one: "{count} voter", other: "{count} voters" };
    expect(formatMessage("en-US", voters, { count: 1 })).toBe("1 voter");
    expect(formatMessage("en-US", voters, { count: 0 })).toBe("0 voters");
    expect(formatMessage("en-US", voters, { count: 1n })).toBe("1 voter");
    const ru = {
      one: "{count} голос",
      few: "{count} голоса",
      many: "{count} голосов",
      other: "{count}",
    };
    expect(formatMessage("ru-RU", ru, { count: 3 })).toBe("3 голоса");
    expect(formatMessage("ru-RU", ru, { count: 5 })).toBe("5 голосов");
  });

  it("falls back to other when the locale's category is absent", () => {
    expect(formatMessage("ru-RU", { other: "{count} x" }, { count: 3 })).toBe("3 x");
  });

  it("rejects a plural without a numeric count", () => {
    expect(() => formatMessage("en-US", { other: "x" })).toThrow(MessageFormatError);
    expect(() => formatMessage("en-US", { other: "x" }, { count: "1" })).toThrow(
      MessageFormatError,
    );
  });

  it("rejects a missing parameter instead of showing a gap", () => {
    expect(() => formatMessage("en-US", "Hello, {name}.")).toThrow(MessageFormatError);
  });

  it("ignores inherited properties as parameters", () => {
    expect(() => formatMessage("en-US", "{toString}", {})).toThrow(MessageFormatError);
  });

  it("never reads a parameter's value as a placeholder", () => {
    // A value is often itself a placeholder for the other parameter, `x`.
    const values = fc.oneof(
      fc.string(),
      fc.constant("{x}"),
      fc.string().map((v) => `{x}${v}{x}`),
    );
    fc.assert(
      fc.property(
        name.filter((k) => k !== "x"),
        values,
        (key, value) => {
          expect(formatMessage("en-US", `<{${key}}>`, { [key]: value, x: "!" })).toBe(`<${value}>`);
        },
      ),
      { numRuns },
    );
  });

  it("leaves a template without placeholders unchanged", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => placeholders(s).length === 0),
        (template) => {
          expect(formatMessage("en-US", template)).toBe(template);
        },
      ),
      { numRuns },
    );
  });
});

describe("placeholders", () => {
  it("lists each name once, in order of first use", () => {
    expect(placeholders("{b} {a} {b} {9x} {}")).toEqual(["b", "a"]);
  });

  it("lists every template of a plural", () => {
    expect(templates({ one: "a", other: "b" })).toEqual(["a", "b"]);
    expect(templates("c")).toEqual(["c"]);
  });
});
