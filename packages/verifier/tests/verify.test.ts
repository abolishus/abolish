import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  BOARD_TREE,
  boardEntryHash,
  chainLink,
  MAX_BOARD_PAYLOAD,
  merkleRoot,
} from "@abolishus/crypto";
import { CHECKS, parseBundle, type Report, splitEntries, verifyBundle } from "../src/index.ts";

// Fixtures: the boards of docs/spec/vectors/board.json, produced by the
// independent Python implementation in packages/crypto/scripts/board-vectors.py
// (never by the code under test), with the verdict each must reach. The
// expected rows of 4.1 and 4.2 follow docs/spec/verifier.md, Procedure, step 5.

interface CheckpointVector {
  readonly electionId: string;
  readonly segment: string;
  readonly size: string;
  readonly head: string;
  readonly root: string;
  readonly anchoredAt: string;
}

interface BoardVector {
  readonly id: string;
  readonly electionId: string;
  readonly now: string;
  readonly entries: readonly string[];
  readonly checkpoints: readonly CheckpointVector[];
  readonly result:
    | "ok"
    | {
        readonly code: string;
        readonly entry?: number;
        readonly checkpoint?: number;
        readonly segment?: number;
        readonly decodeError?: string;
      };
  readonly extent?: number;
}

interface BoardFile {
  readonly format: string;
  readonly clock: Readonly<Record<"epoch" | "period" | "deadline" | "lastSegment", string>>;
  readonly boards: readonly BoardVector[];
}

const vectors = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/board.json", import.meta.url), "utf8"),
) as BoardFile;

const hex = (s: string) => {
  if (!/^(?:[0-9a-f]{2})*$/.test(s)) throw new Error(`not lowercase hex: ${s}`);
  return Uint8Array.from(Buffer.from(s, "hex"));
};
const concat = (parts: readonly Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const bundleJson = (v: BoardVector) =>
  JSON.stringify({
    format: "abolish-verifier-bundle/1",
    electionId: v.electionId,
    boardEntryVersion: 1,
    clock: vectors.clock,
    now: v.now,
    anchors: v.checkpoints.map((c) => ({
      electionId: c.electionId,
      segment: c.segment,
      size: c.size,
      head: c.head,
      root: c.root,
      anchoredAt: c.anchoredAt,
    })),
  });

const row = (r: Report, id: string) => r.checks.find((c) => c.id === id);

// The rows the spec's table gives for each board-check code (Procedure, step 5).
const ANCHOR = ["checkpoint-equivocation", "checkpoint-size", "checkpoint-inconsistent"];
const COPY = ["checkpoint-missing", "copy-mismatch"];
const AFTER = ["checkpoint-boundary", "unanchored", "unsealed"];

// A board copy is self-delimiting, so an entry with trailing bytes can't be
// written into board.bin as itself: the bytes become the start of the next
// entry. Those vectors are tested below on their own.
const splitsBack = (v: BoardVector) => {
  const parts = v.entries.map(hex);
  const { entries, unreadableBytes } = splitEntries(concat(parts));
  return (
    unreadableBytes === 0 &&
    entries.length === parts.length &&
    entries.every((e, i) => Buffer.from(e).equals(Buffer.from(parts[i] as Uint8Array)))
  );
};

test("the fixtures are the board-vector format", () => {
  expect(vectors.format).toBe("abolish-board-vectors/1");
  expect(vectors.boards.length).toBeGreaterThan(40);
  expect(vectors.boards.filter((v) => !splitsBack(v)).map((v) => v.id)).toEqual([
    "forged-trailing-ignored",
    "entry-trailing-bytes",
  ]);
});

describe("board checks 4.1 and 4.2 over the board vectors", () => {
  for (const v of vectors.boards.filter(splitsBack))
    test(v.id, () => {
      const r = verifyBundle(parseBundle(bundleJson(v), concat(v.entries.map(hex))));
      const r41 = row(r, "4.1");
      const r42 = row(r, "4.2");
      // Local inputs never authenticate a verdict (T-53).
      expect(r.verdict).toBe("unverifiable");
      expect(r.board.entries).toBe(v.entries.length);
      expect(r.board.unreadableBytes).toBe(0);
      if (v.result === "ok") {
        expect(r41).toEqual({ id: "4.1", kind: "election", status: "pass" });
        expect(r42).toEqual({ id: "4.2", kind: "election", status: "pass" });
        expect(r.board.unauthenticated).toBe(v.entries.length - (v.extent as number));
        // Every other check is still unimplemented.
        expect(r.verdictAgainstInputs).toBe("unverifiable");
        return;
      }
      const { code, ...at } = v.result;
      const failed = { status: "fail", code, at };
      expect(r.board.unauthenticated).toBeUndefined();
      if (COPY.includes(code)) {
        const copy = { status: "unverifiable", code, at };
        expect(r41).toMatchObject(copy);
        expect(r42).toMatchObject(copy);
        expect(r.verdictAgainstInputs).toBe("unverifiable");
        return;
      }
      if (ANCHOR.includes(code) || (code === "wrong-election" && "checkpoint" in at)) {
        expect(r41).toEqual({
          id: "4.1",
          kind: "election",
          status: "unverifiable",
          code: "not-reached",
        });
        expect(r42).toEqual({ id: "4.2", kind: "election", ...failed });
      } else if (AFTER.includes(code)) {
        expect(r41).toEqual({ id: "4.1", kind: "election", status: "pass" });
        expect(r42).toEqual({ id: "4.2", kind: "election", ...failed });
      } else {
        expect(r41).toEqual({ id: "4.1", kind: "election", ...failed });
        expect(r42).toEqual({
          id: "4.2",
          kind: "election",
          status: "unverifiable",
          code: "not-reached",
        });
      }
      expect(r.verdictAgainstInputs).toBe("failed");
    });
});

test("an anchored entry with trailing bytes can't be carried by board.bin: unverifiable for good (residual)", () => {
  // The entry's extra bytes become the start of the next entry, so no copy
  // splits back into what was anchored (docs/spec/verifier.md, Bundle).
  const v = vectors.boards.find((b) => b.id === "entry-trailing-bytes") as BoardVector;
  const r = verifyBundle(parseBundle(bundleJson(v), concat(v.entries.map(hex))));
  expect(row(r, "4.2")).toMatchObject({ status: "unverifiable", code: "checkpoint-missing" });
  expect(r.verdictAgainstInputs).toBe("unverifiable");
});

test("an anchored entry with a length over MAX_BOARD_PAYLOAD fails 4.1, attributably, instead of leaving the copy short", () => {
  // Hand-built: one entry whose payload length field is over the maximum,
  // anchored by a checkpoint over its exact bytes. The hashes come from the
  // crypto primitives the board vectors pin.
  const electionId = vectors.boards[0]?.electionId as string;
  const entry = concat([
    hex(`000701${electionId}` + "0000000000000000" + "00000000"),
    Uint8Array.of(0x00, 0x10, 0x00, 0x01), // MAX_BOARD_PAYLOAD + 1
    new Uint8Array(MAX_BOARD_PAYLOAD + 1).fill(0x02),
  ]);
  expect(0x00100001).toBe(MAX_BOARD_PAYLOAD + 1);
  const e0 = boardEntryHash(entry);
  const json = JSON.stringify({
    format: "abolish-verifier-bundle/1",
    electionId,
    boardEntryVersion: 1,
    clock: vectors.clock,
    now: "1800003661",
    anchors: [
      {
        electionId,
        segment: "0",
        size: "1",
        head: Buffer.from(chainLink(new Uint8Array(32), e0)).toString("hex"),
        root: Buffer.from(merkleRoot(BOARD_TREE, [e0])).toString("hex"),
        anchoredAt: "1800003660",
      },
    ],
  });
  const r = verifyBundle(parseBundle(json, entry));
  expect(row(r, "4.1")).toEqual({
    id: "4.1",
    kind: "election",
    status: "fail",
    code: "decode",
    at: { entry: 0, decodeError: "length-over-max" },
  });
  expect(r.verdictAgainstInputs).toBe("failed");
});

describe("report", () => {
  const valid = vectors.boards.find((b) => b.id === "valid") as BoardVector;
  const report = verifyBundle(parseBundle(bundleJson(valid), concat(valid.entries.map(hex))));

  test("lists every check of the spec exactly once, in the spec's order", () => {
    const spec = readFileSync(new URL("../../../docs/spec/verifier.md", import.meta.url), "utf8");
    const ids = [...spec.matchAll(/^- ([1-8]\.[0-9]) /gm)].map((m) => m[1]);
    expect(ids.length).toBe(CHECKS.length);
    expect(report.checks.map((c) => c.id)).toEqual(ids);
  });

  test("gives each check the kind the spec's Principles give it", () => {
    const of = (kind: string) => report.checks.filter((c) => c.kind === kind).map((c) => c.id);
    expect(of("report-only")).toEqual(["1.1", "2.7", "7.4", "8.5"]);
    expect(of("admission")).toEqual(["5.1", "5.2", "5.3", "5.4", "5.5", "5.7", "5.8", "6.2"]);
  });

  test("reports every unimplemented check as unverifiable, never as pass", () => {
    const implemented = new Set(["4.1", "4.2", "8.5"]);
    for (const c of report.checks.filter((x) => !implemented.has(x.id)))
      expect(c).toEqual({
        id: c.id,
        kind: c.kind,
        status: "unverifiable",
        code: "not-implemented",
      });
  });

  test("2.9 is unverifiable for a bundle that carries no definition", () => {
    expect(report.checks.find((c) => c.id === "2.9")).toEqual({
      id: "2.9",
      kind: "election",
      status: "unverifiable",
      code: "not-implemented",
    });
  });

  test("8.5 is not applicable: board-entry version 1 can't carry a destruction statement", () => {
    expect(report.checks.find((c) => c.id === "8.5")).toEqual({
      id: "8.5",
      kind: "report-only",
      status: "unverifiable",
      code: "not-applicable",
    });
  });

  test("records every input as a local file and keeps the verdict unverifiable", () => {
    expect(report.inputs).toEqual({
      electionId: "local-file",
      boardEntryVersion: "local-file",
      clock: "local-file",
      now: "local-file",
      anchors: "local-file",
    });
    expect(report.verdict).toBe("unverifiable");
  });

  test("puts its members in the spec's order", () => {
    expect(Object.keys(report)).toEqual([
      "format",
      "verdict",
      "verdictAgainstInputs",
      "inputs",
      "board",
      "checks",
    ]);
    expect(report.format).toBe("abolish-verifier-report/1");
  });

  test("a failed board check under local inputs is reported against the inputs only", () => {
    const v = vectors.boards.find((b) => b.id === "checkpoint-equivocation") as BoardVector;
    const r = verifyBundle(parseBundle(bundleJson(v), concat(v.entries.map(hex))));
    expect(r.verdictAgainstInputs).toBe("failed");
    expect(r.verdict).toBe("unverifiable");
  });
});

describe("unreadable board bytes", () => {
  const valid = vectors.boards.find((b) => b.id === "valid") as BoardVector;
  const forged = vectors.boards.find((b) => b.id === "forged-trailing-ignored") as BoardVector;

  test("past the anchored extent change nothing (T-53)", () => {
    const junk = Uint8Array.from([0, 7, 1, 2, 3]);
    const r = verifyBundle(
      parseBundle(bundleJson(valid), concat([...valid.entries.map(hex), junk])),
    );
    expect(row(r, "4.1")?.status).toBe("pass");
    expect(row(r, "4.2")?.status).toBe("pass");
    expect(r.board.unreadableBytes).toBe(junk.length);
    expect(r.board.unauthenticated).toBe(0);
  });

  test("inside the anchored extent leave the copy short: unverifiable, never a failure", () => {
    const parts = valid.entries.map(hex);
    const last = parts.at(-1) as Uint8Array;
    const board = concat([...parts.slice(0, -1), last.subarray(0, last.length - 1)]);
    const r = verifyBundle(parseBundle(bundleJson(valid), board));
    expect(r.board.entries).toBe(parts.length - 1);
    expect(r.board.unreadableBytes).toBe(last.length - 1);
    expect(row(r, "4.2")).toMatchObject({ status: "unverifiable", code: "checkpoint-missing" });
    expect(r.verdictAgainstInputs).toBe("unverifiable");
  });

  test("forged entries appended past the extent are unauthenticated, and a fragment unreadable", () => {
    // The vector appends one well-formed forged entry and a 2-byte fragment.
    const r = verifyBundle(parseBundle(bundleJson(forged), concat(forged.entries.map(hex))));
    expect(row(r, "4.1")?.status).toBe("pass");
    expect(row(r, "4.2")?.status).toBe("pass");
    expect(r.board.entries).toBe(forged.entries.length - 1);
    expect(r.board.unauthenticated).toBe(1);
    expect(r.board.unreadableBytes).toBe(2);
  });
});
