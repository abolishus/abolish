// The one thing the challenge page reads: its own URL's fragment, which the
// ballot client sets in the frame's `src` and no server ever sees
// ([[registration]], The handoff, step 1). Parsed strictly, so exactly one
// string means each request, and anything else renders nothing.

/** The actions a token may be solved for: the two routes that take one. */
export const ACTIONS = ["tier0-register", "tier1-relay"] as const;

export type Action = (typeof ACTIONS)[number];

/** What the fragment asks: whom to hand the token to, and for which route. */
export interface ChallengeRequest {
  readonly origin: string;
  readonly action: Action;
}

/**
 * The request in `hash` (`location.hash`, with its `#`), or `undefined`:
 * exactly `#origin=<origin>&action=<action>`, the keys once each and in that
 * order, the origin percent-encoded as `encodeURIComponent` encodes it
 * (the ballot client's `challengeFrameSrc`) and one of `entryPoints`, the
 * action one of `ACTIONS` as is. Requiring the one canonical encoding means
 * no two fragments name the same request, and an origin that isn't an
 * entry point is refused here, before a solve is spent on a token no
 * listed page could receive.
 */
export function parseFragment(
  hash: string,
  entryPoints: readonly string[],
): ChallengeRequest | undefined {
  if (!hash.startsWith("#")) return undefined;
  const pairs = hash.slice(1).split("&");
  if (pairs.length !== 2) return undefined;
  const [first, second] = pairs.map((pair) => pair.split("="));
  if (first?.length !== 2 || second?.length !== 2) return undefined;
  const [originKey, encoded] = first as [string, string];
  const [actionKey, action] = second as [string, string];
  if (originKey !== "origin" || actionKey !== "action") return undefined;
  if (!(ACTIONS as readonly string[]).includes(action)) return undefined;
  let origin: string;
  try {
    origin = decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
  if (encodeURIComponent(origin) !== encoded || !entryPoints.includes(origin)) return undefined;
  return { origin, action: action as Action };
}

/** A Turnstile token's form: 1 to 2,048 characters from `0x21` to `0x7e`, as the client accepts it. */
const TOKEN = /^[\x21-\x7e]{1,2048}$/;

/** Whether `token` is one the ballot client would accept, so nothing else is ever posted. */
export function isToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN.test(token);
}
