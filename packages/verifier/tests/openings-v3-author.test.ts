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

// Format-4 bundles under definition version 6 beside an author panel:
// spoiled-ballot opening version 3, both halves, with the author half checked
// against the author panel's registered key set, the output of its own run,
// found by `author_transcript_hash` and approved by the author approvals on
// the board, and each author seat's ciphertext rebuilt under its key there,
// never one the opening or the default panel names (docs/spec/verifier.md,
// Key ceremony, step 5, and Spoiled-ballot openings; T-37, T-17). Fixtures:
// docs/spec/vectors/verifier-openings-v3-author.json (packages/crypto/
// scripts/verifier-openings-v3-author-vectors.py, an independent
// implementation; its ballot records are verifier-ballots-v4-author.json's),
// with l1-anchor.json's L1 evidence, which matters only to 4.1 and 4.2.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;

interface Case {
  readonly id: string;
  readonly panel: string;
  readonly definition: string;
  readonly clock: Readonly<Record<string, string>>;
  readonly board: string;
  readonly expected: Readonly<Record<string, Record<string, unknown>>>;
  readonly openings?: Report["openings"];
}

const file = read("verifier-openings-v3-author.json") as {
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

const row = (r: Report, id = "6.2") => {
  const { status, code, at } = r.checks.find((x) => x.id === id) as CheckResult;
  return { status, ...(code !== undefined && { code }), ...(at !== undefined && { at }) };
};
const entriesOf = (c: Case) => parseBundle(json(c), hex(c.board)).entries;
const join = (entries: readonly Uint8Array[]) => Uint8Array.from(entries.flatMap((e) => [...e]));

// Every case's board opens with the author transcript, the default
// transcript and (but for approvals-missing) the approvals record.
const RUNS = 3;

test("the fixtures cover every check that can fail beside an author panel, the author half's panel, and a cast by its half alone", () => {
  const all = file.cases.flatMap((c) => c.openings ?? []);
  expect(new Set(all.flatMap((o) => (o.code === undefined ? [] : [o.code])))).toEqual(
    new Set([
      "opening-stray",
      "opening-shape",
      "opening-unqualified",
      "opening-vss",
      "opening-ciphertext",
    ]),
  );
  expect(new Set(all.flatMap((o) => o.breaks.map((b) => b.code)))).toEqual(
    new Set(["opening-early", "opening-cast", "opening-repeat"]),
  );
  // Only the author half fails its VSS or a seat's ciphertext here.
  expect(
    new Set(all.flatMap((o) => ((o.option ?? o.seat) === undefined ? [] : [o.panel]))),
  ).toEqual(new Set([2]));
  expect(new Set(file.cases.map((c) => c.expected["6.2"]?.["status"]))).toEqual(
    new Set(["pass", "fail", "unverifiable"]),
  );
  expect(byId("author-cast").expected["6.2"]).toEqual({
    status: "fail",
    code: "opening-cast",
    at: { entry: 4 },
  });
});

describe("6.2 against the independent implementation", () => {
  for (const c of file.cases)
    test(c.id, { timeout: 60_000 }, () => {
      const r = run(c);
      expect(row(r)).toEqual(c.expected["6.2"]);
      expect(row(r, "2.3")).toEqual(c.expected["2.3"]);
      expect(r.openings).toEqual(c.openings);
      if (c.openings !== undefined) {
        // Admission ran against both panels: a ballot is rejected only for
        // its segment (5.5), so opening-cast never needs s_S for it.
        expect(r.ballots?.admitted).toBeGreaterThan(0);
        expect(r.ballots?.rejected.every((b) => b.code === "window-boarded-late")).toBe(true);
      }
      // An opening never counts, displaces or fails anything but 6.2 (T-53);
      // 2.3 refuses every author panel whatever the copy holds, and 5.5
      // fails for a ballot boarded late, as above.
      const failing = r.checks
        .filter((x) => x.status === "fail" && x.id !== "5.5")
        .map((x) => x.id);
      expect(failing).toEqual(c.expected["6.2"]?.["status"] === "fail" ? ["2.3", "6.2"] : ["2.3"]);
    });
});

describe("openings are judged only against the approved author key set", () => {
  test("without the approvals record no opening is judged, however it fails", () => {
    const c = byId("author-ciphertext-first");
    const entries = entriesOf(c);
    const r = run(c, join(entries.filter((_, i) => i !== 2)));
    expect(row(r, "3.1")).toMatchObject({ code: "author-approvals-missing" });
    expect(row(r)).toEqual({ status: "unverifiable", code: "not-reached" });
    expect(r.openings).toBeUndefined();
  });

  test("without the author transcript neither is", () => {
    const c = byId("author-cast");
    const r = run(c, join(entriesOf(c).slice(1)));
    expect(row(r)).toEqual({ status: "unverifiable", code: "not-reached" });
    expect(r.openings).toBeUndefined();
  });
});

describe("each opening is judged from its own entry", () => {
  const mixed = byId("mixed");
  const entries = entriesOf(mixed);
  const whole = new Map((run(mixed).openings ?? []).map((o) => [o.entry, o] as const));
  const head = entries.slice(0, RUNS);

  test("any subset of the copy past both runs and the approvals gives every kept opening the checks, tracking code, vote and earliness it has in the whole copy", () => {
    fc.assert(
      fc.property(fc.subarray([...entries.keys()].slice(RUNS)), (kept) => {
        const r = run(mixed, join([...head, ...kept.map((i) => entries[i] as Uint8Array)]));
        const got = new Map((r.openings ?? []).map((o) => [o.entry, o] as const));
        kept.forEach((i, at) => {
          const want = whole.get(i);
          if (want === undefined) return expect(got.has(at + RUNS)).toBe(false);
          const o = got.get(at + RUNS);
          expect(o?.code).toBe(want.code);
          expect(o?.panel).toBe(want.panel);
          expect(o?.seat).toBe(want.seat);
          expect(o?.coreHash).toBe(want.coreHash);
          expect(o?.votes).toEqual(want.votes);
          expect(o?.breaks.some((b) => b.code === "opening-early")).toBe(
            want.breaks.some((b) => b.code === "opening-early"),
          );
        });
      }),
      { numRuns: runs(20) },
    );
  }, 180_000);

  test("a cast ballot dropped from the copy no longer makes an opening of its author half cast", () => {
    // Entry 3 is the segment-0 ballot; two openings re-use its commitments,
    // one its product and one its author half alone.
    const cast = [...whole.values()].filter((o) => o.breaks.some((b) => b.code === "opening-cast"));
    expect(cast.map((o) => o.breaks)).toEqual([
      [{ code: "opening-cast", ballot: 3 }],
      [{ code: "opening-cast", ballot: 3 }],
    ]);
    for (const o of cast) {
      const r = run(mixed, join([...head, entries[o.entry] as Uint8Array]));
      expect(r.openings?.[0]?.breaks).toEqual([]);
    }
  }, 60_000);

  test("any change to a passing opening's record but its cell makes it fail, both halves alike", () => {
    // Entry 10 is the honest opening in segment 5.
    const at = 10;
    const opening = entries[at] as Uint8Array;
    expect(whole.get(at)).toMatchObject({ breaks: [] });
    expect(whole.get(at)?.code).toBeUndefined();
    expect(whole.get(at)?.voteOutside).toBeUndefined();
    fc.assert(
      fc.property(
        // From the record's first field on: the 51-byte envelope and the
        // record's 3-byte header precede it; the cell byte (at 86) can name
        // another core instead (openings-v3.test.ts).
        fc.integer({ min: 54, max: opening.length - 1 }).filter((i) => i !== 86),
        fc.integer({ min: 1, max: 255 }),
        (i, x) => {
          const changed = Uint8Array.from(opening);
          changed[i] = (changed[i] as number) ^ x;
          const r = run(mixed, join([...head, changed]));
          expect(r.openings?.[0]?.code).toBeDefined();
          expect(row(r).status).toBe("fail");
        },
      ),
      { numRuns: runs(40) },
    );
  }, 180_000);
});
