import { parseShortCode } from "@abolishus/core/short-codes";

/** Lowercase hex, two digits per byte (docs/spec/notation.md). */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Bytes from lowercase hex, two digits per byte; anything else is a `RangeError`. */
export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new RangeError("expected lowercase hex");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return bytes;
}

/** An election ID as the API and the board write it: 32 bytes, lowercase hex, nothing else (T-31). */
export function isElectionId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * What someone typed or pasted as a poll ID, as the one string that names it:
 * surrounding space, a `0x` prefix and capitals are forgiven. `undefined` if
 * it isn't 32 bytes of hex.
 */
export function normalizeElectionId(input: string): string | undefined {
  const id = input.trim().replace(/^0x/i, "").toLowerCase();
  return isElectionId(id) ? id : undefined;
}

/** A poll's short code in its one canonical form: what the API resolves and a short link redirects on (T-31). */
export function isShortCode(value: unknown): value is string {
  return typeof value === "string" && parseShortCode(value) === value;
}

const U64_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/;
const U64_MAX = (1n << 64n) - 1n;

/** A `u64` as the API writes it: a canonical decimal string, no sign or leading zeros. */
export function isCanonicalU64(value: unknown): value is string {
  return typeof value === "string" && U64_PATTERN.test(value) && BigInt(value) <= U64_MAX;
}

/**
 * A search parameter as the text it was in the URL. The router turns `123`
 * into a number and `true` into a boolean, and only when the text survives
 * the round trip exactly, so `String` gives back the same text.
 */
export function searchText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}
