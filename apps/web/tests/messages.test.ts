import { POLL_FAILURES } from "@abolishus/core/poll-failures";
import { describe, expect, test } from "vite-plus/test";
import { catalogs, POLL_FAILURE_MESSAGES } from "../src/messages.ts";

// A failed poll's reason in plain words (ADR 0032, rule 14; P2-22 part
// 5d-2): every code core writes has its own message in every catalog, and
// no message shows the code, a hash or an identifier.

describe("POLL_FAILURE_MESSAGES", () => {
  test("words every failure code with its own message, in every catalog", () => {
    expect(Object.keys(POLL_FAILURE_MESSAGES).sort()).toEqual([...POLL_FAILURES].sort());
    const keys = Object.values(POLL_FAILURE_MESSAGES);
    expect(new Set(keys).size).toBe(keys.length);
    for (const catalog of Object.values(catalogs)) {
      const words = keys.map((k) => catalog[k]);
      expect(new Set(words).size).toBe(words.length);
      for (const w of words) expect(typeof w === "string" && w.length > 0).toBe(true);
    }
    // Nothing else claims to word a failure.
    expect(
      Object.keys(catalogs["en-US"]!)
        .filter((k) => k.startsWith("pollFailure_"))
        .sort(),
    ).toEqual([...keys].sort());
  });

  test("never shows a code, a hash or an identifier", () => {
    for (const catalog of Object.values(catalogs))
      for (const key of Object.values(POLL_FAILURE_MESSAGES)) {
        const words = catalog[key];
        if (typeof words !== "string") throw new Error(`${key} isn't plain text`);
        for (const failure of POLL_FAILURES) expect(words).not.toContain(failure);
        expect(words).not.toMatch(/0x|[0-9a-f]{8}|hash|\{/i);
      }
  });
});

// "Setting up your poll" (P2-22 part 6d) words each step for the author,
// never as the worker names its states (ADR 0032, rule 14; T-34).
describe("setup's steps", () => {
  test("never name a worker state, a code or a hash", () => {
    for (const catalog of Object.values(catalogs))
      for (const [key, words] of Object.entries(catalog))
        if (key.startsWith("setupStep_") || key === "setupNow") {
          if (typeof words !== "string") throw new Error(`${key} isn't plain text`);
          expect(words).not.toMatch(
            /rooted|ceremony|registered|stub|electorate|0x|[0-9a-f]{8}|hash/i,
          );
        }
  });
});
