import { keccak_256 } from "@noble/hashes/sha3.js";

// Execution-layer headers for tests, encoded by a reference RLP encoder
// written from the Yellow Paper's Appendix B (as l1.test.ts's), so a run's
// hashes and parent links never come from the code under test.

type Item = Uint8Array | Item[];

function lengthPrefix(n: number, short: number): Uint8Array {
  if (n < 56) return Uint8Array.of(short + n);
  const len: number[] = [];
  for (let x = n; x > 0; x = Math.floor(x / 256)) len.unshift(x % 256);
  return Uint8Array.of(short + 55 + len.length, ...len);
}

export function rlp(x: Item): Uint8Array {
  if (x instanceof Uint8Array) {
    if (x.length === 1 && (x[0] as number) < 0x80) return x.slice();
    return Uint8Array.from([...lengthPrefix(x.length, 0x80), ...x]);
  }
  const body = x.flatMap((i) => [...rlp(i)]);
  return Uint8Array.from([...lengthPrefix(body.length, 0xc0), ...body]);
}

/** A minimal big-endian integer, as RLP encodes one (0 is empty). */
function uint(n: bigint): Uint8Array {
  const out: number[] = [];
  for (let x = n; x > 0n; x >>= 8n) out.unshift(Number(x & 0xffn));
  return Uint8Array.from(out);
}

export const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export interface TestHeader {
  readonly encoded: Uint8Array;
  readonly hash: Uint8Array;
  readonly number: bigint;
  readonly timestamp: bigint;
}

/** One header with the 15 fields every fork has; only the parent, number and time vary. */
export function header(parentHash: Uint8Array, number: bigint, timestamp: bigint): TestHeader {
  const z = (n: number) => new Uint8Array(n);
  const encoded = rlp([
    parentHash,
    z(32),
    z(20),
    z(32),
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
  ]);
  return { encoded, hash: keccak_256(encoded), number, timestamp };
}

/** A linked run from `first`, one header per timestamp; the first's parent is arbitrary. */
export function run(first: bigint, timestamps: readonly bigint[], parent = new Uint8Array(32)) {
  const out: TestHeader[] = [];
  for (const [i, t] of timestamps.entries()) {
    const h = header(out[i - 1]?.hash ?? parent, first + BigInt(i), t);
    out.push(h);
  }
  return out;
}
