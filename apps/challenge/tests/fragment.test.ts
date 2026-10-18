import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { ACTIONS, isToken, parseFragment } from "../src/fragment.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const ENTRY = "https://ballot.example";
const OTHER = "https://ballot.example:8443";
const ENTRY_POINTS = [ENTRY, OTHER];

/** The fragment the ballot client's `challengeFrameSrc` writes. */
const fragment = (origin: string, action: string) =>
  `#origin=${encodeURIComponent(origin)}&action=${action}`;

describe("parseFragment", () => {
  test("reads each entry point and action as the client writes them", () => {
    for (const origin of ENTRY_POINTS)
      for (const action of ACTIONS)
        expect(parseFragment(fragment(origin, action), ENTRY_POINTS)).toEqual({ origin, action });
    expect(
      parseFragment("#origin=https%3A%2F%2Fballot.example&action=tier0-register", [ENTRY]),
    ).toEqual({ origin: ENTRY, action: "tier0-register" });
  });

  test("refuses an origin that isn't an entry point, however it is written", () => {
    for (const origin of [
      "https://evil.example",
      "https://ballot.example/",
      "https://BALLOT.example",
      "http://ballot.example",
      "https://ballot.example:443",
      "null",
      "",
    ])
      expect(parseFragment(fragment(origin, "tier0-register"), ENTRY_POINTS)).toBeUndefined();
  });

  test("refuses any other shape", () => {
    const good = fragment(ENTRY, "tier0-register");
    for (const hash of [
      "",
      "#",
      good.slice(1),
      `${good}&`,
      `${good}&x=1`,
      `#&${good.slice(1)}`,
      `#action=tier0-register&origin=${encodeURIComponent(ENTRY)}`,
      `#origin=${encodeURIComponent(ENTRY)}`,
      "#action=tier0-register",
      `#origin=${encodeURIComponent(ENTRY)}&origin=${encodeURIComponent(ENTRY)}`,
      `#origin=${encodeURIComponent(ENTRY)}&action=tier0-register=`,
      `#origin=${encodeURIComponent(ENTRY)}=&action=tier0-register`,
      `#origin&action=tier0-register`,
      `#Origin=${encodeURIComponent(ENTRY)}&action=tier0-register`,
      `#origin=${encodeURIComponent(ENTRY)}&action=Tier0-register`,
      `#origin=${encodeURIComponent(ENTRY)}&action=tier0%2Dregister`,
      `#origin=${encodeURIComponent(ENTRY)}&action=`,
      `#origin=${encodeURIComponent(ENTRY)}&action=account-create`,
      // Not the one encoding `encodeURIComponent` gives.
      `#origin=${ENTRY}&action=tier0-register`,
      "#origin=https%3a%2f%2fballot.example&action=tier0-register",
      "#origin=https%3A//ballot.example&action=tier0-register",
      "#origin=%68ttps%3A%2F%2Fballot.example&action=tier0-register",
      "#origin=https%3A%2F%2Fballot.example%&action=tier0-register",
      "#origin=https%3A%2F%2Fballot.example%E0%A4%A&action=tier0-register",
    ])
      expect(parseFragment(hash, ENTRY_POINTS), hash).toBeUndefined();
  });

  test("names each request by exactly one fragment", () => {
    // Whatever parses is the client's own fragment for what it parsed to,
    // so no other string can stand for the same request.
    const near = fc.oneof(
      fc.string(),
      fc
        .tuple(
          fc.constantFrom(...ENTRY_POINTS.map((o) => fragment(o, "tier1-relay"))),
          fc.nat(),
          fc.string({ maxLength: 4 }),
        )
        .map(([s, at, insert]) => s.slice(0, at % s.length) + insert + s.slice(at % s.length)),
    );
    fc.assert(
      fc.property(near, (hash) => {
        const request = parseFragment(hash, ENTRY_POINTS);
        if (request !== undefined) expect(fragment(request.origin, request.action)).toBe(hash);
      }),
      { numRuns },
    );
  });

  test("never names an origin outside the entry points", () => {
    fc.assert(
      fc.property(fc.webUrl(), fc.constantFrom(...ACTIONS), (url, action) => {
        const { origin } = new URL(url);
        const request = parseFragment(fragment(origin, action), [ENTRY]);
        expect(request === undefined || request.origin === ENTRY).toBe(true);
        expect(request !== undefined).toBe(origin === ENTRY);
      }),
      { numRuns },
    );
  });
});

describe("isToken", () => {
  test("accepts Turnstile's form and nothing else", () => {
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.integer({ min: 0x21, max: 0x7e }).map((c) => String.fromCharCode(c)),
          minLength: 1,
          maxLength: 2048,
        }),
        (token) => {
          expect(isToken(token)).toBe(true);
        },
      ),
      { numRuns },
    );
    for (const token of ["", " ", "a b", "a\n", "é", "x".repeat(2049), 1, null, undefined, ["a"]])
      expect(isToken(token)).toBe(false);
  });
});
