import { readFileSync } from "node:fs";
import { type AnchorClock, decodeBoardEntry, RECORD_TYPES } from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import { ballotChecks } from "../src/ballots.ts";
import { ceremonyChecks } from "../src/ceremony.ts";
import { countedChecks, type CountedOutcome } from "../src/counted.ts";
import { authorRunOf, decodeDefinition, readDefinition } from "../src/definition.ts";
import { splitEntries } from "../src/index.ts";
import { type TallyOutcome, tallyChecks } from "../src/tallies.ts";

// The tally (7.1 to 7.4) and destruction (8.5) beside an author panel under
// definition version 7 with a fixed electorate, which the verifier reads as
// version 6 under version 7's own hash and stubs (docs/spec/verifier.md,
// Definition): verifier-tally-v3-author.json's elections made again under
// version 7, both runs made for version 7's stubs, the approvals naming
// version 7's author stub, the ballots proved for the version-7 hash and
// every receipt, partial opening and destruction statement made for it, so
// 7.1 to 7.4, 8.5 and the report's cells, tiers, tallies and destruction are
// judged as under version 6. Each partial opening and statement is checked
// against the definition hash `readDefinition` gives, so these vectors also
// hold that hash to version 7's own. Two cases are version 7's own: partial
// openings (`v6-reading`) and destruction statements
// (`v6-reading-destruction`) made for the same election read as version 6.
// Fixtures: docs/spec/vectors/verifier-tally-v3-author-definition-v7.json
// (packages/crypto/scripts/verifier-tally-v3-author-vectors.py with `7`, an
// independent implementation) beside verifier-tally-v3-author.json.
// Selection (6.1) needs L1 evidence these copies don't carry, so the
// admitted ballots stand in for the selected ones, as each has its own
// nullifier (tally-v3-author.test.ts).

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);

interface Case {
  readonly id: string;
  readonly definition: string;
  readonly board: string;
  readonly clock: Readonly<Record<string, string>>;
  readonly expected: Readonly<Record<string, Record<string, unknown>>>;
  readonly counted: readonly number[];
  readonly cells: readonly { readonly counts?: readonly string[] }[];
  readonly tiers: readonly { readonly counts?: readonly string[] }[];
  readonly tallies: readonly Record<string, unknown>[];
  readonly destruction: Record<string, unknown>;
}

interface File {
  readonly panel: { readonly threshold: string; readonly keys: readonly string[] };
  readonly cases: readonly Case[];
}

const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as File;
const v7 = read("verifier-tally-v3-author-definition-v7.json");
const v6 = read("verifier-tally-v3-author.json");
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const byId = (file: File, id: string) => {
  const c = file.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};
const OWN = new Set(["v6-reading", "v6-reading-destruction"]);

const clockOf = (c: Case): AnchorClock => ({
  epoch: BigInt(c.clock["epoch"] ?? ""),
  period: BigInt(c.clock["period"] ?? ""),
  deadline: BigInt(c.clock["deadline"] ?? ""),
  lastSegment: Number(c.clock["lastSegment"]),
});

/** The ceremony, admission, counted-set and tally checks over a case's copy (verify.ts's calls). */
function run(file: File, c: Case) {
  const panel = { threshold: Number(file.panel.threshold), keys: file.panel.keys.map(hex) };
  const definition = decodeDefinition(hex(c.definition));
  const { stubHash, hash } = readDefinition(definition);
  const { entries } = splitEntries(hex(c.board));
  const clock = clockOf(c);
  const ceremony = ceremonyChecks(
    definition.value,
    stubHash,
    panel,
    authorRunOf(definition),
    entries,
    7,
  );
  const admission = ballotChecks(
    definition,
    ceremony.registered,
    ceremony.authorRegistered,
    entries,
    7,
    clock,
  );
  const candidates = admission.candidates ?? [];
  const r = countedChecks({
    definition,
    definitionHash: hash,
    registered: ceremony.registered ?? [],
    ...(ceremony.authorRegistered !== undefined && {
      authorRegistered: ceremony.authorRegistered,
    }),
    selected: candidates.map(({ entry, tally }) => ({
      entry,
      tally: tally as NonNullable<typeof tally>,
    })),
    entries,
    boardEntryVersion: 7,
    extent: entries.length,
    eventsPass: false,
    clock,
    destruction: true,
    admitted: candidates,
    blocks: undefined,
  });
  const opened = tallyChecks(
    definition,
    hash,
    ceremony.registered,
    ceremony.authorRegistered,
    entries,
    7,
    r.tallyBreaks === undefined
      ? undefined
      : {
          extent: entries.length,
          breaks: r.tallyBreaks,
          ...(r.tallyEarly !== undefined && { early: r.tallyEarly }),
        },
  );
  return { ceremony, candidates, r, opened };
}

// A not-reached row carries an empty `at`, which the vectors leave out.
const rows = (r: { readonly rows: ReadonlyMap<string, CountedOutcome | TallyOutcome> }) =>
  Object.fromEntries(
    [...r.rows].map(([id, { status, code, at }]) => [
      id,
      {
        status,
        ...(code !== undefined && { code }),
        ...(at !== undefined && Object.keys(at).length > 0 && { at }),
      },
    ]),
  );
const countedOf = (r: ReturnType<typeof countedChecks>, selected: readonly number[]) => {
  const excluded = new Set(
    ((r.delivery?.excluded ?? []) as readonly { readonly entry: number }[]).map((x) => x.entry),
  );
  return selected.filter((entry) => !excluded.has(entry));
};
// The vectors give the flat counts; the verifier also cuts them by question
// (tally-v3-author.test.ts checks that cut).
const flat = (xs: readonly object[] | undefined) =>
  xs?.map((x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== "byQuestion")));

test("every definition is version 7", () => {
  for (const c of v7.cases) expect(hex(c.definition)[2], c.id).toBe(7);
});

test("the version-6 file's cases, and version 7's own, are all here", () => {
  expect(v7.cases.map((c) => c.id).filter((id) => !OWN.has(id))).toEqual(v6.cases.map((c) => c.id));
  expect(v7.cases.filter((c) => OWN.has(c.id)).length).toBe(OWN.size);
});

describe("7.1 to 7.4 and 8.5 beside an author panel against the independent implementation", () => {
  for (const c of v7.cases)
    test(
      c.id,
      () => {
        const { ceremony, candidates, r, opened } = run(v7, c);
        // Both runs and the approvals hold under version 7's stubs.
        expect(ceremony.registered?.map((k) => k.index)).toEqual([1, 2, 3]);
        expect(ceremony.authorRegistered?.map((k) => k.index)).toEqual([1, 2]);
        expect(candidates.map((x) => x.entry)).toEqual([3, 4, 5]);
        expect(
          rows({
            rows: new Map<string, CountedOutcome | TallyOutcome>([...r.rows, ["7.4", opened.row]]),
          }),
        ).toEqual(c.expected);
        expect(countedOf(r, [3, 4, 5])).toEqual(c.counted);
        expect(flat(r.cells)).toEqual(c.cells);
        expect(flat(r.tiers)).toEqual(c.tiers);
        expect(opened.report).toEqual(c.tallies);
        expect(r.destruction).toEqual(c.destruction);
      },
      60_000,
    );
});

test("a fixed version 7 gets version 6's rows and report, over other entries", () => {
  for (const c6 of v6.cases) {
    const c7 = byId(v7, c6.id);
    for (const key of ["expected", "counted", "cells", "tiers", "tallies", "destruction"] as const)
      expect(c7[key], `${c6.id} ${key}`).toEqual(c6[key]);
  }
  // Every entry binds its definition (the runs its stubs, the approvals its
  // author stub, the ballots, receipts, partial openings and statements its
  // hash), so the only board entry both readings' is destruction-mixed's
  // stray statement, which names neither: its definition hash is all zero.
  const of = (f: File) =>
    f.cases.flatMap((c) =>
      splitEntries(hex(c.board)).entries.map((e) => Buffer.from(e).toString("hex")),
    );
  const own6 = new Set(of(v6));
  const shared = [...new Set(of(v7).filter((e) => own6.has(e)))].map(
    (e) => decodeBoardEntry(hex(e), 7).payload,
  );
  expect(shared).toHaveLength(1);
  for (const payload of shared) {
    expect(((payload[0] as number) << 8) + (payload[1] as number)).toBe(
      RECORD_TYPES.destructionStatement,
    );
    expect(payload.subarray(3, 35)).toEqual(new Uint8Array(32));
  }
});

describe("records made for the version-6 reading of the same election are another election's", () => {
  test("partial openings: stray, so the cell they open has none", () => {
    // Each binds the version-6 encoding's hash (T-29, T-37): attributed to
    // its seat, but no opening of cell 0, which fails for the author panel.
    const c = byId(v7, "v6-reading");
    const { r, opened } = run(v7, c);
    expect(r.rows.get("7.2")).toEqual({
      status: "fail",
      code: "tally-missing",
      at: { cell: 0, panel: 2 },
    });
    const stray = (opened.report ?? []).filter((o) =>
      o.breaks.some((b) => b.code === "tally-stray"),
    );
    expect(stray.map((o) => [o.panel, o.signer, o.cell])).toEqual([
      [2, 1, undefined],
      [1, 2, undefined],
    ]);
    expect(r.cells?.map((x) => x.counts !== undefined)).toEqual([false, true, true]);
  }, 60_000);

  test("destruction statements: stray, so no seat is destroyed", () => {
    // Each binds the version-6 encoding's hash (T-14): attributed to its
    // seat, never counted for it.
    const c = byId(v7, "v6-reading-destruction");
    const { r } = run(v7, c);
    expect(r.rows.get("7.2")).toEqual({ status: "pass" });
    expect(r.rows.get("8.5")).toEqual({
      status: "fail",
      code: "destruction-missing",
      at: { panel: 1, seat: 1 },
    });
    expect(r.destruction?.seats.map((s) => s.code)).toEqual(Array(5).fill("destruction-missing"));
    expect(
      (c.destruction["stray"] as readonly { panel: number; signer: number }[]).map((s) => [
        s.panel,
        s.signer,
      ]),
    ).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
      [2, 1],
      [2, 2],
    ]);
  }, 60_000);
});
