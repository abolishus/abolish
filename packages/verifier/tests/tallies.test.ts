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

// Format-4 bundles: the tally openings, 7.4, sorted into cells or stray,
// attributed by the key set the transcript registered, and judged against
// tally.md's Boarding rule as far as the bundle decides it without the
// counted set (docs/spec/verifier.md, Tally openings). Fixtures:
// docs/spec/vectors/verifier-tallies.json
// (packages/crypto/scripts/verifier-tallies-vectors.py, an independent
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
  readonly tallies?: Report["tallies"];
}

const file = read("verifier-tallies.json") as {
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

const json = (c: Case) =>
  JSON.stringify({
    format: BUNDLE_FORMAT_CEREMONY,
    definition: c.definition,
    clock: c.clock,
    l1,
    panel: file.panels[c.panel],
  });

const run = (c: Case, board = hex(c.board)) => verifyBundle(parseBundle(json(c), board));

const row = (r: Report) => {
  const { status, code, at } = r.checks.find((x) => x.id === "7.4") as CheckResult;
  return { status, ...(code !== undefined && { code }), ...(at !== undefined && { at }) };
};
const entriesOf = (c: Case) => parseBundle(json(c), hex(c.board)).entries;
const join = (entries: readonly Uint8Array[]) => Uint8Array.from(entries.flatMap((e) => [...e]));

test("the fixtures cover decoding, every decided boarding rule and every status", () => {
  const all = file.cases.flatMap((c) => c.tallies ?? []);
  expect(new Set(all.flatMap((o) => (o.code === undefined ? [] : [o.code])))).toEqual(
    new Set(["decode"]),
  );
  expect(new Set(all.flatMap((o) => o.breaks.map((b) => b.code)))).toEqual(
    new Set(["tally-stray", "tally-missing", "tally-unattributed", "tally-second", "tally-repeat"]),
  );
  expect(new Set(file.cases.map((c) => c.expected["7.4"]?.["code"]))).toEqual(
    new Set([
      undefined,
      "decode",
      "tally-stray",
      "tally-missing",
      "tally-unattributed",
      "not-implemented",
      "not-reached",
      "unsupported-version",
    ]),
  );
});

describe("7.4 against the independent implementation", () => {
  for (const c of file.cases)
    test(c.id, { timeout: 60_000 }, () => {
      const r = run(c);
      expect(row(r)).toEqual(c.expected["7.4"]);
      expect(r.tallies).toEqual(c.tallies);
      // 7.4 reports and attributes; it never decides the verdict, and the
      // copy is a local file (T-53).
      const failed = r.checks.some((x) => x.kind === "election" && x.status === "fail");
      expect(r.verdictAgainstInputs).toBe(failed ? "failed" : "unverifiable");
      expect(r.verdict).toBe("unverifiable");
    });
});

describe("each opening is judged from its own entry", () => {
  const mixed = byId("mixed");
  const entries = entriesOf(mixed);
  const whole = new Map((run(mixed).tallies ?? []).map((o) => [o.entry, o] as const));

  test("any subset of the copy keeps each opening's cell, signer and breaks, and a second is one exactly after a kept opening by its seat", () => {
    fc.assert(
      fc.property(fc.subarray([...entries.keys()].slice(1)), (kept) => {
        const r = run(mixed, join([0, ...kept].map((i) => entries[i] as Uint8Array)));
        const got = new Map((r.tallies ?? []).map((o) => [o.entry, o] as const));
        const firsts = new Map<string, number>();
        kept.forEach((i, at) => {
          const want = whole.get(i);
          if (want === undefined) return expect(got.has(at + 1)).toBe(false);
          const o = got.get(at + 1);
          expect(o?.code).toBe(want.code);
          expect(o?.cell).toBe(want.cell);
          expect(o?.signer).toBe(want.signer);
          const others = (x: typeof o) =>
            x?.breaks.filter((b) => b.code !== "tally-second" && b.code !== "tally-repeat");
          expect(others(o)).toEqual(others(want));
          if (want.cell === undefined || want.signer === null || want.signer === undefined) return;
          const key = `${want.cell}/${want.signer}`;
          const of = firsts.get(key);
          if (of === undefined) firsts.set(key, at + 1);
          // The mixed copy's openings by one seat of one cell all differ, so
          // a later one is a second, never a repeat.
          expect(
            o?.breaks.find((b) => b.code === "tally-second" || b.code === "tally-repeat"),
          ).toEqual(of === undefined ? undefined : { code: "tally-second", of });
        });
      }),
      { numRuns: runs(30) },
    );
  }, 120_000);

  test("any change to an attributed opening's record leaves it undecodable or unattributed", () => {
    const at = 1;
    const opening = entries[at] as Uint8Array;
    expect(whole.get(at)).toEqual({ entry: 1, cell: 0, signer: 1, breaks: [] });
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
          const o = r.tallies?.[0];
          expect(o?.code === "decode" || o?.signer === null).toBe(true);
          expect(row(r).status).toBe("fail");
        },
      ),
      { numRuns: runs(40) },
    );
  }, 120_000);

  test("an opening is unattributed once its seat isn't in the registered key set", () => {
    // Entry 7 is a cell-1 opening validly signed by seat 4's per-election
    // key, which the transcript never registered (seat 4 sent nothing).
    expect(whole.get(7)).toEqual({
      entry: 7,
      cell: 1,
      signer: null,
      breaks: [{ code: "tally-unattributed" }],
    });
  });
});

test("a replay of a seat's signed opening is a repeat, the operator's alone, never a second", () => {
  // Entries 1 and 3 of second-by-seat are byte-identical; 4 and 5 are seat
  // 1's other openings of the same cell. Dropping the first copy makes the
  // replay the first and leaves the others seconds of it (T-29).
  const c = byId("second-by-seat");
  const entries = entriesOf(c);
  const r = run(c, join([0, 3, 4, 5].map((i) => entries[i] as Uint8Array)));
  expect(r.tallies?.map((o) => o.breaks)).toEqual([
    [],
    [{ code: "tally-second", of: 1 }],
    [{ code: "tally-second", of: 1 }],
  ]);
});
