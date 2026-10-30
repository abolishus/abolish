import { readFileSync } from "node:fs";
import {
  type AnchorClock,
  type RollingBallotChain,
  type RollingTierEvent,
} from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import { ballotChecks } from "../src/ballots.ts";
import { ceremonyChecks } from "../src/ceremony.ts";
import { cellTiers, countedChecks } from "../src/counted.ts";
import { authorRunOf, decodeDefinition, readDefinition } from "../src/definition.ts";
import { splitEntries } from "../src/index.ts";
import { partitionSize, tallyChecks } from "../src/tallies.ts";

// Delivery (5.9), the counted set (7.1 to 7.3, 8.5) and the tally openings
// (7.4) under a rolling definition (definition version 7, `electorate_mode`
// 2) without an author panel (docs/spec/verifier.md, Counted set and tally,
// Tally openings; P2-17 parts 4d-2b-2b-2a and 4d-2b-2b-2b-1): ballot version
// 5's delivery records are version 2, each naming the ballot by version 5's
// ballot hash, which binds the step (T-38), and the partition is one cell per
// rolling tier (tally.md, Rolling tiers), into which 7.4 sorts the openings.
// Fixtures: docs/spec/vectors/verifier-counted-v5-rolling.json
// (packages/crypto/scripts/verifier-counted-v5-rolling-vectors.py, an
// independent implementation), whose ballots are verifier-ballots-v5.json's,
// admitted under the chain from that file's group registry events and
// registration time. Selection (6.1) needs L1 evidence these copies don't
// carry, so the admitted ballots, each of its own nullifier, stand in for
// the selected ones, as in delivery-v2-author.test.ts. Beside an author
// panel: counted-v5-rolling-author.test.ts.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

interface Case {
  readonly id: string;
  readonly definition: string;
  readonly board: string;
  readonly clock: Readonly<Record<string, string>>;
  readonly expected: Readonly<Record<string, Record<string, unknown>>>;
  readonly delivery: {
    readonly excluded: readonly { readonly entry: number }[];
    readonly records: readonly { readonly entry: number; readonly code: string }[];
  };
  readonly counted: readonly number[];
  readonly cells: readonly Record<string, unknown>[];
  readonly tallies: readonly Record<string, unknown>[];
}

const file = read("verifier-counted-v5-rolling.json") as {
  readonly panel: { readonly threshold: string; readonly keys: readonly string[] };
  readonly cases: readonly Case[];
};
const ballotsFile = read("verifier-ballots-v5.json") as {
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

/** The ceremony, admission under the chain, the counted-set checks and 7.4 once they're known over a case's copy. */
function run(c: Case, override?: (d: ReturnType<typeof decodeDefinition>) => typeof d) {
  const panel = { threshold: Number(file.panel.threshold), keys: file.panel.keys.map(hex) };
  const decoded = decodeDefinition(hex(c.definition));
  const { stubHash, hash } = readDefinition(decoded);
  const { entries } = splitEntries(hex(c.board));
  const clock = clockOf(c);
  const ceremony = ceremonyChecks(decoded.value, stubHash, panel, authorRunOf(decoded), entries, 5);
  const admission = ballotChecks(
    decoded,
    ceremony.registered,
    ceremony.authorRegistered,
    entries,
    5,
    clock,
    undefined,
    chain,
  );
  const candidates = admission.candidates ?? [];
  const definition = override === undefined ? decoded : override(decoded);
  const r = countedChecks({
    definition,
    definitionHash: hash,
    registered: ceremony.registered ?? [],
    selected: candidates.map(({ entry, tally }) => ({
      entry,
      tally: tally as NonNullable<typeof tally>,
    })),
    entries,
    boardEntryVersion: 5,
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
    undefined,
    entries,
    5,
    r.tallyBreaks === undefined ? undefined : { extent: entries.length, breaks: r.tallyBreaks },
  );
  return { candidates, r, opened };
}

// A not-reached row carries an empty `at`, which the vectors leave out.
const rows = (
  r: ReturnType<typeof countedChecks>,
  opened: ReturnType<typeof tallyChecks>,
): Record<string, unknown> =>
  Object.fromEntries(
    [...r.rows, ["7.4", opened.row] as const].map(([id, { status, code, at }]) => [
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

describe("5.9, the counted set and 7.4 under a rolling definition against the independent implementation", () => {
  for (const c of file.cases)
    test(c.id, { timeout: 60_000 }, () => {
      const { candidates, r, opened } = run(c);
      // dan's (cell 0), tess's (cell 1) and eve's (cell 0) ballots, each
      // admitted against its step's root.
      expect(candidates.map((x) => [x.entry, x.tally?.cell])).toEqual([
        [1, 0],
        [2, 1],
        [3, 0],
      ]);
      expect(rows(r, opened)).toEqual(c.expected);
      expect(r.delivery).toEqual(c.delivery);
      expect(countedOf(r, [1, 2, 3])).toEqual(c.counted);
      expect(r.cells).toEqual(c.cells);
      expect(opened.report).toEqual(c.tallies);
    });
});

test("the partition is one cell per rolling tier, in rolling_electorate's order", () => {
  const d = decodeDefinition(hex(byId("delivered").definition));
  if (d.version !== 7) throw new Error("not version 7");
  const tiers = d.value.rolling_electorate.map((t) => t.tier);
  expect(tiers).toEqual([0, 2]);
  expect(cellTiers(d)).toEqual(tiers);
  expect(partitionSize(d)).toBe(2);
  const { r } = run(byId("delivered"));
  expect(r.tiers?.map((t) => [t.tier, t.counted])).toEqual([
    [0, 2],
    [2, 1],
  ]);
});

test("a receipt for the fields at another step, or as version 4, delivers nothing (T-38)", () => {
  // Hashing a version-5 ballot without its step would deliver both.
  for (const id of ["step-relabelled", "version-4-hash"]) {
    const { r } = run(byId(id));
    expect(r.rows.get("5.9"), id).toEqual({ status: "pass" });
    expect(countedOf(r, [1, 2, 3]).length, id).toBe(2);
  }
});

test("beside an author panel whose key set isn't registered 5.9 and everything after it are not reached (T-37)", () => {
  // The author run isn't on this copy, so no author key set is given:
  // delivery is never judged over the default panel's seats alone.
  const { r } = run(byId("delivered"), (d) => {
    if (d.version !== 7) throw new Error("not version 7");
    return { ...d, value: { ...d.value, author_keys: [new Uint8Array(33)] } };
  });
  for (const id of ["5.9", "6.3", "7.1", "7.2", "7.3", "8.5"])
    expect(r.rows.get(id), id).toEqual({ status: "unverifiable", code: "not-reached", at: {} });
  expect(r.delivery).toBeUndefined();
});

test(
  "7.4 sorts a rolling poll's openings into one cell per rolling tier, the next number stray",
  { timeout: 60_000 },
  () => {
    // The definition states no fixed electorate: read as one, every opening
    // would be stray.
    const c = byId("tally-breaks");
    const d = decodeDefinition(hex(c.definition));
    if (d.version !== 7) throw new Error("not version 7");
    expect(d.value.electorate).toEqual([]);
    const { opened } = run(c);
    expect(opened.report?.map((o) => o.cell ?? null)).toEqual([0, 1, null, 0, 1, 1]);
    expect(opened.row).toEqual({ status: "fail", code: "tally-stray", at: { entry: 15 } });
  },
);

test("before the counted set is known an honest opening of a rolling poll stays unsettled", () => {
  const c = byId("delivered");
  const d = decodeDefinition(hex(c.definition));
  const { stubHash, hash } = readDefinition(d);
  const { entries } = splitEntries(hex(c.board));
  const panel = { threshold: Number(file.panel.threshold), keys: file.panel.keys.map(hex) };
  const { registered } = ceremonyChecks(d.value, stubHash, panel, authorRunOf(d), entries, 5);
  const r = tallyChecks(d, hash, registered, undefined, entries, 5);
  expect(r.row).toEqual({ status: "unverifiable", code: "not-implemented" });
  expect(r.report).toEqual(c.tallies);
  // With no registered key set nothing is attributed.
  expect(tallyChecks(d, hash, undefined, undefined, entries, 5).row).toEqual({
    status: "unverifiable",
    code: "not-reached",
  });
});

test("beside an author panel 7.4 reads a rolling poll's openings only under tally-opening version 3 (T-37)", () => {
  // This profile pins version 1, whose openings open one sharing, never two
  // halves: a later release's, whatever key sets and counted set are given.
  const c = byId("delivered");
  const d = decodeDefinition(hex(c.definition));
  if (d.version !== 7) throw new Error("not version 7");
  const panelled = { ...d, value: { ...d.value, author_keys: [new Uint8Array(33)] } };
  const { entries } = splitEntries(hex(c.board));
  expect(
    tallyChecks(panelled, readDefinition(d).hash, [], [], entries, 5, {
      extent: entries.length,
      breaks: new Map(),
    }),
  ).toEqual({ row: { status: "unverifiable", code: "unsupported-version", at: {} } });
});
