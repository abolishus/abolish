import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  BUNDLE_FORMAT_CEREMONY,
  type CheckResult,
  parseBundle,
  type Report,
  verifyBundle,
} from "../src/index.ts";

// Format-4 bundles under definition version 7 with a fixed electorate,
// which the verifier reads as version 6 under version 7's own hashes
// (docs/spec/verifier.md, 2.3): verifier-ballots-v4.json's elections made
// again under version 7, so every ballot names the version-7 hash and proves
// membership under its scope, every transcript is made for its stub, and
// 1.3, 2.3, 3.2, 5.1 to 5.5, 5.7, 6.2 and 7.4 are judged as under version
// 6. Two cases are version 7's own: a ballot made for the same election read
// as version 6 (`v6-reading`), and a transcript made for that reading's stub
// (`v6-stub`). Fixtures: docs/spec/vectors/verifier-ballots-v4-definition-v7.json
// (packages/crypto/scripts/verifier-ballots-v4-vectors.py with `7`, with
// snarkjs's verdict on every membership proof) beside verifier-ballots-v4.json,
// and l1-anchor.json's L1 evidence, which matters only to 4.1 and 4.2.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;

interface Case {
  readonly id: string;
  readonly panel: string;
  readonly definition: string;
  readonly board: string;
  readonly expected: Readonly<Record<string, Record<string, unknown>>>;
  readonly ballots?: Report["ballots"];
}

interface File {
  readonly panels: Readonly<
    Record<string, { readonly threshold: string; readonly keys: string[] }>
  >;
  readonly clock: Readonly<Record<string, string>>;
  readonly cases: readonly Case[];
}

const v7 = read("verifier-ballots-v4-definition-v7.json") as File;
const v6 = read("verifier-ballots-v4.json") as File;
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
        panel: file.panels[c.panel],
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
// Only 2.3's ballot version 5 differs: a rolling electorate's, which a
// fixed version 7 fails and version 6 doesn't read.
const OWN = new Set(["v6-reading", "v6-stub"]);

test("every definition is version 7 under a fixed electorate", () => {
  for (const c of v7.cases) {
    const d = hex(c.definition);
    expect(d[2], c.id).toBe(7);
  }
});

test("the version-6 file's cases, and version 7's own two, are all here", () => {
  expect(v7.cases.map((c) => c.id).filter((id) => !OWN.has(id))).toEqual(v6.cases.map((c) => c.id));
  expect(v7.cases.filter((c) => OWN.has(c.id)).length).toBe(OWN.size);
});

describe("1.3, 2.3, 3.1, 3.2, 5.1 to 5.5, 5.7, 6.2 and 7.4 against the independent implementation", () => {
  for (const c of v7.cases)
    test(
      c.id,
      () => {
        const r = format4(v7, c);
        expect(rows(r, Object.keys(c.expected))).toEqual(c.expected);
        expect(r.ballots).toEqual(c.ballots);
        expect(r.openings).toEqual(c.expected["6.2"]?.["status"] === "pass" ? [] : undefined);
        expect(r.verdict).toBe("unverifiable");
        const failedElection = Object.entries(c.expected).some(
          ([id, o]) =>
            !ADMISSION.includes(id) && id !== "6.2" && id !== "7.4" && o["status"] === "fail",
        );
        expect(r.verdictAgainstInputs === "failed").toBe(failedElection);
      },
      120_000,
    );
});

test("a fixed version 7 gets version 6's verdict on every ballot and row, but 2.3 beside ballot version 5", () => {
  for (const c6 of v6.cases) {
    const c7 = byId(v7, c6.id);
    expect(c7.ballots, c6.id).toEqual(c6.ballots);
    const { "3.1": _, ...expected7 } = c7.expected;
    if (c6.id === "ballot-v5") {
      expect(expected7["2.3"]).toEqual({ status: "fail", code: "profile-combination", at: {} });
      expect(c6.expected["2.3"]).toEqual({
        status: "unverifiable",
        code: "unsupported-version",
        at: {},
      });
      expect({ ...expected7, "2.3": c6.expected["2.3"] }).toEqual(c6.expected);
    } else expect(expected7, c6.id).toEqual(c6.expected);
  }
});

test("a ballot made for the version-6 reading of the same election is another election's", () => {
  // Its hash and scope are the version-6 encoding's, so 5.1 rejects it
  // before its proof is read (T-12, T-34).
  const c = byId(v7, "v6-reading");
  expect(c.ballots).toEqual({
    admitted: 1,
    rejected: [{ entry: 2, code: "ballot-stray" }],
    repeats: [],
  });
  expect(row(format4(v7, c), "5.1")).toMatchObject({
    status: "fail",
    code: "ballot-stray",
    at: { entry: 2 },
  });
});

test("a transcript made for the version-6 reading's stub registers no key set", () => {
  // The stub the ceremony binds is version 7's own (T-37).
  const r = format4(v7, byId(v7, "v6-stub"));
  expect(row(r, "3.1")).toMatchObject({
    status: "fail",
    code: "ceremony-signature",
    at: { entry: 0 },
  });
  for (const id of ADMISSION)
    expect(row(r, id)).toMatchObject({ status: "unverifiable", code: "not-reached" });
});
