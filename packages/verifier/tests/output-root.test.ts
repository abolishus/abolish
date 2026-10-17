import {
  type ArchivedContractLog,
  checkEventAccumulatorProof,
  replayEventAccumulator,
} from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  ACCUMULATOR_SLOT,
  accumulatorAtOutputRoot,
  OutputRootError,
  type OutputRootErrorCode,
  type OutputRootEvidence,
  outputRootV0,
  storageAtOutputRoot,
} from "../src/index.ts";
import { rlp } from "./headers.ts";
import { buildTrie, stored } from "./state.ts";

// Storage under an output root posted on L1 (src/output-root.ts;
// docs/spec/contracts.md, Event accumulator, Output root). The vectors are a
// real Base Sepolia dispute game's root claim with the block and proofs a
// Base Sepolia node served (docs/spec/vectors/output-root.json); the
// synthetic states are built by the tests' own trie writer (tests/state.ts),
// so neither comes from the reader under test (T-71, T-34).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const run = <T>(p: fc.IPropertyWithHooks<T> | fc.IProperty<T>) => fc.assert(p, { numRuns });

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

interface Vector {
  readonly id: string;
  readonly outputRoot: string;
  readonly messagePasserStorageRoot: string;
  readonly header: string;
  readonly address: string;
  readonly slots: readonly string[];
  readonly nodes: readonly string[];
  readonly result:
    | {
        readonly number: string;
        readonly timestamp: string;
        readonly hash: string;
        readonly words: readonly string[];
      }
    | { readonly error: OutputRootErrorCode };
}

const file = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/output-root.json", import.meta.url), "utf8"),
) as {
  readonly format: string;
  readonly game: { readonly rootClaim: string; readonly l2SequenceNumber: string };
  readonly vectors: readonly Vector[];
};

const evidenceOf = (v: Vector): OutputRootEvidence => ({
  outputRoot: hex(v.outputRoot),
  messagePasserStorageRoot: hex(v.messagePasserStorageRoot),
  header: hex(v.header),
  nodes: v.nodes.map(hex),
});

function codeOf(f: () => unknown): OutputRootErrorCode | "none" {
  try {
    f();
    return "none";
  } catch (e) {
    if (e instanceof OutputRootError) return e.code;
    throw e;
  }
}

describe("output-root.json", () => {
  test("is the format this reader implements", () => {
    expect(file.format).toBe("abolish-output-root-vectors/1");
  });

  for (const v of file.vectors)
    test(`${v.id}`, () => {
      const read = () => storageAtOutputRoot(evidenceOf(v), hex(v.address), v.slots.map(hex));
      if ("error" in v.result) {
        expect(codeOf(read)).toBe(v.result.error);
        return;
      }
      const { block, words } = read();
      expect(block.number).toBe(BigInt(v.result.number));
      expect(block.timestamp).toBe(BigInt(v.result.timestamp));
      expect(toHex(block.hash)).toBe(v.result.hash);
      expect(words.map(toHex)).toEqual(v.result.words);
    });

  test("the honest vectors are the game's root claim at its L2 block", () => {
    const honest = file.vectors.filter((v) => !("error" in v.result));
    expect(honest.length).toBeGreaterThan(0);
    for (const v of honest) {
      expect(v.outputRoot).toBe(file.game.rootClaim);
      expect("number" in v.result && v.result.number).toBe(file.game.l2SequenceNumber);
    }
  });
});

// A synthetic L2 state: the contract at `address` holding `accumulator` and
// `count` at the spec's slots, beside `others` (address, storage) accounts.

const uint = (n: bigint) => {
  const out: number[] = [];
  for (let x = n; x > 0n; x >>= 8n) out.unshift(Number(x & 0xffn));
  return Uint8Array.from(out);
};
const word = (n: bigint) => {
  const b = new Uint8Array(32);
  for (let i = 31, x = n; x > 0n; i--, x >>= 8n) b[i] = Number(x & 0xffn);
  return b;
};
const CODE = keccak_256(Uint8Array.of(0xfe));
const NO_CODE = keccak_256(new Uint8Array());

interface Account {
  readonly address: Uint8Array;
  readonly storage: readonly (readonly [Uint8Array, Uint8Array])[];
  readonly codeHash?: Uint8Array;
}

function l2State(accounts: readonly Account[], number: bigint, timestamp: bigint) {
  const nodes: Uint8Array[] = [];
  const entries = accounts.map((a): [Uint8Array, Uint8Array] => {
    const nonZero = a.storage.filter(([, w]) => w.some((x) => x !== 0));
    // An empty storage trie has the empty root and no nodes.
    let root = keccak_256(Uint8Array.of(0x80));
    if (nonZero.length > 0) {
      const trie = buildTrie(nonZero.map(([slot, w]) => [slot, stored(w)] as const));
      root = trie.root;
      nodes.push(...trie.nodes);
    }
    return [a.address, rlp([uint(1n), uint(0n), root, a.codeHash ?? CODE])];
  });
  const state = buildTrie(entries);
  nodes.push(...state.nodes);
  const z = (n: number) => new Uint8Array(n);
  const header = rlp([
    z(32),
    z(32),
    z(20),
    state.root,
    z(32),
    z(32),
    z(256),
    uint(0n),
    uint(number),
    uint(30_000_000n),
    uint(0n),
    uint(timestamp),
    new Uint8Array(),
    z(32),
    z(8),
    uint(1n),
  ]);
  const messagePasserStorageRoot = keccak_256(Uint8Array.of(0x42));
  // Written out here rather than through outputRootV0, which is under test.
  const outputRoot = keccak_256(
    Uint8Array.from([
      ...new Uint8Array(32),
      ...state.root,
      ...messagePasserStorageRoot,
      ...keccak_256(header),
    ]),
  );
  return {
    evidence: { outputRoot, messagePasserStorageRoot, header, nodes },
    hash: keccak_256(header),
  };
}

const S = word(ACCUMULATOR_SLOT);
const S1 = word(ACCUMULATOR_SLOT + 1n);
const REGISTRY = hex("00000000000000000000000000000000000e1ec7");
const bytes = (n: number) => fc.uint8Array({ minLength: n, maxLength: n });
const u64 = fc.bigInt({ min: 0n, max: (1n << 64n) - 1n });

const registryState = (accumulator: Uint8Array, count: bigint, others: readonly Account[] = []) =>
  l2State(
    [
      {
        address: REGISTRY,
        storage: [
          [S, accumulator],
          [S1, word(count)],
        ],
      },
      ...others,
    ],
    1_000n,
    1_800_000_000n,
  );

const otherAccount = fc.record({
  address: bytes(20).filter((a) => !a.every((x, i) => x === REGISTRY[i])),
  // Distinct slots: a trie has one value per key.
  storage: fc.uniqueArray(fc.tuple(bytes(32), bytes(32)), {
    maxLength: 3,
    selector: ([slot]) => toHex(slot),
  }),
});

describe("accumulatorAtOutputRoot", () => {
  test("reads the accumulator and count at the root's block, which the event check accepts", () => {
    const logs: ArchivedContractLog[] = [0n, 1n, 2n].map((n) => ({
      n,
      block: 900n + n,
      timestamp: 1_799_999_000n + n,
      topics: [keccak_256(Uint8Array.of(Number(n)))],
      data: new Uint8Array(0),
    }));
    const { accumulator, count } = replayEventAccumulator(84_532n, REGISTRY, logs);
    const { evidence, hash } = registryState(accumulator, count);
    const proven = accumulatorAtOutputRoot(evidence, REGISTRY);
    expect(proven).toEqual({
      block: 1_000n,
      timestamp: 1_800_000_000n,
      blockHash: hash,
      accumulator,
      count: 3n,
    });
    expect(checkEventAccumulatorProof(84_532n, REGISTRY, logs, proven)).toBeNull();
    expect(checkEventAccumulatorProof(84_532n, REGISTRY, logs.slice(0, 2), proven)).toBe(
      "accumulator",
    );
  });

  test("reads any accumulator and u64 count beside other accounts", () => {
    run(
      fc.property(
        bytes(32),
        u64,
        fc.array(otherAccount, { maxLength: 4 }),
        (acc, count, others) => {
          const unique = others.filter(
            (a, i) => others.findIndex((b) => toHex(b.address) === toHex(a.address)) === i,
          );
          const { evidence } = registryState(acc, count, unique);
          const proven = accumulatorAtOutputRoot(evidence, REGISTRY);
          expect(proven.accumulator).toEqual(acc);
          expect(proven.count).toBe(count);
        },
      ),
    );
  });

  test("reads unwritten slots as a zero accumulator and count", () => {
    const { evidence } = l2State([{ address: REGISTRY, storage: [] }], 7n, 8n);
    const proven = accumulatorAtOutputRoot(evidence, REGISTRY);
    expect(proven.accumulator).toEqual(new Uint8Array(32));
    expect(proven.count).toBe(0n);
  });

  test("refuses a count word above a u64", () => {
    run(
      fc.property(fc.bigInt({ min: 1n << 64n, max: (1n << 256n) - 1n }), (count) => {
        const { evidence } = registryState(new Uint8Array(32).fill(1), count);
        expect(codeOf(() => accumulatorAtOutputRoot(evidence, REGISTRY))).toBe("l2-count");
      }),
    );
  });

  test("refuses an address with no account, or one without code", () => {
    const { evidence } = registryState(new Uint8Array(32).fill(1), 1n);
    expect(codeOf(() => accumulatorAtOutputRoot(evidence, hex("00".repeat(19) + "01")))).toBe(
      "l2-contract-absent",
    );
    const eoa = l2State(
      [{ address: REGISTRY, storage: [[S, word(1n)]], codeHash: NO_CODE }],
      1n,
      1n,
    );
    expect(codeOf(() => accumulatorAtOutputRoot(eoa.evidence, REGISTRY))).toBe(
      "l2-contract-absent",
    );
  });
});

describe("storageAtOutputRoot binds everything to the root", () => {
  const honest = () => registryState(new Uint8Array(32).fill(7), 5n).evidence;
  const read = (e: OutputRootEvidence) => () => accumulatorAtOutputRoot(e, REGISTRY);

  test("any changed bit of the root or the message-passer root is refused", () => {
    run(
      fc.property(fc.nat(255), fc.boolean(), (bit, which) => {
        const e = honest();
        const field = which ? "outputRoot" : "messagePasserStorageRoot";
        const changed = Uint8Array.from(e[field]);
        changed[bit >> 3] = (changed[bit >> 3] as number) ^ (1 << (bit & 7));
        expect(codeOf(read({ ...e, [field]: changed }))).toBe("output-root");
      }),
    );
  });

  test("any changed byte of the header is refused, as another header or as no header", () => {
    run(
      fc.property(fc.nat(), fc.integer({ min: 1, max: 255 }), (at, x) => {
        const e = honest();
        const header = Uint8Array.from(e.header);
        const i = at % header.length;
        header[i] = (header[i] as number) ^ x;
        expect(["output-root", "l2-header"]).toContain(codeOf(read({ ...e, header })));
      }),
    );
  });

  test("a header of another block holding the same storage is refused", () => {
    const e = honest();
    const later = l2State(
      [
        {
          address: REGISTRY,
          storage: [
            [S, new Uint8Array(32).fill(7)],
            [S1, word(5n)],
          ],
        },
      ],
      1_001n,
      1_800_000_002n,
    );
    expect(codeOf(read({ ...e, header: later.evidence.header }))).toBe("output-root");
  });

  test("dropping any node the walk needs is refused as missing", () => {
    const e = honest();
    for (const i of e.nodes.keys())
      expect(codeOf(read({ ...e, nodes: e.nodes.filter((_, j) => j !== i) }))).toBe(
        "l2-proof-missing",
      );
  });

  test("a trie that holds a stored value that isn't minimal is refused as malformed", () => {
    const zeroLed = Uint8Array.from([0xa1, 0x00, ...new Uint8Array(31).fill(1)]);
    const accountTrie = buildTrie([[S, zeroLed]]);
    const state = buildTrie([[REGISTRY, rlp([uint(1n), uint(0n), accountTrie.root, CODE])]]);
    const header = rlp([
      new Uint8Array(32),
      new Uint8Array(32),
      new Uint8Array(20),
      state.root,
      new Uint8Array(32),
      new Uint8Array(32),
      new Uint8Array(256),
      uint(0n),
      uint(1n),
      uint(0n),
      uint(0n),
      uint(1n),
      new Uint8Array(),
      new Uint8Array(32),
      new Uint8Array(8),
    ]);
    const mp = new Uint8Array(32);
    const e: OutputRootEvidence = {
      outputRoot: outputRootV0(state.root, mp, keccak_256(header)),
      messagePasserStorageRoot: mp,
      header,
      nodes: [...accountTrie.nodes, ...state.nodes],
    };
    expect(codeOf(read(e))).toBe("l2-proof-malformed");
  });

  test("refuses inputs of the wrong length before reading anything, the node's as a root mismatch", () => {
    const e = honest();
    expect(() =>
      accumulatorAtOutputRoot({ ...e, outputRoot: new Uint8Array(31) }, REGISTRY),
    ).toThrow(RangeError);
    expect(
      codeOf(() =>
        accumulatorAtOutputRoot({ ...e, messagePasserStorageRoot: new Uint8Array(33) }, REGISTRY),
      ),
    ).toBe("output-root");
    expect(() => accumulatorAtOutputRoot(e, new Uint8Array(32))).toThrow(RangeError);
    expect(() => storageAtOutputRoot(e, REGISTRY, [new Uint8Array(31)])).toThrow(RangeError);
  });
});
