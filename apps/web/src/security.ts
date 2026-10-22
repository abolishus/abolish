// The headers on every response from apps/web.
//
// apps/web never casts a vote: ballots are cast only in apps/ballot, under its
// own origin and stricter policy (T-43). These headers keep this site from
// being a stepping stone to it or to an account: no script runs but our own
// bundles and the inline scripts the server rendered this response with
// (each carrying a per-response nonce), nothing loads from or is sent to
// another origin, and no other site can frame a page or learn which poll a
// visitor came from (T-11, T-67).
//
// One exception: the poll editor's pages (P2-22 part 6c) and the account's
// verification page (P2-31 part 4) may load Cloudflare Turnstile's script and
// frame, whose token a poll's submission and a request for a code need (T-72,
// T-52). It is third-party code on our origin, so it is allowed only there,
// and the page loads it only when the author submits or asks for a code
// (src/account/challenge.ts; T-43, T-55).
//
// The other: a poll's embed, `/embed/p/<code>` (P2-24 part 3), which other
// sites frame (docs/design/sharing.md, The embed decision). It is the only
// page any site may frame, and it has no script at all, so its policy has no
// `script-src` and sandboxes the document whatever the host's iframe says.

/** A fresh nonce for one response's inline scripts: 128 bits from the platform CSPRNG. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/** Where Turnstile's script and frame come from. */
export const CHALLENGE_ORIGIN = "https://challenges.cloudflare.com";

/**
 * Whether the page at `pathname` may run Turnstile: the poll editor's,
 * `/account/polls/<new or id>`, and the verification page's,
 * `/account/verify`, and no other. Their links out are plain ones that load
 * a new document under that page's own policy.
 */
export function isChallengePage(pathname: string): boolean {
  return pathname === "/account/verify" || /^\/account\/polls\/[a-z0-9]+$/.test(pathname);
}

/** Whether `pathname` is a poll's embed, `/embed/p/<code>`, and so frameable. */
export function isEmbedPage(pathname: string): boolean {
  return /^\/embed\/p\/[^/]+$/i.test(pathname);
}

export interface PolicyOptions {
  /** Allow Turnstile's script and frame (`isChallengePage`). */
  readonly challenge?: boolean;
}

/** The response's Content-Security-Policy, allowing inline scripts that carry `nonce`. */
export function contentSecurityPolicy(
  nonce: string,
  { challenge = false }: PolicyOptions = {},
): string {
  if (!/^[A-Za-z0-9+/]{22}==$/.test(nonce))
    throw new RangeError("nonce must be 16 bytes of base64");
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'${challenge ? ` ${CHALLENGE_ORIGIN}` : ""}`,
    // The widget is Cloudflare's frame; it talks to Cloudflare itself, so
    // `connect-src` stays ours alone.
    ...(challenge ? [`frame-src ${CHALLENGE_ORIGIN}`] : []),
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
export function securityHeaders(
  nonce: string,
  options: PolicyOptions = {},
): Readonly<Record<string, string>> {
  return {
    "content-security-policy": contentSecurityPolicy(nonce, options),
    "x-content-type-options": "nosniff",
    // A link out of a poll page tells the next site nothing (T-11, T-67).
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    // Each page is rendered for one response, with its own nonce: a cache that
    // served it again would hand every visitor the same one.
    "cache-control": "no-store",
    // Ignored over plain HTTP; the proxy in front (P2-11) terminates TLS.
    "strict-transport-security": "max-age=31536000",
    "permissions-policy":
      "camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), browsing-topics=()",
  };
}

/**
 * The headers on a link-preview image. No document runs in it, so the policy
 * only refuses everything; other origins may load it (a chat's web client
 * shows it from our URL), and its caching is the route's own: a preview
 * carries no nonce and nothing about whoever fetched it.
 */
export function imageHeaders(): Readonly<Record<string, string>> {
  return {
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "cross-origin",
    "strict-transport-security": "max-age=31536000",
  };
}

/**
 * The headers on a poll's embed (`isEmbedPage`). Any site may frame it, so
 * nothing in it may run or send anything: no `script-src` (so no script, ours
 * or injected), no form action, and the CSP's own sandbox, which holds even
 * where a host leaves the iframe's `sandbox` out. The sandbox keeps the
 * page's origin only so its stylesheet and fonts load from us (an opaque
 * origin would be refused our `same-origin` assets); with no script there is
 * nothing to use it with. Links open in a new tab, outside the sandbox, as
 * plain navigations (T-43, T-67). A reader's browser still contacts us when
 * a host page loads (T-11): the page sets no cookie, asks for no referrer,
 * and may be cached briefly, since it carries no nonce and nothing about
 * whoever loaded it.
 */
export function embedHeaders(): Readonly<Record<string, string>> {
  return {
    "content-security-policy": [
      "default-src 'none'",
      "style-src 'self'",
      "font-src 'self'",
      "img-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors *",
      "sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox",
    ].join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    // A host that isolates itself (COEP) can still frame it.
    "cross-origin-resource-policy": "cross-origin",
    "cache-control": "public, max-age=60",
    "strict-transport-security": "max-age=31536000",
    "permissions-policy":
      "camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), browsing-topics=()",
  };
}
