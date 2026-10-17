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

// Format-4 bundles under definition version 6 without an author panel, whose
// ballots (version 4) name their cell, carry one range proof per question and
// split each vote into a default half and an author half, empty here: ballot
// admission, 5.1 to 5.5 and 5.7, against the cell's root and scope, the
// questions and both panels in the definition and the key set its transcript
// check registered, and 1.3 under the one pinned membership key
// (docs/spec/verifier.md, Ballot admission). These boards carry no spoiled-ballot
// opening, so 6.2 passes wherever it runs (openings-v3.test.ts checks them),
// and no tally opening, so 7.4 does too (counted-v4.test.ts judges them);
// no ballot is judged beside an author panel, whose key set 3.2 doesn't register (P2-16
// part 4d). Fixtures: docs/spec/vectors/verifier-ballots-v4.json
// (packages/crypto/scripts/verifier-ballots-v4-vectors.py, an independent
// implementation of the version-4 record, both halves' shapes, its range
// proofs and its admission order, with snarkjs's verdict on every membership
// proof) and its anchoring clock, and l1-anchor.json's L1 evidence, which
// matters only to 4.1 and 4.2.

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

const file = read("verifier-ballots-v4.json") as {
  readonly panels: Readonly<
    Record<string, { readonly threshold: string; readonly keys: string[] }>
  >;
  readonly clock: Readonly<Record<string, string>>;
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
    clock: file.clock,
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
const ADMISSION = ["5.1", "5.2", "5.3", "5.4", "5.5", "5.7"];

const entriesOf = (c: Case) => parseBundle(json(c), hex(c.board)).entries;
const join = (entries: readonly Uint8Array[]) => Uint8Array.from(entries.flatMap((e) => [...e]));
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

test("the fixtures reject a ballot for every version-4 admission code, repeats and decoding", () => {
  const codes = new Set(file.cases.flatMap((c) => (c.ballots?.rejected ?? []).map((r) => r.code)));
  expect([...codes].sort(byCode)).toEqual(
    [
      "ballot-cell",
      "ballot-stray",
      "decode",
      "membership-proof",
      "option-proof",
      "repeat",
      "share-hash-unqualified",
      "sum-proof",
      "validity-shape",
    ].sort(byCode),
  );
});

test("share-hash-unqualified names its seat and panel, option-proof its flat option and sum-proof its question, and nothing else names any", () => {
  const rejected = file.cases.flatMap((c) => c.ballots?.rejected ?? []);
  for (const r of rejected) {
    expect(r.option !== undefined).toBe(r.code === "option-proof");
    expect(r.question !== undefined).toBe(r.code === "sum-proof");
    expect(r.seat !== undefined).toBe(r.code === "share-hash-unqualified");
    expect(r.panel !== undefined).toBe(r.code === "share-hash-unqualified");
  }
  const mixed = byId("mixed").ballots?.rejected ?? [];
  // Seat 4 of the default panel, which sent nothing at the ceremony.
  expect(mixed.filter((r) => r.code === "share-hash-unqualified")).toEqual([
    { entry: 10, code: "share-hash-unqualified", panel: 1, seat: 4 },
  ]);
  // A question over its maximum and a pick-exactly-one question left blank.
  expect(mixed.filter((r) => r.code === "sum-proof").map((r) => r.question)).toEqual([1, 2]);
});

test("an author half on a poll without an author panel fails validity-shape, never judged against a panel the ballot implies", () => {
  // Entry 8's range proof has the wrong shape; entry 9 carries a 2-of-3
  // author half with valid proofs over both halves (T-17, T-37).
  expect(
    byId("mixed")
      .ballots?.rejected.filter((r) => r.code === "validity-shape")
      .map((r) => r.entry),
  ).toEqual([8, 9]);
});

describe("1.3, 2.3, 3.2, 5.1 to 5.5, 5.7, 6.2 and 7.4 against the independent implementation", () => {
  // A bundle checks up to 20 membership proofs (pairings) and every
  // question's range proofs: seconds each on a CI runner.
  for (const c of file.cases)
    test(
      c.id,
      () => {
        const r = format4(c);
        expect(rows(r, Object.keys(c.expected))).toEqual(c.expected);
        expect(r.ballots).toEqual(c.ballots);
        // No opening is on these boards: where 6.2 runs past its step 1 it
        // reports none.
        expect(r.openings).toEqual(c.expected["6.2"]?.["status"] === "pass" ? [] : undefined);
        expect(r.verdict).toBe("unverifiable");
        // A rejected ballot rejects its entry only, never the election (T-52):
        // only an election check (here 1.3, 2.3 or 3.2) can make it fail.
        const failedElection = Object.entries(c.expected).some(
          ([id, o]) =>
            !ADMISSION.includes(id) && id !== "6.2" && id !== "7.4" && o["status"] === "fail",
        );
        expect(r.verdictAgainstInputs === "failed").toBe(failedElection);
      },
      120_000,
    );
});

describe("admission is decided per entry", () => {
  const mixed = byId("mixed");
  const entries = entriesOf(mixed);
  const verdicts = (r: Report) =>
    new Map((r.ballots?.rejected ?? []).map((x) => [x.entry, x.code] as const));
  const full = verdicts(format4(mixed));
  // Entry 19 repeats entry 1, so it is a repeat only while entry 1 is kept;
  // every other verdict is the entry's own (R4).
  const expected = (kept: readonly number[], i: number) =>
    i === 19 && !kept.includes(1) ? undefined : full.get(i);

  test("the repeat in the fixture is a byte-identical copy of entry 1", () => {
    expect(full.get(19)).toBe("repeat");
    expect((entries[19] as Uint8Array).slice(51)).toEqual((entries[1] as Uint8Array).slice(51));
  });

  test("any subset of the copy gives every kept ballot the verdict it has in the whole copy, a repeat only with its original (R4)", () => {
    fc.assert(
      fc.property(fc.subarray([...entries.keys()], { minLength: 1 }), (kept) => {
        const r = format4(mixed, join(kept.map((i) => entries[i] as Uint8Array)));
        // The transcript is entry 0: without it no key set is registered.
        if (!kept.includes(0))
          for (const id of ADMISSION)
            expect(row(r, id)).toMatchObject({ status: "unverifiable", code: "not-reached" });
        else {
          const got = verdicts(r);
          kept.forEach((i, at) => expect(got.get(at)).toBe(expected(kept, i)));
          expect(r.ballots?.admitted).toBe(
            kept.filter((i) => i > 0 && expected(kept, i) === undefined).length,
          );
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
      // record's 3-byte header: the cell at 35 of the record, and both
      // halves' share-hash lists, included.
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
    // (T-16; verifier 2.8). Version 4 keeps version 3's offsets.
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

test("a ballot record of another version is refused whatever its bytes, never read under its own layout", () => {
  // Labelled version 3, the layout definition version 5 pins, whose
  // committed vote has no author half: the profile pins version 4, so it is
  // profile-mismatch (T-34).
  const admitted = byId("admitted");
  const all = entriesOf(admitted);
  const ballot = Uint8Array.from(all[1] as Uint8Array);
  const versionAt = 51 + 2;
  expect(ballot[versionAt]).toBe(4);
  for (const v of [1, 2, 3, 5]) {
    ballot[versionAt] = v;
    const r = format4(admitted, join([all[0] as Uint8Array, ballot]));
    expect(r.ballots?.rejected).toEqual([
      { entry: 1, code: "decode", decodeError: "profile-mismatch" },
    ]);
  }
});
