// A QR Code encoder (ISO/IEC 18004), written from the standard with no
// dependency so the ballot client can draw a poll's link without new runtime
// code in its bundle. One segment in the smallest mode that holds the text
// (numeric, alphanumeric or UTF-8 bytes), any version 1–40, levels L/M/Q/H,
// and the mask with the lowest penalty under the standard's four rules.

export type QrLevel = "L" | "M" | "Q" | "H";
export type QrMode = "numeric" | "alphanumeric" | "byte";

export const QR_MIN_VERSION = 1;
export const QR_MAX_VERSION = 40;

/** Quiet zone the standard requires around a symbol, in modules. */
export const QR_QUIET_ZONE = 4;

export interface QrOptions {
  /** Error correction: M on screens, Q on print (docs/design/sharing.md). Default M. */
  readonly level?: QrLevel;
  /** Smallest version to use; the smallest that fits at or above it is chosen. Default 1. */
  readonly minVersion?: number;
  /** Largest version allowed. Default 40. */
  readonly maxVersion?: number;
  /** A fixed mask (0–7) instead of the lowest-penalty one. */
  readonly mask?: number;
  /** Light modules around the symbol. Default 4. */
  readonly quietZone?: number;
}

export interface QrSymbol {
  readonly version: number;
  readonly level: QrLevel;
  readonly mask: number;
  readonly mode: QrMode;
  /** Modules per side of the symbol itself, `4 × version + 17`. */
  readonly size: number;
  readonly quietZone: number;
  /** The final message: data and error correction codewords, interleaved. */
  readonly codewords: Uint8Array;
  /** Row by row, `true` for a dark module, quiet zone included. */
  readonly modules: boolean[][];
}

// The format information's two-bit level indicator (Table 12).
const LEVEL_BITS: Readonly<Record<QrLevel, number>> = { L: 1, M: 0, Q: 3, H: 2 };
const LEVEL_ROW: Readonly<Record<QrLevel, number>> = { L: 0, M: 1, Q: 2, H: 3 };

// Table 9: error correction codewords per block, and blocks, by level and
// version (index 0 unused).
// prettier-ignore
const ECC_PER_BLOCK: readonly (readonly number[])[] = [
  [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
// prettier-ignore
const BLOCKS: readonly (readonly number[])[] = [
  [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

function checkVersion(version: number) {
  if (!Number.isInteger(version) || version < QR_MIN_VERSION || version > QR_MAX_VERSION)
    throw new RangeError(`a QR version is an integer from 1 to 40, not ${version}`);
}

/** Modules per side of a symbol of `version`. */
export function qrSize(version: number): number {
  checkVersion(version);
  return version * 4 + 17;
}

/** Alignment pattern centres, on both axes (Annex E): evenly spaced from the far edge back to 6. */
export function qrAlignmentPositions(version: number): number[] {
  checkVersion(version);
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let pos = qrSize(version) - 7; positions.length < count; pos -= step)
    positions.splice(1, 0, pos);
  return positions;
}

/** Modules left for codewords once the function patterns are drawn. */
function rawDataModules(version: number): number {
  let modules = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    modules -= (25 * align - 10) * align - 55;
    if (version >= 7) modules -= 36;
  }
  return modules;
}

/** How the codewords of `version` at `level` split into blocks. */
export function qrBlocks(version: number, level: QrLevel) {
  checkVersion(version);
  const row = LEVEL_ROW[level];
  const blocks = BLOCKS[row]![version]!;
  const ecc = ECC_PER_BLOCK[row]![version]!;
  const total = Math.floor(rawDataModules(version) / 8);
  const short = blocks - (total % blocks);
  const shortData = Math.floor(total / blocks) - ecc;
  return { total, blocks, ecc, short, shortData, data: total - blocks * ecc };
}

/** Data codewords a symbol of `version` at `level` holds. */
export function qrDataCapacity(version: number, level: QrLevel): number {
  return qrBlocks(version, level).data;
}

// GF(256) over x^8 + x^4 + x^3 + x^2 + 1 (0x11d), the field of the standard's
// Reed–Solomon code, with α = 2.
const EXP = new Uint8Array(510);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  EXP[i + 255] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}

const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

const generators = new Map<number, Uint8Array>();

/** ∏ (x − αⁱ) for i < degree, highest power first, its leading 1 left out. */
function generator(degree: number): Uint8Array {
  const known = generators.get(degree);
  if (known !== undefined) return known;
  const poly = new Uint8Array(degree);
  poly[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      poly[j] = mul(poly[j]!, root) ^ (j + 1 < degree ? poly[j + 1]! : 0);
    }
    root = mul(root, 2);
  }
  generators.set(degree, poly);
  return poly;
}

/** The error correction codewords for one block: the remainder of data · x^degree by the generator. */
export function reedSolomon(data: Uint8Array, degree: number): Uint8Array {
  const gen = generator(degree);
  const rem = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ rem[0]!;
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    for (let i = 0; i < degree; i++) rem[i]! ^= mul(gen[i]!, factor);
  }
  return rem;
}

/**
 * The final message for `data` (exactly the version's data codewords): split
 * into blocks, shorter ones first, each given its error correction, then
 * interleaved codeword by codeword, data before error correction.
 */
export function qrCodewords(data: Uint8Array, version: number, level: QrLevel): Uint8Array {
  const { total, blocks, ecc, short, shortData, data: capacity } = qrBlocks(version, level);
  if (data.length !== capacity)
    throw new RangeError(`version ${version}-${level} takes ${capacity} data codewords`);
  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];
  for (let b = 0, at = 0; b < blocks; b++) {
    const length = shortData + (b < short ? 0 : 1);
    const block = data.subarray(at, at + length);
    at += length;
    dataBlocks.push(block);
    eccBlocks.push(reedSolomon(block, ecc));
  }
  const out = new Uint8Array(total);
  let k = 0;
  for (let i = 0; i <= shortData; i++)
    for (const block of dataBlocks) if (i < block.length) out[k++] = block[i]!;
  for (let i = 0; i < ecc; i++) for (const block of eccBlocks) out[k++] = block[i]!;
  return out;
}

/** The 15 format bits for `level` and `mask`, BCH-coded and XORed with 101010000010010. */
export function qrFormatBits(level: QrLevel, mask: number): number {
  const data = (LEVEL_BITS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** The 18 version bits (version 7 and up), BCH-coded with generator 0x1f25. */
export function qrVersionBits(version: number): number {
  checkVersion(version);
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

/** Appends bits most significant first. */
class Bits {
  readonly bits: number[] = [];
  push(value: number, length: number) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

function modeOf(text: string): QrMode {
  if (/^[0-9]*$/.test(text)) return "numeric";
  if (/^[0-9A-Z $%*+\-./:]*$/.test(text)) return "alphanumeric";
  return "byte";
}

const MODE_INDICATOR: Readonly<Record<QrMode, number>> = {
  numeric: 0b0001,
  alphanumeric: 0b0010,
  byte: 0b0100,
};

/** Bits in the character count indicator (Table 3). */
function countBits(mode: QrMode, version: number): number {
  const band = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  return { numeric: [10, 12, 14], alphanumeric: [9, 11, 13], byte: [8, 16, 16] }[mode][band]!;
}

/** The segment's payload, without mode or count. */
function payload(text: string, mode: QrMode): { bits: Bits; count: number } {
  const bits = new Bits();
  if (mode === "numeric") {
    for (let i = 0; i < text.length; i += 3) {
      const group = text.slice(i, i + 3);
      bits.push(Number(group), group.length * 3 + 1);
    }
    return { bits, count: text.length };
  }
  if (mode === "alphanumeric") {
    for (let i = 0; i < text.length; i += 2) {
      const a = ALPHANUMERIC.indexOf(text[i]!);
      if (i + 1 < text.length) bits.push(a * 45 + ALPHANUMERIC.indexOf(text[i + 1]!), 11);
      else bits.push(a, 6);
    }
    return { bits, count: text.length };
  }
  const bytes = new TextEncoder().encode(text);
  for (const b of bytes) bits.push(b, 8);
  return { bits, count: bytes.length };
}

/** The data codewords: mode, count, payload, terminator, then 0xec 0x11 padding. */
function dataCodewords(mode: QrMode, count: number, body: Bits, version: number, level: QrLevel) {
  const capacity = qrDataCapacity(version, level) * 8;
  const bits = new Bits();
  bits.push(MODE_INDICATOR[mode], 4);
  bits.push(count, countBits(mode, version));
  bits.bits.push(...body.bits);
  bits.push(0, Math.min(4, capacity - bits.bits.length));
  bits.push(0, (8 - (bits.bits.length % 8)) % 8);
  for (let pad = 0xec; bits.bits.length < capacity; pad ^= 0xec ^ 0x11) bits.push(pad, 8);
  const out = new Uint8Array(capacity / 8);
  bits.bits.forEach((bit, i) => (out[i >>> 3]! |= bit << (7 - (i & 7))));
  return out;
}

/** Whether the mask inverts the module at row `y`, column `x` (Table 10). */
function masked(mask: number, y: number, x: number): boolean {
  switch (mask) {
    case 0:
      return (y + x) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (y + x) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((y * x) % 2) + ((y * x) % 3) === 0;
    case 6:
      return (((y * x) % 2) + ((y * x) % 3)) % 2 === 0;
    case 7:
      return (((y + x) % 2) + ((y * x) % 3)) % 2 === 0;
    default:
      throw new RangeError(`a mask is 0 to 7, not ${mask}`);
  }
}

class Matrix {
  readonly size: number;
  readonly dark: boolean[][];
  readonly fixed: boolean[][];
  constructor(size: number) {
    this.size = size;
    this.dark = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
    this.fixed = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  }
  set(y: number, x: number, dark: boolean) {
    this.dark[y]![x] = dark;
    this.fixed[y]![x] = true;
  }
}

function drawFunctionPatterns(m: Matrix, version: number) {
  const n = m.size;
  for (let i = 0; i < n; i++) {
    m.set(6, i, i % 2 === 0);
    m.set(i, 6, i % 2 === 0);
  }
  // Finders with their separators: rings at distance 0–1 and 3 dark, 2 and 4 light.
  for (const [cy, cx] of [
    [3, 3],
    [3, n - 4],
    [n - 4, 3],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const y = cy + dy;
        const x = cx + dx;
        if (y < 0 || y >= n || x < 0 || x >= n) continue;
        const ring = Math.max(Math.abs(dy), Math.abs(dx));
        m.set(y, x, ring !== 2 && ring !== 4);
      }
    }
  }
  const centres = qrAlignmentPositions(version);
  const last = centres.length - 1;
  centres.forEach((cy, i) =>
    centres.forEach((cx, j) => {
      // Not over the three finders.
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          m.set(cy + dy, cx + dx, Math.max(Math.abs(dy), Math.abs(dx)) !== 1);
    }),
  );
  // Reserve the format areas; drawFormat fills them once the mask is known.
  drawFormat(m, 0);
  if (version >= 7) {
    const bits = qrVersionBits(version);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = n - 11 + (i % 3);
      const b = Math.floor(i / 3);
      m.set(b, a, dark);
      m.set(a, b, dark);
    }
  }
}

/** Both copies of the format bits, most significant first from the top-left corner's edge. */
function drawFormat(m: Matrix, bits: number) {
  const n = m.size;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) m.set(i, 8, bit(i));
  m.set(7, 8, bit(6));
  m.set(8, 8, bit(7));
  m.set(8, 7, bit(8));
  for (let i = 9; i < 15; i++) m.set(8, 14 - i, bit(i));
  for (let i = 0; i < 8; i++) m.set(8, n - 1 - i, bit(i));
  for (let i = 8; i < 15; i++) m.set(n - 15 + i, 8, bit(i));
  // The dark module, always dark.
  m.set(n - 8, 8, true);
}

/** Codewords into the free modules, two columns at a time from the bottom right, up then down. */
function drawCodewords(m: Matrix, codewords: Uint8Array) {
  const n = m.size;
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let v = 0; v < n; v++) {
      const y = upward ? n - 1 - v : v;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (m.fixed[y]![x] || i >= codewords.length * 8) continue;
        m.dark[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }
}

function applyMask(m: Matrix, mask: number) {
  for (let y = 0; y < m.size; y++)
    for (let x = 0; x < m.size; x++)
      if (!m.fixed[y]![x] && masked(mask, y, x)) m.dark[y]![x] = !m.dark[y]![x];
}

/** Penalties for one row or column: N1 runs of five or more, N3 finder-like 1:1:3:1:1 patterns. */
function linePenalty(line: readonly boolean[]): number {
  // Runs, the symbol's edge counting as a wide light run on both sides.
  const runs: { dark: boolean; length: number }[] = [{ dark: false, length: line.length }];
  for (const dark of line) {
    const run = runs.at(-1)!;
    if (run.dark === dark) run.length++;
    else runs.push({ dark, length: 1 });
  }
  const tail = runs.at(-1)!;
  if (tail.dark) runs.push({ dark: false, length: line.length });
  else tail.length += line.length;
  let penalty = 0;
  // The edge runs are padding, not modules of the symbol.
  for (let i = 0; i < runs.length; i++) {
    const length = runs[i]!.length - (i === 0 || i === runs.length - 1 ? line.length : 0);
    if (length >= 5) penalty += 3 + (length - 5);
  }
  for (let i = 1; i + 4 < runs.length; i++) {
    const [d1, l1, d2, l2, d3] = runs.slice(i, i + 5).map((r) => r.length) as [
      number,
      number,
      number,
      number,
      number,
    ];
    if (!runs[i]!.dark || l1 !== d1 || d2 !== 3 * d1 || l2 !== d1 || d3 !== d1) continue;
    if (runs[i - 1]!.length >= 4 * d1) penalty += 40;
    if ((runs[i + 5]?.length ?? 0) >= 4 * d1) penalty += 40;
  }
  return penalty;
}

/** The standard's penalty score for a masked symbol (Table 11). */
export function qrPenalty(dark: readonly (readonly boolean[])[]): number {
  const n = dark.length;
  let penalty = 0;
  for (let y = 0; y < n; y++) penalty += linePenalty(dark[y]!);
  for (let x = 0; x < n; x++) penalty += linePenalty(dark.map((row) => row[x]!));
  for (let y = 0; y + 1 < n; y++)
    for (let x = 0; x + 1 < n; x++) {
      const c = dark[y]![x];
      if (c === dark[y]![x + 1] && c === dark[y + 1]![x] && c === dark[y + 1]![x + 1]) penalty += 3;
    }
  const darkCount = dark.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  const total = n * n;
  penalty += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
  return penalty;
}

/**
 * Encodes `text` as a QR Code: the smallest mode and version that hold it at
 * the requested level, and the lowest-penalty mask unless one is given.
 * Throws a `RangeError` if it doesn't fit.
 */
export function encodeQr(text: string, options: QrOptions = {}): QrSymbol {
  const {
    level = "M",
    minVersion = QR_MIN_VERSION,
    maxVersion = QR_MAX_VERSION,
    quietZone = QR_QUIET_ZONE,
  } = options;
  checkVersion(minVersion);
  checkVersion(maxVersion);
  if (!(level in LEVEL_BITS)) throw new RangeError(`a QR level is L, M, Q or H, not ${level}`);
  if (!Number.isInteger(quietZone) || quietZone < 0)
    throw new RangeError("the quiet zone is a whole number of modules");
  const mode = modeOf(text);
  const { bits, count } = payload(text, mode);
  let version = minVersion;
  for (; version <= maxVersion; version++) {
    const needed = 4 + countBits(mode, version) + bits.bits.length;
    if (count < 2 ** countBits(mode, version) && needed <= qrDataCapacity(version, level) * 8)
      break;
  }
  if (version > maxVersion)
    throw new RangeError(
      `${count} ${mode === "byte" ? "bytes" : "characters"} in ${mode} mode don't fit a QR code up to version ${maxVersion} at level ${level}`,
    );
  const codewords = qrCodewords(dataCodewords(mode, count, bits, version, level), version, level);
  const size = qrSize(version);

  const draw = (mask: number) => {
    const m = new Matrix(size);
    drawFunctionPatterns(m, version);
    drawCodewords(m, codewords);
    applyMask(m, mask);
    drawFormat(m, qrFormatBits(level, mask));
    return m;
  };
  let mask = options.mask;
  let best: Matrix;
  if (mask !== undefined) {
    best = draw(mask);
  } else {
    let lowest = Infinity;
    best = draw(0);
    for (let k = 0; k < 8; k++) {
      const m = k === 0 ? best : draw(k);
      const score = qrPenalty(m.dark);
      if (score < lowest) [lowest, best, mask] = [score, m, k];
    }
  }

  const full = size + 2 * quietZone;
  const modules = Array.from({ length: full }, (_, y) =>
    Array.from({ length: full }, (_, x) => best.dark[y - quietZone]?.[x - quietZone] === true),
  );
  return { version, level, mask: mask!, mode, size, quietZone, codewords, modules };
}
