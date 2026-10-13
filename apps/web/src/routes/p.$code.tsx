import { parseShortCode } from "@abolishus/core/short-codes";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

import { fetchShortLink } from "../data.ts";

/**
 * How long a browser or proxy may keep a short link's redirect. A code that
 * resolves never moves to another poll (docs/design/sharing.md, Short links),
 * so it may be cached; a day rather than for good bounds how long a code our
 * database pointed at the wrong poll keeps sending visitors there once fixed.
 */
export const SHORT_LINK_MAX_AGE = 86_400;

// A poll's short link, `/p/<code>` (docs/design/sharing.md): any forgiving
// form of a code the poll owns sends the visitor to its page. A QR code
// carries the upper-case form, which the router matches too, since routes
// aren't case-sensitive. Anything else is the site's 404, which never
// quotes the input; the code itself never reaches analytics (`/p/:code`,
// src/analytics.ts; T-67).
export const Route = createFileRoute("/p/$code")({
  loader: async ({ params }) => {
    const code = parseShortCode(params.code);
    if (code === undefined) throw notFound();
    const link = await fetchShortLink({ data: code });
    if (link.kind === "not-found") throw notFound();
    // 301, not 308: the same for a GET, and the permanent redirect every
    // link-preview crawler follows (docs/design/sharing.md).
    throw redirect({
      to: "/polls/$electionId",
      params: { electionId: link.electionId },
      statusCode: 301,
      headers: { "cache-control": `public, max-age=${SHORT_LINK_MAX_AGE}` },
    });
  },
});
