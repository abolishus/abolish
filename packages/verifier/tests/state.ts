import {
  type AnchorClock,
  checkpointHash,
  copyCheckpoints,
  decodeBoardEntry,
  type BoardEntryVersion,
} from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { checkpointSlot, lowestSegmentSlot } from "../src/index.ts";
import { rlp, toHex } from "./headers.ts";

// A sealed, anchored board for tests: the board anchor's storage holding a
// checkpoint after every segment that holds entries and after the seal, in
// an L1 state whose header is the bundle's (docs/spec/verifier.md, Anchors
// from L1). The secure Merkle–Patricia trie is written here from the Yellow
// Paper's Appendix D, as packages/sdk's simulation builds it, so the trie the
// verifier walks never comes from its own reader. The slots are the
// verifier's own: what these bundles test is everything after 4.1 and 4.2.

type Item = Uint8Array | Item[] | { readonly encoded: Uint8Array };

function encode(x: Item): Uint8Array {
  if (x instanceof Uint8Array || Array.isArray(x)) {
    if (Array.isArray(x)) {
      const parts = x.map(encode);
      const body = Uint8Array.from(parts.flatMap((p) => [...p]));
      // A list whose items are already encoded: rlp() of the list of their
      // bodies would re-encode them, so the prefix is built here.
      return Uint8Array.from([...listPrefix(body.length), ...body]);
    }
    return rlp(x);
  }
  return Uint8Array.from(x.encoded);
}

function listPrefix(n: number): number[] {
  if (n < 56) return [0xc0 + n];
  const len: number[] = [];
  for (let x = n; x > 0; x = Math.floor(x / 256)) len.unshift(x % 256);
  return [0xc0 + 55 + len.length, ...len];
}

function hexPrefix(path: readonly number[], leaf: boolean): Uint8Array {
  const odd = path.length % 2;
  const all = [(leaf ? 2 : 0) + odd, ...(odd === 1 ? [] : [0]), ...path];
  const out = new Uint8Array(all.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = ((all[2 * i] as number) << 4) | (all[2 * i + 1] as number);
  return out;
}

const nibbles = (b: Uint8Array) => [...b].flatMap((x) => [x >> 4, x & 0x0f]);

/** The secure trie of `entries`: its root and every node 32 bytes or longer. */
export function buildTrie(entries: readonly (readonly [Uint8Array, Uint8Array])[]) {
  const nodes: Uint8Array[] = [];
  const reference = (node: Uint8Array): Item => {
    if (node.length < 32) return { encoded: node };
    nodes.push(node);
    return keccak_256(node);
  };
  type Leaf = { readonly path: readonly number[]; readonly value: Uint8Array };
  const build = (leaves: readonly Leaf[], depth: number): Uint8Array => {
    const first = leaves[0] as Leaf;
    if (leaves.length === 1) return encode([hexPrefix(first.path.slice(depth), true), first.value]);
    let shared = 0;
    while (leaves.every((l) => l.path[depth + shared] === first.path[depth + shared])) shared++;
    if (shared > 0)
      return encode([
        hexPrefix(first.path.slice(depth, depth + shared), false),
        reference(build(leaves, depth + shared)),
      ]);
    const children: Item[] = [];
    for (let n = 0; n < 16; n++) {
      const under = leaves.filter((l) => l.path[depth] === n);
      children.push(under.length === 0 ? new Uint8Array() : reference(build(under, depth + 1)));
    }
    return encode([...children, new Uint8Array()]);
  };
  const root = build(
    entries.map(([k, value]) => ({ path: nibbles(keccak_256(k)), value })),
    0,
  );
  nodes.push(root);
  return { root: keccak_256(root), nodes };
}

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
export const stored = (w: Uint8Array) => rlp(w.subarray(w.findIndex((x) => x !== 0)));

/**
 * An L1 state whose only account is the anchor at `anchor`, its storage
 * holding `storage` (slot, RLP of the stored word), and the header of a block
 * numbered `number` at `timestamp` over it: the header's bytes and every
 * trie node `eth_getProof` could return.
 */
export function anchorState(
  anchor: Uint8Array,
  storage: readonly (readonly [Uint8Array, Uint8Array])[],
  block: { readonly number: bigint; readonly timestamp: bigint },
) {
  const storageTrie = buildTrie(storage);
  const account = rlp([uint(1n), uint(0n), storageTrie.root, keccak_256(Uint8Array.of(0xfe))]);
  const stateTrie = buildTrie([[anchor, account]]);
  const z = (n: number) => new Uint8Array(n);
  const header = rlp([
    z(32),
    z(32),
    z(20),
    stateTrie.root,
    z(32),
    z(32),
    z(256),
    uint(0n),
    uint(block.number),
    uint(0n),
    uint(0n),
    uint(block.timestamp),
    new Uint8Array(),
    z(32),
    z(8),
  ]);
  return { header, nodes: [...stateTrie.nodes, ...storageTrie.nodes] };
}

/**
 * The `l1` member of a format-2 to 5 bundle whose anchor at `anchor` holds a
 * checkpoint after every segment of `entries` and after the seal, proven at
 * an L1 block numbered `number` at `timestamp`.
 */
export function anchoredL1(
  electionId: Uint8Array,
  anchor: Uint8Array,
  entries: readonly Uint8Array[],
  version: BoardEntryVersion,
  clock: AnchorClock,
  block: { readonly number: bigint; readonly timestamp: bigint },
) {
  const segments = [
    ...new Set([...entries.map((e) => decodeBoardEntry(e, version).segment), clock.lastSegment]),
  ].sort((a, b) => a - b);
  const checkpoints = copyCheckpoints(electionId, entries, segments);
  const storage: [Uint8Array, Uint8Array][] = segments.map((s) => {
    const c = checkpoints.get(s);
    if (c === undefined) throw new Error(`anchoredL1: no checkpoint after segment ${s}`);
    return [checkpointSlot(electionId, s), stored(checkpointHash(c))];
  });
  storage.push([lowestSegmentSlot(electionId), stored(word(BigInt(segments[0] as number) + 1n))]);
  const storageTrie = buildTrie(storage);
  const account = rlp([uint(1n), uint(0n), storageTrie.root, keccak_256(Uint8Array.of(0xfe))]);
  const stateTrie = buildTrie([[anchor, account]]);
  const z = (n: number) => new Uint8Array(n);
  const header = rlp([
    z(32),
    z(32),
    z(20),
    stateTrie.root,
    z(32),
    z(32),
    z(256),
    uint(0n),
    uint(block.number),
    uint(0n),
    uint(0n),
    uint(block.timestamp),
    new Uint8Array(),
    z(32),
    z(8),
  ]);
  return {
    firstSegment: "0",
    header: toHex(header),
    nodes: [...stateTrie.nodes, ...storageTrie.nodes].map(toHex),
    checkpoints: [],
  };
}
