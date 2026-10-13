import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  BUNDLE_FORMAT_CEREMONY,
  type CheckResult,
  parseBundle,
  type Report,
  verifyBundle,
} from "../src/index.ts";
import { countedFloor } from "../src/openings.ts";

// Format-4 bundles: the spoiled-ballot openings, 6.2, checked against the
// definition and the key set its transcript registered, and judged against
// challenge.md's Publication rules as far as the floor of s_S decides them
// (docs/spec/verifier.md, Spoiled-ballot openings). Fixtures:
// docs/spec/vectors/verifier-openings.json
// (packages/crypto/scripts/verifier-openings-vectors.py, an independent
// implementation), with l1-anchor.json's L1 evidence, which matters only to
// 4.1 and 4.2.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;

interface Case {
  readonly id: string;
  readonly panel: string;
  readonly definition: string;
  readonly clock: Readonly<Record<string, string>>;
  readonly board: string;
  readonly expected: Readonly<Record<string, Record<string, unknown>>>;
  readonly openings?: Report["openings"];
}

const file = read("verifier-openings.json") as {
  readonly panels: Readonly<
    Record<string, { readonly threshold: string; readonly keys: string[] }>
  >;
  readonly cases: readonly Case[];
};
const l1File = read("l1-anchor.json") as {
  readonly vectors: readonly {
    readonly id: string;
    readonly firstSegment: string;
    readonly block: { readonly header: string };
    readonly nodes: readonly string[];
    readonly checkpoints: readonly string[];
  }[];
};
const closed = l1File.vectors.find((v) => v.id === "closed");
if (closed === undefined) throw new Error("no closed L1 vector");
const l1 = {
  firstSegment: closed.firstSegment,
  header: closed.block.header,
  nodes: closed.nodes,
  checkpoints: closed.checkpoints,
};

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const byId = (id: string) => {
  const c = file.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};
const runs = (cap: number) => Math.min(Number(process.env["FC_NUM_RUNS"] ?? 100), cap);

const json = (c: Case, clock = c.clock) =>
  JSON.stringify({
    format: BUNDLE_FORMAT_CEREMONY,
    definition: c.definition,
    clock,
    l1,
    panel: file.panels[c.panel],
  });

const run = (c: Case, board = hex(c.board), clock = c.clock) =>
  verifyBundle(parseBundle(json(c, clock), board));

const row = (r: Report) => {
  const { status, code, at } = r.checks.find((x) => x.id === "6.2") as CheckResult;
  return { status, ...(code !== undefined && { code }), ...(at !== undefined && { at }) };
};
const entriesOf = (c: Case) => parseBundle(json(c), hex(c.board)).entries;
const join = (entries: readonly Uint8Array[]) => Uint8Array.from(entries.flatMap((e) => [...e]));

test("the fixtures cover every check, decoding, every decided rule and a vote outside the rules", () => {
  const all = file.cases.flatMap((c) => c.openings ?? []);
  expect(new Set(all.flatMap((o) => (o.code === undefined ? [] : [o.code])))).toEqual(
    new Set([
      "decode",
      "opening-stray",
      "opening-tier",
      "opening-shape",
      "opening-unqualified",
      "opening-vss",
      "opening-ciphertext",
    ]),
  );
  expect(new Set(all.flatMap((o) => o.breaks.map((b) => b.code)))).toEqual(
    new Set(["opening-early", "opening-cast", "opening-repeat"]),
  );
  expect(all.some((o) => o.voteOutside === true)).toBe(true);
  expect(new Set(file.cases.map((c) => c.expected["6.2"]?.["status"]))).toEqual(
    new Set(["pass", "fail", "unverifiable"]),
  );
});

describe("6.2 against the independent implementation", () => {
  for (const c of file.cases)
    test(c.id, () => {
      const r = run(c);
      expect(row(r)).toEqual(c.expected["6.2"]);
      expect(r.openings).toEqual(c.openings);
      // An opening never counts, displaces or fails anything: 6.2 is an
      // admission row, and the copy is a local file (T-53).
      expect(r.verdict).toBe("unverifiable");
      expect(r.verdictAgainstInputs).not.toBe("failed");
    });
});

describe("each opening is judged from its own entry", () => {
  const mixed = byId("mixed");
  const entries = entriesOf(mixed);
  const whole = new Map((run(mixed).openings ?? []).map((o) => [o.entry, o] as const));

  test("any subset of the copy gives every kept opening the checks, tracking code, vote and earliness it has in the whole copy", () => {
    fc.assert(
      fc.property(fc.subarray([...entries.keys()].slice(1)), (kept) => {
        const r = run(mixed, join([0, ...kept].map((i) => entries[i] as Uint8Array)));
        const got = new Map((r.openings ?? []).map((o) => [o.entry, o] as const));
        kept.forEach((i, at) => {
          const want = whole.get(i);
          if (want === undefined) return expect(got.has(at + 1)).toBe(false);
          const o = got.get(at + 1);
          expect(o?.code).toBe(want.code);
          expect(o?.coreHash).toBe(want.coreHash);
          expect(o?.votes).toEqual(want.votes);
          expect(o?.breaks.some((b) => b.code === "opening-early")).toBe(
            want.breaks.some((b) => b.code === "opening-early"),
          );
        });
      }),
      { numRuns: runs(20) },
    );
  }, 120_000);

  test("an opening is a repeat exactly when an earlier kept entry carries its core, whatever that one's checks", () => {
    // Entries 12 and 15 are one honest opening, 14 and 16 one stray opening.
    const r = run(mixed, join([0, 16, 14, 15].map((i) => entries[i] as Uint8Array)));
    expect(r.openings?.map((o) => o.breaks)).toEqual([[], [{ code: "opening-repeat", of: 1 }], []]);
  });

  test("a cast ballot dropped from the copy no longer makes its opening cast", () => {
    // Entry 1 is the segment-0 ballot, entry 11 the opening re-using its commitment.
    const kept = [0, 1, 11].map((i) => entries[i] as Uint8Array);
    expect(run(mixed, join(kept)).openings?.[0]?.breaks).toEqual([
      { code: "opening-cast", ballot: 1 },
    ]);
    expect(
      run(mixed, join([kept[0] as Uint8Array, kept[2] as Uint8Array])).openings?.[0]?.breaks,
    ).toEqual([]);
  });

  test("any change to a passing opening's record makes it fail", () => {
    const at = 10;
    const opening = entries[at] as Uint8Array;
    expect(whole.get(at)).toMatchObject({ breaks: [] });
    expect(whole.get(at)?.code).toBeUndefined();
    fc.assert(
      // From the record's first field on: the 51-byte envelope and the
      // record's 3-byte header precede it.
      fc.property(
        fc.integer({ min: 54, max: opening.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (i, x) => {
          const changed = Uint8Array.from(opening);
          changed[i] = (changed[i] as number) ^ x;
          const r = run(mixed, join([entries[0] as Uint8Array, changed]));
          expect(r.openings?.[0]?.code).toBeDefined();
          expect(row(r).status).toBe("fail");
        },
      ),
      { numRuns: runs(40) },
    );
  }, 120_000);

  test("an opening of another election's board isn't this election's to judge", () => {
    const other = Uint8Array.from(entries[10] as Uint8Array);
    other[3] = (other[3] as number) ^ 1;
    const r = run(mixed, join([entries[0] as Uint8Array, other]));
    expect(r.openings).toEqual([]);
    expect(row(r)).toEqual({ status: "pass" });
  });
});

describe("the floor of s_S", () => {
  test("is period(closes_at) + 1, rounding down before the epoch", () => {
    const clock = { epoch: 1000n, period: 10n, deadline: 0n, lastSegment: 9 };
    expect(countedFloor(1000n, clock)).toBe(1n);
    expect(countedFloor(1009n, clock)).toBe(1n);
    expect(countedFloor(1010n, clock)).toBe(2n);
    expect(countedFloor(999n, clock)).toBe(0n);
    expect(countedFloor(990n, clock)).toBe(0n);
    expect(countedFloor(989n, clock)).toBe(-1n);
  });

  test("moving close past the early opening's segment leaves it undecided", () => {
    const settled = byId("settled");
    // An epoch one period later puts close in period 1 and the floor at 2,
    // below the early opening's segment 3 and above the cast ballot's 0.
    const clock = {
      ...settled.clock,
      epoch: String(BigInt(settled.clock["epoch"] as string) + 3600n),
    };
    const r = run(settled, hex(settled.board), clock);
    expect(r.openings?.[0]?.breaks).toEqual([]);
    expect(r.openings?.[2]?.breaks).toEqual([{ code: "opening-cast", ballot: 1 }]);
    expect(row(r)).toEqual({ status: "unverifiable", code: "not-implemented" });
  });
});
