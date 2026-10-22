// What a ballot link asks the client to open. The election rides in the URL's
// fragment, `#election=<64 hex digits>`, which a browser never sends: neither
// the host serving the client nor a gateway's logs learn which poll a reader
// opened (T-10, T-11). A link from a card that offers the first question's
// answers adds the one tapped, `&pick=<option>`, in the fragment for the same
// reason ([[first-answer]], step 1).

import { PARAMETERS } from "@abolishus/crypto";

/** What the fragment names. */
export type Link =
  /** No fragment: the client's own page. */
  | { readonly kind: "none" }
  /**
   * An election, as 32 bytes and as lowercase hex, and the option of its
   * first question the link was tapped on, if any: below `MAX_OPTIONS`, but
   * whether the question has it is known only once the election is checked.
   */
  | {
      readonly kind: "election";
      readonly electionId: Uint8Array;
      readonly hex: string;
      readonly pick?: number;
    }
  /** Something other than one election id and at most one pick: shown as a broken link, never guessed at. */
  | { readonly kind: "malformed" };

// The pick in its one decimal spelling: no sign, no leading zero, no spaces.
const ELECTION = /^#election=([0-9a-fA-F]{64})(?:&pick=(0|[1-9][0-9]?))?$/;

/**
 * Reads `location.hash`. Exactly one `election` parameter, optionally then
 * one `pick`, and nothing else is a link.
 */
export function parseLink(hash: string): Link {
  if (hash === "" || hash === "#") return { kind: "none" };
  const match = ELECTION.exec(hash);
  if (match === null) return { kind: "malformed" };
  // The regex matched 64 hex digits, so the group is there.
  const hex = (match[1] as string).toLowerCase();
  const electionId = new Uint8Array(32);
  for (let i = 0; i < 32; i++) electionId[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  if (match[2] === undefined) return { kind: "election", electionId, hex };
  // No question has more options than the whole poll may (MAX_OPTIONS).
  const pick = Number(match[2]);
  if (pick >= PARAMETERS.MAX_OPTIONS) return { kind: "malformed" };
  return { kind: "election", electionId, hex, pick };
}
