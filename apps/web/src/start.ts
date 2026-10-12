import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";

import { newNonce, securityHeaders } from "./security.ts";

// Server functions are reachable only from our own pages: a request from
// another origin is refused before any handler runs. Page loads are plain
// GETs and need no check.
const csrf = createCsrfMiddleware({ filter: ({ handlerType }) => handlerType === "serverFn" });

// Every response gets the security headers, its CSP naming the nonce the
// router stamps on the inline scripts it renders (src/router.tsx).
const headers = createMiddleware().server(async ({ next }) => {
  const nonce = newNonce();
  const result = await next({ context: { nonce } });
  // A copy: a response's own headers can be immutable (redirects, fetches).
  const response = new Response(result.response.body, result.response);
  for (const [name, value] of Object.entries(securityHeaders(nonce)))
    response.headers.set(name, value);
  return { ...result, response };
});

export const startInstance = createStart(() => ({ requestMiddleware: [headers, csrf] }));
