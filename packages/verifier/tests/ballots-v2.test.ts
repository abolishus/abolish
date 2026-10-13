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

// Format-4 bundles under definition versions 3 and 4, whose ballots (version
// 2) name their cell: ballot admission, 5.1 to 5.4 and 5.7, against the
// cell's root and scope in the definition and the key set its transcript
// check registered, and 6.2, which no opening version this verifier reads
// can judge (docs/spec/verifier.md, Ballot admission). Fixtures:
// docs/spec/vectors/verifier-ballots-v2.json
// (packages/crypto/scripts/verifier-ballots-v2-vectors.py, an independent
// implementation that builds each cell tree by the first-occurrence rule,
// with snarkjs's verdict on every membership proof), and l1-anchor.json's L1
// evidence and clock, which matter only to 4.1 and 4.2.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;

interface Case {
  readonly id: string;
  readonly panel: string;
  readonly definition: string;
  readonly board: string;
  readonly expected: Readonly<Record<string, Record<string, unknown>>>;
  readonly ballots?: Report["ballots"];
}

const file = read("verifier-ballots-v2.json") as {
  readonly panels: Readonly<
    Record<string, { readonly threshold: string; readonly keys: string[] }>
  >;
  readonly cases: readonly Case[];
};
const l1File = read("l1-anchor.json") as {
  readonly clock: Readonly<Record<string, string>>;
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
    clock: l1File.clock,
    l1,
    panel: file.panels[c.panel],
  });

const format4 = (c: Case, board = hex(c.board)) => verifyBundle(parseBundle(json(c), board));

const row = (r: Report, id: string) => r.checks.find((x) => x.id === id) as CheckResult;
const rows = (r: Report, ids: readonly string[]) =>
  Object.fromEntries(
    ids.map((id) => {
      const { status, code, at } = row(r, id);
      return [id, { status, ...(code !== undefined && { code }), ...(at !== undefined && { at }) }];
    }),
  );
const ADMISSION = ["5.1", "5.2", "5.3", "5.4", "5.7"];

const entriesOf = (c: Case) => parseBundle(json(c), hex(c.board)).entries;
const join = (entries: readonly Uint8Array[]) => Uint8Array.from(entries.flatMap((e) => [...e]));
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

test("the fixtures reject a ballot for every version-2 admission code and for decoding", () => {
  const codes = new Set(file.cases.flatMap((c) => (c.ballots?.rejected ?? []).map((r) => r.code)));
  expect([...codes].sort(byCode)).toEqual(
    [
      "ballot-cell",
      "ballot-stray",
      "decode",
      "membership-proof",
      "option-proof",
      "share-hash-unqualified",
      "sum-proof",
      "validity-shape",
    ].sort(byCode),
  );
});

describe("1.3, 2.3, 3.2, 5.1 to 5.4, 5.7 and 6.2 against the independent implementation", () => {
  for (const c of file.cases)
    test(c.id, () => {
      const r = format4(c);
      expect(rows(r, Object.keys(c.expected))).toEqual(c.expected);
      expect(r.ballots).toEqual(c.ballots);
      // No opening version this verifier reads opens version-2 cores.
      expect(r.openings).toBeUndefined();
      expect(r.verdict).toBe("unverifiable");
      // A rejected ballot rejects its entry only, never the election (T-52):
      // only an election check (here 1.3, 2.3 or 3.2) can make it fail.
      const failedElection = Object.entries(c.expected).some(
        ([id, o]) => !ADMISSION.includes(id) && id !== "6.2" && o["status"] === "fail",
      );
      expect(r.verdictAgainstInputs === "failed").toBe(failedElection);
    });
});

describe("admission is decided per entry", () => {
  const mixed = byId("mixed");
  const entries = entriesOf(mixed);
  const verdicts = (r: Report) =>
    new Map((r.ballots?.rejected ?? []).map((x) => [x.entry, x.code] as const));
  const full = verdicts(format4(mixed));

  test("any subset of the copy gives every kept ballot the verdict it has in the whole copy (R4)", () => {
    fc.assert(
      fc.property(fc.subarray([...entries.keys()], { minLength: 1 }), (kept) => {
        const r = format4(mixed, join(kept.map((i) => entries[i] as Uint8Array)));
        // The transcript is entry 0: without it no key set is registered.
        if (!kept.includes(0))
          for (const id of ADMISSION)
            expect(row(r, id)).toMatchObject({ status: "unverifiable", code: "not-reached" });
        else {
          const got = verdicts(r);
          kept.forEach((i, at) => expect(got.get(at)).toBe(full.get(i)));
          expect(r.ballots?.admitted).toBe(kept.filter((i) => i > 0 && !full.has(i)).length);
        }
      }),
      { numRuns: runs(20) },
    );
  }, 120_000);

  test("any change to an admitted ballot's record rejects it", () => {
    const admitted = byId("admitted");
    const all = entriesOf(admitted);
    const ballot = all[1] as Uint8Array;
    fc.assert(
      // From the record's first field on, past the 51-byte envelope and the
      // record's 3-byte header: the cell at 35 of the record included.
      fc.property(
        fc.integer({ min: 54, max: ballot.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, x) => {
          const changed = Uint8Array.from(ballot);
          changed[at] = (changed[at] as number) ^ x;
          const r = format4(admitted, join([all[0] as Uint8Array, changed]));
          expect(r.ballots?.admitted).toBe(0);
          expect(r.ballots?.rejected.map((b) => b.entry)).toEqual([1]);
        },
      ),
      { numRuns: runs(30) },
    );
  }, 120_000);

  test("a ballot naming another cell is judged against that cell's root and scope, never its own proof's", () => {
    // The cell 0 ballot renamed into each other cell, and past the
    // partition: its proof is cell 0's, so the definition's cells refuse it
    // (T-16; verifier 2.8).
    const admitted = byId("admitted");
    const all = entriesOf(admitted);
    const ballot = all[1] as Uint8Array;
    const cellAt = 51 + 35;
    expect(ballot[cellAt]).toBe(0);
    for (const [cell, code] of [
      [1, "membership-proof"],
      [2, "membership-proof"],
      [3, "ballot-cell"],
      [255, "ballot-cell"],
    ] as const) {
      const moved = Uint8Array.from(ballot);
      moved[cellAt] = cell;
      const r = format4(admitted, join([all[0] as Uint8Array, moved]));
      expect(r.ballots?.rejected).toEqual([{ entry: 1, code }]);
    }
  });
});

test("the report gives the ballots after the ceremony, with no openings", () => {
  const r = format4(byId("mixed"));
  expect(Object.keys(r)).toEqual([
    "format",
    "verdict",
    "verdictAgainstInputs",
    "inputs",
    "definition",
    "ceremony",
    "ballots",
    "board",
    "l1",
    "checks",
  ]);
});
