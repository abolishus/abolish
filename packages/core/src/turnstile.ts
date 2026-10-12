// Cloudflare Turnstile, checked on our server (docs/PROJECT_BRIEF.md:
// "Turnstile on Tier 0 actions"). A Tier 0 identity is a passkey, and anyone
// can make passkeys by the thousand, so each action that writes a row for an
// anonymous caller first costs a solved challenge (T-01, T-52).
//
// Never on the ballot path: the ballot client ships no third-party code, and
// ballot submission must work without our domain (T-25, ADR 0017).

/** The request header that carries a Turnstile token. */
export const TURNSTILE_HEADER = "x-turnstile-token";

/** Cloudflare's verification endpoint. */
export const TURNSTILE_SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Cloudflare's tokens are at most 2048 characters. */
export const MAX_TURNSTILE_TOKEN = 2048;

/**
 * What a token was issued for: the widget's `action`, which Cloudflare signs
 * into the token, so a token solved for one action can't be spent on another.
 */
export type TurnstileAction = "passkey-register" | "passkey-authenticate";

/**
 * `passed`: Cloudflare vouched for the token, for this site and action.
 * `refused`: missing, malformed, spent, expired, or for another site or action.
 * `unavailable`: Cloudflare couldn't say (network, timeout, its own error).
 */
export type TurnstileVerdict = "passed" | "refused" | "unavailable";

export interface Turnstile {
  verify(token: string | null, action: TurnstileAction): Promise<TurnstileVerdict>;
}

export interface TurnstileOptions {
  /** The widget's secret key. */
  readonly secretKey: string;
  /** The host the widget runs on (apps/web's): a token solved on another site is refused. */
  readonly hostname: string;
  /** How long to wait for Cloudflare before answering `unavailable`. */
  readonly timeoutMs?: number;
  /** For tests; the platform's otherwise. */
  readonly fetch?: typeof globalThis.fetch;
}

const SERVER_SIDE: ReadonlySet<unknown> = new Set([
  "internal-error",
  "missing-input-secret",
  "invalid-input-secret",
]);

// Printable ASCII without spaces: anything else isn't a token, and isn't sent.
const TOKEN = /^[\x21-\x7e]+$/;

/**
 * Checks tokens with Cloudflare's siteverify. Each token passes at most once
 * (Cloudflare refuses a spent one) and only within 300 seconds of being
 * solved. Fails closed: anything but a clear success is not `passed`.
 */
export function createTurnstile({
  secretKey,
  hostname,
  timeoutMs = 5000,
  fetch = globalThis.fetch,
}: TurnstileOptions): Turnstile {
  if (secretKey === "") throw new Error("secretKey must not be empty");
  if (hostname === "" || hostname.includes("/") || hostname.includes(":"))
    throw new Error("hostname must be a bare host name");
  return {
    async verify(token, action) {
      if (token === null || token.length > MAX_TURNSTILE_TOKEN || !TOKEN.test(token))
        return "refused";
      // No `remoteip`: we keep no addresses, and don't hand them on (T-11).
      const body = new URLSearchParams({ secret: secretKey, response: token });
      let response: Response;
      let outcome: unknown;
      try {
        response = await fetch(TURNSTILE_SITEVERIFY, {
          method: "POST",
          body,
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return "unavailable";
        outcome = await response.json();
      } catch {
        return "unavailable";
      }
      if (typeof outcome !== "object" || outcome === null) return "unavailable";
      const o = outcome as Record<string, unknown>;
      // A real token solved on another site or for another action is the
      // caller's doing, not Cloudflare's: refused, not unavailable.
      if (o["success"] === true)
        return o["hostname"] === hostname && o["action"] === action ? "passed" : "refused";
      // Cloudflare's own failure, or our misconfigured key: not the caller's fault.
      const codes = o["error-codes"];
      return Array.isArray(codes) && codes.some((c) => SERVER_SIDE.has(c))
        ? "unavailable"
        : "refused";
    },
  };
}
