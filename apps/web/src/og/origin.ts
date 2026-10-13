import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestUrl } from "@tanstack/react-start/server";

/**
 * This site's origin: on the server, the request's, which the Node front
 * builds on the configured origin and never on the Host header a client sent
 * (src/node/serve.ts).
 */
export const siteOrigin = createIsomorphicFn()
  .server(() => getRequestUrl().origin)
  .client(() => window.location.origin);
