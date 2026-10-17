import { readFileSync } from "node:fs";
import { decodeElectionDefinition, encodeBoardEntry, panelId } from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import { ceremonyChecks } from "../src/ceremony.ts";

// The default panel's side of an election with an author panel
// (docs/spec/verifier.md, 2.5 and Key ceremony; docs/spec/ceremony.md,
// Author panel): 2.5's `default-seat`, the default run's `duplicate-key`
// over the author keys, and 3.2, which holds per panel, so it never passes
// while the author run isn't checked (T-14, T-54). Fixtures: the default run
// of docs/spec/vectors/author-ceremony.json (packages/crypto/scripts/
// author-ceremony-vectors.py, an independent implementation), whose seat 3
// registers author seat 1's identity key as its signing key.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

interface PanelJson {
  readonly threshold: number;
  readonly keys: readonly string[];
}
const file = read("author-ceremony.json") as {
  readonly election: Readonly<Record<string, string>>;
  readonly panels: Readonly<Record<string, PanelJson>>;
  readonly transcripts: readonly {
    readonly id: string;
    readonly panel: string;
    readonly transcript: string;
    readonly result: { readonly hash: string };
  }[];
};
const definitions = read("election-definition.json") as {
  readonly vectors: readonly { readonly id: string; readonly encoding: string }[];
};

const panelOf = (name: string) => {
  const p = file.panels[name];
  if (p === undefined) throw new Error(`no panel ${name}`);
  return { threshold: p.threshold, keys: p.keys.map(hex) };
};
const run = file.transcripts.find((t) => t.id === "default-duplicate-author");
if (run === undefined) throw new Error("no default-duplicate-author transcript");
const defaultPanel = panelOf(run.panel);
const authorKeys = panelOf("author-3").keys;
const election = file.election as Record<
  "l2ChainId" | "trusteeRegistry" | "electionId" | "stubHash",
  string
>;

// The fields the ceremony checks read, the same in every definition version:
// the typical version-1 profile (transcript version 1) and the vector's
// election, its default panel and its transcript's hash.
const typical = definitions.vectors.find((v) => v.id === "definition-typical");
if (typical === undefined) throw new Error("no typical definition");
const d = {
  profile: decodeElectionDefinition(hex(typical.encoding)).profile,
  election_id: hex(election.electionId),
  l2_chain_id: BigInt(election.l2ChainId),
  trustee_registry: hex(election.trusteeRegistry),
  panel_id: panelId(defaultPanel),
  threshold: defaultPanel.threshold,
  panel_size: defaultPanel.keys.length,
  ceremony_transcript_hash: hex(run.result.hash),
};
const entries = [
  encodeBoardEntry(
    { election_id: d.election_id, index: 0n, segment: 0, payload: hex(run.transcript) },
    7,
  ),
];
const check = (author: readonly Uint8Array[]) =>
  ceremonyChecks(d, hex(election.stubHash), defaultPanel, author, entries, 7);

describe("the default panel beside an author panel", () => {
  test("the default run's duplicate-key reads the author keys", () => {
    // Seat 3's signing key is author seat 1's identity key: it qualifies
    // only when the run doesn't know the author panel.
    expect(check([]).report?.seats).toEqual([1, 2, 3, 4].map((index) => ({ index, reasons: [] })));
    expect(check(authorKeys).report?.seats).toEqual([
      { index: 1, reasons: [] },
      { index: 2, reasons: [] },
      { index: 3, reasons: ["duplicate-key"] },
      { index: 4, reasons: [] },
    ]);
  });

  test("3.2 passes without an author panel, and never with one", () => {
    const alone = check([]);
    expect(alone.rows.get("3.2")).toEqual({ status: "pass" });
    expect(alone.registered).toHaveLength(4);
    // Three of four seats meet k = 3 and rule 7's n − 1 = 3, but that is the
    // default panel's half of 3.2: no key set is returned for one half.
    const beside = check(authorKeys);
    expect(beside.rows.get("3.2")).toEqual({ status: "unverifiable", code: "not-implemented" });
    expect(beside.registered).toBeUndefined();
    expect(beside.report?.registered).toHaveLength(3);
  });

  test("2.5 fails `default-seat` at the first author seat holding a default seat's key", () => {
    expect(check(authorKeys).rows.get("2.5")).toEqual({
      status: "unverifiable",
      code: "not-implemented",
    });
    const [q1, q2] = defaultPanel.keys;
    const [a1] = authorKeys;
    if (q1 === undefined || q2 === undefined || a1 === undefined) throw new Error("short panels");
    for (const [author, seat] of [
      [[q1], 1],
      [[a1, q2], 2],
      [[a1, q2, q1], 2],
      [[a1, Uint8Array.from(q1)], 2],
    ] as const) {
      const r = check(author);
      expect(r.rows.get("2.5")).toEqual({ status: "fail", code: "default-seat", at: { seat } });
      // The transcript is still checked: 3.1 and 3.2 report what it holds.
      expect(r.report).toBeDefined();
    }
  });

  test("another panel is `panel-unpinned` before `default-seat`", () => {
    const r = ceremonyChecks(
      { ...d, threshold: d.threshold - 1 },
      hex(election.stubHash),
      defaultPanel,
      defaultPanel.keys,
      entries,
      7,
    );
    expect(r.rows.get("2.5")).toEqual({ status: "fail", code: "panel-unpinned", at: {} });
  });
});
