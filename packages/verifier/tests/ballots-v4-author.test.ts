import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  BUNDLE_FORMAT_CEREMONY,
  type CheckResult,
  electionAdmission,
  parseBundle,
  type Report,
  verifyBundle,
} from "../src/index.ts";
import { ballotChecks } from "../src/ballots.ts";
import { ceremonyChecks } from "../src/ceremony.ts";
import { countedChecks } from "../src/counted.ts";
import { authorRunOf, decodeDefinition, readDefinition } from "../src/definition.ts";
import { tallyChecks } from "../src/tallies.ts";

// Format-4 bundles under definition version 6 beside an author panel: ballot
// admission, 5.1 to 5.5 and 5.7, with each ballot's author half judged
// against the author panel's registered key set, the output of its own run,
// found by `author_transcript_hash` and approved by the author approvals on
// the board, never against the ballot's or the default panel's (docs/spec/
// verifier.md, Key ceremony, step 5, and Ballot admission; T-37, T-17).
// These copies carry no opening, so 6.2 passes wherever admission runs
// (openings-v3-author.test.ts judges some); delivery and the tally beside an
// author panel are P2-16 part 4d-3's later parts, so 7.4 stays not reached.
// Fixtures:
// docs/spec/vectors/verifier-ballots-v4-author.json (packages/crypto/scripts/
// verifier-ballots-v4-author-vectors.py, an independent implementation of
// both runs, the approvals and the version-4 record's admission order, with
// snarkjs's verdict on every membership proof) and l1-anchor.json's L1
// evidence, which matters only to 4.1 and 4.2.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;

interface Case {
  readonly id: string;
  readonly definition: string;
  readonly board: string;
  readonly expected: Readonly<Record<string, Record<string, unknown>>>;
  readonly ballots?: Report["ballots"];
}

const file = read("verifier-ballots-v4-author.json") as {
  readonly panel: { readonly threshold: string; readonly keys: string[] };
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
    panel: file.panel,
  });
const format4 = (c: Case, board = hex(c.board)) => verifyBundle(parseBundle(json(c), board));
const entriesOf = (c: Case) => parseBundle(json(c), hex(c.board)).entries;
const join = (entries: readonly Uint8Array[]) => Uint8Array.from(entries.flatMap((e) => [...e]));

const row = (r: Report, id: string) => r.checks.find((x) => x.id === id) as CheckResult;
const rows = (r: Report, ids: readonly string[]) =>
  Object.fromEntries(
    ids.map((id) => {
      const { status, code, at } = row(r, id);
      return [id, { status, ...(code !== undefined && { code }), ...(at !== undefined && { at }) }];
    }),
  );
const ADMISSION = ["5.1", "5.2", "5.3", "5.4", "5.5", "5.7"];
const notReached = (r: Report) => {
  for (const id of ADMISSION)
    expect(row(r, id)).toMatchObject({ status: "unverifiable", code: "not-reached" });
  expect(r.ballots).toBeUndefined();
};

// The boards begin with the author transcript, the default transcript and
// the approvals record (where there is one).
const AUTHOR_TRANSCRIPT = 0;
const DEFAULT_TRANSCRIPT = 1;
const APPROVALS = 2;

describe("1.3, 2.3, 2.5, 3.1, 3.2, 5.1 to 5.5, 5.7, 6.2 and 7.4 against the independent implementation", () => {
  for (const c of file.cases)
    test(
      c.id,
      () => {
        const r = format4(c);
        expect(rows(r, Object.keys(c.expected))).toEqual(c.expected);
        expect(r.ballots).toEqual(c.ballots);
        expect(r.verdict).toBe("unverifiable");
        // 2.3 fails every author panel, an election check; a rejected ballot
        // rejects its entry only (T-52).
        expect(r.verdictAgainstInputs).toBe("failed");
      },
      120_000,
    );
});

test("an author half is judged against the author panel's own registered seats, default seats named first", () => {
  // Author seat 3 sent nothing at the author run, so its share hash is
  // unqualified; with every author seat registered it is admitted.
  expect(
    byId("author-mixed").ballots?.rejected.filter((r) => r.code === "share-hash-unqualified"),
  ).toEqual([
    { entry: 6, code: "share-hash-unqualified", panel: 2, seat: 3 },
    { entry: 7, code: "share-hash-unqualified", panel: 1, seat: 4 },
  ]);
  expect(byId("author-every-seat").ballots).toEqual({ admitted: 1, rejected: [], repeats: [] });
});

describe("no ballot is judged unless the author panel's approvals approve its run", () => {
  const mixed = byId("author-mixed");
  const entries = entriesOf(mixed);

  test("without either transcript or the approvals record", () => {
    for (const drop of [AUTHOR_TRANSCRIPT, DEFAULT_TRANSCRIPT, APPROVALS])
      notReached(format4(mixed, join(entries.filter((_, i) => i !== drop))));
  });

  test("approvals of another run of the same election never approve this one", () => {
    // The every-seat election's record approves its own author transcript,
    // which this definition doesn't bind: no record names this run's.
    const other = entriesOf(byId("author-every-seat"))[APPROVALS] as Uint8Array;
    const copy = entries.map((e, i) => (i === APPROVALS ? other : e));
    const r = format4(mixed, join(copy));
    expect(row(r, "3.1")).toMatchObject({ code: "author-approvals-missing" });
    notReached(r);
  });

  test("any subset of the copy gives every kept ballot the verdict it has in the whole copy (R4)", () => {
    const verdicts = (r: Report) =>
      new Map((r.ballots?.rejected ?? []).map((x) => [x.entry, x.code] as const));
    const full = verdicts(format4(mixed));
    // Entry 12 repeats entry 3, so it is a repeat only while entry 3 is kept.
    expect(full.get(12)).toBe("repeat");
    const expected = (kept: readonly number[], i: number) =>
      i === 12 && !kept.includes(3) ? undefined : full.get(i);
    const ballots = [...entries.keys()].filter((i) => i > APPROVALS);
    fc.assert(
      fc.property(fc.subarray(ballots), (chosen) => {
        const kept = [AUTHOR_TRANSCRIPT, DEFAULT_TRANSCRIPT, APPROVALS, ...chosen];
        const r = format4(mixed, join(kept.map((i) => entries[i] as Uint8Array)));
        const got = verdicts(r);
        kept.forEach((i, at) => expect(got.get(at)).toBe(expected(kept, i)));
        expect(r.ballots?.admitted).toBe(
          chosen.filter((i) => expected(kept, i) === undefined).length,
        );
      }),
      { numRuns: runs(20) },
    );
  }, 120_000);
});

test("an operator still boards no ballot beside an author panel: 2.3 refuses every one first", () => {
  const c = byId("author-mixed");
  expect(
    electionAdmission(
      hex(c.definition),
      { threshold: Number(file.panel.threshold), keys: file.panel.keys.map(hex) },
      entriesOf(c),
    ),
  ).toEqual({ ok: false, code: "profile-combination" });
});

test("delivery, the counted set and 7.4 decide nothing beside an author panel, whatever admission admitted", () => {
  // Admission now registers ballots there, so 6.1 can pass; until they take
  // the author panel's key set too (P2-16 part 4d-3c on), every counted row is
  // not reached, never decided over the default panel's alone (T-37).
  const c = byId("author-mixed");
  const bundle = parseBundle(json(c), hex(c.board));
  const definition = decodeDefinition(hex(c.definition));
  const { stubHash } = readDefinition(definition);
  const panel = { threshold: Number(file.panel.threshold), keys: file.panel.keys.map(hex) };
  const ceremony = ceremonyChecks(
    definition.value,
    stubHash,
    panel,
    authorRunOf(definition),
    bundle.entries,
    7,
  );
  const admission = ballotChecks(
    definition,
    ceremony.registered,
    ceremony.authorRegistered,
    bundle.entries,
    7,
    bundle.clock,
  );
  const candidates = admission.candidates ?? [];
  expect(candidates).toHaveLength(4);
  const counted = countedChecks({
    definition,
    definitionHash: new Uint8Array(32),
    registered: ceremony.registered ?? [],
    selected: candidates.map(({ entry, tally }) => ({
      entry,
      tally: tally as NonNullable<typeof tally>,
    })),
    entries: bundle.entries,
    boardEntryVersion: 7,
    extent: bundle.entries.length,
    eventsPass: true,
    clock: bundle.clock,
    destruction: true,
    admitted: candidates,
    blocks: undefined,
  });
  expect(counted.rows.size).toBeGreaterThan(0);
  for (const o of counted.rows.values())
    expect(o).toMatchObject({ status: "unverifiable", code: "not-reached" });
  expect(
    tallyChecks(definition, new Uint8Array(32), ceremony.registered, bundle.entries, 7).row,
  ).toMatchObject({ status: "unverifiable", code: "not-reached" });
});
