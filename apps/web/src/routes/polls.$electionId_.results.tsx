import { useTranslate } from "@abolishus/ui";
import { createFileRoute, notFound } from "@tanstack/react-router";

import { PollResultsPage } from "../components/poll-results-page.tsx";
import { Notice } from "../components/site-layout.tsx";
import { fetchPhoneVerification, fetchResultsPage } from "../data.ts";
import { catalogs } from "../messages.ts";
import { pollStatus } from "../poll.ts";
import { titles } from "../titles.ts";
import { isElectionId } from "../values.ts";

// A poll's results page, `/polls/<id>/results`: not nested in the poll page,
// which is a page of its own, as the board's is.
export const Route = createFileRoute("/polls/$electionId_/results")({
  loader: async ({ params }) => {
    // One spelling per poll (T-31), as on the poll page.
    if (!isElectionId(params.electionId)) throw notFound();
    const page = await fetchResultsPage({ data: params.electionId });
    if (page.kind === "not-found") throw notFound();
    return { page, phoneVerification: await fetchPhoneVerification() };
  },
  head: ({ match, loaderData, params }) => {
    const { pageTitle, text } = titles(match.context.locale);
    const page = loaderData?.page;
    return {
      meta:
        page === undefined
          ? []
          : [
              pageTitle(
                text(page.kind === "unavailable" ? "unavailableTitle" : "resultsPageTitle"),
                text("pollHeading", { prefix: params.electionId.slice(0, 16) }),
              ),
              // A hidden poll stays reachable by link, but out of search
              // engines, as its page is (docs/moderation-policy.md).
              ...(page.kind === "results" && page.hidden
                ? [{ name: "robots", content: "noindex" }]
                : []),
            ],
    };
  },
  component: function Results() {
    const t = useTranslate(catalogs);
    const { page, phoneVerification } = Route.useLoaderData();
    if (page.kind === "results")
      return (
        <PollResultsPage
          poll={page.poll}
          heading={page.text?.heading}
          results={page.results}
          cells={page.cells}
          status={pollStatus(page.poll, page.asOf)}
          words={page.words}
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
