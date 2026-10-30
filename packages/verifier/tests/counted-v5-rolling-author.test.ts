import { readFileSync } from "node:fs";
import {
  type AnchorClock,
  type RollingBallotChain,
  type RollingTierEvent,
} from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import { ballotChecks } from "../src/ballots.ts";
import { ceremonyChecks } from "../src/ceremony.ts";
import {
  cellTiers,
  countedChecks,
  type CountedInputs,
  type CountedOutcome,
} from "../src/counted.ts";
import { authorRunOf, decodeDefinition, readDefinition } from "../src/definition.ts";
import { splitEntries } from "../src/index.ts";
import { type TallyOutcome, tallyChecks } from "../src/tallies.ts";

// Delivery (5.9), the counted set (7.1 to 7.3, 8.5) and the tally openings
// (7.4) under a rolling definition (definition version 7, `electorate_mode`
// 2) beside an author panel (docs/spec/verifier.md, Counted set and tally,
// Tally openings; P2-17 part 4d-2b-2b-2b-2b-1): ballot version 5's delivery
// records are version 2 over both panels' seats, each naming the ballot by
// version 5's ballot hash, which binds the step (T-38); the partition is one
// cell per rolling tier (tally.md, Rolling tiers), each cell's count the sum
// of both panels' partial openings (tally-opening version 3), each against
// its own panel's aggregate over the one counted set and attributed only by
// its own panel's key set (tally.md, Author panel; T-29, T-37, T-54); and 8.5
// judges every seat of both panels by its version-2 destruction statement.
// Fixtures: docs/spec/vectors/verifier-counted-v5-rolling-author.json
// (packages/crypto/scripts/verifier-counted-v5-rolling-author-vectors.py, an
// independent implementation), whose ballots are
// verifier-ballots-v5-author.json's, admitted under the chain from that
// file's group registry events and registration time. Selection (6.1) needs
// L1 evidence these copies don't carry, so the admitted ballots, each of its
// own nullifier, stand in for the selected ones, as in tally-v3-author.test.ts.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

interface Case {
  readonly id: string;
  readonly definition: string;
  readonly board: string;
  readonly clock: Readonly<Record<string, string>>;
  readonly expected: Readonly<Record<string, Record<string, unknown>>>;
  readonly delivery: Record<string, unknown>;
  readonly counted: readonly number[];
  readonly cells: readonly { readonly counts?: readonly string[] }[];
  readonly tiers: readonly { readonly counts?: readonly string[] }[];
  readonly tallies: readonly Record<string, unknown>[];
  readonly destruction: Record<string, unknown>;
}

const file = read("verifier-counted-v5-rolling-author.json") as {
  readonly panel: { readonly threshold: string; readonly keys: readonly string[] };
  readonly cases: readonly Case[];
};
const ballotsFile = read("verifier-ballots-v5-author.json") as {
  readonly events: readonly {
    readonly block: string;
    readonly timestamp: string;
    readonly group: string;
    readonly add?: readonly string[];
    readonly remove?: readonly string[];
  }[];
  readonly registeredAt: string;
};
const events: RollingTierEvent[] = ballotsFile.events.map((e) => {
  const at = {
    blockNumber: BigInt(e.block),
    timestamp: BigInt(e.timestamp),
    groupId: BigInt(e.group),
  };
  return e.remove === undefined
    ? { ...at, kind: "add", commitments: (e.add ?? []).map(BigInt) }
    : { ...at, kind: "remove", indices: e.remove.map(BigInt) };
});
const chain: RollingBallotChain = { events, registeredAt: BigInt(ballotsFile.registeredAt) };
const panel = { threshold: Number(file.panel.threshold), keys: file.panel.keys.map(hex) };

const byId = (id: string) => {
  const c = file.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};
const clockOf = (c: Case): AnchorClock => ({
  epoch: BigInt(c.clock["epoch"] ?? ""),
  period: BigInt(c.clock["period"] ?? ""),
  deadline: BigInt(c.clock["deadline"] ?? ""),
  lastSegment: Number(c.clock["lastSegment"]),
});

/** Both runs, admission under the chain, and what `countedChecks` and 7.4 take from them over a case's copy. */
function election(c: Case) {
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
    undefined,
    chain,
  );
  const candidates = admission.candidates ?? [];
  const inputs = (over: Partial<CountedInputs> = {}): CountedInputs => ({
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
    ...over,
  });
  /** 7.4 over the copy, with what the counted set settles (verify.ts's call). */
  const tallies = (
    r: ReturnType<typeof countedChecks>,
    authorRegistered: CountedInputs["authorRegistered"],
  ) =>
    tallyChecks(
      definition,
      hash,
      ceremony.registered,
      authorRegistered,
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
  return { ceremony, candidates, definition, hash, entries, inputs, tallies };
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

/** `counts` cut into consecutive runs of `sizes`' lengths (8.1). */
function sliceBy(sizes: readonly number[], counts: readonly string[]): string[][] {
  const out: string[][] = [];
  let at = 0;
  for (const n of sizes) {
    out.push(counts.slice(at, at + n));
    at += n;
  }
  expect(at).toBe(counts.length);
  return out;
}

describe("5.9, the counted set, 7.4 and 8.5 beside a rolling author panel against the independent implementation", () => {
  for (const c of file.cases)
    test(c.id, { timeout: 60_000 }, () => {
      const { ceremony, candidates, definition, inputs, tallies } = election(c);
      expect(ceremony.registered?.map((k) => k.index)).toEqual([1, 2, 3]);
      expect(ceremony.authorRegistered?.map((k) => k.index)).toEqual([1, 2]);
      // dan's (cell 0), ada's (cell 0) and tess's (cell 1) ballots, each
      // admitted against its step's root and both panels' key sets.
      expect(candidates.map((x) => [x.entry, x.tally?.cell])).toEqual([
        [3, 0],
        [4, 0],
        [5, 1],
      ]);
      const r = countedChecks(inputs());
      const opened = tallies(r, ceremony.authorRegistered);
      expect(
        rows({
          rows: new Map<string, CountedOutcome | TallyOutcome>([...r.rows, ["7.4", opened.row]]),
        }),
      ).toEqual(c.expected);
      expect(r.delivery).toEqual(c.delivery);
      expect(countedOf(r, [3, 4, 5])).toEqual(c.counted);
      if (definition.version !== 7) throw new Error("not version 7");
      const sizes = definition.value.questions.map((q) => q.option_count);
      const perQuestion = <T extends { readonly counts?: readonly string[] }>(x: T) =>
        x.counts === undefined ? x : { ...x, byQuestion: sliceBy(sizes, x.counts) };
      expect(r.cells).toEqual(c.cells.map(perQuestion));
      expect(r.tiers).toEqual(c.tiers.map(perQuestion));
      expect(opened.report).toEqual(c.tallies);
      expect(r.destruction).toEqual(c.destruction);
    });
});

test("the cells are the rolling tiers, each summed over both panels' partial openings", () => {
  const c = byId("counted");
  const { definition, inputs } = election(c);
  if (definition.version !== 7) throw new Error("not version 7");
  // The definition states no fixed electorate: read as one, there would be
  // no cell to count into.
  expect(definition.value.electorate).toEqual([]);
  expect(cellTiers(definition)).toEqual([0, 2]);
  const r = countedChecks(inputs());
  expect(r.cells?.map((x) => [x.tier, x.counted, x.signers, x.authorSigners])).toEqual([
    [0, 2, [2], [1]],
    [2, 1, [2], [1]],
  ]);
});

test("an author seat's receipt for the fields at another step delivers nothing (T-38)", () => {
  // Hashing a version-5 ballot without its step would deliver dan's ballot.
  const r = countedChecks(election(byId("author-step-relabelled")).inputs());
  expect(r.rows.get("5.9")).toEqual({ status: "pass" });
  expect(r.delivery?.excluded).toEqual([
    { entry: 3, missing: [{ panel: 2, seat: 1 }], complaints: [] },
  ]);
});

test("without the author panel's key set nothing after admission is decided (T-37)", () => {
  // Never delivered or tallied over the default panel's seats alone.
  const { inputs, tallies } = election(byId("counted"));
  const { authorRegistered: _, ...rest } = inputs();
  const r = countedChecks(rest);
  for (const id of ["5.9", "6.3", "7.1", "7.2", "7.3", "8.5"])
    expect(r.rows.get(id), id).toEqual({ status: "unverifiable", code: "not-reached", at: {} });
  expect(r.delivery).toBeUndefined();
  expect(tallies(r, undefined).row).toEqual({ status: "unverifiable", code: "not-reached" });
});

test("a default partial opening alone never counts a rolling tier: each cell needs both panels' (T-37)", () => {
  // Read as a poll without an author panel, each default partial opening
  // would open the cell by itself.
  const r = countedChecks(election(byId("author-missing")).inputs());
  expect(r.rows.get("7.2")).toEqual({
    status: "fail",
    code: "tally-missing",
    at: { cell: 1, panel: 2 },
  });
  expect(r.cells?.[1]?.counts).toBeUndefined();
});
