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

// Format-4 bundles under definition version 6 without an author panel:
// spoiled-ballot opening version 3, of ballot version 4's cores, checked over
// both halves against the definition's cells and questions and the key set
// its transcript registered, and judged against challenge.md's Publication
// rules as far as the floor of s_S decides them (docs/spec/verifier.md,
// Spoiled-ballot openings). Fixtures: docs/spec/vectors/verifier-openings-v3.json
// (packages/crypto/scripts/verifier-openings-v3-vectors.py, an independent
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
  readonly openings: Report["openings"];
}

const file = read("verifier-openings-v3.json") as {
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
// An opening entry's cell byte: the 51-byte envelope, the record's 3-byte
// header and the 32-byte definition hash precede it.
const CELL_AT = 86;

const runs = (cap: number) => Math.min(Number(process.env["FC_NUM_RUNS"] ?? 100), cap);

const json = (c: Case) =>
  JSON.stringify({
    format: BUNDLE_FORMAT_CEREMONY,
    definition: c.definition,
    clock: c.clock,
    l1,
    panel: file.panels[c.panel],
  });

const run = (c: Case, board = hex(c.board)) => verifyBundle(parseBundle(json(c), board));

const row = (r: Report, id = "6.2") => {
  const { status, code, at } = r.checks.find((x) => x.id === id) as CheckResult;
  return { status, ...(code !== undefined && { code }), ...(at !== undefined && { at }) };
};
const entriesOf = (c: Case) => parseBundle(json(c), hex(c.board)).entries;
const join = (entries: readonly Uint8Array[]) => Uint8Array.from(entries.flatMap((e) => [...e]));

test("the fixtures cover every check, decoding, every decided rule, both failing halves' panel and votes outside naming their question", () => {
  const all = file.cases.flatMap((c) => c.openings ?? []);
  expect(new Set(all.flatMap((o) => (o.code === undefined ? [] : [o.code])))).toEqual(
    new Set([
      "decode",
      "opening-stray",
      "opening-cell",
      "opening-shape",
      "opening-unqualified",
      "opening-vss",
      "opening-ciphertext",
    ]),
  );
  expect(new Set(all.flatMap((o) => o.breaks.map((b) => b.code)))).toEqual(
    new Set(["opening-early", "opening-cast", "opening-repeat"]),
  );
  expect(new Set(all.flatMap((o) => (o.voteOutside === true ? [o.question] : [])))).toEqual(
    new Set([1, 2]),
  );
  // Without an author panel only the default half can fail its VSS or a
  // seat's ciphertext.
  expect(
    new Set(all.flatMap((o) => ((o.option ?? o.seat) === undefined ? [] : [o.panel]))),
  ).toEqual(new Set([1]));
  expect(new Set(file.cases.map((c) => c.expected["6.2"]?.["status"]))).toEqual(
    new Set(["pass", "fail", "unverifiable"]),
  );
});

describe("6.2 against the independent implementation", () => {
  for (const c of file.cases)
    test(c.id, { timeout: 60_000 }, () => {
      const r = run(c);
      expect(row(r)).toEqual(c.expected["6.2"]);
      expect(row(r, "2.3")).toEqual(c.expected["2.3"]);
      expect(r.openings).toEqual(c.openings);
      // A ballot is rejected only for its segment: a board-path one above
      // the floor is late (5.5), so opening-cast never needs s_S for it.
      expect(r.ballots?.rejected.every((b) => b.code === "window-boarded-late")).toBe(true);
      // An opening never counts, displaces or fails anything (T-53).
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
          expect(o?.panel).toBe(want.panel);
          expect(o?.coreHash).toBe(want.coreHash);
          expect(o?.votes).toEqual(want.votes);
          expect(o?.question).toBe(want.question);
          expect(o?.breaks.some((b) => b.code === "opening-early")).toBe(
            want.breaks.some((b) => b.code === "opening-early"),
          );
        });
      }),
      { numRuns: runs(20) },
    );
  }, 120_000);

  test("a cast ballot dropped from the copy no longer makes its opening cast", () => {
    // Entry 1 is the segment-0 ballot, entry 6 the opening re-using its commitment.
    expect(whole.get(6)?.breaks).toEqual([{ code: "opening-cast", ballot: 1 }]);
    const r = run(mixed, join([0, 6].map((i) => entries[i] as Uint8Array)));
    expect(r.openings?.[0]?.breaks).toEqual([]);
  });

  test("any change to a passing opening's record but its cell makes it fail", () => {
    const at = 7;
    const opening = entries[at] as Uint8Array;
    expect(whole.get(at)).toMatchObject({ breaks: [] });
    expect(whole.get(at)?.code).toBeUndefined();
    fc.assert(
      // From the record's first field on: the 51-byte envelope and the
      // record's 3-byte header precede it. The cell byte has its own test
      // below: another cell the partition has opens another core.
      fc.property(
        fc.integer({ min: 54, max: opening.length - 1 }).filter((i) => i !== CELL_AT),
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

  test("another cell makes the opening one of another core, or fails opening-cell", () => {
    const at = 7;
    const opening = entries[at] as Uint8Array;
    const own = whole.get(at)?.coreHash;
    expect(own).toBeDefined();
    let otherCells = 0;
    for (const cell of [0, 1, 2, 3, 255]) {
      if (cell === opening[CELL_AT]) continue;
      const changed = Uint8Array.from(opening);
      changed[CELL_AT] = cell;
      const o = run(mixed, join([entries[0] as Uint8Array, changed])).openings?.[0];
      // The core hash binds the cell (docs/spec/challenge.md, Opening version
      // 3), so an opening re-labelled to a cell the partition has is a valid
      // opening of a core with another tracking code, never of this ballot's.
      if (o?.code === undefined) {
        otherCells++;
        expect(o?.coreHash).toBeDefined();
        expect(o?.coreHash).not.toBe(own);
      } else expect(o.code).toBe("opening-cell");
    }
    // The partition has three cells, so both branches run.
    expect(otherCells).toBe(2);
  }, 120_000);
});

describe("opening-cast compares with admitted ballots only", () => {
  test("a ballot at the floor that admission rejects makes no opening cast", () => {
    // cast-at-floor: entry 2 is the tier-2 ballot in segment 3, entry 3 the
    // opening re-using its commitment. A changed last byte of the ballot's
    // last range proof rejects it, leaving its C_j as they were.
    const c = byId("cast-at-floor");
    const entries = entriesOf(c);
    const ballot = Uint8Array.from(entries[2] as Uint8Array);
    ballot[ballot.length - 1] = (ballot[ballot.length - 1] as number) ^ 1;
    const r = run(c, join([entries[0], entries[1], ballot, entries[3]] as Uint8Array[]));
    expect(r.ballots?.rejected.map((b) => b.entry)).toEqual([2]);
    expect(r.openings?.[0]?.breaks).toEqual([]);
    expect(row(r)).toEqual({ status: "unverifiable", code: "not-implemented" });
  });
});
