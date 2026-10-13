// The poll's link preview as PNG (docs/design/sharing.md): 1200×630, or
// 1080×1080 with `?format=square`. Built from public data only, like the
// page, and rendered here: no third-party image service sees the poll.
//
// `?v=` names a version (src/og/poll.ts). The current version is cached for
// good; anything else is answered with the current image, briefly cacheable
// and revalidated by its ETag, so a chat that kept an old URL still gets
// what is true now.

import { createFileRoute } from "@tanstack/react-router";

import { pollPreview, previewVersion } from "../og/poll.ts";
import { api } from "../server/api.ts";
import { loadPoll } from "../server/load.ts";
import { isElectionId } from "../values.ts";

const plain = (status: number) =>
  new Response(`${status}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

export const Route = createFileRoute("/polls/$electionId/preview.png")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        if (!isElectionId(params.electionId)) return plain(404);
        const url = new URL(request.url);
        const format = url.searchParams.get("format");
        const version = url.searchParams.get("v");
        if ([...url.searchParams.keys()].some((k) => k !== "format" && k !== "v"))
          return plain(400);
        if (format !== null && format !== "square") return plain(400);
        const page = await loadPoll(api(), params.electionId);
        if (page.kind !== "poll") return plain(404);
        const shape = format === "square" ? "square" : "landscape";
        const model = pollPreview(page.poll, url.host, Date.now());
        const current = await previewVersion(model, shape);
        const etag = `"${current}"`;
        const headers = {
          "content-type": "image/png",
          etag,
          "cache-control":
            version === current
              ? "public, max-age=31536000, immutable"
              : "public, max-age=300, must-revalidate",
        };
        if (request.headers.get("if-none-match") === etag)
          return new Response(null, { status: 304, headers });
        // Loaded on first use: the renderer carries its fonts and WebAssembly.
        const { renderPreview } = await import("../og/render.ts");
        const png = await renderPreview(model, shape);
        return new Response(png, {
          headers: { ...headers, "content-length": String(png.length) },
        });
      },
    },
  },
});
