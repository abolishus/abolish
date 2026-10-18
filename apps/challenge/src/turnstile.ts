// Where Turnstile comes from: Cloudflare's own URL, as Cloudflare requires,
// so it can't be pinned or given an integrity hash. That is why it runs
// only here, on an origin of its own, never in the ballot client (T-67).

/** Cloudflare's origin: Turnstile's script and its frame, and nothing else third-party. */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** Turnstile's script for a widget the page renders itself. */
export const TURNSTILE_SCRIPT = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit`;
