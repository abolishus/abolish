/** A cell of the fingerprint grid. */
export type FingerprintCell = "empty" | "square" | "dot" | "corner";

const CELLS: readonly FingerprintCell[] = ["empty", "square", "dot", "corner"];

/** Rows and columns of the grid; the right half mirrors the left. */
export const FINGERPRINT_SIZE = 8;

/** Bits of the hash the glyph shows: 2 per cell of the left half. */
export const FINGERPRINT_BITS = (FINGERPRINT_SIZE / 2) * FINGERPRINT_SIZE * 2;

/**
 * The fingerprint's grid for a 32-byte hash, row by row. The left half's 32
 * cells take 2 bits each from the hash's first 8 bytes, most significant
 * bits first; the right half mirrors the left. Every one of those 64 bits
 * changes the glyph, and the bits come straight from a hash output, so they
 * are already uniform (T-24): there is nothing to gain from hashing again.
 */
export function fingerprintCells(hash: string): FingerprintCell[][] {
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new RangeError("a fingerprint takes a 32-byte hash as 64 lowercase hex digits");
  }
  const half = FINGERPRINT_SIZE / 2;
  const rows: FingerprintCell[][] = [];
  for (let row = 0; row < FINGERPRINT_SIZE; row++) {
    const left: FingerprintCell[] = [];
    for (let col = 0; col < half; col++) {
      const cell = row * half + col;
      const byte = Number.parseInt(hash.slice((cell >> 2) * 2, (cell >> 2) * 2 + 2), 16);
      // `?? "empty"` is unreachable: two bits always index CELLS.
      left.push(CELLS[(byte >> (6 - 2 * (cell & 3))) & 3] ?? "empty");
    }
    rows.push([...left, ...left.toReversed()]);
  }
  return rows;
}

export interface FingerprintProps {
  /** The hash it is drawn from: 64 lowercase hex digits. */
  value: string;
  /**
   * What it is a fingerprint of, translated by the caller. Include the hash's
   * first digits ("Fingerprint of receipt 9f86 d081"): a screen reader can't
   * compare shapes.
   */
  label: string;
  /** Rendered width and height in CSS pixels. */
  size?: number;
}

/**
 * The visual fingerprint (brief, signature elements): a deterministic,
 * left-right symmetric glyph from a receipt or election hash, so people can
 * compare "does mine match the board's?" without reading hex (T-24, T-41,
 * T-53). A difference is conclusive; a match is only as strong as the bits a
 * person actually compares, so the hash stays shown beside it and the
 * verifier compares bytes.
 */
export function Fingerprint({ value, label, size = 96 }: FingerprintProps) {
  const rows = fingerprintCells(value);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`-0.5 -0.5 ${FINGERPRINT_SIZE + 1} ${FINGERPRINT_SIZE + 1}`}
      width={size}
      height={size}
      className="shrink-0 text-foreground"
    >
      <rect
        x={-0.25}
        y={-0.25}
        width={FINGERPRINT_SIZE + 0.5}
        height={FINGERPRINT_SIZE + 0.5}
        fill="none"
        stroke="currentColor"
        strokeWidth={0.08}
      />
      {rows.map((cells, y) =>
        cells.map((cell, x) => {
          const key = `${x}-${y}`;
          switch (cell) {
            case "square":
              return (
                <rect
                  key={key}
                  x={x + 0.1}
                  y={y + 0.1}
                  width={0.8}
                  height={0.8}
                  fill="currentColor"
                />
              );
            case "dot":
              return <circle key={key} cx={x + 0.5} cy={y + 0.5} r={0.3} fill="currentColor" />;
            case "corner": {
              // A triangle in the cell's outer top corner, mirrored with the
              // cell, so the whole glyph stays symmetric.
              const outer = x < FINGERPRINT_SIZE / 2 ? x + 0.1 : x + 0.9;
              const inner = x < FINGERPRINT_SIZE / 2 ? x + 0.9 : x + 0.1;
              return (
                <polygon
                  key={key}
                  points={`${outer},${y + 0.1} ${inner},${y + 0.1} ${outer},${y + 0.9}`}
                  fill="currentColor"
                />
              );
            }
            case "empty":
              return null;
          }
        }),
      )}
    </svg>
  );
}
