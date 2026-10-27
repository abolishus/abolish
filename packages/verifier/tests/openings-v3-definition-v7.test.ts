import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  BUNDLE_FORMAT_CEREMONY,
  type CheckResult,
  parseBundle,
  type Report,
  verifyBundle,
} from "../src/index.ts";

// Format-4 bundles under definition version 7 with a fixed electorate, which
// the verifier reads as version 6 under version 7's own hash
// (docs/spec/verifier.md, 2.3): verifier-openings-v3.json's election made
// again under version 7, its ballots verifier-ballots-v4-definition-v7.json's
// and every opening made for the version-7 hash, so 2.3 and 6.2 and the
// report's openings are judged as under version 6. One case is version 7's
// own: an opening made for the same election read as version 6
// (`v6-reading`). Fixtures: docs/spec/vectors/verifier-openings-v3-definition-v7.json
// (packages/crypto/scripts/verifier-openings-v3-vectors.py with `7`, an
// independent implementation) beside verifier-openings-v3.json, and
// l1-anchor.json's L1 evidence, which matters only to 4.1 and 4.2.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;

interface Case {
  readonly id: string;
  readonly panel: string;
  readonly definition: string;
  readonly clock: Readonly<Record<string, string>>;
  readonly board: string;
  readonly expected: Readonly<Record<string, Record<string, unknown>>>;
  readonly openings: NonNullable<Report["openings"]>;
}

interface File {
  readonly panels: Readonly<
    Record<string, { readonly threshold: string; readonly keys: string[] }>
  >;
  readonly cases: readonly Case[];
}

const v7 = read("verifier-openings-v3-definition-v7.json") as File;
const v6 = read("verifier-openings-v3.json") as File;
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
const byId = (file: File, id: string) => {
  const c = file.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};
const run = (file: File, c: Case) =>
  verifyBundle(
    parseBundle(
      JSON.stringify({
        format: BUNDLE_FORMAT_CEREMONY,
        definition: c.definition,
        clock: c.clock,
        l1,
        panel: file.panels[c.panel],
      }),
      hex(c.board),
    ),
  );
const row = (r: Report, id: string) => {
  const { status, code, at } = r.checks.find((x) => x.id === id) as CheckResult;
  return { status, ...(code !== undefined && { code }), ...(at !== undefined && { at }) };
};
// What an opening's report says but where it sits: openings are sorted by
// their bytes within a segment (board.md, Spoiled-ballot openings), and
// their bytes and core hashes move with the definition hash, so the entries
// they name do too.
const verdicts = (c: Case) =>
  c.openings
    .map((o) =>
      JSON.stringify({
        ...o,
        entry: undefined,
        coreHash: undefined,
        breaks: o.breaks.map((b) => b.code),
      }),
    )
    .sort();
const OWN = new Set(["v6-reading"]);

test("every definition is version 7", () => {
  for (const c of v7.cases) expect(hex(c.definition)[2], c.id).toBe(7);
});

test("the version-6 file's cases, and version 7's own, are all here", () => {
  expect(v7.cases.map((c) => c.id).filter((id) => !OWN.has(id))).toEqual(v6.cases.map((c) => c.id));
  expect(v7.cases.filter((c) => OWN.has(c.id)).length).toBe(OWN.size);
});

describe("2.3 and 6.2 against the independent implementation", () => {
  for (const c of v7.cases)
    test(c.id, { timeout: 60_000 }, () => {
      const r = run(v7, c);
      expect(row(r, "6.2")).toEqual(c.expected["6.2"]);
      expect(row(r, "2.3")).toEqual(c.expected["2.3"]);
      expect(r.openings).toEqual(c.openings);
      expect(r.ballots?.rejected.every((b) => b.code === "window-boarded-late")).toBe(true);
      // An opening never counts, displaces or fails anything (T-53).
      expect(r.verdict).toBe("unverifiable");
      expect(r.verdictAgainstInputs).not.toBe("failed");
    });
});

test("a fixed version 7 gets version 6's rows and the same verdict on every opening, over other cores", () => {
  for (const c6 of v6.cases) {
    const c7 = byId(v7, c6.id);
    expect(c7.expected, c6.id).toEqual(c6.expected);
    expect(verdicts(c7), c6.id).toEqual(verdicts(c6));
  }
  // The core hash binds the definition hash (docs/spec/challenge.md, Opening
  // version 3), so no core is both readings'.
  const cores = (f: File) =>
    f.cases.flatMap((c) =>
      c.openings.flatMap((o) => (o.coreHash === undefined ? [] : [o.coreHash])),
    );
  const own6 = new Set(cores(v6));
  expect(cores(v7).length).toBeGreaterThan(0);
  expect(cores(v7).filter((h) => own6.has(h))).toEqual([]);
});

test("an opening made for the version-6 reading of the same election is another election's", () => {
  // Its core and every ciphertext's associated data bind the version-6
  // encoding's hash (T-12, T-34).
  const c = byId(v7, "v6-reading");
  expect(c.openings).toEqual([{ entry: 2, code: "opening-stray", breaks: [] }]);
  expect(row(run(v7, c), "6.2")).toEqual({
    status: "fail",
    code: "opening-stray",
    at: { entry: 2 },
  });
});
