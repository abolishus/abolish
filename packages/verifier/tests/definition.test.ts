import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeElectionDefinition,
  decodeElectionDefinitionRecord,
  type ElectionDefinition,
  electionDefinitionV3Hash,
  type ElectionDefinitionV3,
  type ElectionDefinitionV4,
  encodeElectionDefinition,
  encodeElectionDefinitionV3,
  encodeElectionDefinitionV4,
  RECORD_TYPES,
} from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import {
  BUNDLE_FORMAT_DEFINITION,
  BUNDLE_FORMAT_L1,
  type CheckResult,
  EXIT_CODES,
  parseBundle,
  type Report,
  runCli,
  verifyBundle,
} from "../src/index.ts";

// Format-3 bundles: the election identifier, the pinned board-entry version
// and the anchor's address come from the election definition
// (docs/spec/verifier.md, Definition). Fixtures: the definitions of
// docs/spec/vectors/election-definition.json (packages/crypto/scripts/
// definition-vectors.py, with each one's expected decode error, rule and
// hash), with versions 3 and 4 from election-definition-v3.json
// (regional-cells-vectors.py) and election-definition-v4.json
// (definition-v4-vectors.py), and the L1 evidence and boards of
// l1-anchor.json and board.json.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;

interface DefinitionVector {
  readonly id: string;
  readonly encoding: string;
  readonly error?: string;
  readonly illFormed?: string;
  readonly hash?: string;
}

interface L1Vector {
  readonly id: string;
  readonly anchor: string;
  readonly firstSegment: string;
  readonly block: { readonly header: string };
  readonly nodes: readonly string[];
  readonly checkpoints: readonly string[];
  readonly copy: string;
  readonly copyEntries?: string;
}

const vectorsOf = (name: string) => (read(name) as { vectors: DefinitionVector[] }).vectors;
const definitions = vectorsOf("election-definition.json");
const definitionsV3 = vectorsOf("election-definition-v3.json");
const definitionsV4 = vectorsOf("election-definition-v4.json");
const l1File = read("l1-anchor.json") as {
  readonly clock: Readonly<Record<string, string>>;
  readonly electionId: string;
  readonly vectors: readonly L1Vector[];
};
const boards = (read("board.json") as { boards: { id: string; entries: string[] }[] }).boards;

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function copyOf(v: L1Vector): Uint8Array {
  const copy = boards.find((b) => b.id === v.copy);
  if (copy === undefined) throw new Error(`no board ${v.copy}`);
  const n = v.copyEntries === undefined ? undefined : Number(v.copyEntries);
  return hex(copy.entries.slice(0, n).join(""));
}

const l1Of = (v: L1Vector) => ({
  firstSegment: v.firstSegment,
  header: v.block.header,
  nodes: v.nodes,
  checkpoints: v.checkpoints,
});

function format3(definition: string, v: L1Vector): Report {
  const json = JSON.stringify({
    format: BUNDLE_FORMAT_DEFINITION,
    definition,
    clock: l1File.clock,
    l1: l1Of(v),
  });
  return verifyBundle(parseBundle(json, copyOf(v)));
}

function format2(v: L1Vector): Report {
  const json = JSON.stringify({
    format: BUNDLE_FORMAT_L1,
    electionId: l1File.electionId,
    boardEntryVersion: 1,
    clock: l1File.clock,
    l1: { anchor: v.anchor, ...l1Of(v) },
  });
  return verifyBundle(parseBundle(json, copyOf(v)));
}

const vector = (id: string) => {
  const d = [...definitions, ...definitionsV3, ...definitionsV4].find((x) => x.id === id);
  if (d === undefined) throw new Error(`no definition ${id}`);
  return d;
};
const closed = l1File.vectors.find((v) => v.id === "closed") as L1Vector;
const typical = decodeElectionDefinition(hex(vector("definition-typical").encoding));

/** The typical definition, for the L1 vectors' election and anchor. */
const forElection = (anchor: string, change: Partial<ElectionDefinition> = {}) =>
  toHex(
    encodeElectionDefinition({
      ...typical,
      election_id: hex(l1File.electionId),
      l1_anchor: hex(anchor),
      ...change,
    }),
  );

const row = (r: Report, id: string) => r.checks.find((c) => c.id === id) as CheckResult;
const COMBINATION_FAILS = {
  id: "2.3",
  kind: "election",
  status: "fail",
  code: "profile-combination",
  at: {},
};
const notReached = (r: Report) => {
  expect(row(r, "4.1")).toMatchObject({ status: "unverifiable", code: "not-reached" });
  expect(row(r, "4.2")).toMatchObject({ status: "unverifiable", code: "not-reached" });
};

test("the fixtures cover undecodable, ill-formed and well-formed definitions", () => {
  expect(definitions.some((d) => d.error !== undefined)).toBe(true);
  // Both kinds of unknown version: 0, never valid, and a later one.
  const versions = definitions
    .filter((d) => d.error === "unknown-version")
    .map((d) => hex(d.encoding)[2]);
  expect(versions).toContain(0);
  expect(versions.some((v) => v !== 0)).toBe(true);
  expect(definitions.some((d) => d.illFormed !== undefined)).toBe(true);
  expect(definitions.some((d) => d.error === undefined && d.illFormed === undefined)).toBe(true);
});

test("the version-3 and version-4 fixtures cover every outcome too", () => {
  for (const file of [definitionsV3, definitionsV4]) {
    expect(file.some((d) => d.error === "unknown-version")).toBe(true);
    expect(file.some((d) => d.error !== undefined && d.error !== "unknown-version")).toBe(true);
    expect(file.some((d) => d.illFormed !== undefined)).toBe(true);
    expect(file.some((d) => d.error === undefined && d.illFormed === undefined)).toBe(true);
  }
  // Each version's own rule, reported on 2.1 like version 1's.
  expect(definitionsV3.some((d) => d.illFormed === "cells")).toBe(true);
  expect(definitionsV4.some((d) => d.illFormed === "receipt-keys")).toBe(true);
});

describe("2.1: the definition decodes strictly and is well formed", () => {
  // An empty definition is rejected with the bundle: bundle hex is never
  // empty (bundle.test.ts). Definition versions 1, 3 and 4 are read, each
  // under its own layout, hash and rules.
  for (const d of [...definitions, ...definitionsV3, ...definitionsV4].filter(
    (x) => x.encoding !== "",
  ))
    test(d.id, () => {
      const r = format3(d.encoding, closed);
      // The definition is a local file: whatever it is, nothing can verify
      // or fail the election through it (T-53).
      expect(r.verdict).toBe("unverifiable");
      expect(r.inputs.definition).toBe("local-file");
      if (d.error === "unknown-version" && hex(d.encoding)[2] !== 0) {
        // A version a later release may read: unverifiable, never failed.
        expect(row(r, "2.3")).toEqual({
          id: "2.3",
          kind: "election",
          status: "unverifiable",
          code: "unsupported-version",
          at: {},
        });
        expect(row(r, "2.1").code).toBe("not-implemented");
        expect(r.verdictAgainstInputs).toBe("unverifiable");
        notReached(r);
        return;
      }
      if (d.error !== undefined) {
        expect(row(r, "2.1")).toEqual({
          id: "2.1",
          kind: "election",
          status: "fail",
          code: "decode",
          at: { decodeError: d.error },
        });
        expect(r.definition).toBeUndefined();
        expect(r.verdictAgainstInputs).toBe("failed");
        notReached(r);
        return;
      }
      // The hash the registry must hold, from the independent implementation.
      expect(r.definition).toEqual({ hash: d.hash });
      if (d.illFormed !== undefined) {
        expect(row(r, "2.1")).toEqual({
          id: "2.1",
          kind: "election",
          status: "fail",
          code: d.illFormed,
          at: {},
        });
        expect(r.verdictAgainstInputs).toBe("failed");
        notReached(r);
        return;
      }
      // Decoding and well-formedness pass, but whether L2 registered this
      // hash isn't checked yet, so 2.1 can't pass.
      expect(row(r, "2.1")).toMatchObject({ status: "unverifiable", code: "not-implemented" });
      // Versions 1 and 3 list no receipt keys; version 4's need the anchor's
      // record from L1, which isn't read yet (P1-13b). A board-entry version
      // this verifier can't read stops every check after 2.3.
      if (row(r, "4.1").code !== "not-reached")
        expect(row(r, "2.9")).toMatchObject(
          hex(d.encoding)[2] === 4
            ? { status: "unverifiable", code: "not-implemented" }
            : { status: "pass" },
        );
    });
});

describe("2.3: the profile's versions fit together", () => {
  const pinning = (versions: Partial<Record<number, number>>) =>
    forElection(closed.anchor, {
      profile: {
        ...typical.profile,
        pins: typical.profile.pins.map((p) => ({
          ...p,
          version: versions[p.record_type] ?? p.version,
        })),
      },
    });

  // [board entry, ballot, tally opening, fits]: ballot version 1 needs board
  // entries that carry share receipts and complaints (3 or 4), tally-opening
  // version 1 needs ones that carry destruction statements (4), ballot
  // version 2, which names a cell, needs definition version 3 or 4, and ballot
  // version 3, which carries questions, definition version 5 (these are
  // version 1). Ballot version 4 stands for a version this verifier doesn't
  // know, with neither need: a later release judges it.
  const table: readonly (readonly [number, number, number, boolean])[] = [
    [4, 1, 1, true],
    [3, 1, 1, false],
    [1, 1, 1, false],
    [3, 1, 2, true],
    [1, 1, 2, false],
    [4, 2, 1, false],
    [4, 2, 2, false],
    [4, 3, 1, false],
    [4, 3, 2, false],
    [4, 4, 1, true],
    [3, 4, 1, false],
    [1, 4, 1, false],
    [1, 4, 2, true],
    [3, 4, 2, true],
    [4, 4, 2, true],
  ];
  for (const [board, ballot, opening, fits] of table)
    test(`board entry ${board}, ballot ${ballot}, tally opening ${opening}: ${fits ? "fits" : "fails"}`, () => {
      const r = format3(
        pinning({
          [RECORD_TYPES.boardEntry]: board,
          [RECORD_TYPES.ballot]: ballot,
          [RECORD_TYPES.tallyOpening]: opening,
        }),
        closed,
      );
      if (fits)
        expect(row(r, "2.3")).toMatchObject({ status: "unverifiable", code: "not-implemented" });
      else {
        expect(row(r, "2.3")).toEqual(COMBINATION_FAILS);
        expect(r.verdictAgainstInputs).toBe("failed");
      }
      // The version is one this verifier reads, so the board checks ran.
      expect(row(r, "4.1").code).not.toBe("not-reached");
      // Only version 4 carries destruction statements (8.5, report-only).
      expect(row(r, "8.5")).toMatchObject(
        board === 4
          ? { status: "unverifiable", code: "not-implemented" }
          : { status: "unverifiable", code: "not-applicable" },
      );
      expect(r.verdict).toBe("unverifiable");
    });

  test("a version this verifier can't read is unsupported before any combination", () => {
    for (const board of [2, 5]) {
      const r = format3(pinning({ [RECORD_TYPES.boardEntry]: board }), closed);
      expect(row(r, "2.3")).toMatchObject({ status: "unverifiable", code: "unsupported-version" });
      notReached(r);
    }
  });
});

describe("the board checks' inputs come from the definition", () => {
  for (const v of l1File.vectors)
    test(`${v.id}: the same checks as format 2 with the definition's fields`, () => {
      // These boards are board-entry version 1, and the typical definition
      // pins it beside ballot and tally-opening version 1: a combination 2.3
      // fails, which stops none of the other checks.
      const r3 = format3(forElection(v.anchor), v);
      const r2 = format2(v);
      // 1.3 and 2.9 need a decoded definition, which only format 3 carries.
      const others = (r: Report) =>
        r.checks.filter((c) => !["1.3", "2.1", "2.3", "2.9"].includes(c.id));
      expect(others(r3)).toEqual(others(r2));
      expect(row(r3, "2.3")).toEqual(COMBINATION_FAILS);
      // The typical definition names a placeholder membership key, not the pinned one.
      expect(row(r3, "1.3")).toMatchObject({ status: "fail", code: "membership-key" });
      expect(row(r3, "2.9")).toEqual({ id: "2.9", kind: "election", status: "pass" });
      expect(r3.board).toEqual(r2.board);
      expect(r3.l1).toEqual(r2.l1);
      expect(r3.verdictAgainstInputs).toBe("failed");
      expect(r3.verdict).toBe("unverifiable");
      // Only format 3 has a definition to report.
      expect(r2.definition).toBeUndefined();
      expect(r3.definition).toBeDefined();
    });

  test("the election identifier is the definition's: anchors are read under it", () => {
    const other = new Uint8Array(32).fill(7);
    const r = format3(forElection(closed.anchor, { election_id: other }), closed);
    // The anchor holds nothing for that election, so no entry is inside an
    // anchored extent, and the closed election was never sealed.
    expect(r.l1?.anchors).toEqual([]);
    expect(row(r, "4.1").status).toBe("pass");
    expect(row(r, "4.2")).toMatchObject({ status: "fail", code: "unsealed" });
  });

  test("the anchor is the definition's l1_anchor: another address holds no anchor", () => {
    const others = l1File.vectors.filter((v) => v.anchor !== closed.anchor);
    expect(others.length).toBeGreaterThan(0);
    for (const o of others) {
      const r = format3(forElection(o.anchor), closed);
      expect(row(r, "4.1")).toMatchObject({ status: "unverifiable", code: "not-reached" });
      expect(row(r, "4.2").status).toBe("unverifiable");
      expect(["l1-anchor-absent", "l1-proof-missing"]).toContain(row(r, "4.2").code);
    }
  });

  test("a board-entry version this verifier can't read leaves 2.3 unverifiable", () => {
    const pins = typical.profile.pins.map((p) =>
      p.record_type === RECORD_TYPES.boardEntry ? { ...p, version: 2 } : p,
    );
    const r = format3(
      forElection(closed.anchor, { profile: { ...typical.profile, pins } }),
      closed,
    );
    expect(row(r, "2.3")).toEqual({
      id: "2.3",
      kind: "election",
      status: "unverifiable",
      code: "unsupported-version",
      at: {},
    });
    expect(row(r, "2.1")).toMatchObject({ status: "unverifiable", code: "not-implemented" });
    expect(r.verdictAgainstInputs).toBe("unverifiable");
    expect(r.definition?.hash).toMatch(/^[0-9a-f]{64}$/);
    notReached(r);
  });
});

describe("the report", () => {
  test("2.9 passes a decoded version-1 definition, which lists no receipt keys", () => {
    const r = format3(forElection(closed.anchor), closed);
    expect(r.checks.find((c) => c.id === "2.9")).toEqual({
      id: "2.9",
      kind: "election",
      status: "pass",
    });
  });

  test("gives the definition hash after the inputs, in the spec's member order", () => {
    const r = format3(forElection(closed.anchor), closed);
    expect(Object.keys(r)).toEqual([
      "format",
      "verdict",
      "verdictAgainstInputs",
      "inputs",
      "definition",
      "board",
      "l1",
      "checks",
    ]);
    expect(Object.keys(r.inputs)).toEqual([
      "electionId",
      "boardEntryVersion",
      "clock",
      "now",
      "anchors",
      "l1Header",
      "anchorAddress",
      "firstSegment",
      "definition",
    ]);
  });

  test("the summary names the definition as unauthenticated, not the fields taken from it", () => {
    const json = JSON.stringify({
      format: BUNDLE_FORMAT_DEFINITION,
      definition: forElection(closed.anchor),
      clock: l1File.clock,
      l1: l1Of(closed),
    });
    const dir = mkdtempSync(join(tmpdir(), "abolish-verify-"));
    try {
      writeFileSync(join(dir, "bundle.json"), json);
      writeFileSync(join(dir, "board.bin"), copyOf(closed));
      let stderr = "";
      const code = runCli([dir], { stdout: () => {}, stderr: (t) => (stderr += t) });
      expect(code).toBe(EXIT_CODES.unverifiable);
      expect(stderr.split("\n")[0]).toBe(
        "verdict: unverifiable (unauthenticated inputs: clock, l1Header, firstSegment, definition; " +
          "against those inputs: failed)",
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("definition versions 3 and 4 (regional cells)", () => {
  const v3 = decodeElectionDefinitionRecord(hex(vector("definition-v3-typical").encoding))
    .value as ElectionDefinitionV3;
  const v4 = decodeElectionDefinitionRecord(hex(vector("definition-v4-typical").encoding))
    .value as ElectionDefinitionV4;
  const pinned = (
    pins: ElectionDefinition["profile"]["pins"],
    versions: Partial<Record<number, number>>,
  ) => pins.map((p) => ({ ...p, version: versions[p.record_type] ?? p.version }));
  /** The typical version-3 definition, for the L1 vectors' election and anchor. */
  const v3For = (anchor: string, versions: Partial<Record<number, number>> = {}) =>
    toHex(
      encodeElectionDefinitionV3({
        ...v3,
        election_id: hex(l1File.electionId),
        l1_anchor: hex(anchor),
        profile: { ...v3.profile, pins: pinned(v3.profile.pins, versions) },
      }),
    );
  const v4For = (anchor: string, versions: Partial<Record<number, number>> = {}) =>
    toHex(
      encodeElectionDefinitionV4({
        ...v4,
        election_id: hex(l1File.electionId),
        l1_anchor: hex(anchor),
        profile: { ...v4.profile, pins: pinned(v4.profile.pins, versions) },
      }),
    );

  for (const v of l1File.vectors)
    test(`${v.id}: a version-3 definition gives the board checks the same inputs as version 1`, () => {
      // Both typical profiles pin every other type at version 1, which 2.3
      // fails under either definition version; the board checks run all the same.
      const r3 = format3(v3For(v.anchor), v);
      const r1 = format3(forElection(v.anchor), v);
      expect(r3.checks).toEqual(r1.checks);
      expect(r3.board).toEqual(r1.board);
      expect(r3.l1).toEqual(r1.l1);
      expect(row(r3, "2.3")).toEqual(COMBINATION_FAILS);
      // The version-3 hash, over the version-3 encoding.
      const decoded = decodeElectionDefinitionRecord(hex(v3For(v.anchor)))
        .value as ElectionDefinitionV3;
      expect(r3.definition).toEqual({ hash: toHex(electionDefinitionV3Hash(decoded)) });
      expect(r3.definition).not.toEqual(r1.definition);
    });

  // [board entry, ballot, spoiled-ballot opening, 2.3]: definition versions 3
  // and 4 need a ballot version that names its cell (2 is the only one known), which needs board entries that carry its
  // delivery records and a spoiled-ballot opening version that opens its
  // cores: version 1 opens version-1 cores only, so it fails, and version 2,
  // which opens them, is one this verifier doesn't read yet, so it is
  // unsupported, never a failure (T-36, T-42).
  const table: readonly (readonly [number, number, number, string])[] = [
    [4, 1, 1, "profile-combination"],
    // Ballot version 3 carries questions, which definition version 5 alone has.
    [4, 3, 1, "profile-combination"],
    [4, 3, 2, "profile-combination"],
    // Ballot version 4 stands for one a later release may define as naming
    // its cell: unsupported, never failed, whatever the opening (T-36).
    [4, 4, 1, "unsupported-version"],
    [4, 4, 2, "unsupported-version"],
    [4, 2, 1, "profile-combination"],
    [4, 2, 2, "unsupported-version"],
    [3, 2, 255, "unsupported-version"],
    [1, 2, 1, "profile-combination"],
    // A board that can't carry delivery fails whatever the opening.
    [1, 2, 2, "profile-combination"],
  ];
  for (const [version, encode] of [
    [3, v3For],
    [4, v4For],
  ] as const)
    for (const [board, ballot, spoiled, code] of table)
      test(`version ${version}: board entry ${board}, ballot ${ballot}, opening ${spoiled}: ${code}`, () => {
        const r = format3(
          encode(closed.anchor, {
            [RECORD_TYPES.boardEntry]: board,
            [RECORD_TYPES.ballot]: ballot,
            [RECORD_TYPES.spoiledBallotOpening]: spoiled,
            // Tally-opening version 2 stands for one with no board need, so
            // only the ballot's needs decide.
            [RECORD_TYPES.tallyOpening]: 2,
          }),
          closed,
        );
        expect(row(r, "2.3")).toEqual(
          code === "profile-combination"
            ? COMBINATION_FAILS
            : { id: "2.3", kind: "election", status: "unverifiable", code, at: {} },
        );
        // The copy is board-entry version 1's, so the board checks may fail
        // it under another pin; only a failing combination fails it here.
        if (code === "profile-combination") expect(r.verdictAgainstInputs).toBe("failed");
        // The board-entry version is one this verifier reads, so the board
        // checks ran under it either way.
        expect(row(r, "4.1").code).not.toBe("not-reached");
        expect(r.verdict).toBe("unverifiable");
      });

  test("2.9 passes version 3, which lists no receipt keys, and reads version 4's from L1 state", () => {
    expect(row(format3(v3For(closed.anchor), closed), "2.9")).toEqual({
      id: "2.9",
      kind: "election",
      status: "pass",
    });
    // The L1-anchor vectors' anchor registered no receipt key, and their
    // nodes prove the first listed key's slot empty after opens_at.
    expect(row(format3(v4For(closed.anchor), closed), "2.9")).toEqual({
      id: "2.9",
      kind: "election",
      status: "fail",
      code: "receipt-key-unregistered",
      at: { key: 0 },
    });
  });

  test("a version-3 layout labelled version 1 doesn't decode as either", () => {
    // Its own pin says 3, so read as version 1 its bytes run past the layout.
    const bytes = hex(v3For(closed.anchor));
    bytes[2] = 1;
    const r = format3(toHex(bytes), closed);
    expect(row(r, "2.1")).toMatchObject({ status: "fail", code: "decode" });
    expect(r.definition).toBeUndefined();
    notReached(r);
  });
});
