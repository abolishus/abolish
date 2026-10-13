// Simulated L1 state for the verifier's bundle (docs/spec/verifier.md, Anchors
// from L1): recursive-length prefix encoding (Ethereum Yellow Paper, Appendix
// B) and the Merkle–Patricia trie (Appendix D) built from a set of 32-byte
// keys, so a simulated board anchor's storage can be handed to the verifier
// as the nodes `eth_getProof` returns. The sdk builds the trie and the
// verifier walks it, so a trie the verifier can't read stops the run instead
// of passing (T-24). Only what a simulated anchor needs: hashed keys, all of
// one length, so no value ever sits in a branch.

import { keccak_256 } from "@noble/hashes/sha3.js";

/** An RLP item: a byte string, a list, or an item already encoded (a child node embedded in its parent). */
export type RlpItem = Uint8Array | readonly RlpItem[] | { readonly encoded: Uint8Array };

function lengthPrefix(length: number, offset: number): number[] {
  if (length < 56) return [offset + length];
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return [offset + 55 + bytes.length, ...bytes];
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function encodeRlp(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && (item[0] as number) < 0x80) return Uint8Array.from(item);
    return concat([Uint8Array.from(lengthPrefix(item.length, 0x80)), item]);
  }
  if ("encoded" in item) return Uint8Array.from(item.encoded);
  const body = concat(item.map(encodeRlp));
  return concat([Uint8Array.from(lengthPrefix(body.length, 0xc0)), body]);
}

/** A non-negative integer as RLP wants it: big-endian with no leading zero bytes, so 0 is empty. */
export function uintBytes(n: bigint): Uint8Array {
  if (n < 0n) throw new RangeError("uintBytes: negative");
  const bytes: number[] = [];
  for (let x = n; x > 0n; x >>= 8n) bytes.unshift(Number(x & 0xffn));
  return Uint8Array.from(bytes);
}

/** The root of the trie with no keys: Keccak-256 of the empty string's RLP. */
export const EMPTY_TRIE_ROOT = keccak_256(Uint8Array.of(0x80));

/** A trie: its root hash and every node whose encoding is 32 bytes or more, the root's included. */
export interface Trie {
  readonly root: Uint8Array;
  readonly nodes: readonly Uint8Array[];
}

interface Leaf {
  readonly path: readonly number[];
  readonly value: Uint8Array;
}

function nibbles(b: Uint8Array): number[] {
  const out: number[] = [];
  for (const x of b) out.push(x >> 4, x & 0x0f);
  return out;
}

// Hex-prefix encoding (Appendix C): a flag nibble (2 for a leaf, plus 1 for
// an odd length), a zero nibble to pad an even path, then the path.
function hexPrefix(path: readonly number[], leaf: boolean): Uint8Array {
  const odd = path.length % 2;
  const all = [(leaf ? 2 : 0) + odd, ...(odd === 1 ? [] : [0]), ...path];
  const out = new Uint8Array(all.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = ((all[2 * i] as number) << 4) | (all[2 * i + 1] as number);
  return out;
}

/**
 * The trie holding each value at Keccak-256 of its key, as the state and
 * storage tries key accounts and slots (a "secure" trie, so every path is 64
 * nibbles). Every key must appear once, and no value may be empty (a trie
 * never stores one).
 */
export function buildTrie(entries: readonly (readonly [Uint8Array, Uint8Array])[]): Trie {
  const seen = new Set<string>();
  for (const [key, value] of entries) {
    if (value.length === 0) throw new RangeError("buildTrie: an empty value");
    const hex = Array.from(key, (x) => x.toString(16).padStart(2, "0")).join("");
    if (seen.has(hex)) throw new RangeError("buildTrie: a key repeated");
    seen.add(hex);
  }
  if (entries.length === 0) return { root: Uint8Array.from(EMPTY_TRIE_ROOT), nodes: [] };
  const nodes: Uint8Array[] = [];
  // A child is the node's hash, or the node itself when its encoding is
  // shorter than 32 bytes.
  const reference = (encoded: Uint8Array): RlpItem => {
    if (encoded.length < 32) return { encoded };
    nodes.push(encoded);
    return keccak_256(encoded);
  };
  const build = (leaves: readonly Leaf[], depth: number): Uint8Array => {
    const [first] = leaves;
    if (first === undefined) throw new Error("buildTrie: an empty subtrie");
    if (leaves.length === 1)
      return encodeRlp([hexPrefix(first.path.slice(depth), true), first.value]);
    // The nibbles every remaining path shares become an extension.
    let shared = 0;
    while (leaves.every((l) => l.path[depth + shared] === first.path[depth + shared])) shared++;
    if (shared > 0)
      return encodeRlp([
        hexPrefix(first.path.slice(depth, depth + shared), false),
        reference(build(leaves, depth + shared)),
      ]);
    const children: RlpItem[] = [];
    for (let nibble = 0; nibble < 16; nibble++) {
      const under = leaves.filter((l) => l.path[depth] === nibble);
      children.push(under.length === 0 ? new Uint8Array() : reference(build(under, depth + 1)));
    }
    // Keys of one length end at leaves, so a branch holds no value.
    return encodeRlp([...children, new Uint8Array()]);
  };
  const root = build(
    entries.map(([key, value]) => ({ path: nibbles(keccak_256(key)), value })),
    0,
  );
  nodes.push(root);
  return { root: keccak_256(root), nodes };
}
