import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import {
  encodeQr,
  qrAlignmentPositions,
  qrCodewords,
  qrDataCapacity,
  qrFormatBits,
  qrPenalty,
  qrVersionBits,
  type QrLevel,
  type QrSymbol,
} from "../src/lib/qr.ts";
import { ALIGNMENT, EC_TABLE, FORMAT_STRINGS, VERSION_STRINGS } from "./qr-reference.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const LEVELS: readonly QrLevel[] = ["L", "M", "Q", "H"];
const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
/** Bytes from the published lists, one list per block or part. */
const bytes = (...parts: number[][]) => Uint8Array.from(parts.flat());
const hex = (s: string) => Uint8Array.from(s.split(" "), (h) => Number.parseInt(h, 16));
const bitString = (value: number, length: number) => value.toString(2).padStart(length, "0");

// ---------------------------------------------------------------------------
// A reader written from the standard's figures, sharing no code with the
// encoder: it finds the function patterns, reads both format copies, walks
// the data modules, unmasks them, de-interleaves the blocks by the published
// table, checks each block's Reed–Solomon syndromes and parses the segment.
// ---------------------------------------------------------------------------

/** GF(256) multiplication by shift-and-add, reduced by x^8 + x^4 + x^3 + x^2 + 1. */
function gfMul(a: number, b: number): number {
  let product = 0;
  for (; b > 0; b >>= 1) {
    if (b & 1) product ^= a;
    a <<= 1;
    if (a & 0x100) a ^= 0x11d;
  }
  return product;
}

/** Whether c(αⁱ) = 0 for i < ecc: a codeword of the code whose generator has roots α⁰…α^(ecc−1). */
function syndromesVanish(block: readonly number[], ecc: number): boolean {
  for (let i = 0, alpha = 1; i < ecc; i++, alpha = gfMul(alpha, 2)) {
    let value = 0;
    for (const c of block) value = gfMul(value, alpha) ^ c;
    if (value !== 0) return false;
  }
  return true;
}

/** The remainder of a bit string's polynomial by `generator` (binary BCH). */
function bchRemainder(bits: number, length: number, generator: number, degree: number): number {
  let rem = bits;
  for (let i = length - 1; i >= degree; i--) if ((rem >>> i) & 1) rem ^= generator << (i - degree);
  return rem;
}

/** Table 10, with i the row and j the column. */
const MASKS: readonly ((i: number, j: number) => boolean)[] = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (_, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
];

const centresCache = new Map<number, [number, number][]>();

/** Alignment pattern centres that don't overlap a finder. */
function alignmentCentres(version: number): [number, number][] {
  const known = centresCache.get(version);
  if (known !== undefined) return known;
  const coords = ALIGNMENT[version] ?? [];
  const n = 4 * version + 17;
  const centres: [number, number][] = [];
  for (const r of coords)
    for (const c of coords) {
      const onFinder = (r < 9 && c < 9) || (r < 9 && c > n - 10) || (r > n - 10 && c < 9);
      if (!onFinder) centres.push([r, c]);
    }
  centresCache.set(version, centres);
  return centres;
}

/** Whether module (r, c) of a symbol of `version` belongs to a function pattern or reserved area. */
function isFunction(version: number, r: number, c: number): boolean {
  const n = 4 * version + 17;
  if (r <= 8 && c <= 8) return true; // finder, separator, format
  if (r <= 8 && c >= n - 8) return true;
  if (r >= n - 8 && c <= 8) return true; // includes the dark module
  if (r === 6 || c === 6) return true;
  if (version >= 7 && ((r < 6 && c >= n - 11 && c < n - 8) || (c < 6 && r >= n - 11 && r < n - 8)))
    return true;
  return alignmentCentres(version).some(
    ([ar, ac]) => Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2,
  );
}

/** The symbol's modules without the quiet zone. */
function inner(symbol: QrSymbol): boolean[][] {
  const q = symbol.quietZone;
  return symbol.modules.slice(q, q + symbol.size).map((row) => row.slice(q, q + symbol.size));
}

/** Both format copies as 15-bit strings, most significant first (Figure 25). */
function readFormat(m: boolean[][]): [string, string] {
  const n = m.length;
  const b = (r: number, c: number) => (m[r]![c] ? "1" : "0");
  let first = "";
  for (const c of [0, 1, 2, 3, 4, 5, 7, 8]) first += b(8, c);
  for (const r of [7, 5, 4, 3, 2, 1, 0]) first += b(r, 8);
  let second = "";
  for (let r = n - 1; r >= n - 7; r--) second += b(r, 8);
  for (let c = n - 8; c < n; c++) second += b(8, c);
  return [first, second];
}

/** Both version copies as 18-bit strings, most significant first (Figure 27). */
function readVersion(m: boolean[][]): [string, string] {
  const n = m.length;
  let below = "";
  let right = "";
  for (let i = 17; i >= 0; i--) {
    const a = Math.floor(i / 3);
    const b = n - 11 + (i % 3);
    below += m[b]![a] ? "1" : "0";
    right += m[a]![b] ? "1" : "0";
  }
  return [below, right];
}

/** The codewords, read in the placement order of 7.7.3 and unmasked. */
function readCodewords(m: boolean[][], version: number, mask: number): number[] {
  const n = m.length;
  const bits: number[] = [];
  let upward = true;
  for (let right = n - 1; right > 0; right -= 2) {
    if (right === 6) right--;
    for (let k = 0; k < n; k++) {
      const r = upward ? n - 1 - k : k;
      for (const c of [right, right - 1]) {
        if (isFunction(version, r, c)) continue;
        bits.push(Number(m[r]![c]) ^ Number(MASKS[mask]!(r, c)));
      }
    }
    upward = !upward;
  }
  const codewords: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    codewords.push(bits.slice(i, i + 8).reduce((v, bit) => (v << 1) | bit, 0));
  return codewords;
}

/** De-interleaved blocks per the published table, each data then error correction. */
function deinterleave(codewords: readonly number[], version: number, level: QrLevel) {
  const [, ecc, b1, d1, b2 = 0, d2 = 0] = EC_TABLE[`${version}-${level}`]!;
  const sizes = [...Array<number>(b1!).fill(d1!), ...Array<number>(b2).fill(d2)];
  const blocks = sizes.map(() => [] as number[]);
  let k = 0;
  for (let i = 0; i < Math.max(...sizes); i++)
    sizes.forEach((size, b) => {
      if (i < size) blocks[b]!.push(codewords[k++]!);
    });
  for (let i = 0; i < ecc!; i++) for (const block of blocks) block.push(codewords[k++]!);
  return { blocks, sizes, ecc: ecc!, used: k };
}

/** Parses one segment of data codewords back into text. */
function parseSegment(data: readonly number[], version: number): string {
  const bits = data.flatMap((byte) => bitString(byte, 8).split("").map(Number));
  let at = 0;
  const take = (length: number) => {
    let v = 0;
    for (let i = 0; i < length; i++) v = (v << 1) | bits[at++]!;
    return v;
  };
  const band = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  const mode = take(4);
  if (mode === 0b0001) {
    const count = take([10, 12, 14][band]!);
    let out = "";
    for (let left = count; left > 0; left -= 3)
      out += String(take(left >= 3 ? 10 : left === 2 ? 7 : 4)).padStart(Math.min(left, 3), "0");
    return out;
  }
  if (mode === 0b0010) {
    const count = take([9, 11, 13][band]!);
    let out = "";
    for (let left = count; left > 0; left -= 2) {
      if (left >= 2) {
        const v = take(11);
        out += ALPHANUMERIC[Math.floor(v / 45)]! + ALPHANUMERIC[v % 45]!;
      } else out += ALPHANUMERIC[take(6)]!;
    }
    return out;
  }
  if (mode === 0b0100) {
    const count = take([8, 16, 16][band]!);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Uint8Array.from({ length: count }, () => take(8)),
    );
  }
  throw new Error(`unexpected mode ${mode}`);
}

/** Everything the reader can check about a symbol, then the text it decodes to. */
function decode(symbol: QrSymbol): string {
  const { version, level, mask, size, quietZone, modules } = symbol;
  const n = 4 * version + 17;
  expect(size).toBe(n);
  expect(modules).toHaveLength(n + 2 * quietZone);
  for (const row of modules) expect(row).toHaveLength(n + 2 * quietZone);
  // Quiet zone: all light.
  const quiet = modules.flatMap((row, r) =>
    row.filter(
      (_, c) => r < quietZone || c < quietZone || r >= quietZone + n || c >= quietZone + n,
    ),
  );
  expect(quiet.includes(true)).toBe(false);
  const m = inner(symbol);

  const wrong: [string, number, number][] = [];
  // Finders (dark 7×7 ring, light ring, dark 3×3 core) and light separators.
  for (const [top, left] of [
    [0, 0],
    [0, n - 7],
    [n - 7, 0],
  ] as const) {
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const rr = top + r;
        const cc = left + c;
        if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        if (m[rr]![cc] !== (ring === 0 || ring === 1 || ring === 3)) wrong.push(["finder", rr, cc]);
      }
  }
  // Timing patterns between the finders.
  for (let i = 8; i < n - 8; i++) {
    if (m[6]![i] !== (i % 2 === 0)) wrong.push(["timing", 6, i]);
    if (m[i]![6] !== (i % 2 === 0)) wrong.push(["timing", i, 6]);
  }
  // Alignment patterns at the published centres.
  for (const [ar, ac] of alignmentCentres(version))
    for (let r = -2; r <= 2; r++)
      for (let c = -2; c <= 2; c++)
        if (m[ar + r]![ac + c] !== (Math.max(Math.abs(r), Math.abs(c)) !== 1))
          wrong.push(["alignment", ar + r, ac + c]);
  // The dark module.
  if (!m[n - 8]![8]) wrong.push(["dark module", n - 8, 8]);
  expect(wrong).toEqual([]);

  // Format: both copies equal the published string for this level and mask,
  // and decode by BCH to them.
  const [first, second] = readFormat(m);
  expect(first).toBe(FORMAT_STRINGS[level]![mask]);
  expect(second).toBe(first);
  const unmasked = Number.parseInt(first, 2) ^ 0b101010000010010;
  expect(bchRemainder(unmasked, 15, 0b10100110111, 10)).toBe(0);
  expect(unmasked >>> 10).toBe(({ L: 0b01, M: 0b00, Q: 0b11, H: 0b10 } as const)[level] * 8 + mask);

  if (version >= 7) {
    const [below, right] = readVersion(m);
    expect(right).toBe(below);
    if (VERSION_STRINGS[version] !== undefined) expect(below).toBe(VERSION_STRINGS[version]);
    expect(bchRemainder(Number.parseInt(below, 2), 18, 0b1111100100101, 12)).toBe(0);
    expect(Number.parseInt(below, 2) >>> 12).toBe(version);
  }

  const [totalData] = EC_TABLE[`${version}-${level}`]!;
  const codewords = readCodewords(m, version, mask);
  const { blocks, sizes, ecc, used } = deinterleave(codewords, version, level);
  // Every codeword module is used; fewer than 8 remainder bits are left over.
  expect(codewords.length).toBe(used);
  expect(sizes.reduce((a, b) => a + b, 0)).toBe(totalData);
  for (const block of blocks) expect(syndromesVanish(block, ecc)).toBe(true);
  expect(Uint8Array.from(codewords)).toEqual(symbol.codewords);
  return parseSegment(
    blocks.flatMap((block, b) => block.slice(0, sizes[b])),
    version,
  );
}

// ---------------------------------------------------------------------------

describe("published vectors", () => {
  // Thonky, error-correction-coding: "HELLO WORLD" at 1-M.
  it("encodes HELLO WORLD at 1-M to the tutorial's codewords", () => {
    const symbol = encodeQr("HELLO WORLD", { level: "M" });
    expect([symbol.version, symbol.mode]).toEqual([1, "alphanumeric"]);
    expect(symbol.codewords).toEqual(
      bytes(
        [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17],
        [196, 35, 39, 119, 235, 215, 231, 226, 93, 23],
      ),
    );
  });

  // Thonky, data-encoding: the 13 data codewords of "HELLO WORLD" at 1-Q.
  it("encodes HELLO WORLD at 1-Q to the tutorial's data codewords", () => {
    const symbol = encodeQr("HELLO WORLD", { level: "Q" });
    expect(symbol.version).toBe(1);
    expect(symbol.codewords.subarray(0, 13)).toEqual(
      bytes([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236]),
    );
    expect(decode(symbol)).toBe("HELLO WORLD");
  });

  // Wikiversity, "Reed–Solomon codes for coders": the 1-M byte-mode symbol
  // read back, and its unmasked format bits 000111101011001 (M, mask 3).
  it("encodes 'Twas brillig at 1-M to the article's codewords and format", () => {
    const symbol = encodeQr("'Twas brillig", { level: "M", mask: 3 });
    expect([symbol.version, symbol.mode]).toEqual([1, "byte"]);
    expect(symbol.codewords).toEqual(
      hex("40 d2 75 47 76 17 32 06 27 26 96 c6 c6 96 70 ec bc 2a 90 13 6b af ef fd 4b e0"),
    );
    expect(bitString(qrFormatBits("M", 3) ^ 0b101010000010010, 15)).toBe("000111101011001");
    expect(decode(symbol)).toBe("'Twas brillig");
  });

  // Thonky, structure-final-message: the four 5-Q blocks interleaved.
  it("splits and interleaves 5-Q as the tutorial does", () => {
    const data = bytes(
      [67, 85, 70, 134, 87, 38, 85, 194, 119, 50, 6, 18, 6, 103, 38],
      [246, 246, 66, 7, 118, 134, 242, 7, 38, 86, 22, 198, 199, 146, 6],
      [182, 230, 247, 119, 50, 7, 118, 134, 87, 38, 82, 6, 134, 151, 50, 7],
      [70, 247, 118, 86, 194, 6, 151, 50, 224, 236, 17, 236, 17, 236, 17, 236],
    );
    // prettier-ignore
    const final = [
      67, 246, 182, 70, 85, 246, 230, 247, 70, 66, 247, 118, 134, 7, 119, 86, 87, 118, 50, 194, 38, 134, 7, 6, 85, 242, 118, 151, 194, 7, 134, 50, 119, 38, 87, 224, 50, 86, 38, 236, 6, 22, 82, 17, 18, 198, 6, 236, 6, 199, 134, 17, 103, 146, 151, 236, 38, 6, 50, 17, 7, 236,
      213, 87, 148, 140, 199, 204, 116, 100, 11, 96, 177, 250, 45, 60, 212, 247, 115, 202, 76, 108, 247, 182, 133, 131, 241, 124, 75, 37, 223, 157, 242, 104, 229, 200, 238, 253, 248, 134, 76, 113, 154, 27, 195, 111, 117, 129, 230, 235, 154, 209, 189, 197, 111, 17, 10, 83, 86, 163, 108, 6, 161, 163, 240, 205, 111, 120, 192, 89, 39, 133, 141, 74,
    ];
    expect([...qrCodewords(data, 5, "Q")]).toEqual(final);
  });

  // ISO/IEC 18004's worked example, "01234567" at 1-M, as widely quoted; the
  // standard's own text wasn't available to check it against.
  it("encodes the standard's 01234567 example at 1-M", () => {
    const symbol = encodeQr("01234567", { level: "M" });
    expect([symbol.version, symbol.mode]).toEqual([1, "numeric"]);
    expect(symbol.codewords).toEqual(
      hex("10 20 0c 56 61 80 ec 11 ec 11 ec 11 ec 11 ec 11 a5 24 d4 c1 ed 36 c7 87 2c 55"),
    );
    expect(decode(symbol)).toBe("01234567");
  });

  it("produces all 32 published format strings", () => {
    for (const level of LEVELS)
      for (let mask = 0; mask < 8; mask++)
        expect(bitString(qrFormatBits(level, mask), 15)).toBe(FORMAT_STRINGS[level]![mask]);
  });

  it("produces the published version strings 7 to 10", () => {
    for (const [version, bits] of Object.entries(VERSION_STRINGS))
      expect(bitString(qrVersionBits(Number(version)), 18)).toBe(bits);
  });

  it("matches the published alignment positions and data capacities, versions 1 to 40", () => {
    for (let version = 1; version <= 40; version++) {
      expect(qrAlignmentPositions(version)).toEqual(ALIGNMENT[version] ?? []);
      for (const level of LEVELS)
        expect(qrDataCapacity(version, level)).toBe(EC_TABLE[`${version}-${level}`]![0]);
    }
  });

  // The design's short link: 28 alphanumeric characters fit version 2 (sharing.md).
  it("fits the upper-cased short link in version 2", () => {
    for (const level of ["M", "Q"] as const) {
      const symbol = encodeQr("HTTPS://ABOLISH.US/P/3J55DW1", { level });
      expect([symbol.version, symbol.mode]).toEqual([2, "alphanumeric"]);
      expect(decode(symbol)).toBe("HTTPS://ABOLISH.US/P/3J55DW1");
    }
  });
});

describe("encodeQr", () => {
  const level = fc.constantFrom(...LEVELS);
  const text = fc.oneof(
    fc.string({ unit: fc.constantFrom(...ALPHANUMERIC.split("")), maxLength: 120 }),
    fc.string({ unit: fc.constantFrom(..."0123456789".split("")), maxLength: 160 }),
    fc.string({ unit: "grapheme", maxLength: 40 }),
    fc.string({ unit: "binary-ascii", maxLength: 80 }),
  );

  it("reads back, by an independent reader, at every level and version", () => {
    fc.assert(
      fc.property(text, level, fc.integer({ min: 1, max: 40 }), (value, lvl, minVersion) => {
        const symbol = encodeQr(value, { level: lvl, minVersion });
        expect(symbol.version).toBeGreaterThanOrEqual(minVersion);
        expect(decode(symbol)).toBe(value);
      }),
      { numRuns },
    );
  }, 120_000);

  it("reads back under every mask", () => {
    fc.assert(
      fc.property(text, level, fc.integer({ min: 0, max: 7 }), (value, lvl, mask) => {
        const symbol = encodeQr(value, { level: lvl, mask });
        expect(symbol.mask).toBe(mask);
        expect(decode(symbol)).toBe(value);
      }),
      { numRuns },
    );
  });

  it("chooses the smallest version and mode that hold the text", () => {
    fc.assert(
      fc.property(text, level, (value, lvl) => {
        const symbol = encodeQr(value, { level: lvl });
        const mode = /^[0-9]*$/.test(value)
          ? "numeric"
          : /^[0-9A-Z $%*+\-./:]*$/.test(value)
            ? "alphanumeric"
            : "byte";
        expect(symbol.mode).toBe(mode);
        if (symbol.version > 1)
          expect(() => encodeQr(value, { level: lvl, maxVersion: symbol.version - 1 })).toThrow(
            RangeError,
          );
      }),
      { numRuns },
    );
  });

  it("chooses the mask with the lowest penalty", () => {
    fc.assert(
      fc.property(text, level, (value, lvl) => {
        const chosen = encodeQr(value, { level: lvl });
        const penalties = Array.from({ length: 8 }, (_, mask) =>
          qrPenalty(inner(encodeQr(value, { level: lvl, mask }))),
        );
        expect(penalties[chosen.mask]).toBe(Math.min(...penalties));
        expect(penalties.indexOf(Math.min(...penalties))).toBe(chosen.mask);
      }),
      { numRuns: Math.max(1, Math.floor(numRuns / 10)) },
    );
  });

  it("is deterministic", () => {
    fc.assert(
      fc.property(text, level, (value, lvl) => {
        expect(encodeQr(value, { level: lvl })).toEqual(encodeQr(value, { level: lvl }));
      }),
      { numRuns },
    );
  });

  it("says plainly when the text doesn't fit", () => {
    expect(() => encodeQr("x".repeat(2954), { level: "L" })).toThrow(/don't fit/);
    expect(() => encodeQr("HELLO WORLD", { level: "H", maxVersion: 1 })).toThrow(RangeError);
    expect(() => encodeQr("1", { minVersion: 41 })).toThrow(RangeError);
    expect(() => encodeQr("1", { mask: 8 })).toThrow(RangeError);
  });

  it("holds the largest published capacities exactly", () => {
    expect(encodeQr("x".repeat(2953), { level: "L" }).version).toBe(40);
    expect(encodeQr("A".repeat(4296), { level: "L" }).version).toBe(40);
    expect(encodeQr("7".repeat(7089), { level: "L" }).version).toBe(40);
    expect(() => encodeQr("7".repeat(7090), { level: "L" })).toThrow(RangeError);
  });
});
