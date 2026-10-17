import { readFileSync } from "node:fs";
import { type AnchorClock, decodeBoardEntry, RECORD_TYPES } from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { ballotChecks } from "../src/ballots.ts";
import { ceremonyChecks } from "../src/ceremony.ts";
import { countedChecks, type CountedInputs } from "../src/counted.ts";
import { authorRunOf, decodeDefinition, readDefinition } from "../src/definition.ts";
import { decodeHeader, splitEntries } from "../src/index.ts";
import { run } from "./headers.ts";

// The tally (7.1 to 7.3) beside an author panel, under tally-opening version
// 3: one counted set per cell, from delivery over both panels' seats, which
// both panels sum over; each panel's partial openings checked against its
// own half's aggregate and attributed only by its own panel's registered key
// set, the author panel's checked first; each cell's count the sum of the
// two; and a missing default partial opening `tally-author-late` while some
// cell's author opening is late, decided only where `s_A`'s floor and an
// unbounded `s_A` agree (docs/spec/verifier.md, Counted set and tally, steps
// 4 and 5; docs/spec/tally.md, Author panel, Opening checks (version 3);
// T-29, T-37, T-54). The close check (6.3) runs over the same delivery, with
// the default panel's seats alone. Fixtures:
// docs/spec/vectors/verifier-tally-v3-author.json (packages/crypto/scripts/
// verifier-tally-v3-author-vectors.py, an independent implementation of both
// runs, the approvals, the ballots and their shares, the receipts, the
// delivery check, each panel's honest combination and the opening checks over
// both panels); selection (6.1) needs L1 evidence these copies don't carry,
// so the admitted ballots stand in for the selected ones, as each has its own
// nullifier.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);

interface Case {
  readonly id: string;
  readonly definition: string;
  readonly board: string;
  readonly clock: Readonly<Record<string, string>>;
  readonly expected: Readonly<Record<string, Record<string, unknown>>>;
  readonly counted: readonly number[];
  readonly cells: readonly Record<string, unknown>[];
  readonly tiers: readonly Record<string, unknown>[];
}

const file = JSON.parse(
  readFileSync(new URL("verifier-tally-v3-author.json", VECTORS), "utf8"),
) as {
  readonly panel: { readonly threshold: string; readonly keys: readonly string[] };
  readonly cases: readonly Case[];
};
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const panel = { threshold: Number(file.panel.threshold), keys: file.panel.keys.map(hex) };
const byId = (id: string) => {
  const c = file.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};
const numRuns = Math.min(Number(process.env["FC_NUM_RUNS"] ?? 100), 50);

const clockOf = (c: Case): AnchorClock => ({
  epoch: BigInt(c.clock["epoch"] ?? ""),
  period: BigInt(c.clock["period"] ?? ""),
  deadline: BigInt(c.clock["deadline"] ?? ""),
  lastSegment: Number(c.clock["lastSegment"]),
});

/** The ceremony and admission checks over a case's copy, and what `countedChecks` takes from them. */
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
  return { ceremony, candidates, definition, entries, inputs };
}

// A not-reached row carries an empty `at`, which the vectors leave out.
const rows = (r: ReturnType<typeof countedChecks>) =>
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

describe("7.1 to 7.3 beside an author panel against the independent implementation", () => {
  for (const c of file.cases)
    test(c.id, () => {
      const { ceremony, candidates, inputs } = election(c);
      expect(ceremony.registered?.map((k) => k.index)).toEqual([1, 2, 3]);
      expect(ceremony.authorRegistered?.map((k) => k.index)).toEqual([1, 2]);
      expect(candidates.map((x) => x.entry)).toEqual([3, 4, 5]);
      const r = countedChecks(inputs());
      expect(rows(r)).toEqual(c.expected);
      expect(countedOf(r, [3, 4, 5])).toEqual(c.counted);
      expect(r.cells).toEqual(c.cells);
      expect(r.tiers).toEqual(c.tiers);
      // 7.4's breaks beside an author panel are P2-16 part 4d-3d-2's.
      expect(r.tallyBreaks).toBeUndefined();
    });
});

/** The copy's tally openings by position, with the cell, panel and signer each names. */
function openingsOf(entries: readonly Uint8Array[]) {
  return entries.flatMap((encoded, at) => {
    const { payload } = decodeBoardEntry(encoded, 7);
    if (((payload[0] as number) << 8) + (payload[1] as number) !== RECORD_TYPES.tallyOpening)
      return [];
    // Version 3's header, then the definition hash, then cell and panel.
    return [{ at, version: payload[2], cell: payload[35], panel: payload[36] }];
  });
}

describe("each cell needs both panels' partial openings", () => {
  test("over any subset of the counted case's openings, 7.2 fails at the first cell short of either panel's, the author panel's first", () => {
    // In the counted case every opening is timely, so a missing default
    // partial opening is the author's delay exactly when some cell has no
    // author partial opening at all.
    const c = byId("counted");
    const { entries, inputs } = election(c);
    const openings = openingsOf(entries);
    expect(openings).toHaveLength(10);
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 10, maxLength: 10 }), (keep) => {
        const dropped = new Set(openings.filter((_, k) => keep[k] !== true).map((o) => o.at));
        const kept = entries.filter((_, at) => !dropped.has(at));
        const r = countedChecks(inputs({ entries: kept, extent: kept.length }));
        // Every kept opening of a cell for panel 1 or 2 passes (the stray
        // one names panel 3, the rejected one is version 1).
        const has = (cell: number, p: number) =>
          openings.some(
            (o) => o.version === 3 && o.cell === cell && o.panel === p && !dropped.has(o.at),
          );
        const authorLate = [0, 1, 2].some((cell) => !has(cell, 2));
        const first = [0, 1, 2].find((cell) => !has(cell, 2) || !has(cell, 1));
        const expected =
          first === undefined
            ? { status: "pass" }
            : !has(first, 2)
              ? { status: "fail", code: "tally-missing", at: { cell: first, panel: 2 } }
              : authorLate
                ? { status: "fail", code: "tally-author-late", at: { cell: first } }
                : { status: "fail", code: "tally-missing", at: { cell: first, panel: 1 } };
        expect(r.rows.get("7.2")).toEqual(expected);
        expect(r.rows.get("7.1")).toEqual({ status: "pass" });
        expect(r.rows.get("7.3")).toEqual({ status: "pass" });
        // A passing cell's count is the same whichever passing openings remain.
        for (const [cell, report] of (r.cells ?? []).entries())
          if (report.counts !== undefined)
            expect(report.counts).toEqual((c.cells[cell] as { counts: unknown }).counts);
      }),
      { numRuns },
    );
  }, 120_000);
});

describe("the author panel's partial openings are its own", () => {
  test("attributed by the author panel's key set alone: the default set in its place is refused", () => {
    const { ceremony, inputs } = election(byId("counted"));
    expect(() => countedChecks(inputs({ authorRegistered: ceremony.registered ?? [] }))).toThrow(
      /approved key set/,
    );
  });

  test("without it nothing past the ceremony is decided", () => {
    const { inputs } = election(byId("counted"));
    const { authorRegistered: _, ...without } = inputs();
    const r = countedChecks(without);
    for (const o of r.rows.values())
      expect(o).toMatchObject({ status: "unverifiable", code: "not-reached" });
    expect(r.cells).toBeUndefined();
  });
});

describe("6.3 beside an author panel", () => {
  test("runs over the delivery both panels gave, with the default panel's seats alone", () => {
    const c = byId("counted");
    const { definition, inputs } = election(c);
    const closesAt = definition.value.closes_at;
    // L_δ is the last block at or before closes_at + δ.
    const bound = BigInt(definition.value.l1_inclusion_bound);
    const blocks = run(21_000_000n, [closesAt - 12n, closesAt + bound, closesAt + bound + 12n]);
    const r = countedChecks(inputs({ blocks: blocks.map((h) => decodeHeader(h.encoded)) }));
    // No seat made a close statement, so there is no close head: the check
    // passes and the report says the close is unchecked.
    expect(r.rows.get("6.3")).toEqual({ status: "pass" });
    expect(r.close?.head).toBeNull();
    expect(r.close?.seats.map((s) => s.seat)).toEqual([1, 2, 3]);
    expect(r.rows.get("7.2")).toEqual({ status: "pass" });
  });
});
