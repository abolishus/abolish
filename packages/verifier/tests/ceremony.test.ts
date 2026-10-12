import { readFileSync } from "node:fs";
import {
  decodeElectionDefinition,
  encodeElectionDefinition,
  RECORD_TYPES,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  BUNDLE_FORMAT_CEREMONY,
  BUNDLE_FORMAT_DEFINITION,
  BundleError,
  type CheckResult,
  parseBundle,
  type Report,
  verifyBundle,
} from "../src/index.ts";

// Format-4 bundles: the key-ceremony checks against the panel the bundle pins
// (docs/spec/verifier.md, Key ceremony). Fixtures: the elections of
// docs/spec/vectors/verifier-ceremony.json (packages/crypto/scripts/
// verifier-ceremony-vectors.py, an independent implementation, with each
// one's expected rows and transcript check), and the L1 evidence and clock of
// l1-anchor.json, which matter only to 4.1 and 4.2: the ceremony checks don't
// depend on them.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;

interface PanelJson {
  readonly threshold: string;
  readonly keys: readonly string[];
}

interface Case {
  readonly id: string;
  readonly panel: string;
  readonly definition: string;
  readonly board: string;
  readonly expected: Readonly<Record<"2.5" | "3.1" | "3.2", Record<string, unknown>>>;
  readonly ceremony?: Report["ceremony"];
}

const file = read("verifier-ceremony.json") as {
  readonly panels: Readonly<Record<string, PanelJson>>;
  readonly cases: readonly Case[];
};
const l1File = read("l1-anchor.json") as {
  readonly clock: Readonly<Record<string, string>>;
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
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const byId = (id: string) => {
  const c = file.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};
const panelOf = (name: string) => {
  const p = file.panels[name];
  if (p === undefined) throw new Error(`no panel ${name}`);
  return p;
};

const json = (definition: string, panel: unknown, extra: object = {}) =>
  JSON.stringify({
    format: BUNDLE_FORMAT_CEREMONY,
    definition,
    clock: l1File.clock,
    l1,
    panel,
    ...extra,
  });

const format4 = (c: Case, definition = c.definition, board = hex(c.board)) =>
  verifyBundle(parseBundle(json(definition, panelOf(c.panel)), board));

const row = (r: Report, id: string) => r.checks.find((x) => x.id === id) as CheckResult;
const rows = (r: Report) =>
  Object.fromEntries(
    (["2.5", "3.1", "3.2"] as const).map((id) => {
      const { status, code, at } = row(r, id);
      return [id, { status, ...(code !== undefined && { code }), ...(at !== undefined && { at }) }];
    }),
  );

test("the fixtures cover a pass, every row's failures and the unverifiable cases", () => {
  const outcomes = file.cases.flatMap((c) => Object.values(c.expected));
  for (const want of [
    { status: "pass" },
    { status: "fail", code: "panel-unpinned" },
    { status: "fail", code: "ceremony-quorum" },
    { status: "fail", code: "ceremony-participation" },
    { status: "fail", code: "ceremony-signature" },
    { status: "fail", code: "ceremony-order" },
    { status: "fail", code: "decode" },
    { status: "unverifiable", code: "ceremony-transcript-missing" },
    { status: "unverifiable", code: "unsupported-version" },
  ])
    expect(outcomes.some((o) => Object.entries(want).every(([k, v]) => o[k] === v))).toBe(true);
});

describe("2.5, 3.1 and 3.2 against the independent implementation", () => {
  for (const c of file.cases)
    test(c.id, () => {
      const r = format4(c);
      expect(rows(r)).toEqual(c.expected);
      expect(r.ceremony).toEqual(c.ceremony);
      // The panel and the definition are local files: whatever the transcript
      // is, nothing can verify or fail the election through them (T-53).
      expect(r.inputs.panel).toBe("local-file");
      expect(r.verdict).toBe("unverifiable");
      // 3.1 needs the registration on L2, so it never passes yet.
      expect(row(r, "3.1").status).not.toBe("pass");
      if (Object.values(c.expected).some((o) => o["status"] === "fail"))
        expect(r.verdictAgainstInputs).toBe("failed");
    });
});

describe("the transcript is the definition's, wherever it sits", () => {
  const honest = byId("honest");
  const entry = honest.ceremony?.entry ?? -1;
  const entries = parseBundle(
    json(honest.definition, panelOf(honest.panel)),
    hex(honest.board),
  ).entries;

  test("the honest board's transcript isn't its first transcript entry", () => {
    // An abandoned run's transcript comes first: only the hash picks.
    expect(entry).toBeGreaterThan(0);
  });

  test("the ceremony checks don't depend on the board checks", () => {
    // The L1 evidence is another election's, so 4.1 and 4.2 can't pass, and
    // the transcript is still checked: the definition's hash authenticates it.
    const r = format4(honest);
    expect(row(r, "4.2").status).not.toBe("pass");
    expect(row(r, "3.2").status).toBe("pass");
  });

  test("a copy that holds only the transcript's entry is enough", () => {
    const only = Uint8Array.from(entries[entry] as Uint8Array);
    const r = format4(honest, honest.definition, only);
    expect(row(r, "3.2").status).toBe("pass");
    expect(r.ceremony?.entry).toBe(0);
  });

  test("any change to the transcript's entry leaves it missing, never another transcript", () => {
    const board = hex(honest.board);
    const start = entries.slice(0, entry).reduce((n, e) => n + e.length, 0);
    const length = (entries[entry] as Uint8Array).length;
    fc.assert(
      fc.property(
        // From the payload's first byte on (51 bytes of envelope precede it),
        // or the entry's election identifier (bytes 3 to 34).
        fc.oneof(fc.integer({ min: 51, max: length - 1 }), fc.integer({ min: 3, max: 34 })),
        fc.integer({ min: 1, max: 255 }),
        (at, x) => {
          const changed = Uint8Array.from(board);
          changed[start + at] = (changed[start + at] as number) ^ x;
          const r = format4(honest, honest.definition, changed);
          expect(row(r, "3.1")).toMatchObject({
            status: "unverifiable",
            code: "ceremony-transcript-missing",
          });
          expect(row(r, "3.2")).toMatchObject({ status: "unverifiable", code: "not-reached" });
          expect(r.ceremony).toBeUndefined();
        },
      ),
      { numRuns: Math.min(Number(process.env["FC_NUM_RUNS"] ?? 100), 200) },
    );
  });

  test("a definition naming another hash finds no transcript", () => {
    const d = decodeElectionDefinition(hex(honest.definition));
    const other = toHex(
      encodeElectionDefinition({ ...d, ceremony_transcript_hash: new Uint8Array(32).fill(1) }),
    );
    const r = format4(honest, other);
    expect(row(r, "3.1")).toMatchObject({ code: "ceremony-transcript-missing" });
  });
});

describe("when the ceremony checks can't run", () => {
  const honest = byId("honest");

  test("a definition that doesn't decode leaves them not reached", () => {
    const r = format4(honest, "0001");
    for (const id of ["2.5", "3.1", "3.2"])
      expect(row(r, id)).toMatchObject({ status: "unverifiable", code: "not-reached" });
    expect(row(r, "2.1")).toMatchObject({ status: "fail", code: "decode" });
    expect(r.ceremony).toBeUndefined();
  });

  test("a board-entry version this verifier can't read leaves them not reached", () => {
    const d = decodeElectionDefinition(hex(honest.definition));
    const pins = d.profile.pins.map((p) =>
      p.record_type === RECORD_TYPES.boardEntry ? { ...p, version: 2 } : p,
    );
    const r = format4(
      honest,
      toHex(encodeElectionDefinition({ ...d, profile: { ...d.profile, pins } })),
    );
    for (const id of ["2.5", "3.1", "3.2"])
      expect(row(r, id)).toMatchObject({ status: "unverifiable", code: "not-reached" });
    expect(row(r, "2.3")).toMatchObject({ code: "unsupported-version" });
  });

  test("format 3 has no panel, so they stay not implemented", () => {
    const r = verifyBundle(
      parseBundle(
        JSON.stringify({
          format: BUNDLE_FORMAT_DEFINITION,
          definition: honest.definition,
          clock: l1File.clock,
          l1,
        }),
        hex(honest.board),
      ),
    );
    for (const id of ["2.5", "3.1", "3.2"])
      expect(row(r, id)).toMatchObject({ status: "unverifiable", code: "not-implemented" });
    expect(r.ceremony).toBeUndefined();
    expect(r.inputs.panel).toBeUndefined();
  });
});

describe("the bundle's panel", () => {
  const honest = byId("honest");
  const panel = panelOf("panel-4");
  const parse = (p: unknown, extra: object = {}) =>
    parseBundle(json(honest.definition, p, extra), hex(honest.board));

  test("is read as given, a local input", () => {
    const b = parse(panel);
    expect(b.format).toBe(BUNDLE_FORMAT_CEREMONY);
    expect(b.sources.panel).toBe("local-file");
    if (b.format !== BUNDLE_FORMAT_CEREMONY) throw new Error("format");
    expect(b.panel.threshold).toBe(3);
    expect(b.panel.keys.map(toHex)).toEqual(panel.keys);
  });

  const key = panel.keys[0] as string;
  const rejected: [string, unknown, object?][] = [
    ["a missing panel", undefined],
    ["an unknown member", { ...panel, extra: "1" }],
    ["a missing threshold", { keys: panel.keys }],
    ["a threshold as a number", { ...panel, threshold: 3 }],
    ["a threshold of 1", { ...panel, threshold: "1" }],
    ["a threshold over n", { ...panel, threshold: "5" }],
    ["a threshold over MAX_TRUSTEES", { ...panel, threshold: "17" }],
    ["a key in two seats", { ...panel, keys: [key, key, ...panel.keys.slice(2)] }],
    [
      "a key that isn't a P-256 point",
      { ...panel, keys: [`04${key.slice(2)}`, ...panel.keys.slice(1)] },
    ],
    ["a short key", { ...panel, keys: [key.slice(2), ...panel.keys.slice(1)] }],
    ["uppercase hex", { ...panel, keys: [key.toUpperCase(), ...panel.keys.slice(1)] }],
    ["keys that aren't an array", { ...panel, keys: key }],
    ["format 3 with a panel", panel, { format: BUNDLE_FORMAT_DEFINITION }],
  ];
  for (const [name, p, extra] of rejected)
    test(`rejects ${name}`, () => {
      expect(() => parse(p, extra)).toThrow(BundleError);
    });
});

test("the report gives the ceremony after the definition, and the panel last among the inputs", () => {
  const r = format4(byId("honest"));
  expect(Object.keys(r)).toEqual([
    "format",
    "verdict",
    "verdictAgainstInputs",
    "inputs",
    "definition",
    "ceremony",
    "board",
    "l1",
    "checks",
  ]);
  expect(Object.keys(r.inputs).at(-1)).toBe("panel");
});
