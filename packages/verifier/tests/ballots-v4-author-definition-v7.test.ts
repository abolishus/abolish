import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  BUNDLE_FORMAT_CEREMONY,
  type CheckResult,
  parseBundle,
  type Report,
  verifyBundle,
} from "../src/index.ts";

// Format-4 bundles beside an author panel under definition version 7 with a
// fixed electorate, which the verifier reads as version 6 under version 7's
// own hashes and stubs (docs/spec/verifier.md, 2.3; Key ceremony, step 5):
// verifier-ballots-v4-author.json's elections made again under version 7, so
// both runs are made for version 7's stubs, the approvals name its author
// stub, every ballot names its hash and proves membership under its scope,
// and 1.3, 2.3, 2.5, 3.1, 3.2, 5.1 to 5.5, 5.7, 6.2 and 7.4 are judged as
// under version 6. Three cases are version 7's own, each made for the same
// election read as version 6: a ballot (`v6-reading`), the author approvals
// (`v6-approvals`) and the author transcript (`v6-author-stub`).
// Fixtures: docs/spec/vectors/verifier-ballots-v4-author-definition-v7.json
// (packages/crypto/scripts/verifier-ballots-v4-author-vectors.py with `7`,
// with snarkjs's verdict on every membership proof) beside
// verifier-ballots-v4-author.json, and l1-anchor.json's L1 evidence, which
// matters only to 4.1 and 4.2.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;

interface Case {
  readonly id: string;
  readonly definition: string;
  readonly board: string;
  readonly expected: Readonly<Record<string, Record<string, unknown>>>;
  readonly ballots?: Report["ballots"];
}

interface File {
  readonly panel: { readonly threshold: string; readonly keys: string[] };
  readonly clock: Readonly<Record<string, string>>;
  readonly cases: readonly Case[];
}

const v7 = read("verifier-ballots-v4-author-definition-v7.json") as File;
const v6 = read("verifier-ballots-v4-author.json") as File;
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
const format4 = (file: File, c: Case) =>
  verifyBundle(
    parseBundle(
      JSON.stringify({
        format: BUNDLE_FORMAT_CEREMONY,
        definition: c.definition,
        clock: file.clock,
        l1,
        panel: file.panel,
      }),
      hex(c.board),
    ),
  );
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
const OWN = new Set(["v6-reading", "v6-approvals", "v6-author-stub"]);

test("every definition is version 7 under a fixed electorate", () => {
  for (const c of v7.cases) expect(hex(c.definition)[2], c.id).toBe(7);
});

test("the version-6 file's cases, and version 7's own three, are all here", () => {
  expect(v7.cases.map((c) => c.id).filter((id) => !OWN.has(id))).toEqual(v6.cases.map((c) => c.id));
  expect(v7.cases.filter((c) => OWN.has(c.id)).length).toBe(OWN.size);
});

describe("1.3, 2.3, 2.5, 3.1, 3.2, 5.1 to 5.5, 5.7, 6.2 and 7.4 against the independent implementation", () => {
  for (const c of v7.cases)
    test(
      c.id,
      () => {
        const r = format4(v7, c);
        expect(rows(r, Object.keys(c.expected))).toEqual(c.expected);
        expect(r.ballots).toEqual(c.ballots);
        expect(r.verdict).toBe("unverifiable");
        // 2.3 fails every author panel, an election check (T-52).
        expect(r.verdictAgainstInputs).toBe("failed");
      },
      120_000,
    );
});

test("a fixed version 7 gets version 6's verdict on every ballot and row beside an author panel", () => {
  for (const c6 of v6.cases) {
    const c7 = byId(v7, c6.id);
    expect(c7.ballots, c6.id).toEqual(c6.ballots);
    expect(c7.expected, c6.id).toEqual(c6.expected);
  }
});

test("no definition, ballot or run is both readings'", () => {
  for (const c6 of v6.cases) {
    const c7 = byId(v7, c6.id);
    expect(c7.definition, c6.id).not.toBe(c6.definition);
    expect(c7.board, c6.id).not.toBe(c6.board);
  }
});

test("a ballot made for the version-6 reading of the same election is another election's", () => {
  // Its hash and scope are the version-6 encoding's, so 5.1 rejects it
  // before its proof is read (T-12, T-34).
  const c = byId(v7, "v6-reading");
  expect(c.ballots).toEqual({
    admitted: 1,
    rejected: [{ entry: 4, code: "ballot-stray" }],
    repeats: [],
  });
  expect(row(format4(v7, c), "5.1")).toMatchObject({
    status: "fail",
    code: "ballot-stray",
    at: { entry: 4 },
  });
});

test("approvals naming the version-6 reading's author stub approve nothing", () => {
  // The author stub an approval binds is version 7's own (T-37, T-17).
  const r = format4(v7, byId(v7, "v6-approvals"));
  expect(row(r, "3.1")).toMatchObject({
    status: "fail",
    code: "author-approvals",
    at: { panel: "author" },
  });
  notReached(r);
});

test("an author transcript made for the version-6 reading's author stub registers no author key set", () => {
  const r = format4(v7, byId(v7, "v6-author-stub"));
  expect(row(r, "3.1")).toMatchObject({
    status: "fail",
    code: "ceremony-signature",
    at: { entry: 0, panel: "author" },
  });
  notReached(r);
});
