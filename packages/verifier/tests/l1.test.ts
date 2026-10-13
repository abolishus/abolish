import { keccak_256 } from "@noble/hashes/sha3.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  checkpointSlot,
  decodeHeader,
  decodeRlp,
  L1Error,
  lowestSegmentSlot,
  NodePool,
  type Rlp,
  RlpError,
} from "../src/index.ts";

// Strict RLP, headers and trie walks (docs/spec/verifier.md, Anchors from
// L1). The vectors in l1-vectors.test.ts check them against Anvil's own
// encodings; these check every rejection and the shapes Anvil's tries never
// produce (T-36).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const run = <T>(p: fc.IPropertyWithHooks<T> | fc.IProperty<T>) => fc.assert(p, { numRuns });

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// A reference RLP encoder, written from the Yellow Paper's Appendix B.
type Item = Uint8Array | Item[];
function lengthPrefix(n: number, short: number): Uint8Array {
  if (n < 56) return Uint8Array.of(short + n);
  const len: number[] = [];
  for (let x = n; x > 0; x = Math.floor(x / 256)) len.unshift(x % 256);
  return Uint8Array.of(short + 55 + len.length, ...len);
}
function rlp(x: Item): Uint8Array {
  if (x instanceof Uint8Array) {
    if (x.length === 1 && (x[0] as number) < 0x80) return x.slice();
    return Uint8Array.from([...lengthPrefix(x.length, 0x80), ...x]);
  }
  const body = x.flatMap((i) => [...rlp(i)]);
  return Uint8Array.from([...lengthPrefix(body.length, 0xc0), ...body]);
}
function plain(r: Rlp): Item {
  return r.list ? r.items.map(plain) : r.bytes;
}

const itemArb: fc.Arbitrary<Item> = fc.letrec<{ item: Item }>((tie) => ({
  item: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.uint8Array({ maxLength: 80 }),
    fc.array(tie("item"), { maxLength: 4 }),
  ),
})).item;

describe("RLP", () => {
  test("decode(encode(x)) = x, and every raw slice re-encodes its item", () => {
    run(
      fc.property(itemArb, (x) => {
        const bytes = rlp(x);
        const r = decodeRlp(bytes);
        expect(plain(r)).toEqual(x);
        expect(r.raw).toEqual(bytes);
      }),
    );
  });

  test("any bytes that decode are the canonical encoding of what they decode to", () => {
    run(
      fc.property(fc.uint8Array({ maxLength: 64 }), (b) => {
        let r: Rlp;
        try {
          r = decodeRlp(b);
        } catch (e) {
          if (e instanceof RlpError) return;
          throw e;
        }
        expect(rlp(plain(r))).toEqual(b);
      }),
    );
  });

  const rejected: [string, string][] = [
    ["empty input", ""],
    ["a single byte below 0x80 with a length prefix", "8105"],
    ["the long form for a 55-byte string", `b837${"00".repeat(55)}`],
    ["the long form for a short list", `f801${"80"}`],
    ["a length with a leading zero", `b90038${"00".repeat(56)}`],
    ["a truncated string", "83aabb"],
    ["a truncated long length", "b9"],
    ["a list whose item overruns it", "c283aabbcc"],
    ["trailing bytes", "8000"],
    ["two items", "0102"],
  ];
  for (const [what, h] of rejected)
    test(`rejects ${what}`, () => {
      expect(() => decodeRlp(hex(h))).toThrow(RlpError);
    });

  test("accepts nesting of 16 lists and rejects 17", () => {
    const nest = (n: number): Item => (n === 0 ? [] : [nest(n - 1)]);
    expect(() => decodeRlp(rlp(nest(16)))).not.toThrow();
    expect(() => decodeRlp(rlp(nest(17)))).toThrow(/deeply/);
  });
});

const vectors = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/l1-anchor.json", import.meta.url), "utf8"),
) as {
  readonly electionId: string;
  readonly vectors: readonly {
    readonly id: string;
    readonly block: { readonly header: string; readonly hash: string; readonly number: string };
  }[];
};
const closed = vectors.vectors.find((v) => v.id === "closed");
if (closed === undefined) throw new Error("no closed vector");
const fields = (decodeRlp(hex(closed.block.header)) as Extract<Rlp, { list: true }>).items.map(
  (f) => plain(f) as Uint8Array,
);

describe("block headers", () => {
  test("hashes the bytes given and reads the state root, number and time", () => {
    const h = decodeHeader(hex(closed.block.header));
    expect(toHex(h.hash)).toBe(closed.block.hash);
    expect(h.stateRoot).toEqual(fields[3]);
    expect(h.number).toBe(BigInt(closed.block.number));
    expect(h.timestamp).toBe(1800032401n);
  });

  test("accepts any number of fields from 15, as forks append them", () => {
    expect(decodeHeader(rlp(fields.slice(0, 15))).timestamp).toBe(1800032401n);
    expect(decodeHeader(rlp([...fields, new Uint8Array(32)])).number).toBe(
      BigInt(closed.block.number),
    );
  });

  const with_ = (i: number, v: Item) => rlp(fields.map((f, j) => (j === i ? v : f)));
  const rejected: [string, Uint8Array][] = [
    ["14 fields", rlp(fields.slice(0, 14))],
    ["a byte string", rlp(new Uint8Array(40))],
    ["a field that is a list", with_(5, [])],
    ["a state root of 31 bytes", with_(3, new Uint8Array(31))],
    ["a number with a leading zero", with_(8, Uint8Array.of(0, 13))],
    ["a time over 64 bits", with_(11, new Uint8Array(9).fill(1))],
    ["trailing bytes", Uint8Array.from([...hex(closed.block.header), 0])],
  ];
  for (const [what, bytes] of rejected)
    test(`rejects ${what}`, () => {
      expect(() => decodeHeader(bytes)).toThrow(RlpError);
    });
});

// Hex-prefix encoding (Yellow Paper, Appendix C).
function hp(nibbles: readonly number[], leaf: boolean): Uint8Array {
  const odd = nibbles.length % 2 === 1;
  const flag = (leaf ? 2 : 0) + (odd ? 1 : 0);
  const all = odd ? [flag, ...nibbles] : [flag, 0, ...nibbles];
  const out = new Uint8Array(all.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = ((all[2 * i] as number) << 4) | (all[2 * i + 1] as number);
  return out;
}
const nibblesOf = (b: Uint8Array) => [...b].flatMap((x) => [x >> 4, x & 15]);
const missing = (f: () => unknown) =>
  expect(f).toThrow(expect.objectContaining({ code: "l1-proof-missing" }));
const malformed = (f: () => unknown) =>
  expect(f).toThrow(expect.objectContaining({ code: "l1-proof-malformed" }));

describe("trie walks", () => {
  const key = keccak_256(Uint8Array.of(1));
  const value = Uint8Array.of(0x2a);

  test("a one-leaf trie gives its value, and proves every other key absent", () => {
    run(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (other) => {
        const leaf = rlp([hp(nibblesOf(key), true), value]);
        const pool = new NodePool([leaf]);
        const root = keccak_256(leaf);
        expect(pool.get(root, key)).toEqual(value);
        if (toHex(other) !== toHex(key)) expect(pool.get(root, other)).toBeUndefined();
      }),
    );
  });

  test("the empty trie proves every key absent, with no nodes", () => {
    expect(new NodePool([]).get(keccak_256(Uint8Array.of(0x80)), key)).toBeUndefined();
  });

  test("a root not in the pool is missing", () => {
    missing(() => new NodePool([]).get(new Uint8Array(32), key));
  });

  test("follows a branch, an extension and an embedded node", () => {
    // Keys of two bytes, so a leaf under a branch is short enough to embed.
    const k1 = Uint8Array.of(0x12, 0x34);
    const k2 = Uint8Array.of(0x12, 0x56);
    const l1 = rlp([hp([4], true), Uint8Array.of(1)]);
    expect(l1.length).toBeLessThan(32);
    const branch: Item[] = Array.from({ length: 17 }, () => new Uint8Array());
    branch[3] = [hp([4], true), Uint8Array.of(1)];
    branch[5] = [hp([6], true), Uint8Array.of(2)];
    const branchBytes = rlp(branch);
    const ext = rlp([hp([1, 2], false), keccak_256(branchBytes)]);
    const pool = new NodePool([ext, branchBytes]);
    const root = keccak_256(ext);
    expect(pool.get(root, k1)).toEqual(Uint8Array.of(1));
    expect(pool.get(root, k2)).toEqual(Uint8Array.of(2));
    expect(pool.get(root, Uint8Array.of(0x12, 0x74))).toBeUndefined();
    expect(pool.get(root, Uint8Array.of(0x13, 0x34))).toBeUndefined();
    expect(pool.get(root, Uint8Array.of(0x12, 0x35))).toBeUndefined();
    missing(() => new NodePool([ext]).get(root, k1));
  });

  const as =
    (node: Item, k = key) =>
    () =>
      new NodePool([rlp(node)]).get(keccak_256(rlp(node)), k);
  const branch = (child: Item): Item[] => {
    const b: Item[] = Array.from({ length: 17 }, () => new Uint8Array());
    b[(key[0] as number) >> 4] = child;
    return b;
  };
  const shapes: [string, () => unknown][] = [
    [
      "a node that isn't RLP",
      () => new NodePool([Uint8Array.of(0x81)]).get(keccak_256(Uint8Array.of(0x81)), key),
    ],
    ["a node that is a string", as(new Uint8Array(40))],
    ["a node of 3 items", as([new Uint8Array(1), new Uint8Array(1), new Uint8Array(1)])],
    ["an even path with a non-zero pad nibble", as([Uint8Array.of(0x21, ...key), value])],
    ["a path flag over 3", as([Uint8Array.of(0x40, ...key), value])],
    ["an empty path", as([new Uint8Array(), value])],
    ["a leaf with an empty value", as([hp(nibblesOf(key), true), new Uint8Array()])],
    ["a leaf whose value is a list", as([hp(nibblesOf(key), true), []])],
    ["an extension with an empty path", as([hp([], false), new Uint8Array(32)])],
    ["a branch child of 31 bytes", as(branch(new Uint8Array(31)))],
    ["an embedded child of 32 bytes or more", as(branch([new Uint8Array(20), new Uint8Array(20)]))],
    ["a branch where the key ends", as(branch(new Uint8Array(32)), new Uint8Array())],
  ];
  for (const [what, f] of shapes) test(`rejects ${what}`, () => malformed(f));

  test("errors are L1Errors", () => {
    expect(() => new NodePool([]).get(new Uint8Array(32), key)).toThrow(L1Error);
  });
});

describe("the anchor's slots", () => {
  // Solidity's layout for mapping(bytes32 => mapping(uint32 => bytes32)) at
  // A, and mapping(bytes32 => uint256) at A + 1, computed independently of
  // the code here (cast index, Foundry 1.8.3).
  const id = hex("ab9ec7a6b367362c48aee10f4ea81bf886d90a266dfda8c924bfe478e9b04f9d");
  test("match cast index", () => {
    expect(toHex(lowestSegmentSlot(id))).toBe(LOWEST);
    expect(toHex(checkpointSlot(id, 4))).toBe(SEGMENT_4);
  });
});

const LOWEST = "4deec46d1206ebcc58f27722da628d4e33b00bdc7afe212b05fc372eb17961cd";
const SEGMENT_4 = "cf115cb93d54de9eafa07e3e2164782b6e5e513f833a34690f5e70fd7b90ad0b";
