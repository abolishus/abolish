import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vite-plus/test";
import {
  consistencyProof,
  inclusionProof,
  merkleRoot,
  merkleRoots,
  type TreeHash,
  verifyConsistency,
  verifyInclusion,
} from "../../src/index.ts";
import { readVendored } from "./harness.ts";

// Published vectors for the RFC 9162 tree the board uses (docs/spec/board.md;
// T-23, T-24): transparency-dev/merkle's RFC 6962 roots, node hashes and
// proofs. The tree code is generic over its two hashes, so running it with
// RFC 6962's `0x00` and `0x01` prefixes checks the tree shape, the proof
// algorithms and their verification against an implementation that isn't ours.

const RFC6962: TreeHash = {
  leaf: (d) => sha256(concatBytes(Uint8Array.of(0), d)),
  node: (l, r) => sha256(concatBytes(Uint8Array.of(1), l, r)),
};

const text = (path: string) => readVendored(`transparency-dev/${path}`).toString("utf8");

/** The hex strings inside one Go function or `var` block, by exact header. */
function hexIn(source: string, header: string, end: string): string[] {
  const start = source.indexOf(header);
  if (start === -1) throw new Error(`no ${header}`);
  const stop = source.indexOf(end, start);
  if (stop === -1) throw new Error(`no end for ${header}`);
  return [...source.slice(start, stop).matchAll(/(?:hd|dh)\("([0-9a-f]*)"(?:, \d+)?\)/g)].map(
    (m) => m[1] ?? "",
  );
}

interface ProofVector {
  readonly a: number;
  readonly b: number;
  readonly path: Uint8Array[];
}

/** `{a, b, nil}` and `{a, b, [][]byte{dh(...), ...}}` rows of one test table. */
function table(source: string, name: string): ProofVector[] {
  const start = source.indexOf(`\t${name} = []`);
  if (start === -1) throw new Error(`no table ${name}`);
  const body = source.slice(start, source.indexOf("\n\t}\n", start));
  const rows = [...body.matchAll(/\{(\d+), (\d+), (nil|\[\]\[\]byte\{([\s\S]*?)\n\t\t\})\}/g)];
  // Every row opening in the table must have been parsed, or one was skipped.
  expect(rows.length).toBe(body.match(/\n\t\t\{\d/g)?.length);
  return rows.map((m) => ({
    a: Number(m[1]),
    b: Number(m[2]),
    path: [...(m[4] ?? "").matchAll(/dh\("([0-9a-f]{64})", 32\)/g)].map((x) =>
      hexToBytes(x[1] ?? ""),
    ),
  }));
}

const constants = text("constants.go");
const verify = text("verify_test.go");
const leaves = hexIn(constants, "func LeafInputs()", "\n}\n").map((h) => hexToBytes(h));
const roots = hexIn(constants, "func RootHashes()", "\n}\n").map((h) => hexToBytes(h));
const levels = hexIn(constants, "func NodeHashes()", "\n}\n");

describe("transparency-dev/merkle v0.0.2 (RFC 6962 hashing)", () => {
  test("parses the published tables in full", () => {
    expect(leaves.length).toBe(8);
    // RootHashes() lists the empty tree's root first, through a function call.
    expect(roots.length).toBe(8);
    expect(levels.length).toBe(8 + 4 + 2 + 1);
    expect(hexIn(constants, "func EmptyRootHash()", "\n}\n")).toEqual([
      bytesToHex(sha256(new Uint8Array())),
    ]);
  });

  test("merkleRoot gives the root of every tree size from 1 to 8", () => {
    roots.forEach((root, i) =>
      expect(bytesToHex(merkleRoot(RFC6962, leaves.slice(0, i + 1)))).toBe(bytesToHex(root)),
    );
  });

  test("merkleRoots gives every prefix root in one pass", () => {
    const all = merkleRoots(RFC6962, leaves, new Set([1, 2, 3, 4, 5, 6, 7, 8]));
    roots.forEach((root, i) =>
      expect(bytesToHex(all.get(i + 1) as Uint8Array)).toBe(bytesToHex(root)),
    );
  });

  test("every complete subtree's hash is a published node hash", () => {
    let i = 0;
    for (let width = 1; width <= 8; width *= 2)
      for (let from = 0; from < 8; from += width)
        expect(bytesToHex(merkleRoot(RFC6962, leaves.slice(from, from + width)))).toBe(levels[i++]);
    expect(i).toBe(levels.length);
  });

  const inclusion = table(verify, "inclusionProofs");
  const consistency = table(verify, "consistencyProofs");

  test("inclusion proofs (1-based leaf indices) are generated and verified as published", () => {
    expect(inclusion.length).toBe(6);
    let checked = 0;
    for (const { a: leaf, b: size, path } of inclusion) {
      // {0, 0, nil}: an empty tree, which the board never proves anything about.
      if (size === 0) continue;
      const tree = leaves.slice(0, size);
      expect(inclusionProof(RFC6962, tree, leaf - 1).map(bytesToHex)).toEqual(path.map(bytesToHex));
      const root = roots[size - 1] as Uint8Array;
      expect(
        verifyInclusion(
          RFC6962,
          BigInt(leaf - 1),
          BigInt(size),
          tree[leaf - 1] as Uint8Array,
          path,
          root,
        ),
      ).toBe(true);
      checked++;
    }
    expect(checked).toBe(5);
  });

  test("consistency proofs are generated and verified as published", () => {
    expect(consistency.length).toBe(5);
    for (const { a: size1, b: size2, path } of consistency) {
      expect(consistencyProof(RFC6962, leaves.slice(0, size2), size1).map(bytesToHex)).toEqual(
        path.map(bytesToHex),
      );
      const r1 = roots[size1 - 1] as Uint8Array;
      const r2 = roots[size2 - 1] as Uint8Array;
      expect(verifyConsistency(RFC6962, BigInt(size1), BigInt(size2), r1, r2, path)).toBe(true);
    }
  });
});
