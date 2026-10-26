import { MAX_MANIFEST_LINKS } from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  type ChainManifest,
  locatorManifest,
  needsLinkingManifest,
  nextManifestLinks,
} from "../src/index.ts";

// The archive manifests' chain (src/archive-chain.ts; docs/spec/archive.md,
// Who writes them): out-of-order and failed uploads never leave a confirmed
// manifest unreachable from one written after it confirmed, and a locator
// names only a manifest that reaches every manifest before it (T-51, T-49).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const m = (links: number[], confirmed = true): ChainManifest => ({ links, confirmed });

/** Every manifest `from` reaches through confirmed manifests, by brute force. */
function reached(chain: readonly ChainManifest[], from: number): Set<number> {
  const out = new Set<number>();
  const todo = [...(chain[from]?.links ?? [])];
  while (todo.length > 0) {
    const k = todo.shift() as number;
    if (out.has(k) || chain[k]?.confirmed !== true) continue;
    out.add(k);
    todo.push(...(chain[k]?.links ?? []));
  }
  return out;
}

const meetsRule = (chain: readonly ChainManifest[], k: number) =>
  chain[k]?.confirmed === true && reached(chain, k).size === k;

/** A history: write the next manifest, or confirm one written (by a pick among the unconfirmed). */
const historyArb = fc.array(fc.oneof(fc.constant(-1), fc.nat({ max: 1000 })), {
  minLength: 1,
  maxLength: 120,
});

interface Run {
  chain: ChainManifest[];
  written: number[];
  confirmedAt: (number | undefined)[];
}

/** Plays a history as the worker would, checking `check` after every step. */
function play(steps: readonly number[], maxLinks: number, check: (run: Run) => void): Run {
  const run: Run = { chain: [], written: [], confirmedAt: [] };
  for (const [t, step] of steps.entries()) {
    const pending = run.chain.flatMap((x, k) => (x.confirmed ? [] : [k]));
    if (step === -1 || pending.length === 0) {
      run.chain.push(m(nextManifestLinks(run.chain, maxLinks), false));
      run.written.push(t);
      run.confirmedAt.push(undefined);
    } else {
      const k = pending[step % pending.length] as number;
      run.chain[k] = m([...(run.chain[k] as ChainManifest).links]);
      run.confirmedAt[k] = t;
    }
    check(run);
  }
  return run;
}

describe("nextManifestLinks", () => {
  test("links nothing before any manifest confirms", () => {
    expect(nextManifestLinks([])).toEqual([]);
    expect(nextManifestLinks([m([], false), m([], false)])).toEqual([]);
  });

  test("links the confirmed manifests no confirmed manifest links", () => {
    expect(nextManifestLinks([m([]), m([0]), m([1])])).toEqual([2]);
    // 1 never confirmed, so 0 is reached only through it: linked again.
    expect(nextManifestLinks([m([]), m([0], false), m([1])])).toEqual([0, 2]);
    // 1 confirmed after 2 was written: a root again.
    expect(nextManifestLinks([m([]), m([0]), m([0])])).toEqual([1, 2]);
  });

  test("links the lowest roots first, at most maxLinks", () => {
    const chain = [m([]), m([]), m([]), m([])];
    expect(nextManifestLinks(chain, 2)).toEqual([0, 1]);
    expect(nextManifestLinks(chain)).toEqual([0, 1, 2, 3]);
  });

  test("refuses links out of order, repeated or not below the manifest", () => {
    for (const links of [[1], [2], [0, 0], [0.5], [-1]])
      expect(() => nextManifestLinks([m([]), m(links)])).toThrow(RangeError);
    expect(() => nextManifestLinks([m([]), m([]), m([1, 0])])).toThrow(RangeError);
    expect(() => nextManifestLinks([m([0])])).toThrow(RangeError);
  });

  test("refuses maxLinks outside 2 to MAX_MANIFEST_LINKS", () => {
    for (const maxLinks of [0, 1, MAX_MANIFEST_LINKS + 1, 1.5])
      expect(() => nextManifestLinks([], maxLinks)).toThrow(RangeError);
  });

  test("a confirmed manifest stays reachable from every manifest written after it confirmed", () => {
    fc.assert(
      fc.property(historyArb, (steps) => {
        play(steps, MAX_MANIFEST_LINKS, ({ chain, written, confirmedAt }) => {
          for (const [k, x] of chain.entries()) {
            if (!x.confirmed) continue;
            const r = reached(chain, k);
            for (const [c, at] of confirmedAt.entries())
              if (c < k && at !== undefined && at < (written[k] as number))
                expect(r.has(c), `${c} from ${k}`).toBe(true);
          }
        });
      }),
      { numRuns },
    );
  });
});

describe("locatorManifest", () => {
  test("names nothing while no manifest reaches all before it", () => {
    expect(locatorManifest([])).toBeUndefined();
    expect(locatorManifest([m([], false)])).toBeUndefined();
    expect(locatorManifest([m([], false), m([])])).toBeUndefined();
  });

  test("names the highest confirmed manifest that reaches every one before it", () => {
    expect(locatorManifest([m([])])).toBe(0);
    expect(locatorManifest([m([]), m([0]), m([1])])).toBe(2);
    // 2 links 0 only: 1 confirmed late, so 1 is named until a manifest links both.
    expect(locatorManifest([m([]), m([0]), m([0])])).toBe(1);
    expect(locatorManifest([m([]), m([0]), m([0]), m([1, 2])])).toBe(3);
    // Reached only through an unconfirmed manifest isn't reached.
    expect(locatorManifest([m([]), m([0], false), m([1])])).toBe(0);
    expect(locatorManifest([m([]), m([0], false), m([0, 1])])).toBe(0);
  });

  test("is the brute force's answer, reaches every manifest before it and never falls", () => {
    fc.assert(
      fc.property(historyArb, fc.integer({ min: 2, max: 4 }), (steps, maxLinks) => {
        let last = -1;
        play(steps, maxLinks, ({ chain }) => {
          const named = locatorManifest(chain);
          const brute = chain.findLastIndex((_, k) => meetsRule(chain, k));
          expect(named ?? -1).toBe(brute);
          expect(named ?? -1).toBeGreaterThanOrEqual(last);
          last = named ?? -1;
        });
      }),
      { numRuns },
    );
  });
});

describe("needsLinkingManifest", () => {
  test("asks for one only once every manifest confirmed and the latest isn't named", () => {
    expect(needsLinkingManifest([])).toBe(false);
    expect(needsLinkingManifest([m([])])).toBe(false);
    expect(needsLinkingManifest([m([]), m([0])])).toBe(false);
    expect(needsLinkingManifest([m([]), m([])])).toBe(true);
    expect(needsLinkingManifest([m([]), m([0]), m([0])])).toBe(true);
    // 1 is still to confirm: its upload is posted again instead.
    expect(needsLinkingManifest([m([]), m([0], false), m([0])])).toBe(false);
  });

  test("once every upload confirms, linking manifests bring the locator to the latest", () => {
    fc.assert(
      fc.property(historyArb, fc.integer({ min: 2, max: 4 }), (steps, maxLinks) => {
        const { chain } = play(steps, maxLinks, () => {});
        for (const [k, x] of chain.entries()) chain[k] = m([...x.links]);
        // Each linking manifest leaves at least one root fewer, so this bounds it.
        for (let i = 0; i <= chain.length && needsLinkingManifest(chain); i++)
          chain.push(m(nextManifestLinks(chain, maxLinks)));
        expect(needsLinkingManifest(chain)).toBe(false);
        expect(locatorManifest(chain)).toBe(chain.length - 1);
      }),
      { numRuns },
    );
  });
});
