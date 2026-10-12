import { useTranslate } from "@abolishus/ui";
import { createFileRoute, notFound } from "@tanstack/react-router";

import { PollSummary } from "../components/poll-summary.tsx";
import { Notice } from "../components/site-layout.tsx";
import { fetchPoll } from "../data.ts";
import { isElectionId } from "../values.ts";
import { catalogs } from "../messages.ts";

export const Route = createFileRoute("/polls/$electionId")({
  loader: async ({ params }) => {
    // One spelling per poll (T-31): anything but canonical hex isn't a poll page.
    if (!isElectionId(params.electionId)) throw notFound();
    const page = await fetchPoll({ data: params.electionId });
    if (page.kind === "not-found") throw notFound();
    return page;
  },
  head: ({ loaderData }) => ({
    // A delisted or hidden poll stays reachable by link, but out of search
    // engines too (docs/moderation-policy.md).
    meta:
      loaderData?.kind === "poll" && loaderData.moderation.state !== "visible"
        ? [{ name: "robots", content: "noindex" }]
        : [],
  }),
  component: function Poll() {
    const t = useTranslate(catalogs);
    const page = Route.useLoaderData();
    if (page.kind === "poll") return <PollSummary {...page} />;
    return (
      <Notice title={t("unavailableTitle")}>
        {t(page.problem === "undecodable" ? "definitionUndecodable" : "definitionMismatch")}
      </Notice>
    );
  },
});
