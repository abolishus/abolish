// The poll's short link on the website, which "Ask others" offers after
// answering (docs/design/sharing.md, Share sheet). The link is the same for
// everyone who shares the poll, so it says nothing about who shared it or how
// they answered (T-10). The code comes from the API, which is untrusted: it
// is taken only as a prefix of the definition hash the registry holds, so a
// served code is at least this poll's spelling (T-34). Which poll owns a
// prefix two hashes share is the registry's order (`packages/core`,
// short-codes.ts), which the client doesn't read, so an operator could serve
// a longer prefix, which no poll owns (a dead link), or a shorter one an
// earlier poll owns, and the code would then name that poll wherever it is
// entered, mirrors included. It needs an earlier poll sharing at least the
// first 35 bits of the hash, and whoever follows the link opens that poll in
// this client, which checks it and shows its own question; see Known-weak in
// docs/status/P2-24.md.

/** Crockford base32, lower case: no i, l, o or u (`packages/core`, short-codes.ts). */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Every code is 7 to 52 characters: 52 hold all 256 bits, the last zero-padded. */
const MIN_CODE = 7;
const MAX_CODE = 52;

/** `hash` (32 bytes) as 52 characters of the alphabet: every code it can have is a prefix. */
function codeOf(hash: Uint8Array): string {
  let code = "";
  for (let i = 0; i < MAX_CODE; i++) {
    let digit = 0;
    for (let bit = 5 * i; bit < 5 * i + 5; bit++) {
      const byte = hash[bit >> 3] ?? 0; // past the 256th bit: the padding
      digit = (digit << 1) | ((byte >> (7 - (bit & 7))) & 1);
    }
    code += ALPHABET[digit];
  }
  return code;
}

/** Whether `code` is a short code of `hash` (32 bytes): 7 to 52 of its leading characters, as canonical text. */
export function isCodeOf(code: string, hash: Uint8Array): boolean {
  if (hash.length !== 32 || code.length < MIN_CODE || code.length > MAX_CODE) return false;
  return codeOf(hash).startsWith(code);
}

/** The poll's short link on the website at `web` (an origin, no trailing slash). */
export function shortLink(web: string, code: string): string {
  return `${web}/p/${code}`;
}
