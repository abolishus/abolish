import { readFileSync } from "node:fs";
import {
  decodeElectionDefinitionRecord,
  type ElectionDefinitionV4,
  encodeElectionDefinitionV4,
  receiptKeyJudgement,
} from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  BUNDLE_FORMAT_DEFINITION,
  type CheckResult,
  decodeHeader,
  L1Error,
  type L1Evidence,
  NodePool,
  parseBundle,
  receiptKeyRow,
  receiptKeySlot,
  receiptKeyWords,
  type Report,
  verifyBundle,
} from "../src/index.ts";

// docs/spec/vectors/receipt-key-record.json: block headers, trie nodes and
// storage words served by Anvil for deployed BoardAnchors whose receipt keys
// were registered and retired around `opensAt` through the anchor's own calls
// (packages/verifier/scripts/receipt-key-vectors.py), with the slots from
// Foundry's `cast index` and each vector's 2.9 row recomputed by the script
// (docs/spec/verifier.md, Receipt keys from L1; T-26, T-69).

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;

interface Vector {
  readonly id: string;
  readonly block: { readonly hash: string; readonly timestamp: string; readonly header: string };
  readonly anchor: string;
  readonly receiptKeys: readonly string[];
  readonly slots: readonly string[];
  readonly nodes: readonly string[];
  readonly records: readonly string[];
  readonly result: { readonly status: string; readonly code?: string; readonly at?: object };
  readonly board?: string;
}

const file = read("receipt-key-record.json") as {
  readonly format: string;
  readonly clock: Readonly<Record<string, string>>;
  readonly electionId: string;
  readonly opensAt: string;
  readonly vectors: readonly Vector[];
};
const boards = (read("board.json") as { boards: { id: string; entries: string[] }[] }).boards;
const definitionsV4 = (
  read("election-definition-v4.json") as { vectors: { id: string; encoding: string }[] }
).vectors;

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const opensAt = BigInt(file.opensAt);
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const evidence = (v: Vector): L1Evidence => ({
  header: decodeHeader(hex(v.block.header)),
  anchor: hex(v.anchor),
  firstSegment: 0,
  nodes: new NodePool(v.nodes.map(hex)),
  checkpoints: [],
});

test("the file is the receipt-key record vector format", () => {
  expect(file.format).toBe("abolish-receipt-key-record-vectors/1");
  expect(file.vectors.length).toBe(19);
  expect(new Set(file.vectors.map((v) => v.id)).size).toBe(file.vectors.length);
  // Every code of 2.9 appears, and every outcome.
  const codes = new Set(file.vectors.map((v) => v.result.code ?? v.result.status));
  for (const c of [
    "pass",
    "receipt-key-retired",
    "receipt-key-unregistered",
    "receipt-key-record",
    "receipt-key-unsettled",
    "l1-proof-missing",
    "l1-anchor-absent",
  ])
    expect(codes).toContain(c);
});

describe("receipt-key words and 2.9 from L1 state", () => {
  for (const v of file.vectors)
    test(v.id, () => {
      const l1 = evidence(v);
      // The header's hash is Keccak-256 of its bytes, as Anvil computed it.
      expect(Buffer.from(l1.header.hash).toString("hex")).toBe(v.block.hash);
      const keys = v.receiptKeys.map(hex);
      // The slots are Foundry's `cast index`, computed apart from ours.
      expect(keys.map((k) => Buffer.from(receiptKeySlot(k)).toString("hex"))).toEqual(v.slots);
      expect(receiptKeyRow(l1, keys, opensAt)).toEqual(v.result);
      if (v.records.length === 0) {
        expect(() => receiptKeyWords(l1, keys)).toThrow(L1Error);
        return;
      }
      // Each word read is the one eth_getStorageAt returned; a word whose
      // leaf was left out is l1-proof-missing, never zero.
      for (const [i, w] of receiptKeyWords(l1, keys).entries()) {
        if (w instanceof L1Error) expect(w.code).toBe("l1-proof-missing");
        else expect(Buffer.from(w).toString("hex")).toBe(v.records[i]);
      }
    });
});

test("a node not in the pool is never read as a zero word", () => {
  const v = file.vectors.find((x) => x.id === "closed-judges") as Vector;
  for (let i = 0; i < v.nodes.length; i++) {
    const l1 = evidence({ ...v, nodes: v.nodes.filter((_, j) => j !== i) });
    const row = receiptKeyRow(l1, v.receiptKeys.map(hex), opensAt);
    // Only the board's own slots' nodes can be dropped without touching a key.
    expect(row.status === "pass" || ("code" in row && row.code === "l1-proof-missing")).toBe(true);
  }
});

describe("2.9 in a format-3 bundle with a version-4 definition", () => {
  const typical = decodeElectionDefinitionRecord(
    hex(definitionsV4.find((d) => d.id === "definition-v4-typical")?.encoding ?? ""),
  ).value as ElectionDefinitionV4;
  const valid = boards.find((b) => b.id === "valid");
  if (valid === undefined) throw new Error("no valid board");
  const run = (v: Vector, change: Partial<ElectionDefinitionV4> = {}): Report => {
    const definition = encodeElectionDefinitionV4({
      ...typical,
      election_id: hex(file.electionId),
      l1_anchor: hex(v.anchor),
      opens_at: opensAt,
      closes_at: opensAt + 86_400n,
      receipt_keys: v.receiptKeys.map(hex),
      ...change,
    });
    const json = JSON.stringify({
      format: BUNDLE_FORMAT_DEFINITION,
      definition: Buffer.from(definition).toString("hex"),
      clock: file.clock,
      l1: { firstSegment: "0", header: v.block.header, nodes: v.nodes, checkpoints: [] },
    });
    return verifyBundle(parseBundle(json, hex(valid.entries.join(""))));
  };
  const row = (r: Report, id: string) => r.checks.find((c) => c.id === id) as CheckResult;

  for (const v of file.vectors)
    test(`${v.id}: the report's 2.9 row`, () => {
      const r = run(v);
      expect(row(r, "2.9")).toEqual({ id: "2.9", kind: "election", ...v.result });
      // The definition's anchor and keys are local files until 2.1 and 1.2
      // authenticate them, so nothing here verifies or fails an election.
      expect(r.verdict).toBe("unverifiable");
      if (v.result.status === "fail") expect(r.verdictAgainstInputs).toBe("failed");
      // The board's own slots are proven from the same state.
      if (v.board === "valid")
        expect([row(r, "4.1").status, row(r, "4.2").status]).toEqual(["pass", "pass"]);
    });

  test("the definition's opens_at decides, not the file's", () => {
    const v = file.vectors.find((x) => x.id === "closed-judges") as Vector;
    // At a later opens_at, K2's retirement (just after the file's) comes first.
    expect(row(run(v, { opens_at: opensAt + 10n }), "2.9")).toEqual({
      id: "2.9",
      kind: "election",
      status: "fail",
      code: "receipt-key-retired",
      at: { key: 1 },
    });
  });
});

// Single-leaf tries, so any word can be stored under any key's slot.
function rlp(x: Uint8Array | readonly Uint8Array[]): Uint8Array {
  if (x instanceof Uint8Array && x.length === 1 && (x[0] as number) < 0x80) return x;
  // A list's items are encoded here, so callers pass their raw values.
  const body = x instanceof Uint8Array ? x : concatBytes(...x.map((i) => rlp(i)));
  const base = x instanceof Uint8Array ? 0x80 : 0xc0;
  if (body.length < 56) return concatBytes(Uint8Array.of(base + body.length), body);
  const len: number[] = [];
  for (let n = body.length; n > 0; n >>= 8) len.unshift(n & 0xff);
  return concatBytes(Uint8Array.of(base + 55 + len.length), Uint8Array.from(len), body);
}
// A leaf holding the whole 64-nibble path: hex-prefix flag 2, even length.
const leaf = (key: Uint8Array, value: Uint8Array) =>
  rlp([concatBytes(Uint8Array.of(0x20), keccak_256(key)), value]);
const trimmed = (w: Uint8Array) => w.subarray(w.findIndex((x) => x !== 0));

function stored(key: Uint8Array, word: Uint8Array, timestamp: bigint): L1Evidence {
  const anchor = new Uint8Array(20).fill(0x21);
  const storage = leaf(receiptKeySlot(key), rlp(trimmed(word)));
  const account = rlp([
    new Uint8Array(),
    new Uint8Array(),
    keccak_256(storage),
    keccak_256(Uint8Array.of(1)),
  ]);
  const state = leaf(anchor, account);
  return {
    header: {
      hash: new Uint8Array(32),
      parentHash: new Uint8Array(32),
      stateRoot: keccak_256(state),
      number: 1n,
      timestamp,
    },
    anchor,
    firstSegment: 0,
    nodes: new NodePool([state, storage]),
    checkpoints: [],
  };
}

const u64 = fc.bigInt({ min: 1n, max: (1n << 64n) - 1n });
const key = fc.constantFrom(...file.vectors.flatMap((v) => v.receiptKeys));
const wordOf = (registeredAt: bigint, retiredAt: bigint, high = 0n) => {
  const w = (high << 128n) | (retiredAt << 64n) | registeredAt;
  return hex(w.toString(16).padStart(64, "0"));
};

describe("2.9's record rule, over any word", () => {
  test("a word the release code writes is judged as packages/crypto's rule says", () => {
    fc.assert(
      fc.property(key, u64, fc.option(u64, { nil: 0n }), u64, u64, (k, reg, ret0, opens, extra) => {
        const retiredAt = ret0 === 0n ? 0n : reg + (ret0 % ((1n << 64n) - reg));
        const provenAt = [reg, retiredAt, extra].reduce((a, b) => (a > b ? a : b));
        const l1 = stored(hex(k), wordOf(reg, retiredAt), provenAt);
        const row = receiptKeyRow(l1, [hex(k)], opens);
        const judgement = receiptKeyJudgement({ registeredAt: reg, retiredAt }, opens, provenAt);
        const want = {
          judges: { status: "pass" },
          retired: { status: "fail", code: "receipt-key-retired", at: { key: 0 } },
          unregistered: { status: "fail", code: "receipt-key-unregistered", at: { key: 0 } },
          unsettled: { status: "unverifiable", code: "receipt-key-unsettled", at: { key: 0 } },
        }[judgement];
        expect(row).toEqual(want);
      }),
      { numRuns },
    );
  });

  test("a word with a high bit, a retirement without or before its registration, or a later time fails", () => {
    const bad = fc.oneof(
      fc
        .tuple(u64, fc.bigInt({ min: 1n, max: (1n << 128n) - 1n }))
        .map(([reg, high]) => ({ reg, ret: 0n, high, at: reg })),
      u64.map((ret) => ({ reg: 0n, ret, high: 0n, at: ret })),
      fc
        .tuple(u64, u64)
        .filter(([a, b]) => a !== b)
        .map(([a, b]) => {
          const [ret, reg] = a < b ? [a, b] : [b, a];
          return { reg, ret, high: 0n, at: reg };
        }),
      fc
        .tuple(u64, u64)
        .filter(([a, b]) => a !== b)
        .map(([a, b]) => {
          const [at, reg] = a < b ? [a, b] : [b, a];
          return { reg, ret: 0n, high: 0n, at };
        }),
      // Registered by the block, retired after it.
      fc
        .tuple(u64, u64, u64)
        .map((xs) => xs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
        .filter(([reg, at, ret]) => reg <= at && at < ret)
        .map(([reg, at, ret]) => ({ reg, ret, high: 0n, at })),
    );
    fc.assert(
      fc.property(key, bad, u64, (k, w, opens) => {
        const l1 = stored(hex(k), wordOf(w.reg, w.ret, w.high), w.at);
        expect(receiptKeyRow(l1, [hex(k)], opens)).toEqual({
          status: "fail",
          code: "receipt-key-record",
          at: { key: 0 },
        });
      }),
      { numRuns },
    );
  });

  test("a key with no word stored is unregistered once settled, and unsettled before", () => {
    fc.assert(
      fc.property(u64, u64, (opens, provenAt) => {
        const [stored0, other] = file.vectors[0]!.receiptKeys.map(hex) as [Uint8Array, Uint8Array];
        // Only the first key's slot is in the trie: the second's is proven absent.
        const l1 = stored(stored0, wordOf(1n, 0n), provenAt);
        expect(receiptKeyRow(l1, [other], opens)).toEqual(
          provenAt < opens
            ? { status: "unverifiable", code: "receipt-key-unsettled", at: { key: 0 } }
            : { status: "fail", code: "receipt-key-unregistered", at: { key: 0 } },
        );
      }),
      { numRuns },
    );
  });
});
