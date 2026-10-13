import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  BEACON_FORK_SCHEDULES,
  checkReceiptOpening,
  decodeReceiptOpening,
  encodeReceiptOpening,
  type ReceiptOpeningInput,
  receiptOpeningStateEntry,
  transactionCalldata,
  transactionTrieValue,
  type TrustedBeaconState,
} from "../src/index.ts";
import { decodeRlp, type RlpItem } from "../src/rlp.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/receipt-opening.json comes from an independent Python
// implementation (scripts/receipt-opening-vectors.py), which rebuilds the two
// real blocks' headers and transaction tries and checks them against the
// chains' block hashes and transaction roots, so these expected values never
// come from the code under test.

interface JsonState {
  readonly slot: string;
  readonly forkVersion: string;
  readonly historicalSummaryCount: number;
  readonly blockSummaryRoots: Readonly<Record<string, string>>;
  readonly blockRoots: Readonly<Record<string, string>>;
}

interface OpeningVector {
  readonly id: string;
  readonly opening: string;
  readonly receipt: string;
  readonly disputeEnd: string;
  readonly l1ChainId: string;
  readonly state: JsonState;
  readonly expected: string;
}

interface OpeningVectors {
  readonly format: string;
  readonly forkSchedules: readonly {
    readonly chainId: string;
    readonly forks: readonly {
      readonly name: string;
      readonly epoch: string;
      readonly version: string;
    }[];
  }[];
  readonly blocks: readonly {
    readonly id: string;
    readonly chainId: number;
    readonly blockHash: string;
    readonly header: string;
    readonly transactionsRoot: string;
    readonly transactionCount: number;
    readonly proofs: readonly {
      readonly index: number;
      readonly proof: readonly string[];
      readonly transaction: string;
      readonly calldataSha256: string;
    }[];
  }[];
  readonly trieRejections: readonly {
    readonly id: string;
    readonly root: string;
    readonly index: number;
    readonly proof: readonly string[];
  }[];
  readonly calldata: readonly {
    readonly id: string;
    readonly transaction: string;
    readonly calldata: string | null;
  }[];
  readonly openings: readonly OpeningVector[];
}

const V = JSON.parse(
  readFileSync(new URL("receipt-opening.json", SPEC_VECTORS), "utf8"),
) as OpeningVectors;

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 100);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const state = (s: JsonState): TrustedBeaconState => ({
  slot: BigInt(s.slot),
  forkVersion: hex(s.forkVersion),
  historicalSummaryCount: s.historicalSummaryCount,
  blockSummaryRoots: new Map(
    Object.entries(s.blockSummaryRoots).map(([k, v]) => [Number(k), hex(v)]),
  ),
  blockRoots: new Map(Object.entries(s.blockRoots).map(([k, v]) => [Number(k), hex(v)])),
});

const input = (v: OpeningVector): ReceiptOpeningInput => ({
  opening: hex(v.opening),
  receipt: hex(v.receipt),
  disputeEnd: BigInt(v.disputeEnd),
  l1ChainId: BigInt(v.l1ChainId),
  state: state(v.state),
});

const result = (v: OpeningVector) => {
  const r = checkReceiptOpening(input(v));
  return r.ok ? "ok" : r.code;
};

const passing = V.openings.filter((v) => v.expected === "ok");
const byId = (id: string) => {
  const v = V.openings.find((o) => o.id === id);
  if (v === undefined) throw new Error(`no vector ${id}`);
  return v;
};

/** RLP encoding, written from the yellow paper's Appendix B, to re-encode what the decoder accepts. */
function rlpEncode(x: RlpItem): Uint8Array {
  const payload = x.list ? Buffer.concat(x.items.map(rlpEncode)) : x.bytes;
  if (!x.list && payload.length === 1 && (payload[0] as number) < 0x80) return payload.slice();
  return new Uint8Array(
    Buffer.concat([lengthPrefix(payload.length, x.list ? 0xc0 : 0x80), payload]),
  );
}

function lengthPrefix(n: number, base: number): Uint8Array {
  if (n < 56) return Uint8Array.of(base + n);
  const len: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) len.unshift(v % 256);
  return Uint8Array.of(base + 55 + len.length, ...len);
}

/** `d` lists, each holding the next, the innermost empty; built from the inside out. */
function nestedLists(d: number): Uint8Array {
  const prefixes: Uint8Array[] = [];
  let len = 1;
  for (let i = 1; i < d; i++) {
    const p = lengthPrefix(len, 0xc0);
    prefixes.push(p);
    len += p.length;
  }
  return new Uint8Array(Buffer.concat([...prefixes.reverse(), Uint8Array.of(0xc0)]));
}

describe("receipt-opening.json", () => {
  test("is the expected format, with every vector parsed", () => {
    expect(V.format).toBe("abolish-receipt-opening-vectors/1");
    expect(V.openings).toHaveLength(92);
    expect(V.blocks.map((b) => b.proofs.length)).toEqual([8, 5, 3]);
    expect(V.trieRejections).toHaveLength(8);
    expect(V.calldata).toHaveLength(13);
  });

  test("the pinned fork schedules are the vectors'", () => {
    expect(
      BEACON_FORK_SCHEDULES.map((s) => ({
        chainId: String(s.chainId),
        forks: s.forks.map((f) => ({
          name: f.name,
          epoch: String(f.epoch),
          version: toHex(f.version),
        })),
      })),
    ).toEqual(V.forkSchedules);
  });

  test("the real blocks' headers hash to their block hashes", () => {
    const real = V.blocks.filter((b) => b.chainId !== 0);
    expect(real.map((b) => b.chainId)).toEqual([1, 11155111]);
    for (const b of real) expect(toHex(keccak_256(hex(b.header))), b.id).toBe(b.blockHash);
  });

  test("every transaction proof proves its transaction and calldata", () => {
    for (const b of V.blocks)
      for (const p of b.proofs) {
        const tx = transactionTrieValue(hex(b.transactionsRoot), p.index, p.proof.map(hex));
        expect(tx && toHex(tx), `${b.id} ${p.index}`).toBe(p.transaction);
        const data = transactionCalldata(hex(p.transaction));
        expect(data && toHex(sha256(data)), `${b.id} ${p.index}`).toBe(p.calldataSha256);
      }
  });

  test("proofs that prove nothing are refused", () => {
    for (const r of V.trieRejections)
      expect(transactionTrieValue(hex(r.root), r.index, r.proof.map(hex)), r.id).toBeUndefined();
  });

  test("calldata comes only from the listed transaction types", () => {
    for (const c of V.calldata) {
      const data = transactionCalldata(hex(c.transaction));
      expect(data === undefined ? null : toHex(data), c.id).toBe(c.calldata);
    }
  });

  test("every opening gets the vectors' result", () => {
    for (const v of V.openings) expect(result(v), v.id).toBe(v.expected);
  });

  test("every check's failure is covered", () => {
    expect(new Set(V.openings.map((v) => v.expected))).toEqual(
      new Set([
        "ok",
        "opening-decode",
        "opening-transaction",
        "opening-commitment",
        "opening-late",
        "opening-payload",
        "opening-canonical",
        "opening-fork-unknown",
      ]),
    );
  });
});

describe("checkReceiptOpening", () => {
  test("decodes and re-encodes every passing opening exactly", () => {
    for (const v of passing) {
      const b = hex(v.opening);
      expect(encodeReceiptOpening(decodeReceiptOpening(b)), v.id).toEqual(b);
    }
  });

  test.each(["ok-summary", "ok-sepolia-gloas"])("no single flipped bit of %s passes", (id) => {
    const v = byId(id);
    const b = hex(v.opening);
    fc.assert(
      fc.property(fc.nat({ max: b.length * 8 - 1 }), (bit) => {
        const flipped = b.slice();
        flipped[bit >> 3] = (flipped[bit >> 3] as number) ^ (1 << (bit & 7));
        // A judge with the whole state holds whatever entry a moved slot
        // names; this one holds another root there.
        const s = state(v.state);
        const entry = receiptOpeningStateEntry(flipped, BigInt(v.l1ChainId));
        const other = new Uint8Array(32).fill(0xee);
        const blockSummaryRoots = new Map(s.blockSummaryRoots);
        const blockRoots = new Map(s.blockRoots);
        if (
          entry !== undefined &&
          "summaryIndex" in entry &&
          !blockSummaryRoots.has(entry.summaryIndex)
        )
          blockSummaryRoots.set(entry.summaryIndex, other);
        if (
          entry !== undefined &&
          "blockRootIndex" in entry &&
          !blockRoots.has(entry.blockRootIndex)
        )
          blockRoots.set(entry.blockRootIndex, other);
        const r = checkReceiptOpening({
          ...input(v),
          opening: flipped,
          state: { ...s, blockSummaryRoots, blockRoots },
        });
        expect(r.ok).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("no other receipt or later dispute end changes a pass, and an earlier one fails it late", () => {
    const v = byId("ok-timestamp-at-dispute-end");
    expect(checkReceiptOpening({ ...input(v), disputeEnd: BigInt(v.disputeEnd) + 1n }).ok).toBe(
      true,
    );
    expect(checkReceiptOpening({ ...input(v), disputeEnd: BigInt(v.disputeEnd) - 1n })).toEqual({
      ok: false,
      code: "opening-late",
    });
  });

  test("names the one state entry a passing opening reads", () => {
    for (const v of passing) {
      const entry = receiptOpeningStateEntry(hex(v.opening), BigInt(v.l1ChainId));
      if (entry === undefined) throw new Error(`${v.id} names no entry`);
      const [map, i] =
        "summaryIndex" in entry
          ? [v.state.blockSummaryRoots, entry.summaryIndex]
          : [v.state.blockRoots, entry.blockRootIndex];
      expect(Object.keys(map), v.id).toEqual([String(i)]);
    }
    expect(receiptOpeningStateEntry(new Uint8Array(3), 1n)).toBeUndefined();
    expect(receiptOpeningStateEntry(hex(byId("ok-summary").opening), 31337n)).toBeUndefined();
  });

  test("refuses a state whose known fork version isn't its slot's", () => {
    const v = byId("ok-summary");
    // Electra's version on a state in Fulu.
    expect(() =>
      checkReceiptOpening({
        ...input(v),
        state: { ...state(v.state), forkVersion: hex("05000000") },
      }),
    ).toThrow(RangeError);
  });

  test("refuses a state missing an entry the opening names, rather than failing the opening", () => {
    for (const id of ["ok-summary", "ok-block-roots"]) {
      const v = byId(id);
      const s = { ...state(v.state), blockSummaryRoots: new Map(), blockRoots: new Map() };
      expect(() => checkReceiptOpening({ ...input(v), state: s }), id).toThrow(RangeError);
    }
  });

  test("refuses malformed inputs", () => {
    const v = byId("ok-summary");
    expect(() => checkReceiptOpening({ ...input(v), disputeEnd: -1n })).toThrow(RangeError);
    expect(() => checkReceiptOpening({ ...input(v), l1ChainId: 1 as unknown as bigint })).toThrow(
      RangeError,
    );
    expect(() =>
      checkReceiptOpening({
        ...input(v),
        state: { ...state(v.state), forkVersion: new Uint8Array(3) },
      }),
    ).toThrow(RangeError);
    expect(() =>
      checkReceiptOpening({
        ...input(v),
        state: { ...state(v.state), blockRoots: {} as unknown as Map<number, Uint8Array> },
      }),
    ).toThrow(TypeError);
  });

  test("an opening that decodes round-trips, and any other bytes are opening-decode", () => {
    const v = byId("ok-summary");
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 600 }), (b) => {
        const r = checkReceiptOpening({ ...input(v), opening: b });
        expect(r.ok).toBe(false);
        let decodes = true;
        try {
          expect(encodeReceiptOpening(decodeReceiptOpening(b))).toEqual(b);
        } catch {
          decodes = false;
        }
        if (!decodes) expect(r).toEqual({ ok: false, code: "opening-decode" });
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("transactionTrieValue", () => {
  const block = V.blocks[0];
  test("a proof proves only its own index", () => {
    if (block === undefined) throw new Error("no block");
    const proofs = block.proofs;
    fc.assert(
      fc.property(
        fc.constantFrom(...proofs),
        fc.nat({ max: block.transactionCount + 300 }),
        (p, i) => {
          const got = transactionTrieValue(hex(block.transactionsRoot), i, p.proof.map(hex));
          if (i === p.index) expect(got && toHex(got)).toBe(p.transaction);
          else expect(got).toBeUndefined();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("refuses a proof with any node changed or dropped", () => {
    if (block === undefined) throw new Error("no block");
    fc.assert(
      fc.property(
        fc.constantFrom(...block.proofs),
        fc.nat(),
        fc.nat(),
        fc.boolean(),
        (p, n, at, drop) => {
          const nodes = p.proof.map(hex);
          const k = n % nodes.length;
          if (drop) nodes.splice(k, 1);
          else {
            const node = nodes[k] as Uint8Array;
            node[at % node.length] = (node[at % node.length] as number) ^ 0x01;
          }
          expect(transactionTrieValue(hex(block.transactionsRoot), p.index, nodes)).toBeUndefined();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("decodeRlp", () => {
  const item: fc.Memo<RlpItem> = fc.memo((n) =>
    n <= 1
      ? fc
          .uint8Array({ maxLength: 70 })
          .map((bytes): RlpItem => ({ list: false, bytes, raw: bytes }))
      : fc.oneof(
          fc
            .uint8Array({ maxLength: 70 })
            .map((bytes): RlpItem => ({ list: false, bytes, raw: bytes })),
          fc
            .array(item(n - 1), { maxLength: 5 })
            .map((items): RlpItem => ({ list: true, items, raw: new Uint8Array() })),
        ),
  );
  const shape = (x: RlpItem): unknown => (x.list ? x.items.map(shape) : toHex(x.bytes));

  test("decodes every encoding to its item", () => {
    fc.assert(
      fc.property(item(4), (x) => {
        const decoded = decodeRlp(rlpEncode(x));
        expect(decoded && shape(decoded)).toEqual(shape(x));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  test("every accepted input is the canonical encoding of what it decodes to", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 80 }), (b) => {
        const decoded = decodeRlp(b);
        if (decoded !== undefined) expect(rlpEncode(decoded)).toEqual(b);
      }),
      { numRuns: NUM_RUNS * 10 },
    );
  });

  test("refuses non-canonical forms", () => {
    for (const b of [
      "8100", // one byte below 0x80 in a string
      "817f",
      "b800", // a long form for a short string
      "b837" + "00".repeat(55),
      "b90038" + "00".repeat(56), // a length with a leading zero
      "f800",
      "c180", // fine on its own, so a trailing byte follows
      "c2c0", // a list running past its payload
      "",
    ])
      expect(decodeRlp(hex(b === "c180" ? "c18000" : b)), b).toBeUndefined();
    expect(decodeRlp(hex("b838" + "00".repeat(56)))).toBeDefined();
  });

  test("refuses nesting deeper than any transaction's", () => {
    expect(decodeRlp(nestedLists(16))).toBeDefined();
    expect(decodeRlp(nestedLists(17))).toBeUndefined();
    // Far deeper than the stack could follow without the bound.
    expect(decodeRlp(nestedLists(50_000))).toBeUndefined();
  });
});
