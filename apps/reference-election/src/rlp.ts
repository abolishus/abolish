// Recursive-length prefix encoding (Ethereum Yellow Paper, Appendix B), only
// as far as the fixture needs it: rebuilding an L1 block header from the JSON
// an RPC node returns, so the verifier gets the header's own bytes. The
// fixture checks the result against the node's block hash, so a field encoded
// wrongly here stops the run instead of reaching the verifier.

export type RlpItem = Uint8Array | readonly RlpItem[];

function lengthPrefix(length: number, offset: number): Uint8Array {
  if (length < 56) return Uint8Array.of(offset + length);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return Uint8Array.of(offset + 55 + bytes.length, ...bytes);
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
    return concat([lengthPrefix(item.length, 0x80), item]);
  }
  const body = concat(item.map(encodeRlp));
  return concat([lengthPrefix(body.length, 0xc0), body]);
}

/** A non-negative integer as RLP wants it: big-endian with no leading zero bytes, so 0 is empty. */
export function uintBytes(n: bigint): Uint8Array {
  if (n < 0n) throw new RangeError("uintBytes: negative");
  const bytes: number[] = [];
  for (let x = n; x > 0n; x >>= 8n) bytes.unshift(Number(x & 0xffn));
  return Uint8Array.from(bytes);
}
