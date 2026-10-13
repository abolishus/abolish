import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";

import { imageHeaders, newNonce, securityHeaders } from "./security.ts";

// Server functions are reachable only from our own pages: a request from
// another origin is refused before any handler runs. Page loads are plain
// GETs and need no check.
const csrf = createCsrfMiddleware({ filter: ({ handlerType }) => handlerType === "serverFn" });

// Every response gets the security headers, its CSP naming the nonce the
// router stamps on the inline scripts it renders (src/router.tsx). A link
// preview's PNG gets the image's set instead, keeping its route's caching.
const headers = createMiddleware().server(async ({ next }) => {
  const nonce = newNonce();
  const result = await next({ context: { nonce } });
  // A copy: a response's own headers can be immutable (redirects, fetches).
  const response = new Response(result.response.body, result.response);
  const image = response.headers.get("content-type") === "image/png";
  // A redirect carries no document, so no nonce: one its route made cacheable
  // (a short link, src/routes/p.$code.tsx) keeps its caching. Every other
  // redirect sets none and gets `no-store` like a page.
  const redirectCaching =
    response.status >= 300 && response.status < 400 ? response.headers.get("cache-control") : null;
  for (const [name, value] of Object.entries(image ? imageHeaders() : securityHeaders(nonce)))
    response.headers.set(name, value);
  if (redirectCaching !== null) response.headers.set("cache-control", redirectCaching);
  if (image) response.headers.delete("set-cookie");
  return { ...result, response };
});

export const startInstance = createStart(() => ({ requestMiddleware: [headers, csrf] }));
