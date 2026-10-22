import { readFileSync } from "node:fs";
import { decodeBoardEntry, encodeBoardEntry } from "@abolishus/crypto";
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

// Format-4 bundles: ballot admission, 5.1 to 5.5 and 5.7, against the
// definition and the key set its transcript check registered, with each copy
// judged by its own path's window (docs/spec/verifier.md, Ballot admission).
// Fixtures: docs/spec/vectors/verifier-ballots.json
// (packages/crypto/scripts/verifier-ballots-vectors.py, an independent
// implementation, with snarkjs's verdict on every membership proof) and its
// anchoring clock, and l1-anchor.json's L1 evidence, which matters only to
// 4.1 and 4.2.

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
  readonly clock: Readonly<Record<string, string>>;
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

const json = (c: Case, definition: string, format: string = BUNDLE_FORMAT_CEREMONY) =>
  JSON.stringify({
    format,
    definition,
    clock: file.clock,
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
const ADMISSION = ["5.1", "5.2", "5.3", "5.4", "5.5", "5.7"];

// The copy's entries, re-joined after a change.
const entriesOf = (c: Case) => parseBundle(json(c, c.definition), hex(c.board)).entries;
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
const join = (entries: readonly Uint8Array[]) => Uint8Array.from(entries.flatMap((e) => [...e]));

test("the fixtures reject a ballot for every admission code, the window's, repeats and decoding", () => {
  const codes = new Set(file.cases.flatMap((c) => (c.ballots?.rejected ?? []).map((r) => r.code)));
  expect([...codes].sort()).toEqual(
    [
      "ballot-stray",
      "ballot-tier",
      "decode",
      "membership-proof",
      "option-proof",
      "repeat",
      "share-hash-unqualified",
      "sum-proof",
      "validity-shape",
      "window-after-close",
      "window-before-open",
      "window-boarded-late",
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

describe("1.3, 2.3, 3.2, 5.1 to 5.5 and 5.7 against the independent implementation", () => {
  // A bundle checks every ballot's membership proof (a pairing) and validity
  // proofs: the mixed one has taken over the 5-second default on CI's
  // runners while the other verifier files run beside it.
  for (const c of file.cases)
    test(c.id, { timeout: 60_000 }, () => {
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

  // Entry 14 repeats entry 1, so it is a repeat only while entry 1 is kept;
  // every other verdict is the entry's own (R4).
  const expected = (kept: readonly number[], i: number) =>
    i === 14 && !kept.includes(1) ? undefined : full.get(i);

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
    // Each run checks a whole bundle: the transcript and every ballot's
    // Groth16 pairing, about 0.2 s on a shared CI runner.
  }, 120_000);

  test("a copy is rejected as a repeat exactly when an admitted copy precedes it, whatever its proof bytes (5.7, R4)", () => {
    const repeats = byId("repeats");
    const all = entriesOf(repeats);
    // Entries 2, 3 (its proof negated) and 5 (byte-identical) share (tier, ν,
    // M); entry 1 is a copy with another voter's proof, so it is rejected and
    // never makes another a repeat.
    const copies = new Set([2, 3, 5]);
    // Past the 51-byte envelope, the negated copy's record differs from the
    // original's (its proof), so only the recomputed M finds it; the other
    // copy's record is byte-identical.
    expect(equal((all[3] as Uint8Array).slice(51), (all[2] as Uint8Array).slice(51))).toBe(false);
    expect(equal((all[5] as Uint8Array).slice(51), (all[2] as Uint8Array).slice(51))).toBe(true);
    fc.assert(
      fc.property(fc.subarray([...all.keys()].slice(1)), (kept) => {
        const r = format4(repeats, join([0, ...kept].map((i) => all[i] as Uint8Array)));
        const positions = kept.flatMap((i, at) => (copies.has(i) ? [at + 1] : []));
        expect(r.ballots?.repeats).toEqual([]);
        expect(r.ballots?.rejected.filter((b) => b.code === "repeat")).toEqual(
          positions.slice(1).map((entry) => ({ entry, code: "repeat" })),
        );
        expect(row(r, "5.7")).toEqual(
          positions.length > 1
            ? {
                id: "5.7",
                kind: "admission",
                status: "fail",
                code: "repeat",
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

describe("the close rule's window (5.5) judges each copy by its own path", () => {
  const window = byId("window");
  const entries = entriesOf(window);
  const verdicts = (r: Report) =>
    new Map((r.ballots?.rejected ?? []).map((x) => [x.entry, x.code] as const));
  // Verified once: a whole check of the fixture takes seconds on a busy runner,
  // so each test below that makes one has at least a minute.
  const report = format4(window);
  const full = verdicts(report);
  // Entries 5 and 7 are ordinary copies inside the window of entries 1 and 6:
  // repeats only while their original is kept.
  const originals = new Map([
    [5, 1],
    [7, 6],
  ]);
  const expected = (kept: readonly number[], i: number) => {
    const original = originals.get(i);
    return original !== undefined && !kept.includes(original) ? undefined : full.get(i);
  };

  test("the fixture reaches every window code through both paths", () => {
    expect(full.get(3)).toBe("window-before-open");
    expect(full.get(4)).toBe("window-after-close");
    expect(full.get(11)).toBe("window-boarded-late");
    // The same log from an address the definition doesn't name carries no ballot.
    expect(full.has(9)).toBe(false);
    expect(report.ballots?.admitted).toBe(4);
  });

  test("any subset of the copy gives every kept ballot its own window verdict (R4)", () => {
    fc.assert(
      fc.property(fc.subarray([...entries.keys()].slice(1)), (kept) => {
        const r = format4(window, join([0, ...kept].map((i) => entries[i] as Uint8Array)));
        const got = verdicts(r);
        kept.forEach((i, at) => expect(got.get(at + 1)).toBe(expected(kept, i)));
        // Entry 9 is no ballot, and neither is the transcript.
        expect(r.ballots?.admitted).toBe(
          kept.filter((i) => i !== 9 && expected(kept, i) === undefined).length,
        );
      }),
      { numRuns: runs(20) },
    );
  }, 120_000);

  test("under contract-event version 1 the board emits no event, so a BallotSubmitted record is no ballot", () => {
    const admitted = byId("admitted");
    const own = entriesOf(admitted);
    // The window case's in-window ordinary ballot: the fixtures share one
    // election identifier, so it is an entry of this election's board.
    const spliced = join([...own, entries[2] as Uint8Array]);
    expect(format4(admitted, spliced).ballots).toEqual(format4(admitted).ballots);
  }, 60_000);

  test("another board event carries no ballot, so it is neither admitted nor rejected", () => {
    // contract-event-v2.json's ShareReceiptSubmitted, re-addressed to this
    // definition's board (bytes 3 to 22 of the record) and boarded where the
    // in-window ordinary ballot was.
    const events = read("contract-event-v2.json") as {
      readonly records: readonly { readonly id: string; readonly encoding: string }[];
    };
    const receipt = events.records.find((x) => x.id === "share-receipt");
    if (receipt === undefined) throw new Error("no share-receipt record");
    const entry = decodeBoardEntry(entries[2] as Uint8Array, 5);
    const record = hex(receipt.encoding);
    record.set(entry.payload.subarray(3, 23), 3);
    const swapped = encodeBoardEntry({ ...entry, payload: record }, 5);
    const r = format4(window, join(entries.map((e, i) => (i === 2 ? swapped : e))));
    expect(verdicts(r).has(2)).toBe(false);
    expect(r.ballots?.admitted).toBe(3);
  }, 60_000);

  test("s_A takes the floor of a close before the epoch, so segment 1 is late when s_A is 0", () => {
    const admitted = byId("admitted");
    const all = entriesOf(admitted);
    const entry = decodeBoardEntry(all[1] as Uint8Array, 5);
    const moved = encodeBoardEntry({ ...entry, segment: 1 }, 5);
    const r = verifyBundle(
      parseBundle(
        JSON.stringify({
          ...(JSON.parse(json(admitted, admitted.definition)) as object),
          // closes_at is half a period before the epoch: ⌊−1800 / 3600⌋ + 1 = 0,
          // where truncating division would give 1.
          clock: { ...file.clock, epoch: String(1767830400 + 1800) },
        }),
        join([all[0] as Uint8Array, moved, ...all.slice(2)]),
      ),
    );
    expect(r.ballots?.rejected).toEqual([{ entry: 1, code: "window-boarded-late" }]);
  }, 60_000);

  test("a clock that puts s_A below a board-path ballot's segment rejects it as boarded late", () => {
    const admitted = byId("admitted");
    const late = verifyBundle(
      parseBundle(
        JSON.stringify({
          ...(JSON.parse(json(admitted, admitted.definition)) as object),
          // An epoch after close: s_A is below 0, under every segment.
          clock: { ...file.clock, epoch: "1800000000" },
        }),
        hex(admitted.board),
      ),
    );
    expect(late.ballots?.admitted).toBe(0);
    expect(new Set(late.ballots?.rejected.map((b) => b.code))).toEqual(
      new Set(["window-boarded-late"]),
    );
    expect(row(late, "5.5")).toMatchObject({ status: "fail", code: "window-boarded-late" });
  }, 60_000);
});

describe("when ballot admission can't run", () => {
  const admitted = byId("admitted");

  test("a definition that doesn't decode leaves 5.1 to 5.5, 5.7 and 6.2 not reached", () => {
    const r = format4(admitted, hex(admitted.board), "0001");
    for (const id of [...ADMISSION, "6.2"])
      expect(row(r, id)).toMatchObject({ status: "unverifiable", code: "not-reached" });
    expect(r.ballots).toBeUndefined();
  });

  test("a tier root of 0 leaves them and 6.2 not reached, though the ceremony passed (T-04)", () => {
    const r = format4(byId("root-zero"));
    expect(row(r, "3.2").status).toBe("pass");
    for (const id of [...ADMISSION, "6.2"])
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

test("a ballot pin other than 1 leaves 6.2 unsupported: a later release may open its cores (T-36)", () => {
  const r = format4(byId("ballot-v2"));
  expect(row(r, "6.2")).toMatchObject({ status: "unverifiable", code: "unsupported-version" });
  expect(r.openings).toBeUndefined();
});

// The mixed case, which has taken over the 5-second default on CI's runners.
test("the report gives the ballots after the ceremony, then the openings and the tallies", () => {
  const r = format4(byId("mixed"));
  expect(Object.keys(r)).toEqual([
    "format",
    "verdict",
    "verdictAgainstInputs",
    "inputs",
    "definition",
    "ceremony",
    "ballots",
    "openings",
    "tallies",
    "board",
    "l1",
    "checks",
  ]);
}, 60_000);
