// The headers on every response from apps/web.
//
// apps/web never casts a vote: ballots are cast only in apps/ballot, under its
// own origin and stricter policy (T-43). These headers keep this site from
// being a stepping stone to it or to an account: no script runs but our own
// bundles and the inline scripts the server rendered this response with
// (each carrying a per-response nonce), nothing loads from or is sent to
// another origin, and no other site can frame a page or learn which poll a
// visitor came from (T-11, T-67).

/** A fresh nonce for one response's inline scripts: 128 bits from the platform CSPRNG. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/** The response's Content-Security-Policy, allowing inline scripts that carry `nonce`. */
export function contentSecurityPolicy(nonce: string): string {
  if (!/^[A-Za-z0-9+/]{22}==$/.test(nonce))
    throw new RangeError("nonce must be 16 bytes of base64");
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self'",
    // Server functions are fetched from our own origin; nothing else is.
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Every security header, for a response rendered with `nonce`. */
export function securityHeaders(nonce: string): Readonly<Record<string, string>> {
  return {
    "content-security-policy": contentSecurityPolicy(nonce),
    "x-content-type-options": "nosniff",
    // A link out of a poll page tells the next site nothing (T-11, T-67).
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy":
      "camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), browsing-topics=()",
  };
}
