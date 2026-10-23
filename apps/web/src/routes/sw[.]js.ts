import { createFileRoute } from "@tanstack/react-router";

import { offlinePage, pushNotice } from "../app/offline-page.tsx";
import { offlineWorkerConfig, offlineWorkerSource, shellLocale } from "../app/offline.ts";
import { loadCatalog } from "../messages.ts";
import stylesheet from "../styles.css?url";

// The offline shell's service worker (P2-28 part 1b, src/app/offline.ts),
// which also shows web push's notice (P2-27 part 4b), given its own headers
// (src/security.ts, `workerHeaders`). Its text names the offline page's hash
// and the notice's words, so it changes whenever either does. Its language
// is its address's (`?lang=`, P2-28 part 4c), never the request's cookie or
// `Accept-Language`, so one address is the same worker for everyone.
export const Route = createFileRoute("/sw.js")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const locale = shellLocale(new URL(request.url).search);
        if (locale === undefined) return new Response(null, { status: 404 });
        await loadCatalog(locale);
        const config = await offlineWorkerConfig(
          locale,
          offlinePage(locale, stylesheet),
          stylesheet,
          pushNotice(locale),
        );
        return new Response(offlineWorkerSource(config), {
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      },
    },
  },
});
