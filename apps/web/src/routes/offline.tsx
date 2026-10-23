import { createFileRoute } from "@tanstack/react-router";

import { offlinePage } from "../app/offline-page.tsx";
import { shellLocale } from "../app/offline.ts";
import { loadCatalog } from "../messages.ts";
import stylesheet from "../styles.css?url";

// The offline shell's page (P2-28 part 1b, src/app/offline.ts): rendered here
// as static HTML, never through the router's document with its scripts, and
// given its own headers (src/security.ts, `offlineHeaders`). The worker
// fetches it once when it installs; nothing here reads the request but its
// query, which names the page's language (`?lang=`, P2-28 part 4c).
export const Route = createFileRoute("/offline")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const locale = shellLocale(new URL(request.url).search);
        if (locale === undefined) return new Response(null, { status: 404 });
        await loadCatalog(locale);
        return new Response(offlinePage(locale, stylesheet), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    },
  },
});
