import { createFileRoute } from "@tanstack/react-router";

import { offlinePage } from "../app/offline-page.tsx";
import stylesheet from "../styles.css?url";

// The offline shell's page (P2-28 part 1b, src/app/offline.ts): rendered here
// as static HTML, never through the router's document with its scripts, and
// given its own headers (src/security.ts, `offlineHeaders`). The worker
// fetches it once when it installs; nothing here reads the request.
export const Route = createFileRoute("/offline")({
  server: {
    handlers: {
      GET: () =>
        new Response(offlinePage(stylesheet), {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    },
  },
});
