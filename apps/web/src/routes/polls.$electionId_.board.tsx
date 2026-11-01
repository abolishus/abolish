import { useTranslate } from "@abolishus/ui";
import { createFileRoute, notFound } from "@tanstack/react-router";

import { PollBoard } from "../components/poll-board.tsx";
import { ENTRY_KINDS, type EntryKind } from "../entry-kinds.ts";
import { Notice } from "../components/site-layout.tsx";
import { fetchBoardPage } from "../data.ts";
import { catalogs } from "../messages.ts";
import { ACTIVITY_PAGE, ANCHOR_PAGE, BOARD_PAGE } from "../page-sizes.ts";
import { titles } from "../titles.ts";
import { isCanonicalU64, isElectionId, oneOf, searchText } from "../values.ts";

// A poll's board, `/polls/<id>/board?from=<entry>`: not nested in the poll
// page, which is a page of its own.
export const Route = createFileRoute("/polls/$electionId_/board")({
  // Always sets `from`, as in moderation.tsx: anything but a canonical u64
  // that starts a page (src/page-sizes.ts, `BOARD_PAGE`) starts the board
  // from its first entry. `kind` filters the page in hand, as the register's
  // filters do, so it is no loader dependency: the API is asked for the same
  // page whatever the filter, and never learns what a visitor looked for (T-10).
  validateSearch: (
    search: Record<string, unknown>,
  ): { from: string | undefined; kind: EntryKind | "all" | undefined } => {
    const from = searchText(search["from"]);
    return {
      from: isCanonicalU64(from) && BigInt(from) % BigInt(BOARD_PAGE) === 0n ? from : undefined,
      kind: oneOf(search["kind"], ENTRY_KINDS),
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
    const { kind } = Route.useSearch();
    if (page.kind === "board" || page.kind === "beyond")
      return (
        <PollBoard
          poll={page.poll}
          head={page.head}
          from={page.from}
          rows={page.kind === "board" ? page.rows : undefined}
          kind={kind}
          inclusion={page.kind === "board" ? page.inclusion : undefined}
          ceremony={page.kind === "board" ? page.ceremony : undefined}
          pageSize={BOARD_PAGE}
          anchors={page.anchors}
          histories={page.histories}
          activityPage={ACTIVITY_PAGE}
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
