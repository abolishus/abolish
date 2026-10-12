import fc from "fast-check";
import { expect, test } from "vite-plus/test";
import { encodeRlp, type RlpItem, uintBytes } from "../src/rlp.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (s: string) => new TextEncoder().encode(s);

// The examples of the Ethereum wiki's RLP page
// (https://ethereum.org/developers/docs/data-structures-and-encoding/rlp/#examples).
test("published examples", () => {
  expect(hex(encodeRlp(bytes("dog")))).toBe("83646f67");
  expect(hex(encodeRlp([bytes("cat"), bytes("dog")]))).toBe("c88363617483646f67");
  expect(hex(encodeRlp(new Uint8Array()))).toBe("80");
  expect(hex(encodeRlp([]))).toBe("c0");
  expect(hex(encodeRlp(uintBytes(0n)))).toBe("80");
  expect(hex(encodeRlp(Uint8Array.of(0)))).toBe("00");
  expect(hex(encodeRlp(uintBytes(15n)))).toBe("0f");
  expect(hex(encodeRlp(uintBytes(1024n)))).toBe("820400");
  expect(hex(encodeRlp([[], [[]], [[], [[]]]]))).toBe("c7c0c1c0c3c0c1c0");
  const lorem = bytes("Lorem ipsum dolor sit amet, consectetur adipisicing elit");
  expect(hex(encodeRlp(lorem))).toBe(`b838${hex(lorem)}`);
});

test("uintBytes is minimal big-endian and refuses negatives", () => {
  expect(hex(uintBytes(0x0100n))).toBe("0100");
  expect(hex(uintBytes(2n ** 64n - 1n))).toBe("ffffffffffffffff");
  expect(() => uintBytes(-1n)).toThrow(RangeError);
});

// An independent decoder, only for the round trip: it reads the prefix
// rules from the Yellow Paper, Appendix B, and rejects non-canonical forms.
function decode(b: Uint8Array, at = 0): [RlpItem, number] {
  const p = b[at] as number;
  const long = (offset: number) => {
    const n = p - offset;
    let len = 0;
    for (let i = 1; i <= n; i++) len = len * 256 + (b[at + i] as number);
    expect(b[at + 1]).not.toBe(0);
    expect(len).toBeGreaterThanOrEqual(56);
    return [at + 1 + n, len] as const;
  };
  if (p < 0x80) return [b.slice(at, at + 1), at + 1];
  if (p < 0xc0) {
    const [start, len] = p <= 0xb7 ? [at + 1, p - 0x80] : long(0xb7);
    const out = b.slice(start, start + len);
    if (len === 1) expect(out[0]).toBeGreaterThanOrEqual(0x80);
    return [out, start + len];
  }
  const [start, len] = p <= 0xf7 ? [at + 1, p - 0xc0] : long(0xf7);
  const items: RlpItem[] = [];
  let i = start;
  while (i < start + len) {
    const [item, next] = decode(b, i);
    items.push(item);
    i = next;
  }
  expect(i).toBe(start + len);
  return [items, i];
}

const item: fc.Arbitrary<RlpItem> = fc.letrec<{ item: RlpItem }>((tie) => ({
  item: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.uint8Array({ maxLength: 300 }),
    fc.array(tie("item"), { maxLength: 4 }),
  ),
})).item;

test("every item round-trips through a canonical encoding", () => {
  fc.assert(
    fc.property(item, (x) => {
      const encoded = encodeRlp(x);
      const [back, end] = decode(encoded);
      expect(end).toBe(encoded.length);
      expect(back).toEqual(x);
    }),
    { numRuns },
  );
});
