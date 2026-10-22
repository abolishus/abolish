// Server keyrings ([[0038-verified-accounts]], Keys; T-65, T-73): each a list
// of 32-byte keys with IDs, read from apps/web's environment, never from the
// database or a log. The current key is the one new values are made under;
// the others stay so values made under them can still be read or matched
// until the rotation job (P2-31 part 3) rewrites them.
//
// The text form is `id:hex,id:hex,…`, oldest first, with the last key current
// unless one entry ends in `*`, which makes that one current instead. A new
// key is rolled out in two deploys: first listed after a `*` on the current
// key, so every instance holds it, then made current. An instance that
// doesn't hold a key can't match values made under it, so making a key
// current before every instance holds it would let two instances each take
// one address for a different account. Errors name the entry's position,
// never its text, since that text is the key.

/** One key and the ID stored beside every value made under it. */
export interface KeyringKey {
  readonly id: string;
  readonly key: Uint8Array;
}

export interface Keyring {
  /** The key new values are made under: the one marked `*`, or else the last one listed. */
  readonly current: KeyringKey;
  /** Every key, oldest first. */
  readonly keys: readonly KeyringKey[];
  /** The key with this ID, if the keyring holds it. */
  get(id: string): Uint8Array | undefined;
}

/** What a key ID may be: short, lowercase, and safe in a log line or a column check. */
export const KEY_ID = /^[a-z0-9-]{1,32}$/;

const HEX_KEY = /^[0-9a-f]{64}\*?$/;

/** Parses a keyring's text form, refusing anything but well-formed, distinct 32-byte keys. */
export function parseKeyring(text: string): Keyring {
  const keys: KeyringKey[] = [];
  const ids = new Set<string>();
  const hexes = new Set<string>();
  let marked: KeyringKey | undefined;
  const entries = text.split(",");
  for (const [i, entry] of entries.entries()) {
    const at = entry.indexOf(":");
    const id = entry.slice(0, at);
    const field = entry.slice(at + 1);
    if (at < 0 || !KEY_ID.test(id) || !HEX_KEY.test(field))
      throw new Error(`keyring entry ${i + 1} is not id:64-hex`);
    const hex = field.slice(0, 64);
    if (ids.has(id)) throw new Error(`keyring entry ${i + 1} repeats an ID`);
    if (hexes.has(hex)) throw new Error(`keyring entry ${i + 1} repeats a key`);
    ids.add(id);
    hexes.add(hex);
    const key = { id, key: Uint8Array.from(Buffer.from(hex, "hex")) };
    if (field.endsWith("*")) {
      if (marked !== undefined) throw new Error(`keyring entry ${i + 1} is a second current key`);
      marked = key;
    }
    keys.push(key);
  }
  // `split` returns at least one entry, which the loop has checked.
  const current = marked ?? keys[keys.length - 1]!;
  const byId = new Map(keys.map((k) => [k.id, k.key]));
  return { current, keys, get: (id) => byId.get(id) };
}

/** Throws unless no key appears in more than one of `rings`: each use gets its own keys. */
export function assertDistinctKeyrings(...rings: readonly Keyring[]): void {
  const seen = new Set<string>();
  for (const ring of rings) {
    for (const { key } of ring.keys) {
      const hex = Buffer.from(key).toString("hex");
      if (seen.has(hex)) throw new Error("a key appears in more than one keyring");
      seen.add(hex);
    }
  }
}
