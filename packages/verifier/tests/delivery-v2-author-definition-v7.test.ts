import { readFileSync } from "node:fs";
import type { AnchorClock } from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import { ballotChecks } from "../src/ballots.ts";
import { ceremonyChecks } from "../src/ceremony.ts";
import { countedChecks } from "../src/counted.ts";
import { authorRunOf, decodeDefinition, readDefinition } from "../src/definition.ts";
import { splitEntries } from "../src/index.ts";

// Delivery (5.9) under definition version 7 with a fixed electorate beside
// an author panel, which the verifier reads as version 6 under version 7's
// own hash and stubs (docs/spec/verifier.md, Definition):
// verifier-delivery-v2-author.json's elections made again under version 7,
// both runs made for version 7's stubs, the approvals naming version 7's
// author stub, the ballots verifier-ballots-v4-author-definition-v7.json's
// and every receipt made for the version-7 hash, so 5.9 and the report's
// delivery are judged as under version 6. Each receipt is checked against
// the definition hash `readDefinition` gives, so these vectors also hold
// that hash to version 7's own. One case is version 7's own: receipts made
// for the same election read as version 6 (`v6-reading`). Fixtures:
// docs/spec/vectors/verifier-delivery-v2-author-definition-v7.json
// (packages/crypto/scripts/verifier-delivery-v2-author-vectors.py with `7`,
// an independent implementation) beside verifier-delivery-v2-author.json.
// Selection (6.1) needs L1 evidence these copies don't carry, so the
// admitted ballots stand in for the selected ones, as each has its own
// nullifier (delivery-v2-author.test.ts).

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);

interface Case {
  readonly id: string;
  readonly definition: string;
  readonly board: string;
  readonly clock: Readonly<Record<string, string>>;
  readonly expected: Readonly<Record<string, Record<string, unknown>>>;
  readonly delivery?: {
    readonly excluded: readonly { readonly entry: number }[];
    readonly records: readonly { readonly entry: number; readonly code: string }[];
  };
  readonly counted?: readonly number[];
}

interface File {
  readonly panel: { readonly threshold: string; readonly keys: readonly string[] };
  readonly cases: readonly Case[];
}

const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as File;
const v7 = read("verifier-delivery-v2-author-definition-v7.json");
const v6 = read("verifier-delivery-v2-author.json");
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const byId = (file: File, id: string) => {
  const c = file.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};
const OWN = new Set(["v6-reading"]);

const clockOf = (c: Case): AnchorClock => ({
  epoch: BigInt(c.clock["epoch"] ?? ""),
  period: BigInt(c.clock["period"] ?? ""),
  deadline: BigInt(c.clock["deadline"] ?? ""),
  lastSegment: Number(c.clock["lastSegment"]),
});

/** The ceremony, admission and counted-set checks over a case's copy. */
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
  return { ceremony, candidates, entries, r };
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

test("every definition is version 7", () => {
  for (const c of v7.cases) expect(hex(c.definition)[2], c.id).toBe(7);
});

test("the version-6 file's cases, and version 7's own, are all here", () => {
  expect(v7.cases.map((c) => c.id).filter((id) => !OWN.has(id))).toEqual(v6.cases.map((c) => c.id));
  expect(v7.cases.filter((c) => OWN.has(c.id)).length).toBe(OWN.size);
});

describe("5.9 beside an author panel against the independent implementation", () => {
  for (const c of v7.cases)
    test(c.id, () => {
      const { ceremony, candidates, r } = run(v7, c);
      expect(rows(r)).toEqual(c.expected);
      if (c.delivery === undefined) {
        // Approvals short or missing: no key set is registered, so no
        // ballot is admitted and nothing is delivered.
        expect(ceremony.authorRegistered).toBeUndefined();
        expect(candidates).toEqual([]);
        expect(r.delivery).toBeUndefined();
        return;
      }
      // Both runs and the approvals hold under version 7's stubs.
      expect(ceremony.registered?.map((k) => k.index)).toEqual([1, 2, 3]);
      expect(ceremony.authorRegistered?.map((k) => k.index)).toEqual([1, 2]);
      expect(candidates.map((x) => x.entry)).toEqual([3, 4, 5]);
      expect(r.delivery).toEqual(c.delivery);
      expect(countedOf(r, [3, 4, 5])).toEqual(c.counted);
    });
});

test("a fixed version 7 gets version 6's rows, delivery and counted ballots, over other entries", () => {
  for (const c6 of v6.cases) {
    const c7 = byId(v7, c6.id);
    expect(c7.expected, c6.id).toEqual(c6.expected);
    expect(c7.delivery, c6.id).toEqual(c6.delivery);
    expect(c7.counted, c6.id).toEqual(c6.counted);
  }
  // Every entry binds its definition (the runs its stubs, the approvals its
  // author stub, the ballots and receipts its hash), so no board entry is
  // both readings'.
  const of = (f: File) =>
    f.cases.flatMap((c) =>
      splitEntries(hex(c.board)).entries.map((e) => Buffer.from(e).toString("hex")),
    );
  const own6 = new Set(of(v6));
  expect(of(v7).filter((e) => own6.has(e))).toEqual([]);
});

test("receipts made for the version-6 reading of the same election are another election's", () => {
  // Each binds the version-6 encoding's hash in its statement and in the
  // ballot hash it names (T-12, T-34, T-37), so the cell-0 ballot misses
  // every seat of both panels and isn't counted.
  const c = byId(v7, "v6-reading");
  const { r } = run(v7, c);
  expect(r.rows.get("5.9")).toEqual({ status: "pass" });
  expect(c.delivery?.records.map((x) => x.code)).toEqual(Array(5).fill("delivery-stray"));
  expect(c.delivery?.excluded.map((x) => x.entry)).toEqual([3]);
  expect(countedOf(r, [3, 4, 5])).toEqual([4, 5]);
});
