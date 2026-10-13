import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  BUNDLE_FORMAT_CEREMONY,
  BUNDLE_FORMAT_DEFINITION,
  type CheckResult,
  parseBundle,
  type Report,
  verifyBundle,
} from "../src/index.ts";

// Format-4 bundles: ballot admission, 5.1 to 5.4 and 5.7, against the definition and
// the key set its transcript check registered (docs/spec/verifier.md, Ballot
// admission). Fixtures: docs/spec/vectors/verifier-ballots.json
// (packages/crypto/scripts/verifier-ballots-vectors.py, an independent
// implementation, with snarkjs's verdict on every membership proof), and
// l1-anchor.json's L1 evidence and clock, which matter only to 4.1 and 4.2.

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

const file = read("verifier-ballots.json") as {
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

const json = (c: Case, definition: string, format: string = BUNDLE_FORMAT_CEREMONY) =>
  JSON.stringify({
    format,
    definition,
    clock: l1File.clock,
    l1,
    ...(format === BUNDLE_FORMAT_CEREMONY && { panel: file.panels[c.panel] }),
  });

const format4 = (c: Case, board = hex(c.board), definition = c.definition) =>
  verifyBundle(parseBundle(json(c, definition), board));

const row = (r: Report, id: string) => r.checks.find((x) => x.id === id) as CheckResult;
const rows = (r: Report, ids: readonly string[]) =>
  Object.fromEntries(
    ids.map((id) => {
      const { status, code, at } = row(r, id);
      return [id, { status, ...(code !== undefined && { code }), ...(at !== undefined && { at }) }];
    }),
  );
const ADMISSION = ["5.1", "5.2", "5.3", "5.4", "5.7"];

// The copy's entries, re-joined after a change.
const entriesOf = (c: Case) => parseBundle(json(c, c.definition), hex(c.board)).entries;
const join = (entries: readonly Uint8Array[]) => Uint8Array.from(entries.flatMap((e) => [...e]));

test("the fixtures reject a ballot for every admission code and for decoding", () => {
  const codes = new Set(file.cases.flatMap((c) => (c.ballots?.rejected ?? []).map((r) => r.code)));
  expect([...codes].sort()).toEqual(
    [
      "ballot-stray",
      "ballot-tier",
      "decode",
      "membership-proof",
      "option-proof",
      "share-hash-unqualified",
      "sum-proof",
      "validity-shape",
    ].sort(),
  );
  const outcomes = file.cases.flatMap((c) => ADMISSION.map((id) => c.expected[id]));
  for (const want of [
    { status: "pass" },
    { status: "unverifiable", code: "not-reached" },
    { status: "unverifiable", code: "unsupported-version" },
  ])
    expect(outcomes.some((o) => o?.["status"] === want.status && o["code"] === want.code)).toBe(
      true,
    );
});

describe("1.3, 2.3, 3.2, 5.1 to 5.4 and 5.7 against the independent implementation", () => {
  for (const c of file.cases)
    test(c.id, () => {
      const r = format4(c);
      expect(rows(r, Object.keys(c.expected))).toEqual(c.expected);
      expect(r.ballots).toEqual(c.ballots);
      // The board copy and the panel are local files: nothing verifies or
      // fails the election through them (T-53).
      expect(r.verdict).toBe("unverifiable");
      // A rejected ballot rejects its entry only, never the election (T-52):
      // only an election check (here 1.3, 2.3 or 3.2) can make it fail.
      const failedElection = Object.entries(c.expected).some(
        ([id, o]) => !ADMISSION.includes(id) && o["status"] === "fail",
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
    // Each run checks a whole bundle: the transcript and every ballot's
    // Groth16 pairing, about 0.2 s on a shared CI runner.
  }, 120_000);

  test("a copy is a candidate repeat exactly when an admitted copy precedes it, whatever its proof bytes (5.7, R4)", () => {
    const repeats = byId("repeats");
    const all = entriesOf(repeats);
    // Entries 2, 3 (its proof negated) and 5 (byte-identical) share (tier, ν,
    // M); entry 1 is a copy with another voter's proof, so it is rejected and
    // never makes another a repeat.
    const copies = new Set([2, 3, 5]);
    fc.assert(
      fc.property(fc.subarray([...all.keys()].slice(1)), (kept) => {
        const r = format4(repeats, join([0, ...kept].map((i) => all[i] as Uint8Array)));
        const positions = kept.flatMap((i, at) => (copies.has(i) ? [at + 1] : []));
        expect(r.ballots?.repeats).toEqual(positions.slice(1).map((entry) => ({ entry })));
        expect(row(r, "5.7")).toEqual(
          positions.length > 1
            ? {
                id: "5.7",
                kind: "admission",
                status: "unverifiable",
                code: "not-reached",
                at: { entry: positions[1] },
              }
            : { id: "5.7", kind: "admission", status: "pass" },
        );
      }),
      { numRuns: runs(20) },
    );
  }, 120_000);

  test("any change to an admitted ballot's record rejects it", () => {
    const admitted = byId("admitted");
    const all = entriesOf(admitted);
    const ballot = all[1] as Uint8Array;
    fc.assert(
      // From the record's first field on: the 51-byte envelope and the
      // record's 3-byte header precede it.
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

  test("a ballot of another election's board isn't this election's to judge", () => {
    const admitted = byId("admitted");
    const all = entriesOf(admitted);
    const other = Uint8Array.from(all[1] as Uint8Array);
    other[3] = (other[3] as number) ^ 1;
    const r = format4(admitted, join([all[0] as Uint8Array, other]));
    expect(r.ballots).toEqual({ admitted: 0, rejected: [], repeats: [] });
  });
});

describe("when ballot admission can't run", () => {
  const admitted = byId("admitted");

  test("a definition that doesn't decode leaves 5.1 to 5.4 and 5.7 not reached", () => {
    const r = format4(admitted, hex(admitted.board), "0001");
    for (const id of ADMISSION)
      expect(row(r, id)).toMatchObject({ status: "unverifiable", code: "not-reached" });
    expect(r.ballots).toBeUndefined();
  });

  test("a tier root of 0 leaves them not reached, though the ceremony passed (T-04)", () => {
    const r = format4(byId("root-zero"));
    expect(row(r, "3.2").status).toBe("pass");
    for (const id of ADMISSION)
      expect(row(r, id)).toMatchObject({ status: "unverifiable", code: "not-reached" });
    expect(r.ballots).toBeUndefined();
  });

  test("format 3 has no panel, so no key set: they stay not implemented", () => {
    const r = verifyBundle(
      parseBundle(
        json(admitted, admitted.definition, BUNDLE_FORMAT_DEFINITION),
        hex(admitted.board),
      ),
    );
    for (const id of ADMISSION)
      expect(row(r, id)).toMatchObject({ status: "unverifiable", code: "not-implemented" });
    expect(r.ballots).toBeUndefined();
  });

  test("format 3 still fails 1.3 for another membership key", () => {
    const other = byId("other-key");
    const r = verifyBundle(
      parseBundle(json(other, other.definition, BUNDLE_FORMAT_DEFINITION), hex(other.board)),
    );
    expect(row(r, "1.3")).toMatchObject({ status: "fail", code: "membership-key" });
  });
});

test("the report gives the ballots after the ceremony", () => {
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
