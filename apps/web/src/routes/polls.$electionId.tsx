import { useTranslate } from "@abolishus/ui";
import { createFileRoute, notFound } from "@tanstack/react-router";

import { reactionsClient } from "../account/reactions.ts";
import { PollSummary } from "../components/poll-summary.tsx";
import { Notice } from "../components/site-layout.tsx";
import { fetchPhoneVerification, fetchPoll } from "../data.ts";
import { embedHeight } from "../embed.ts";
import { catalogs } from "../messages.ts";
import { siteOrigin } from "../og/origin.ts";
import { previewMeta } from "../og/poll.ts";
import { PREVIEW_SIZE } from "../og/model.ts";
import { titles } from "../titles.ts";
import { isElectionId } from "../values.ts";

export const Route = createFileRoute("/polls/$electionId")({
  loader: async ({ params }) => {
    // One spelling per poll (T-31): anything but canonical hex isn't a poll page.
    if (!isElectionId(params.electionId)) throw notFound();
    const page = await fetchPoll({ data: params.electionId });
    if (page.kind === "not-found") throw notFound();
    const origin = siteOrigin();
    const preview =
      page.kind === "poll"
        ? await previewMeta(page.poll, page.code, origin, Date.now())
        : undefined;
    // The share sheet offers the short link only, the same for everyone
    // (docs/design/sharing.md), and none for a hidden poll, whose text
    // moderation withheld (docs/moderation-policy.md).
    const share =
      page.kind === "poll" &&
      page.code !== undefined &&
      page.moderation.state !== "hidden" &&
      preview !== undefined
        ? {
            url: `${origin}/p/${page.code}`,
            title: preview.title,
            flyer: `/p/${page.code}/flyer`,
            embed: { page: `${origin}/embed/p/${page.code}`, height: embedHeight(page.poll) },
          }
        : undefined;
    return { page, preview, share, phoneVerification: await fetchPhoneVerification() };
  },
  head: ({ match, loaderData }) => {
    const { pageTitle, text } = titles(match.context.locale);
    const page = loaderData?.page;
    const preview = loaderData?.preview;
    return {
      meta: [
        // A poll's page is named as its heading names it; one that isn't
        // there has the root's not-found title.
        ...(page === undefined
          ? []
          : [
              pageTitle(
                page.kind === "poll"
                  ? text("pollHeading", { prefix: page.poll.electionId.slice(0, 16) })
                  : text("unavailableTitle"),
              ),
            ]),
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
    const { page, share, phoneVerification } = Route.useLoaderData();
    if (page.kind === "poll")
      return (
        <PollSummary
          {...page}
          share={share}
          reactions={reactionsClient}
          phoneVerification={phoneVerification}
        />
      );
    return (
      <Notice title={t("unavailableTitle")}>
        {t(page.problem === "undecodable" ? "definitionUndecodable" : "definitionMismatch")}
      </Notice>
    );
  },
});
