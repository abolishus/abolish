import { useTranslate } from "@abolishus/ui";
import { createFileRoute, notFound } from "@tanstack/react-router";

import { PollBoard } from "../components/poll-board.tsx";
import { Notice } from "../components/site-layout.tsx";
import { fetchBoardPage } from "../data.ts";
import { catalogs } from "../messages.ts";
import { ANCHOR_PAGE, BOARD_PAGE } from "../page-sizes.ts";
import { titles } from "../titles.ts";
import { isCanonicalU64, isElectionId, searchText } from "../values.ts";

// A poll's board, `/polls/<id>/board?from=<entry>`: not nested in the poll
// page, which is a page of its own.
export const Route = createFileRoute("/polls/$electionId_/board")({
  // Always sets `from`, as in moderation.tsx: anything but a canonical u64
  // that starts a page (src/page-sizes.ts, `BOARD_PAGE`) starts the board
  // from its first entry.
  validateSearch: (search: Record<string, unknown>): { from: string | undefined } => {
    const from = searchText(search["from"]);
    return {
      from: isCanonicalU64(from) && BigInt(from) % BigInt(BOARD_PAGE) === 0n ? from : undefined,
    };
  },
  loaderDeps: ({ search }) => ({ from: search.from ?? "0" }),
  loader: async ({ params, deps }) => {
    // One spelling per poll (T-31), as on the poll page.
    if (!isElectionId(params.electionId)) throw notFound();
    const page = await fetchBoardPage({ data: { electionId: params.electionId, from: deps.from } });
    if (page.kind === "not-found") throw notFound();
    return page;
  },
  head: ({ match, loaderData, params }) => {
    const { pageTitle, text } = titles(match.context.locale);
    return {
      meta:
        loaderData === undefined
          ? []
          : [
              pageTitle(
                text(loaderData.kind === "unavailable" ? "unavailableTitle" : "boardPageTitle"),
                text("pollHeading", { prefix: params.electionId.slice(0, 16) }),
              ),
            ],
    };
  },
  component: function Board() {
    const t = useTranslate(catalogs);
    const page = Route.useLoaderData();
    if (page.kind === "board" || page.kind === "beyond")
      return (
        <PollBoard
          poll={page.poll}
          head={page.head}
          from={page.from}
          rows={page.kind === "board" ? page.rows : undefined}
          pageSize={BOARD_PAGE}
          anchors={page.anchors}
          anchorPage={ANCHOR_PAGE}
        />
      );
    return (
      <Notice title={t("unavailableTitle")}>
        {t(
          page.problem === "undecodable"
            ? "definitionUndecodable"
            : page.problem === "another-election"
              ? "definitionMismatch"
              : "boardEntriesUndecodable",
        )}
      </Notice>
    );
  },
});
