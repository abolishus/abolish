import { encodeQr, type QrLevel } from "#/lib/qr";

export interface QrCodeProps {
  /** What the code holds: a poll's short link, upper-cased so it fits alphanumeric mode. */
  value: string;
  /** What it is, translated by the caller ("QR code for abolish.us/p/3j55dw1"). */
  label: string;
  /** Rendered width and height in CSS pixels, quiet zone included. */
  size?: number;
  /** Error correction: M on screens, Q on print. Default M. */
  level?: QrLevel;
}

/**
 * A QR code as one SVG path. Always dark modules on a light ground, in both
 * themes: many scanners can't read an inverted code. The quiet zone is part
 * of the drawing, so it holds whatever surrounds it.
 */
export function QrCode({ value, label, size = 192, level = "M" }: QrCodeProps) {
  const { modules } = encodeQr(value, { level });
  const n = modules.length;
  let d = "";
  modules.forEach((row, y) => {
    for (let x = 0; x < n; x++) {
      if (!row[x]) continue;
      // One rectangle per horizontal run of dark modules.
      let end = x;
      while (row[end + 1]) end++;
      d += `M${x} ${y}h${end - x + 1}v1h${x - end - 1}z`;
      x = end;
    }
  });
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${n} ${n}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="shrink-0"
    >
      <rect width={n} height={n} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}
