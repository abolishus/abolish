// What a ballot link asks the client to open. The election rides in the URL's
// fragment, `#election=<64 hex digits>`, which a browser never sends: neither
// the host serving the client nor a gateway's logs learn which poll a reader
// opened (T-10, T-11).

/** What the fragment names. */
export type Link =
  /** No fragment: the client's own page. */
  | { readonly kind: "none" }
  /** An election, as 32 bytes and as lowercase hex. */
  | { readonly kind: "election"; readonly electionId: Uint8Array; readonly hex: string }
  /** Something other than one election id: shown as a broken link, never guessed at. */
  | { readonly kind: "malformed" };

const ELECTION = /^#election=([0-9a-fA-F]{64})$/;

/** Reads `location.hash`. Exactly one `election` parameter and nothing else is a link. */
export function parseLink(hash: string): Link {
  if (hash === "" || hash === "#") return { kind: "none" };
  const match = ELECTION.exec(hash);
  if (match === null) return { kind: "malformed" };
  // The regex matched 64 hex digits, so the group is there.
  const hex = (match[1] as string).toLowerCase();
  const electionId = new Uint8Array(32);
  for (let i = 0; i < 32; i++) electionId[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return { kind: "election", electionId, hex };
}
