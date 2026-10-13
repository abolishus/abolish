import { useTranslate } from "@abolishus/ui";
import { createFileRoute, notFound } from "@tanstack/react-router";

import { PollSummary } from "../components/poll-summary.tsx";
import { Notice } from "../components/site-layout.tsx";
import { fetchPoll } from "../data.ts";
import { catalogs } from "../messages.ts";
import { siteOrigin } from "../og/origin.ts";
import { previewMeta } from "../og/poll.ts";
import { PREVIEW_SIZE } from "../og/model.ts";
import { isElectionId } from "../values.ts";

export const Route = createFileRoute("/polls/$electionId")({
  loader: async ({ params }) => {
    // One spelling per poll (T-31): anything but canonical hex isn't a poll page.
    if (!isElectionId(params.electionId)) throw notFound();
    const page = await fetchPoll({ data: params.electionId });
    if (page.kind === "not-found") throw notFound();
    const preview =
      page.kind === "poll" ? await previewMeta(page.poll, siteOrigin(), Date.now()) : undefined;
    return { page, preview };
  },
  head: ({ loaderData }) => {
    const page = loaderData?.page;
    const preview = loaderData?.preview;
    return {
      meta: [
        // A delisted or hidden poll stays reachable by link, but out of search
        // engines too (docs/moderation-policy.md).
        ...(page?.kind === "poll" && page.moderation.state !== "visible"
          ? [{ name: "robots", content: "noindex" }]
          : []),
        // The link preview (docs/design/sharing.md): a chat shows the image
        // with this text under it.
        ...(preview === undefined
          ? []
          : [
              { property: "og:type", content: "website" },
              { property: "og:title", content: preview.title },
              { property: "og:description", content: preview.description },
              { property: "og:image", content: preview.image },
              { property: "og:image:type", content: "image/png" },
              { property: "og:image:width", content: String(PREVIEW_SIZE.landscape.width) },
              { property: "og:image:height", content: String(PREVIEW_SIZE.landscape.height) },
              { property: "og:image:alt", content: `${preview.title}. ${preview.description}` },
              { name: "twitter:card", content: "summary_large_image" },
              { name: "twitter:image", content: preview.image },
            ]),
      ],
    };
  },
  component: function Poll() {
    const t = useTranslate(catalogs);
    const { page } = Route.useLoaderData();
    if (page.kind === "poll") return <PollSummary {...page} />;
    return (
      <Notice title={t("unavailableTitle")}>
        {t(page.problem === "undecodable" ? "definitionUndecodable" : "definitionMismatch")}
      </Notice>
    );
  },
});
