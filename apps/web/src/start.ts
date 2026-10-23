import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";

import {
  embedHeaders,
  imageHeaders,
  isChallengePage,
  isEmbedPage,
  isOfflineShell,
  newNonce,
  offlineHeaders,
  securityHeaders,
  workerHeaders,
} from "./security.ts";
import { WORKER_PATH } from "./app/offline.ts";
import { negotiateLocale } from "./locales.ts";
import { loadCatalog } from "./messages.ts";
import type { ReadAskedBy, ReadProfile } from "./server/load.ts";

/**
 * What the front (src/node/serve.ts) hands every request it passes to Start:
 * readers of the account side's public records, which the server functions
 * can't reach through the API, since the API reads no account table (T-10).
 * Each reads by a public key only (a handle, a poll's ID), never by a
 * session: pages never get the account cookie. Optional, so a front without
 * the database (a test's) renders every other page.
 */
export interface StartRequestContext {
  readonly readProfile?: ReadProfile;
  readonly readAskedBy?: ReadAskedBy;
}

declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: StartRequestContext };
  }
}

// Server functions are reachable only from our own pages: a request from
// another origin is refused before any handler runs. Page loads are plain
// GETs and need no check.
const csrf = createCsrfMiddleware({ filter: ({ handlerType }) => handlerType === "serverFn" });

// Every response gets the security headers, its CSP naming the nonce the
// router stamps on the inline scripts it renders (src/router.tsx). A link
// preview's PNG gets the image's set instead, keeping its route's caching.
// Only the poll editor's pages may run Turnstile, and only a poll's embed
// may be framed, with no script at all; the offline shell's page and worker
// get theirs (src/security.ts).
// The page's language is chosen here, once per request, from the footer's
// cookie or the browser's `Accept-Language` (src/locales.ts), and reaches the
// router as its context (src/router.tsx).
const headers = createMiddleware().server(async ({ next, request }) => {
  const nonce = newNonce();
  const locale = negotiateLocale(
    request.headers.get("cookie"),
    request.headers.get("accept-language"),
  );
  await loadCatalog(locale);
  const result = await next({ context: { nonce, locale } });
  // A copy: a response's own headers can be immutable (redirects, fetches).
  const response = new Response(result.response.body, result.response);
  const image = response.headers.get("content-type") === "image/png";
  // A redirect carries no document, so no nonce: one its route made cacheable
  // (a short link, src/routes/p.$code.tsx) keeps its caching. Every other
  // redirect sets none and gets `no-store` like a page.
  const redirectCaching =
    response.status >= 300 && response.status < 400 ? response.headers.get("cache-control") : null;
  const { pathname } = new URL(request.url);
  const embed = !image && isEmbedPage(pathname);
  const offline = !image && isOfflineShell(pathname);
  const challenge = isChallengePage(pathname);
  for (const [name, value] of Object.entries(
    image
      ? imageHeaders()
      : embed
        ? embedHeaders()
        : offline
          ? pathname === WORKER_PATH
            ? workerHeaders()
            : offlineHeaders()
          : securityHeaders(nonce, { challenge }),
  ))
    response.headers.set(name, value);
  // A page is in the language its request chose; the embed and the offline
  // page say their own.
  if (!image && !embed && !offline && response.headers.get("content-type")?.startsWith("text/html"))
    response.headers.set("content-language", locale);
  if (redirectCaching !== null) response.headers.set("cache-control", redirectCaching);
  if (image || embed || offline) response.headers.delete("set-cookie");
  // Only an embed that drew its poll may be cached: a failure is retried.
  if (embed && response.status !== 200) response.headers.set("cache-control", "no-store");
  return { ...result, response };
});

export const startInstance = createStart(() => ({ requestMiddleware: [headers, csrf] }));
