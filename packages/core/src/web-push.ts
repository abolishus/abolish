// Web push without a payload ([[P2-27]] part 4): the sender behind
// `PushSender`, telling a browser's push service to wake our service worker
// on that browser, which then shows a fixed notice of its own. The request
// is RFC 8030's push message with an empty body, authorised by RFC 8292's
// VAPID: an ES256 JWT (RFC 7515, RFC 7518 section 3.4) over the push
// service's origin, signed with `@noble/curves`' P-256.
//
// No payload means no RFC 8291 message encryption: there is nothing to
// encrypt, so the browser's `p256dh` and `auth` keys are never asked for,
// and the push service learns no words, only that we woke the browser.
//
// T-76: an endpoint is a URL a browser handed us, so `parsePushEndpoint`
// takes only an https URL in canonical form on a known push service's host,
// with no port, user or fragment; the sender checks it again before every
// request and follows no redirect, so our server calls nowhere else.
// T-73, T-76: the push service is told the endpoint, our VAPID key and
// subject, a TTL, an urgency and a fixed topic, never an account, a poll or
// what was decided.

import { p256 } from "@noble/curves/nist.js";
import { parseEmailAddress } from "./account-emails.ts";

/** What a push service answered: taken, the subscription is gone for good, or neither. */
export type PushOutcome = "sent" | "gone" | "unavailable";

export interface PushSender {
  /** Wakes the browser behind `endpoint` at `now`, without a payload. */
  send(endpoint: string, now: Date): Promise<PushOutcome>;
}

/** The longest endpoint taken: the push services' own run to a few hundred bytes. */
export const MAX_PUSH_ENDPOINT = 1024;

// The push services the browsers use (T-76): Chrome's and other Chromium
// browsers' (Firebase Cloud Messaging), Firefox's (Mozilla autopush),
// Safari's (Apple), and Edge's (Windows Push Notification Services, one
// host per data centre under notify.windows.com).
const PUSH_HOSTS = new Set([
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
]);
const WNS_HOST = /^[a-z0-9-]{1,63}\.notify\.windows\.com$/;

/**
 * `endpoint` if it is a push endpoint we call: https, in the URL parser's
 * own canonical form, at most `MAX_PUSH_ENDPOINT` characters, on a known
 * push service with no port, user, password or fragment; else `undefined`.
 */
export function parsePushEndpoint(endpoint: string): string | undefined {
  if (endpoint.length > MAX_PUSH_ENDPOINT) return undefined;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  // `href` equal to the input rules out every other spelling of the URL:
  // upper case, dot segments, percent-encoding the parser would change.
  if (url.href !== endpoint || url.protocol !== "https:") return undefined;
  if (url.port !== "" || url.username !== "" || url.password !== "") return undefined;
  if (url.hash !== "" || endpoint.includes("#")) return undefined;
  if (!PUSH_HOSTS.has(url.hostname) && !WNS_HOST.test(url.hostname)) return undefined;
  return endpoint;
}

/** A VAPID key pair (RFC 8292 section 3.2): a P-256 secret scalar and its public point. */
export interface VapidKeys {
  readonly secretKey: Uint8Array;
  /** Uncompressed (65 bytes), as browsers take it for `applicationServerKey`. */
  readonly publicKey: Uint8Array;
}

const fromBase64Url = (s: string): Uint8Array | undefined => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return undefined;
  const bytes = new Uint8Array(Buffer.from(s, "base64url"));
  // Only the one spelling of these bytes: no padding bits set, no stray length.
  return Buffer.from(bytes).toString("base64url") === s ? bytes : undefined;
};
const toBase64Url = (bytes: Uint8Array | string): string =>
  (typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes)).toString(
    "base64url",
  );

/**
 * The VAPID keys from the secret scalar as unpadded base64url (32 bytes, the
 * form `web-push generate-vapid-keys` and our own key generation print).
 * Throws on anything else, a zero or out-of-range scalar included.
 */
export function vapidKeys(secretKey: string): VapidKeys {
  const secret = fromBase64Url(secretKey);
  if (secret === undefined || secret.length !== 32 || !p256.utils.isValidSecretKey(secret))
    throw new Error("the VAPID key is not a P-256 secret key");
  return { secretKey: secret, publicKey: p256.getPublicKey(secret, false) };
}

/** A fresh VAPID secret key, as `vapidKeys` takes it. */
export const newVapidKey = (): string => toBase64Url(p256.utils.randomSecretKey());

/** The public key as unpadded base64url, as the `k` parameter and `applicationServerKey` take it. */
export const vapidPublicKey = (keys: VapidKeys): string => toBase64Url(keys.publicKey);

/** How long a VAPID token holds: RFC 8292 section 2 allows at most 24 hours. */
export const VAPID_TOKEN_SECONDS = 12 * 60 * 60;

/**
 * RFC 8292 section 3's `Authorization` value for a request to `audience`
 * (the push service's origin) at `now`: `vapid t=<JWT>, k=<public key>`.
 * The JWT's claims are `aud`, `exp` (`VAPID_TOKEN_SECONDS` on) and `sub`,
 * and its ES256 signature is `r || s` (RFC 7518 section 3.4).
 */
export function vapidAuthorization(
  keys: VapidKeys,
  audience: string,
  subject: string,
  now: Date,
): string {
  const exp = Math.floor(now.getTime() / 1000) + VAPID_TOKEN_SECONDS;
  const header = toBase64Url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = toBase64Url(JSON.stringify({ aud: audience, exp, sub: subject }));
  const input = `${header}.${claims}`;
  // `prehash` hashes with SHA-256 as ES256 does; the signature is RFC 6979's
  // deterministic one in its compact `r || s` form.
  const signature = p256.sign(new TextEncoder().encode(input), keys.secretKey, {
    prehash: true,
    format: "compact",
  });
  return `vapid t=${input}.${toBase64Url(signature)}, k=${vapidPublicKey(keys)}`;
}

/** How long the push service keeps a message for a browser that is offline: a week. */
export const PUSH_TTL_SECONDS = 7 * 24 * 60 * 60;
// RFC 8030 section 5.4: a later message with the same topic replaces one
// still waiting, so a browser offline for days wakes once.
const PUSH_TOPIC = "notice";

export interface WebPushOptions {
  /** The VAPID secret key, as `vapidKeys` takes it. */
  readonly secretKey: string;
  /**
   * Who the push services may contact about our sends (RFC 8292 section
   * 2.1): a `mailto:` address or an https URL. Apple refuses tokens without it.
   */
  readonly subject: string;
  /** How long to wait for a push service before answering `unavailable`. */
  readonly timeoutMs?: number;
  /** For tests; the platform's otherwise. */
  readonly fetch?: typeof globalThis.fetch;
}

function checkSubject(subject: string): void {
  if (subject.startsWith("mailto:")) {
    const address = subject.slice("mailto:".length);
    if (parseEmailAddress(address) === address && /^[\x21-\x7e]+$/.test(address)) return;
  } else if (URL.canParse(subject)) {
    const url = new URL(subject);
    if (url.protocol === "https:" && url.href === subject) return;
  }
  throw new Error("subject is neither a mailto: address nor an https URL");
}

/**
 * Sends each push through the browser's own push service. `sent` on a 2xx
 * answer; `gone` on 404 or 410, which RFC 8030 section 7.3 and the services
 * give for a subscription that has ended; anything else, a timeout or a
 * refused endpoint included, is `unavailable`.
 */
export function createWebPushSender({
  secretKey,
  subject,
  timeoutMs = 5_000,
  fetch = globalThis.fetch,
}: WebPushOptions): PushSender {
  const keys = vapidKeys(secretKey);
  checkSubject(subject);
  return {
    async send(endpoint, now) {
      if (parsePushEndpoint(endpoint) !== endpoint) return "unavailable";
      if (!(now instanceof Date) || Number.isNaN(now.getTime())) return "unavailable";
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            authorization: vapidAuthorization(keys, new URL(endpoint).origin, subject, now),
            ttl: String(PUSH_TTL_SECONDS),
            urgency: "normal",
            topic: PUSH_TOPIC,
          },
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
        await response.body?.cancel();
        if (response.ok) return "sent";
        return response.status === 404 || response.status === 410 ? "gone" : "unavailable";
      } catch {
        return "unavailable";
      }
    },
  };
}
