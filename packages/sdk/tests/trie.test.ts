import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NodePool } from "@abolishus/verifier";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { buildTrie, EMPTY_TRIE_ROOT, encodeRlp, uintBytes } from "../src/simulation/trie.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

// ethereum/tests' secure-trie vectors (keys hashed with Keccak-256, as the
// state and storage tries key them), vendored unmodified from
// https://raw.githubusercontent.com/ethereum/tests/c67e485ff8b5be9abc8ad15345ec21aa22e290d9/TrieTests/<name>
// (tag v17.2, retrieved 2026-10-13; MIT). A `0x` string is hex, any other
// UTF-8; a null value deletes its key.
const VECTORS = {
  "trieanyorder_secureTrie.json":
    "acba24dcef034b8ddd78d4ba8e716468854bac1a5ac886cc806c93f1c93f1ed4",
  "trietest_secureTrie.json": "98b76fd92fed69cb449d7a555cdb3eb397e7179614857de1289de2f63ac8e77a",
} as const;

type Vector = {
  readonly in: Record<string, string> | readonly (readonly [string, string | null])[];
  readonly root: string;
};

function load(name: keyof typeof VECTORS): Record<string, Vector> {
  const bytes = readFileSync(new URL(`./vectors/${name}`, import.meta.url));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(VECTORS[name]);
  return JSON.parse(bytes.toString("utf8")) as Record<string, Vector>;
}

const bytesOf = (s: string) =>
  s.startsWith("0x")
    ? Uint8Array.from(s.slice(2).match(/../g) ?? [], (b) => Number.parseInt(b, 16))
    : new TextEncoder().encode(s);

function rootOf(v: Vector): string {
  const pairs = Array.isArray(v.in) ? v.in : Object.entries(v.in);
  const state = new Map<string, readonly [Uint8Array, Uint8Array]>();
  for (const [k, value] of pairs as (readonly [string, string | null])[]) {
    if (value === null) state.delete(k);
    else state.set(k, [bytesOf(k), bytesOf(value)]);
  }
  return `0x${bytesToHex(buildTrie([...state.values()]).root)}`;
}

describe("buildTrie", () => {
  it("gives ethereum/tests' secure-trie roots", () => {
    const anyOrder = load("trieanyorder_secureTrie.json");
    const ordered = load("trietest_secureTrie.json");
    // Every vector is read, so a parser that drops some fails here.
    expect(Object.keys(anyOrder)).toHaveLength(7);
    expect(Object.keys(ordered)).toHaveLength(3);
    for (const [name, v] of [...Object.entries(anyOrder), ...Object.entries(ordered)])
      expect(rootOf(v), name).toBe(v.root);
  });

  it("gives the empty trie's root for no keys", () => {
    expect(buildTrie([])).toEqual({ root: EMPTY_TRIE_ROOT, nodes: [] });
    expect(bytesToHex(EMPTY_TRIE_ROOT)).toBe(
      "56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421",
    );
  });

  it("proves every key's value, and every other key absent, to the verifier's walk", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            key: fc.uint8Array({ minLength: 32, maxLength: 32 }),
            value: fc.uint8Array({ minLength: 1, maxLength: 40 }),
          }),
          { maxLength: 40, selector: (e) => bytesToHex(e.key) },
        ),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        (entries, other) => {
          const trie = buildTrie(entries.map((e) => [e.key, e.value]));
          const pool = new NodePool(trie.nodes);
          for (const e of entries) expect(pool.get(trie.root, keccak_256(e.key))).toEqual(e.value);
          if (!entries.some((e) => bytesToHex(e.key) === bytesToHex(other)))
            expect(pool.get(trie.root, keccak_256(other))).toBeUndefined();
          // Only nodes of 32 bytes or more are referenced by hash, and the root always is.
          expect(
            trie.nodes.every(
              (n) => n.length >= 32 || bytesToHex(keccak_256(n)) === bytesToHex(trie.root),
            ),
          ).toBe(true);
        },
      ),
      { numRuns },
    );
  });

  it("refuses a repeated key and an empty value", () => {
    const k = new Uint8Array(32);
    expect(() =>
      buildTrie([
        [k, Uint8Array.of(1)],
        [Uint8Array.from(k), Uint8Array.of(2)],
      ]),
    ).toThrow(/repeated/);
    expect(() => buildTrie([[k, new Uint8Array()]])).toThrow(/empty value/);
  });
});

describe("encodeRlp", () => {
  it("encodes the Yellow Paper's examples", () => {
    const hex = (b: Uint8Array) => bytesToHex(b);
    const utf8 = (s: string) => new TextEncoder().encode(s);
    expect(hex(encodeRlp(utf8("dog")))).toBe("83646f67");
    expect(hex(encodeRlp([utf8("cat"), utf8("dog")]))).toBe("c88363617483646f67");
    expect(hex(encodeRlp(new Uint8Array()))).toBe("80");
    expect(hex(encodeRlp([]))).toBe("c0");
    expect(hex(encodeRlp(uintBytes(0n)))).toBe("80");
    expect(hex(encodeRlp(uintBytes(15n)))).toBe("0f");
    expect(hex(encodeRlp(uintBytes(1024n)))).toBe("820400");
    expect(hex(encodeRlp([[], [[]], [[], [[]]]]))).toBe("c7c0c1c0c3c0c1c0");
    const long = utf8("Lorem ipsum dolor sit amet, consectetur adipisicing elit");
    expect(hex(encodeRlp(long)).slice(0, 4)).toBe("b838");
  });
});
