import { createFileRoute } from "@tanstack/react-router";

import { offlinePage } from "../app/offline-page.tsx";
import { offlineWorkerConfig, offlineWorkerSource } from "../app/offline.ts";
import stylesheet from "../styles.css?url";

// The offline shell's service worker (P2-28 part 1b, src/app/offline.ts),
// given its own headers (src/security.ts, `workerHeaders`). Its text names
// the offline page's hash, so it changes whenever that page does.
export const Route = createFileRoute("/sw.js")({
  server: {
    handlers: {
      GET: async () =>
        new Response(
          offlineWorkerSource(await offlineWorkerConfig(offlinePage(stylesheet), stylesheet)),
          { headers: { "content-type": "text/javascript; charset=utf-8" } },
        ),
    },
  },
});
