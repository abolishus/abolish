import { getGlobalStartContext } from "@tanstack/react-start";
import { createRouter, parseSearchWith, stringifySearchWith } from "@tanstack/react-router";

import { Failed, NotFound } from "./components/site-layout.tsx";
import { routeTree } from "./routeTree.gen.ts";

// Search parameters stay the text they were: the router's default reads them
// as JSON and writes strings back quoted, so `?after=7` would come back as
// `?after=%227%22`. Each route's validateSearch reads what it needs.
const keepText = () => {
  throw new SyntaxError("search parameters are text");
};

export function getRouter() {
  const nonce = getGlobalStartContext()?.nonce;
  return createRouter({
    routeTree,
    // On the server, the inline scripts the router renders carry this
    // response's nonce, the only one its CSP allows (src/start.ts).
    ...(nonce === undefined ? {} : { ssr: { nonce } }),
    parseSearch: parseSearchWith(keepText),
    stringifySearch: stringifySearchWith(JSON.stringify),
    defaultNotFoundComponent: NotFound,
    defaultErrorComponent: Failed,
    scrollRestoration: true,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
