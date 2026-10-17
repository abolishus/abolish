import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeElectionDefinition,
  decodeElectionDefinitionRecord,
  decodeElectionDefinitionV5,
  decodeElectionDefinitionV6,
  type ElectionDefinition,
  electionDefinitionV3Hash,
  type ElectionDefinitionV3,
  type ElectionDefinitionV4,
  encodeElectionDefinition,
  encodeElectionDefinitionV3,
  encodeElectionDefinitionV4,
  encodeElectionDefinitionV5,
  encodeElectionDefinitionV6,
  electionDefinitionV6Hash,
  membershipVkHash,
  type ElectionDefinitionV6,
  POLL_CLASSES,
  RECORD_TYPES,
  RESULTS_MODES,
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
import { judgeFor } from "../src/ballots.ts";
import { decodeDefinition } from "../src/definition.ts";
import { tallyChecks } from "../src/tallies.ts";

// Format-3 bundles: the election identifier, the pinned board-entry version
// and the anchor's address come from the election definition
// (docs/spec/verifier.md, Definition). Fixtures: the definitions of
// docs/spec/vectors/election-definition.json (packages/crypto/scripts/
// definition-vectors.py, with each one's expected decode error, rule and
// hash), with versions 3 and 4 from election-definition-v3.json
// (regional-cells-vectors.py), election-definition-v4.json
// (definition-v4-vectors.py) and election-definition-v5.json
// (definition-v5-vectors.py), and the L1 evidence and boards of
// l1-anchor.json and board.json.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;

interface DefinitionVector {
  readonly id: string;
  readonly encoding: string;
  readonly error?: string;
  readonly illFormed?: string;
  /** Under definition version 5, `option-count`'s and `selections`' first failing question. */
  readonly illFormedQuestion?: string;
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
const definitionsV5 = vectorsOf("election-definition-v5.json");
const definitionsV6 = vectorsOf("election-definition-v6.json");
// Made before version 5 had a layout, so its file expects `unknown-version`;
// a release that reads version 5 decodes it under version 5's layout instead.
const V4_LABELLED_FIVE = "definition-v4-version-five";
// The same for version 5's layout labelled version 6.
const V5_LABELLED_SIX = "definition-v5-version-six";
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
  const d = [
    ...definitions,
    ...definitionsV3,
    ...definitionsV4,
    ...definitionsV5,
    ...definitionsV6,
  ].find((x) => x.id === id);
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

test("the version-3 to version-6 fixtures cover every outcome too", () => {
  for (const file of [definitionsV3, definitionsV4, definitionsV5, definitionsV6]) {
    expect(file.some((d) => d.error === "unknown-version")).toBe(true);
    expect(file.some((d) => d.error !== undefined && d.error !== "unknown-version")).toBe(true);
    expect(file.some((d) => d.illFormed !== undefined)).toBe(true);
    expect(file.some((d) => d.error === undefined && d.illFormed === undefined)).toBe(true);
  }
  // Each version's own rule, reported on 2.1 like version 1's.
  expect(definitionsV3.some((d) => d.illFormed === "cells")).toBe(true);
  expect(definitionsV4.some((d) => d.illFormed === "receipt-keys")).toBe(true);
  expect(definitionsV5.some((d) => d.illFormed === "questions")).toBe(true);
  expect(definitionsV5.some((d) => d.illFormedQuestion !== undefined)).toBe(true);
  for (const rule of ["results", "civic-sealed", "author-panel"])
    expect(definitionsV6.some((d) => d.illFormed === rule)).toBe(true);
  expect(definitionsV6.some((d) => d.illFormedQuestion !== undefined)).toBe(true);
});

describe("2.1: the definition decodes strictly and is well formed", () => {
  // An empty definition is rejected with the bundle: bundle hex is never
  // empty (bundle.test.ts). Definition versions 1, 3, 4, 5 and 6 are read,
  // each under its own layout, hash and rules.
  for (const d of [
    ...definitions,
    ...definitionsV3,
    ...definitionsV4,
    ...definitionsV5,
    ...definitionsV6,
  ].filter((x) => x.encoding !== "" && x.id !== V4_LABELLED_FIVE && x.id !== V5_LABELLED_SIX))
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
          // Version 5 names the first failing question (docs/spec/verifier.md, Definition).
          at: d.illFormedQuestion === undefined ? {} : { question: Number(d.illFormedQuestion) },
        });
        expect(r.verdictAgainstInputs).toBe("failed");
        notReached(r);
        return;
      }
      // Decoding and well-formedness pass, but whether L2 registered this
      // hash isn't checked yet, so 2.1 can't pass.
      expect(row(r, "2.1")).toMatchObject({ status: "unverifiable", code: "not-implemented" });
      // Versions 1 and 3 list no receipt keys; those of version 4 and later
      // need the anchor's record from L1, which isn't read yet (P1-13b). A
      // board-entry version this verifier can't read stops every check after 2.3.
      if (row(r, "4.1").code !== "not-reached")
        expect(row(r, "2.9")).toMatchObject(
          (hex(d.encoding)[2] as number) >= 4
            ? { status: "unverifiable", code: "not-implemented" }
            : { status: "pass" },
        );
    });
});

test("definition version 7 stays unverifiable at its version byte, never failed", () => {
  // This release reads version 6; a later one reads 7 (T-36).
  for (const name of ["election-definition-v7.json"]) {
    const later = vectorsOf(name).filter((d) => {
      const v = hex(d.encoding)[2];
      return d.error === undefined && v === 7;
    });
    expect(later.length).toBeGreaterThan(0);
    for (const d of later) {
      const r = format3(d.encoding, closed);
      expect(row(r, "2.3")).toMatchObject({ status: "unverifiable", code: "unsupported-version" });
      expect(row(r, "2.1").status).not.toBe("fail");
      expect(r.verdictAgainstInputs).toBe("unverifiable");
      notReached(r);
    }
  }
});

test("a layout labelled the next version is read under that version's, and doesn't decode", () => {
  for (const id of [V4_LABELLED_FIVE, V5_LABELLED_SIX]) {
    const r = format3(vector(id).encoding, closed);
    expect(row(r, "2.1")).toMatchObject({ status: "fail", code: "decode" });
    expect(row(r, "2.3")).toMatchObject({ status: "unverifiable", code: "not-implemented" });
    expect(r.definition).toBeUndefined();
    notReached(r);
  }
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

  // [board entry, ballot, tally opening, fits], beside contract-event
  // version 3: ballot version 1 needs board entries that carry share receipts
  // and complaints (3, 4 or 5), tally-opening version 1 needs ones that carry
  // destruction statements (4 or 5), every profile needs the close statement
  // (5; [[close]], Version), ballot version 2, which names a cell, needs
  // definition version 3 or 4, and ballot version 3, which carries
  // questions, definition version 5, and ballot version 4, which carries an
  // author half, definition version 6 (these are version 1). Tally-opening
  // version 2 needs board-entry version 6, a live poll's, so it never fits
  // here. Ballot version 5 stands for a version this verifier doesn't know,
  // with neither need: a later release judges it.
  const table: readonly (readonly [number, number, number, boolean])[] = [
    [5, 1, 1, true],
    [5, 1, 2, false],
    [5, 5, 1, true],
    [5, 5, 2, false],
    [5, 2, 1, false],
    [5, 2, 2, false],
    [5, 3, 1, false],
    [5, 3, 2, false],
    [5, 4, 1, false],
    [5, 4, 2, false],
    // Board-entry versions 1, 3 and 4 have no close statement, so they fail
    // whatever else fits, as they did for want of delivery or destruction.
    [4, 1, 1, false],
    [4, 1, 2, false],
    [4, 5, 2, false],
    [3, 1, 1, false],
    [3, 1, 2, false],
    [3, 5, 2, false],
    [1, 1, 1, false],
    [1, 1, 2, false],
    [1, 5, 2, false],
  ];
  for (const [board, ballot, opening, fits] of table)
    test(`board entry ${board}, ballot ${ballot}, tally opening ${opening}: ${fits ? "fits" : "fails"}`, () => {
      const r = format3(
        pinning({
          [RECORD_TYPES.boardEntry]: board,
          [RECORD_TYPES.ballot]: ballot,
          [RECORD_TYPES.tallyOpening]: opening,
          [RECORD_TYPES.contractEvent]: 6,
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
      // Only versions 4 and 5 carry destruction statements (8.5, report-only).
      expect(row(r, "8.5")).toMatchObject(
        board >= 4
          ? { status: "unverifiable", code: "not-implemented" }
          : { status: "unverifiable", code: "not-applicable" },
      );
      expect(r.verdict).toBe("unverifiable");
    });

  test("every profile pins contract-event version 6, every board and registry event", () => {
    // Versions 1 and 2 name none of the close rule's board events, version 3
    // not the batches', version 4 not the obligation root's and version 5 not
    // the group registry's Tier 1 addition, so 2.3 fails
    // them; one this verifier doesn't read is a later release's,
    // unverifiable unless the profile fails on another ground ([[close]],
    // Version; T-36).
    const at = (board: number, events: number) =>
      row(
        format3(
          pinning({ [RECORD_TYPES.boardEntry]: board, [RECORD_TYPES.contractEvent]: events }),
          closed,
        ),
        "2.3",
      );
    expect(at(5, 6)).toMatchObject({ status: "unverifiable", code: "not-implemented" });
    for (const events of [1, 2, 3, 4, 5]) {
      const r = format3(
        pinning({ [RECORD_TYPES.boardEntry]: 5, [RECORD_TYPES.contractEvent]: events }),
        closed,
      );
      expect(row(r, "2.3")).toEqual(COMBINATION_FAILS);
      expect(r.verdictAgainstInputs).toBe("failed");
    }
    for (const events of [7, 255])
      expect(at(5, events)).toEqual({
        id: "2.3",
        kind: "election",
        status: "unverifiable",
        code: "unsupported-version",
        at: {},
      });
    expect(at(4, 7)).toEqual(COMBINATION_FAILS);
  });

  test("board-entry versions 6 and 7 are read, and fail 2.3 here", () => {
    // A live poll's board and an author panel's: no profile 2.3 passes pins
    // either yet, and the board checks still run under them (T-16, T-17).
    for (const board of [6, 7]) {
      const r = format3(pinning({ [RECORD_TYPES.boardEntry]: board }), closed);
      expect(row(r, "2.3")).toEqual(COMBINATION_FAILS);
      expect(row(r, "4.1").code).not.toBe("not-reached");
    }
  });

  test("a version this verifier can't read is unsupported before any combination", () => {
    for (const board of [2, 8]) {
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
      // 1.3, 2.9 and 4.4 need a decoded definition, which only format 3 carries.
      const others = (r: Report) =>
        r.checks.filter((c) => !["1.3", "2.1", "2.3", "2.9", "4.4"].includes(c.id));
      expect(others(r3)).toEqual(others(r2));
      expect(row(r3, "2.3")).toEqual(COMBINATION_FAILS);
      // board.json's entry 1 is a framing placeholder of type 0x0008, not a
      // contract-event record. It fails 4.4 where 4.1 and 4.2 pass with it
      // inside the anchored extent; with nothing anchored it isn't read; and
      // where the board checks don't pass it leaves 4.4 unverifiable with
      // its code (T-53).
      expect(row(r2, "4.4")).toMatchObject({ status: "unverifiable", code: "not-implemented" });
      const placeholder = { code: "decode", at: { entry: 1, decodeError: "truncated" } };
      expect(row(r3, "4.4")).toEqual({
        id: "4.4",
        kind: "election",
        ...(["closed", "running"].includes(v.id)
          ? { status: "fail", ...placeholder }
          : v.id === "before-any-anchor"
            ? { status: "unverifiable", code: "not-implemented" }
            : { status: "unverifiable", ...placeholder }),
      });
      if (v.id === "before-any-anchor") expect(r3.board.unauthenticated).toBe(r3.board.entries);
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

  test("the summary names the definition as unauthenticated, not the fields taken from it", async () => {
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
      const code = await runCli([dir], { stdout: () => {}, stderr: (t) => (stderr += t) });
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
  // cores: version 1 opens version-1 cores only, so it fails, and version 2
  // opens them, so the combination passes (2.3's other checks aren't
  // implemented yet); an opening version this verifier doesn't know is
  // unsupported, never a failure (T-36, T-42).
  const table: readonly (readonly [number, number, number, string])[] = [
    [5, 1, 1, "profile-combination"],
    // Ballot version 3 carries questions, which definition version 5 alone has.
    [5, 3, 1, "profile-combination"],
    [5, 3, 2, "profile-combination"],
    // Ballot version 4 carries an author half, which definition version 6 alone has.
    [5, 4, 1, "profile-combination"],
    [5, 4, 3, "profile-combination"],
    // Ballot version 5 stands for one a later release may define as naming
    // its cell: unsupported, never failed, whatever the opening (T-36).
    [5, 5, 1, "unsupported-version"],
    [5, 5, 2, "unsupported-version"],
    [5, 2, 1, "profile-combination"],
    [5, 2, 2, "not-implemented"],
    [5, 2, 255, "unsupported-version"],
    // Board-entry versions without the close statement fail whatever else
    // fits, a later ballot or opening version included ([[close]], Version).
    [4, 2, 2, "profile-combination"],
    [4, 5, 2, "profile-combination"],
    [3, 2, 255, "profile-combination"],
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
            // A tally-opening version this verifier doesn't know stands for
            // one with no board need, so only the ballot's needs decide
            // (version 2 needs a live poll's board, version 3 an author
            // panel's).
            [RECORD_TYPES.tallyOpening]: 255,
            [RECORD_TYPES.contractEvent]: 6,
          }),
          closed,
        );
        expect(row(r, "2.3")).toEqual(
          code === "profile-combination"
            ? COMBINATION_FAILS
            : code === "not-implemented"
              ? { id: "2.3", kind: "election", status: "unverifiable", code }
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

describe("definition version 5 (questions)", () => {
  const v5 = decodeElectionDefinitionV5(hex(vector("definition-v5-typical").encoding));
  /** The typical version-5 definition, for the L1 vectors' election and anchor. */
  const v5For = (anchor: string, versions: Partial<Record<number, number>> = {}) =>
    toHex(
      encodeElectionDefinitionV5({
        ...v5,
        election_id: hex(l1File.electionId),
        l1_anchor: hex(anchor),
        profile: {
          ...v5.profile,
          pins: v5.profile.pins.map((p) => ({
            ...p,
            version: versions[p.record_type] ?? p.version,
          })),
        },
      }),
    );

  // [board entry, ballot, spoiled-ballot opening, display text, 2.3]: a
  // version-5 profile pins ballot version 3, which carries one range proof
  // per question, spoiled-ballot opening version 2, which opens its cores,
  // display-text version 2, which carries the questions' text, and, for
  // ballot version 3's delivery, tally-opening version 1's destruction
  // statements and the close statement every profile needs, board-entry
  // version 5, beside contract-event version 6. A ballot or opening version
  // this verifier doesn't know is unsupported, never failed; an unknown
  // display-text version fails (docs/spec/verifier.md, 2.3; T-36, T-41, T-42).
  const table: readonly (readonly [number, number, number, number, string])[] = [
    [5, 3, 2, 2, "not-implemented"],
    [3, 3, 2, 2, "profile-combination"],
    // Version 4 carries delivery and destruction, not the close statement.
    [4, 3, 2, 2, "profile-combination"],
    [5, 3, 1, 2, "profile-combination"],
    [5, 2, 2, 2, "profile-combination"],
    [5, 1, 1, 2, "profile-combination"],
    [5, 3, 2, 1, "profile-combination"],
    [5, 3, 2, 3, "profile-combination"],
    // Ballot version 4 pairs with definition version 6 alone; version 5
    // stands for one a later release may define to carry questions.
    [5, 4, 2, 2, "profile-combination"],
    [5, 5, 2, 2, "unsupported-version"],
    [5, 3, 255, 2, "unsupported-version"],
    [4, 5, 2, 2, "profile-combination"],
  ];
  for (const [board, ballot, spoiled, text, code] of table)
    test(`board entry ${board}, ballot ${ballot}, opening ${spoiled}, display text ${text}: ${code}`, () => {
      const r = format3(
        v5For(closed.anchor, {
          [RECORD_TYPES.boardEntry]: board,
          [RECORD_TYPES.ballot]: ballot,
          [RECORD_TYPES.spoiledBallotOpening]: spoiled,
          [RECORD_TYPES.displayText]: text,
          [RECORD_TYPES.tallyOpening]: 1,
          [RECORD_TYPES.contractEvent]: 6,
        }),
        closed,
      );
      expect(row(r, "2.3")).toEqual(
        code === "profile-combination"
          ? COMBINATION_FAILS
          : code === "not-implemented"
            ? { id: "2.3", kind: "election", status: "unverifiable", code }
            : { id: "2.3", kind: "election", status: "unverifiable", code, at: {} },
      );
      if (code === "profile-combination") expect(r.verdictAgainstInputs).toBe("failed");
      expect(row(r, "4.1").code).not.toBe("not-reached");
      expect(r.verdict).toBe("unverifiable");
    });

  test("the hash is version 5's, over its own encoding", () => {
    const r = format3(v5For(closed.anchor), closed);
    expect(r.definition).toBeDefined();
    expect(r.definition).not.toEqual(format3(forElection(closed.anchor), closed).definition);
    expect(row(r, "2.1")).toMatchObject({ status: "unverifiable", code: "not-implemented" });
  });

  test("2.9 reads version 5's receipt keys from L1 state, as version 4's", () => {
    // The L1-anchor vectors' anchor registered no receipt key, and their
    // nodes prove the first listed key's slot empty after opens_at.
    expect(v5.receipt_keys.length).toBeGreaterThan(0);
    expect(row(format3(v5For(closed.anchor), closed), "2.9")).toEqual({
      id: "2.9",
      kind: "election",
      status: "fail",
      code: "receipt-key-unregistered",
      at: { key: 0 },
    });
  });
});

describe("definition version 6 (poll class, results mode and author panel)", () => {
  const minimal = decodeElectionDefinitionV6(hex(vector("definition-v6-minimal").encoding));
  // A sealed version-6 poll without an author panel: ballot version 4,
  // spoiled-ballot opening version 3, tally-opening version 1, display-text
  // version 2, board-entry version 5 and contract-event version 6 (2.3).
  const FITTING: Readonly<Record<number, number>> = {
    [RECORD_TYPES.ballot]: 4,
    [RECORD_TYPES.spoiledBallotOpening]: 3,
    [RECORD_TYPES.tallyOpening]: 1,
    [RECORD_TYPES.boardEntry]: 5,
    [RECORD_TYPES.contractEvent]: 6,
    [RECORD_TYPES.displayText]: 2,
  };
  const v6For = (
    anchor: string,
    versions: Partial<Record<number, number>> = {},
    fields: Partial<ElectionDefinitionV6> = {},
  ) => {
    const pins = { ...FITTING, ...versions };
    return toHex(
      encodeElectionDefinitionV6({
        ...minimal,
        election_id: hex(l1File.electionId),
        l1_anchor: hex(anchor),
        ...fields,
        profile: {
          ...minimal.profile,
          pins: minimal.profile.pins.map((p) => ({
            ...p,
            version: pins[p.record_type] ?? p.version,
          })),
        },
      }),
    );
  };
  const live = { results_mode: RESULTS_MODES.live, live_every: 3600, live_batch: 20 };
  const authorPanel = {
    author_threshold: 1,
    author_keys: [hex("025df0967c2d52df79f732a9b6c44067c454b77ac2105f787b80a453306a81bf0d")],
    author_transcript_hash: new Uint8Array(32).fill(7),
  };

  test("the hash is version 6's, over its own encoding", () => {
    const bytes = v6For(closed.anchor);
    const r = format3(bytes, closed);
    expect(r.definition).toEqual({
      hash: toHex(electionDefinitionV6Hash(decodeElectionDefinitionV6(hex(bytes)))),
    });
    expect(row(r, "2.1")).toMatchObject({ status: "unverifiable", code: "not-implemented" });
  });

  test("a sealed poll without an author panel passes 2.3's combination, in every poll class", () => {
    for (const poll_class of Object.values(POLL_CLASSES)) {
      const r = format3(v6For(closed.anchor, {}, { poll_class }), closed);
      // 2.3's other checks aren't implemented, so it never passes here.
      expect(row(r, "2.3")).toEqual({
        id: "2.3",
        kind: "election",
        status: "unverifiable",
        code: "not-implemented",
      });
      expect(row(r, "4.1").code).not.toBe("not-reached");
      expect(r.verdict).toBe("unverifiable");
    }
  });

  test("a live poll and an author panel fail 2.3, and the board checks still run", () => {
    for (const [fields, versions] of [
      [live, {}],
      [live, { [RECORD_TYPES.tallyOpening]: 2, [RECORD_TYPES.boardEntry]: 6 }],
      [authorPanel, {}],
      [authorPanel, { [RECORD_TYPES.tallyOpening]: 3, [RECORD_TYPES.boardEntry]: 7 }],
    ] as const) {
      const r = format3(v6For(closed.anchor, versions, fields), closed);
      expect(row(r, "2.1").status).not.toBe("fail");
      expect(row(r, "2.3")).toEqual(COMBINATION_FAILS);
      expect(r.verdictAgainstInputs).toBe("failed");
      expect(row(r, "4.1").code).not.toBe("not-reached");
    }
  });

  test("other pins fail 2.3, or leave it unsupported when a later release may read them", () => {
    for (const [versions, code] of [
      [{ [RECORD_TYPES.ballot]: 3 }, "profile-combination"],
      [{ [RECORD_TYPES.spoiledBallotOpening]: 2 }, "profile-combination"],
      [{ [RECORD_TYPES.displayText]: 1 }, "profile-combination"],
      [{ [RECORD_TYPES.tallyOpening]: 3 }, "profile-combination"],
      [{ [RECORD_TYPES.boardEntry]: 4 }, "profile-combination"],
      [{ [RECORD_TYPES.ballot]: 255 }, "unsupported-version"],
      [{ [RECORD_TYPES.spoiledBallotOpening]: 255 }, "unsupported-version"],
    ] as const) {
      const r = format3(v6For(closed.anchor, versions), closed);
      expect(row(r, "2.3"), JSON.stringify(versions)).toEqual(
        code === "profile-combination"
          ? COMBINATION_FAILS
          : { id: "2.3", kind: "election", status: "unverifiable", code, at: {} },
      );
    }
    // A board-entry version this verifier can't read stops the board checks.
    const r = format3(v6For(closed.anchor, { [RECORD_TYPES.boardEntry]: 8 }), closed);
    expect(row(r, "2.3")).toMatchObject({ status: "unverifiable", code: "unsupported-version" });
    notReached(r);
  });

  test("2.9 reads version 6's receipt keys from L1 state, as version 4's", () => {
    expect(minimal.receipt_keys.length).toBeGreaterThan(0);
    expect(row(format3(v6For(closed.anchor), closed), "2.9")).toMatchObject({
      status: "fail",
      code: "receipt-key-unregistered",
    });
  });

  test("ballot admission and the tally aren't checked under version 6 yet, never passed", () => {
    // Even with a registered key set (none is returned beside an author
    // panel): ballot version 4's admission and version 6's tally rules come
    // with P2-16 part 4's later parts.
    // Under the membership key this release pins, which 1.3 checks first,
    // and with no cell of root 0, which anyone proves membership of.
    const pinnedKey = {
      membership_vk_hash: membershipVkHash(),
      electorate: minimal.electorate.map((t) => ({
        ...t,
        cells: t.cells.map((c) => ({ ...c, root: 1n })),
      })),
    };
    const record = decodeDefinition(hex(v6For(closed.anchor, {}, pinnedKey)));
    const notImplemented = { status: "unverifiable", code: "not-implemented" };
    expect(judgeFor(record, [])).toEqual(notImplemented);
    expect(tallyChecks(record, new Uint8Array(32), [], [], 5)).toEqual({ row: notImplemented });
    // A ballot version a later release may read stays unsupported.
    const later = decodeDefinition(
      hex(v6For(closed.anchor, { [RECORD_TYPES.ballot]: 255 }, pinnedKey)),
    );
    expect(judgeFor(later, [])).toMatchObject({ code: "unsupported-version" });
  });
});
