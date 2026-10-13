// Short codes for polls (docs/design/sharing.md, "Short links and entry
// points"): `abolish.us/p/<code>`, the code a prefix of the poll's definition
// hash in lower-case Crockford base32. Which poll owns a code is a pure
// function of the registered definition hashes in registration order, so
// mirrors, `apps/node` and the verifier resolve codes without us (T-49), and a
// poll ground to share an existing poll's prefix can't take its code: it only
// ever lengthens its own (T-53).

/** Crockford base32, lower case: no i, l, o or u. */
export const SHORT_CODE_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Every code is at least 7 characters: the hash's first 35 bits. */
export const SHORT_CODE_LENGTH = 7;

/**
 * A 32-byte hash in full: 51 characters hold 255 bits and the 52nd the last
 * bit, zero-padded, so two distinct hashes always differ within this length.
 */
export const MAX_SHORT_CODE_LENGTH = 52;

const HASH_LENGTH = 32;

/** Input forgiven before it is checked: `o` reads as `0`, `i` and `l` as `1`. */
const LOOKALIKES: Readonly<Record<string, string>> = { o: "0", i: "1", l: "1" };

function checkHash(hash: Uint8Array): void {
  if (!(hash instanceof Uint8Array) || hash.length !== HASH_LENGTH)
    throw new TypeError("a definition hash is 32 bytes");
}

/** The first `length` characters of `hash` in the short-code alphabet. */
export function shortCode(hash: Uint8Array, length: number = SHORT_CODE_LENGTH): string {
  checkHash(hash);
  if (!Number.isInteger(length) || length < SHORT_CODE_LENGTH || length > MAX_SHORT_CODE_LENGTH)
    throw new RangeError(
      `a short code is ${SHORT_CODE_LENGTH} to ${MAX_SHORT_CODE_LENGTH} characters`,
    );
  let code = "";
  for (let i = 0; i < length; i++) {
    let digit = 0;
    for (let bit = 5 * i; bit < 5 * i + 5; bit++) {
      const byte = hash[bit >> 3] ?? 0; // past the 256th bit: the padding
      digit = (digit << 1) | ((byte >> (7 - (bit & 7))) & 1);
    }
    code += SHORT_CODE_ALPHABET[digit];
  }
  return code;
}

/**
 * What someone typed, scanned or followed as a code, as the one form codes
 * are compared in: case-insensitive, with `o`, `i` and `l` read as the digits
 * they look like. `undefined` for anything else (a `u`, punctuation, a wrong
 * length), never a message built from the input, so a refusal can't echo it.
 */
export function parseShortCode(input: string): string | undefined {
  if (
    typeof input !== "string" ||
    input.length < SHORT_CODE_LENGTH ||
    input.length > MAX_SHORT_CODE_LENGTH
  )
    return undefined;
  let code = "";
  for (const c of input) {
    // ASCII case only: Unicode lower-casing maps the Kelvin sign to `k`.
    const lower = c >= "A" && c <= "Z" ? c.toLowerCase() : c;
    const digit = LOOKALIKES[lower] ?? lower;
    if (!SHORT_CODE_ALPHABET.includes(digit)) return undefined;
    code += digit;
  }
  // The 52nd character holds one bit; the other four are padding, always 0.
  const last = code.slice(MAX_SHORT_CODE_LENGTH - 1);
  if (last !== "" && SHORT_CODE_ALPHABET.indexOf(last) % 16 !== 0) return undefined;
  return code;
}

/** How many leading characters two equal-length codes share. */
function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Each poll's code, given every registered definition hash in registration
 * order: the shortest prefix, of at least 7 characters, that no earlier
 * poll's hash shares. So an earlier poll's code never changes as later polls
 * arrive, no two polls share a code, and a code is longer than 7 characters
 * only because an earlier poll's hash shares its first 7. A hash registered
 * twice is refused: registration order can't say which one a code names.
 */
export function assignShortCodes(hashes: Iterable<Uint8Array>): string[] {
  // Earlier polls' full codes, sorted: the longest prefix a new code shares
  // with any of them is the one it shares with a sorted neighbour.
  const seen: string[] = [];
  const codes: string[] = [];
  for (const hash of hashes) {
    const full = shortCode(hash, MAX_SHORT_CODE_LENGTH);
    let lo = 0;
    let hi = seen.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seen[mid]! < full) lo = mid + 1; // mid < hi = seen.length
      else hi = mid;
    }
    if (seen[lo] === full) throw new RangeError("a definition hash is registered twice");
    const shared = Math.max(
      lo > 0 ? commonPrefix(seen[lo - 1]!, full) : 0, // lo - 1 is in range
      lo < seen.length ? commonPrefix(seen[lo]!, full) : 0, // checked
    );
    codes.push(full.slice(0, Math.max(SHORT_CODE_LENGTH, shared + 1)));
    seen.splice(lo, 0, full);
  }
  return codes;
}

/**
 * The position, in registration order, of the poll that owns `code` (as
 * `parseShortCode` returns it), or `undefined` if none does: a prefix of some
 * poll's hash that isn't exactly its code names nothing, so a code is never
 * resolved by guessing which longer one was meant.
 */
export function resolveShortCode(code: string, hashes: Iterable<Uint8Array>): number | undefined {
  const index = assignShortCodes(hashes).indexOf(code);
  return index === -1 ? undefined : index;
}
