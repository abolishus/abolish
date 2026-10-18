// What the challenge page may load and who may frame it ([[registration]],
// Challenge page). One definition feeds the headers file the host serves
// with the page and the tests, which also pin `index.html`'s `<meta>` copy
// to it, so none of them can drift (T-43).

import type { ChallengeDeployment } from "./deployment.ts";
import { TURNSTILE_ORIGIN } from "./turnstile.ts";

/**
 * The page's policy, less `frame-ancestors`, which a `<meta>` policy can't
 * set. Exactly the spec's directives: no connection, image or font of the
 * page's own, so the page reads nothing and sends nothing but the token.
 */
export const PAGE_POLICY = [
  "default-src 'none'",
  `script-src 'self' ${TURNSTILE_ORIGIN}`,
  `frame-src ${TURNSTILE_ORIGIN}`,
  "style-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** A Turnstile site key as Cloudflare issues them. */
const SITE_KEY = /^[0-9A-Za-z_-]{1,100}$/;

// An ASCII host name and an optional port: the URL parser lets through
// characters such as `;` that would end a directive in the policy.
const ORIGIN_FORM = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::[0-9]{1,5})?$/;

/**
 * An HTTPS origin exactly as `URL#origin` serializes it, with nothing after
 * the host and port, and a host of letters, digits, hyphens and dots only.
 */
export function isSerializedOrigin(origin: string): boolean {
  if (!ORIGIN_FORM.test(origin)) return false;
  try {
    return new URL(origin).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Throws unless `deployment` is one a build may pin: a site key of
 * Turnstile's form (or none), and one or more distinct entry points, each a
 * serialized HTTPS origin. An entry point that isn't one would be a
 * `frame-ancestors` source the browser reads differently from the page's
 * comparison, or a source list a value could break out of.
 */
export function checkDeployment(deployment: ChallengeDeployment): void {
  const { siteKey, entryPoints } = deployment;
  if (siteKey !== undefined && !SITE_KEY.test(siteKey))
    throw new RangeError("siteKey: not a Turnstile site key");
  if (entryPoints.length === 0) throw new RangeError("entryPoints: none");
  if (new Set(entryPoints).size !== entryPoints.length)
    throw new RangeError("entryPoints: listed twice");
  for (const origin of entryPoints)
    if (!isSerializedOrigin(origin)) throw new RangeError(`entryPoints: not an origin: ${origin}`);
}

/**
 * The headers the host sends with every response ([[registration]],
 * Challenge page): the policy with `frame-ancestors` listing exactly the
 * entry points, so no other page can frame it (T-43), and no referrer.
 * Nothing here sets a cookie, and the host adds none (T-10).
 */
export function pageHeaders(deployment: ChallengeDeployment): Readonly<Record<string, string>> {
  checkDeployment(deployment);
  return {
    "content-security-policy": `${PAGE_POLICY}; frame-ancestors ${deployment.entryPoints.join(" ")}`,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
  };
}
