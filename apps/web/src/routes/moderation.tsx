import { createFileRoute } from "@tanstack/react-router";

import { ModerationLog } from "../components/moderation-log.tsx";
import { fetchModerationLog } from "../data.ts";
import { LOG_ACTIONS, type LogAction } from "../log-actions.ts";
import { isCanonicalU64, oneOf, searchText } from "../values.ts";
import { LOG_PAGE } from "../page-sizes.ts";
import { titles } from "../titles.ts";

export const Route = createFileRoute("/moderation")({
  // Always sets `after`, as in polls.index.tsx: anything but a canonical
  // u64 starts the log from the beginning. `action` filters the page in
  // hand, as the board's `kind` does, so it is no loader dependency: the API
  // is asked for the same page whatever the filter (T-10).
  validateSearch: (
    search: Record<string, unknown>,
  ): { after: string | undefined; action: LogAction | "all" | undefined } => {
    const after = searchText(search["after"]);
    return {
      after: isCanonicalU64(after) ? after : undefined,
      action: oneOf(search["action"], LOG_ACTIONS),
    };
  },
  loaderDeps: ({ search }) => ({ after: search.after ?? "0" }),
  loader: ({ deps }) => fetchModerationLog({ data: deps.after }),
  head: ({ match }) => {
    const { pageTitle, text } = titles(match.context.locale);
    return { meta: [pageTitle(text("navModeration"))] };
  },
  component: function Moderation() {
    const log = Route.useLoaderData();
    const { after, action } = Route.useSearch();
    const last = log.entries.at(-1);
    const next = log.entries.length === LOG_PAGE && last !== undefined ? last.seq : undefined;
    return <ModerationLog log={log} after={after} next={next} action={action} />;
  },
});
