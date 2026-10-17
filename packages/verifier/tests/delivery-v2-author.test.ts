import { readFileSync } from "node:fs";
import type { AnchorClock, RegisteredKeys } from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { ballotChecks } from "../src/ballots.ts";
import { ceremonyChecks } from "../src/ceremony.ts";
import { countedChecks, type CountedInputs } from "../src/counted.ts";
import { authorRunOf, decodeDefinition, readDefinition } from "../src/definition.ts";
import { splitEntries } from "../src/index.ts";

// Delivery (5.9) under definition version 6 beside an author panel: each
// selected ballot is delivered only once every registered seat of both
// panels has receipted it, each receipt checked against its own panel's
// share hash and its own run's signing key, with the author panel's seats
// those its own run registered and its approvals approved on the board, never
// a key set taken on trust or the default panel's alone (docs/spec/
// verifier.md, Key ceremony, step 5, and Counted set and tally, step 3;
// docs/spec/delivery.md, Delivery check (version 2); T-37, T-17, T-25). The
// close check and the per-panel tally beside an author panel are P2-16 part
// 4d-3d's, so 6.3, 7.1 to 7.3 and 8.5 stay not reached. Fixtures:
// docs/spec/vectors/verifier-delivery-v2-author.json (packages/crypto/
// scripts/verifier-delivery-v2-author-vectors.py, an independent
// implementation of both runs, the approvals, the receipts and the delivery
// check over both panels), whose ballots are verifier-ballots-v4-author.json's
// admitted ones; selection (6.1) needs L1 evidence these copies don't carry,
// so the admitted ballots stand in for the selected ones, as each has its own
// nullifier.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);

interface Case {
  readonly id: string;
  readonly definition: string;
  readonly board: string;
  readonly clock: Readonly<Record<string, string>>;
  readonly expected: Readonly<Record<string, Record<string, unknown>>>;
  readonly delivery?: unknown;
  readonly counted?: readonly number[];
}

const file = JSON.parse(
  readFileSync(new URL("verifier-delivery-v2-author.json", VECTORS), "utf8"),
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
const runs = (cap: number) => Math.min(Number(process.env["FC_NUM_RUNS"] ?? 100), cap);

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
  return { ceremony, candidates, entries, inputs };
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

describe("5.9 beside an author panel against the independent implementation", () => {
  for (const c of file.cases)
    test(c.id, () => {
      const { ceremony, candidates, inputs } = election(c);
      const r = countedChecks(inputs());
      expect(rows(r)).toEqual(c.expected);
      if (c.delivery === undefined) {
        // No approvals on the copy: no key set is registered, so no ballot
        // is admitted and nothing is delivered.
        expect(ceremony.registered).toBeUndefined();
        expect(ceremony.authorRegistered).toBeUndefined();
        expect(candidates).toEqual([]);
        expect(r.delivery).toBeUndefined();
        return;
      }
      expect(ceremony.registered?.map((k) => k.index)).toEqual([1, 2, 3]);
      expect(ceremony.authorRegistered?.map((k) => k.index)).toEqual([1, 2]);
      expect(candidates.map((x) => x.entry)).toEqual([3, 4, 5]);
      expect(r.delivery).toEqual(c.delivery);
      expect(countedOf(r, [3, 4, 5])).toEqual(c.counted);
      // Nothing past delivery is decided here yet.
      expect(r.cells).toBeUndefined();
      expect(r.close).toBeUndefined();
    });
});

describe("the author panel's key set is its own approved run's", () => {
  test("without it nothing is decided, even where the default panel's seats delivered every ballot", () => {
    const { inputs } = election(byId("default-only"));
    const { authorRegistered: _, ...without } = inputs();
    const r = countedChecks(without);
    for (const o of r.rows.values())
      expect(o).toMatchObject({ status: "unverifiable", code: "not-reached" });
    expect(r.delivery).toBeUndefined();
  });

  test("never the default panel's, a copy of the approved set or another set of seats", () => {
    const { ceremony, inputs } = election(byId("delivered"));
    const approved = ceremony.authorRegistered as readonly RegisteredKeys[];
    const sets: (readonly RegisteredKeys[])[] = [
      ceremony.registered as readonly RegisteredKeys[],
      [...approved],
      approved.slice(0, 1),
      [],
    ];
    for (const authorRegistered of sets)
      expect(() => countedChecks(inputs({ authorRegistered }))).toThrow(/approved key set/);
  });
});

describe("delivery over subsets of the copy's receipts", () => {
  test("a ballot is counted exactly when every registered seat of both panels' honest receipt for it is kept", () => {
    // The delivered case's honest receipts are the ones its report doesn't
    // list; each names a ballot and a seat by its position in the copy (three
    // per ballot from the default panel, then two from the author panel).
    const c = byId("delivered");
    const { entries, inputs } = election(c);
    const listed = new Set(
      (
        (c.delivery as { readonly records: readonly { readonly entry: number }[] }).records ?? []
      ).map((x) => x.entry),
    );
    const receipts = entries.flatMap((_, at) => (at > 5 && !listed.has(at) ? [at] : []));
    expect(receipts).toHaveLength(15);
    const ballotOf = (k: number) => 3 + Math.floor(k / 5);
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 15, maxLength: 15 }), (keep) => {
        const kept = entries.filter((_, at) => {
          const k = receipts.indexOf(at);
          return k === -1 || keep[k] === true;
        });
        const r = countedChecks(inputs({ entries: kept, extent: kept.length }));
        const counted = [3, 4, 5].filter((b) =>
          receipts.every((_, k) => ballotOf(k) !== b || keep[k] === true),
        );
        expect(r.rows.get("5.9")).toEqual({ status: "pass" });
        expect(countedOf(r, [3, 4, 5])).toEqual(counted);
      }),
      { numRuns: runs(50) },
    );
  }, 120_000);
});
