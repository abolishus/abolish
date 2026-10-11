import { bytesToHex } from "@noble/hashes/utils.js";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  BOARD_TREE,
  type BoardEntry,
  boardEntryHash,
  BoardError,
  checkBoard,
  checkCheckpoints,
  type Checkpoint,
  checkpointHash,
  consistencyProof,
  DecodeError,
  decodeBoardEntry,
  encodeBoardEntry,
  inclusionProof,
  MAX_BOARD_PAYLOAD,
  merkleRoot,
  merkleRoots,
  UNPINNED,
  verifyConsistency,
  verifyInclusion,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/board.json, from the independent Python implementation in
// scripts/board-vectors.py (docs/spec/board.md; T-23, T-24, T-31, T-42).
// Expected bytes, hashes, proofs and verdicts all come from the file.

interface EntryVector {
  readonly id: string;
  readonly encoding: string;
  readonly value?: {
    readonly election_id: string;
    readonly index: string;
    readonly segment: string;
    readonly payload: string;
  };
  readonly entryHash?: string;
  readonly error?: string;
}

interface Rejected {
  readonly id: string;
  readonly kind: "inclusion" | "consistency";
  readonly index?: string;
  readonly size?: string;
  readonly leaf?: string;
  readonly root?: string;
  readonly size1?: string;
  readonly size2?: string;
  readonly root1?: string;
  readonly root2?: string;
  readonly path: readonly string[];
}

interface BoardVector {
  readonly id: string;
  readonly electionId: string;
  readonly entries: readonly string[];
  readonly checkpoints: readonly {
    readonly electionId: string;
    readonly segment: string;
    readonly size: string;
    readonly head: string;
    readonly root: string;
    readonly hash: string;
  }[];
  readonly links?: readonly string[];
  readonly result: "ok" | { readonly code: string; readonly [k: string]: unknown };
}

interface BoardFile {
  readonly format: string;
  readonly maxBoardPayload: string;
  readonly entries: readonly EntryVector[];
  readonly tree: {
    readonly leaves: readonly string[];
    readonly roots: readonly string[];
    readonly inclusion: readonly {
      readonly index: string;
      readonly size: string;
      readonly path: readonly string[];
    }[];
    readonly consistency: readonly {
      readonly size1: string;
      readonly size2: string;
      readonly path: readonly string[];
    }[];
    readonly rejected: readonly Rejected[];
  };
  readonly boards: readonly BoardVector[];
}

const file = JSON.parse(readFileSync(new URL("board.json", SPEC_VECTORS), "utf8")) as BoardFile;
const dec = (s: string | undefined) => {
  if (s === undefined || !/^(?:0|[1-9][0-9]*)$/.test(s)) throw new Error(`not a decimal: ${s}`);
  return BigInt(s);
};

test("the file is the board-vector format and agrees on MAX_BOARD_PAYLOAD", () => {
  expect(file.format).toBe("abolish-board-vectors/1");
  expect(dec(file.maxBoardPayload)).toBe(BigInt(MAX_BOARD_PAYLOAD));
});

describe("board entries", () => {
  test("parses every vector", () => {
    expect(file.entries.length).toBe(25);
    expect(new Set(file.entries.map((v) => v.id)).size).toBe(file.entries.length);
  });

  for (const v of file.entries)
    test(v.id, () => {
      const bytes = hex(v.encoding);
      if (v.error !== undefined) {
        expect(v.value).toBeUndefined();
        let code: string | undefined;
        try {
          decodeBoardEntry(bytes, UNPINNED);
        } catch (e) {
          if (!(e instanceof DecodeError)) throw e;
          code = e.code;
        }
        expect(code).toBe(v.error);
        return;
      }
      const want = v.value;
      if (want === undefined || v.entryHash === undefined)
        throw new Error("a valid vector has a value and a hash");
      const entry: BoardEntry = {
        election_id: hex(want.election_id),
        index: dec(want.index),
        segment: Number(dec(want.segment)),
        payload: hex(want.payload),
      };
      expect(decodeBoardEntry(bytes, 1)).toEqual(entry);
      expect(bytesToHex(encodeBoardEntry(entry))).toBe(v.encoding);
      expect(bytesToHex(boardEntryHash(bytes))).toBe(v.entryHash);
    });
});

describe("board tree", () => {
  const leaves = file.tree.leaves.map(hex);
  const roots = file.tree.roots.map(hex);

  test("roots of every prefix", () => {
    expect(leaves.length).toBe(13);
    expect(roots.length).toBe(13);
    const all = merkleRoots(BOARD_TREE, leaves, new Set(roots.map((_, i) => i + 1)));
    roots.forEach((root, i) => {
      expect(merkleRoot(BOARD_TREE, leaves.slice(0, i + 1))).toEqual(root);
      expect(all.get(i + 1)).toEqual(root);
    });
  });

  test("every inclusion proof is generated as published and verifies", () => {
    expect(file.tree.inclusion.length).toBe(91);
    for (const { index, size, path } of file.tree.inclusion) {
      const i = Number(dec(index));
      const n = Number(dec(size));
      const p = path.map(hex);
      expect(inclusionProof(BOARD_TREE, leaves.slice(0, n), i)).toEqual(p);
      expect(
        verifyInclusion(
          BOARD_TREE,
          BigInt(i),
          BigInt(n),
          leaves[i] as Uint8Array,
          p,
          roots[n - 1] as Uint8Array,
        ),
      ).toBe(true);
    }
  });

  test("every consistency proof is generated as published and verifies", () => {
    expect(file.tree.consistency.length).toBe(91);
    for (const { size1, size2, path } of file.tree.consistency) {
      const m = Number(dec(size1));
      const n = Number(dec(size2));
      const p = path.map(hex);
      expect(consistencyProof(BOARD_TREE, leaves.slice(0, n), m)).toEqual(p);
      const r1 = roots[m - 1] as Uint8Array;
      const r2 = roots[n - 1] as Uint8Array;
      expect(verifyConsistency(BOARD_TREE, BigInt(m), BigInt(n), r1, r2, p)).toBe(true);
    }
  });

  test("rejected proofs fail", () => {
    expect(file.tree.rejected.length).toBe(14);
    for (const r of file.tree.rejected) {
      const p = r.path.map(hex);
      const ok =
        r.kind === "inclusion"
          ? verifyInclusion(
              BOARD_TREE,
              dec(r.index),
              dec(r.size),
              hex(r.leaf ?? ""),
              p,
              hex(r.root ?? ""),
            )
          : verifyConsistency(
              BOARD_TREE,
              dec(r.size1),
              dec(r.size2),
              hex(r.root1 ?? ""),
              hex(r.root2 ?? ""),
              p,
            );
      expect(ok, r.id).toBe(false);
    }
  });
});

describe("board checks", () => {
  test("parses every vector", () => {
    expect(file.boards.length).toBe(33);
  });

  for (const v of file.boards)
    test(v.id, () => {
      const checkpoints: Checkpoint[] = v.checkpoints.map((c) => {
        const cp = {
          election_id: hex(c.electionId),
          segment: Number(dec(c.segment)),
          size: dec(c.size),
          head: hex(c.head),
          root: hex(c.root),
        };
        expect(bytesToHex(checkpointHash(cp))).toBe(c.hash);
        return cp;
      });
      let got: unknown = "ok";
      try {
        const board = checkBoard(hex(v.electionId), v.entries.map(hex), 1);
        if (v.links !== undefined) expect(board.links.map(bytesToHex)).toEqual(v.links);
        checkCheckpoints(board, checkpoints);
      } catch (e) {
        if (!(e instanceof BoardError)) throw e;
        got = { code: e.code, ...e.at };
      }
      expect(got).toEqual(v.result);
    });
});
