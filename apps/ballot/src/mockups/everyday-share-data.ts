// Short links and the placeholder QR for the ballot client's share mockups
// (Storybook only). Copied from the website's apps/web/src/mockups/
// share-data.ts so the ballot client never reaches into the website's code.

export const WEB_HOST = "abolish.us";
export const BALLOT_HOST = "abolish.ch";
export const ENS_NAME = "abolishus.eth";

/** Crockford base32, lower case: no i, l, o or u. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** A poll's short code: the first 35 bits of its definition hash as 7 base32 characters. */
export function shortCode(hash: string, length = 7): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    let value = 0;
    for (let b = 0; b < 5; b++) {
      const bit = i * 5 + b;
      const nibble = Number.parseInt(hash[bit >> 2] ?? "0", 16);
      value = (value << 1) | ((nibble >> (3 - (bit & 3))) & 1);
    }
    out += ALPHABET.charAt(value);
  }
  return out;
}

export const shortLink = (hash: string) => `${WEB_HOST}/p/${shortCode(hash)}`;
export const shortHref = (hash: string) => `https://${shortLink(hash)}`;
export const flyerHref = (hash: string) => `${shortHref(hash)}/flyer`;
export const embedHref = (hash: string) => `${shortHref(hash)}/embed`;
/** The fallback when abolish.us is down or blocked: the ballot client's entry points take the code. */
export const alsoAt = (hash: string) =>
  `open ${BALLOT_HOST} or ${ENS_NAME} and enter the code ${shortCode(hash)}`;

/**
 * A stand-in for a real QR code: version 2's 25×25 grid with its finder,
 * timing and alignment patterns, and data modules drawn from the hash. It
 * encodes nothing; a real encoder replaces it.
 */
export function qrPlaceholder(hash: string): boolean[][] {
  const n = 25;
  const grid: boolean[][] = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
  const reserved: boolean[][] = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
  const finder = (top: number, left: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const y = top + r;
        const x = left + c;
        if (y < 0 || x < 0 || y >= n || x >= n) continue;
        reserved[y]![x] = true;
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        grid[y]![x] = ring !== 2 && ring <= 3;
      }
    }
  };
  finder(0, 0);
  finder(0, n - 7);
  finder(n - 7, 0);
  for (let r = 16; r <= 20; r++) {
    for (let c = 16; c <= 20; c++) {
      reserved[r]![c] = true;
      const ring = Math.max(Math.abs(r - 18), Math.abs(c - 18));
      grid[r]![c] = ring !== 1;
    }
  }
  for (let i = 8; i < n - 8; i++) {
    reserved[6]![i] = true;
    reserved[i]![6] = true;
    grid[6]![i] = i % 2 === 0;
    grid[i]![6] = i % 2 === 0;
  }
  const bytes = hash.match(/../g)?.map((h) => Number.parseInt(h, 16)) ?? [0];
  let k = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (reserved[r]![c]) continue;
      const byte = bytes[k % bytes.length]! ^ ((k * 151) & 0xff);
      grid[r]![c] = ((byte >> (k % 8)) & 1) === 1;
      k++;
    }
  }
  return grid;
}
