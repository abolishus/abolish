import { createFileRoute } from "@tanstack/react-router";

import { ModerationLog } from "../components/moderation-log.tsx";
import { fetchModerationLog } from "../data.ts";
import { LOG_ACTIONS, type LogAction } from "../log-actions.ts";
import { isCanonicalU64, oneOf, searchText } from "../values.ts";
import { LOG_LATEST, LOG_PAGE } from "../page-sizes.ts";
import { titles } from "../titles.ts";

export const Route = createFileRoute("/moderation")({
  // Always sets `before`, as polls.index.tsx sets `after`: anything but a
  // canonical u64 shows the latest decisions. `action` filters the page in
  // hand, as the board's `kind` does, so it is no loader dependency: the API
  // is asked for the same page whatever the filter (T-10).
  validateSearch: (
    search: Record<string, unknown>,
  ): { before: string | undefined; action: LogAction | "all" | undefined } => {
    const before = searchText(search["before"]);
    return {
      before: isCanonicalU64(before) ? before : undefined,
      action: oneOf(search["action"], LOG_ACTIONS),
    };
  },
  loaderDeps: ({ search }) => ({ before: search.before ?? LOG_LATEST }),
  loader: ({ deps }) => fetchModerationLog({ data: deps.before }),
  head: ({ match }) => {
    const { pageTitle, text } = titles(match.context.locale);
    return { meta: [pageTitle(text("navModeration"))] };
  },
  component: function Moderation() {
    const log = Route.useLoaderData();
    const { before, action } = Route.useSearch();
    const last = log.entries.at(-1);
    const next = log.entries.length === LOG_PAGE && last !== undefined ? last.seq : undefined;
    return <ModerationLog log={log} before={before} next={next} action={action} />;
  },
});
