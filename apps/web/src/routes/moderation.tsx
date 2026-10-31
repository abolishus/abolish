import { createFileRoute } from "@tanstack/react-router";

import { ModerationLog } from "../components/moderation-log.tsx";
import { fetchModerationLog } from "../data.ts";
import { LOG_ACTIONS, type LogAction } from "../log-actions.ts";
import { isCanonicalU64, oneOf, searchText } from "../values.ts";
import { LOG_LATEST, LOG_PAGE } from "../page-sizes.ts";
import { titles } from "../titles.ts";

export const Route = createFileRoute("/moderation")({
  // A page starts below `before` or above `after`, never both: anything but a
  // canonical u64 is neither, and with neither the page shows the latest
  // decisions; `before` wins when both are given. `action` filters the page
  // in hand, as the board's `kind` does, so it is no loader dependency: the
  // API is asked for the same page whatever the filter (T-10).
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    before: string | undefined;
    after: string | undefined;
    action: LogAction | "all" | undefined;
  } => {
    const before = searchText(search["before"]);
    const after = searchText(search["after"]);
    return {
      before: isCanonicalU64(before) ? before : undefined,
      after: isCanonicalU64(before) || !isCanonicalU64(after) ? undefined : after,
      action: oneOf(search["action"], LOG_ACTIONS),
    };
  },
  loaderDeps: ({ search: { before, after } }) =>
    after === undefined ? { before: before ?? LOG_LATEST } : { after },
  loader: ({ deps }) => fetchModerationLog({ data: deps }),
  head: ({ match }) => {
    const { pageTitle, text } = titles(match.context.locale);
    return { meta: [pageTitle(text("navModeration"))] };
  },
  component: function Moderation() {
    const log = Route.useLoaderData();
    const { before, after, action } = Route.useSearch();
    const first = log.entries[0];
    const last = log.entries.at(-1);
    // A page read back from a number ends the log when it isn't full; one
    // read forward from a number has the decisions up to it still before it.
    const forward = after !== undefined && !log.latest;
    const next =
      last !== undefined && (forward || log.entries.length === LOG_PAGE) ? last.seq : undefined;
    const later = log.latest ? undefined : first?.seq;
    const place = log.latest
      ? undefined
      : after !== undefined
        ? { after }
        : before === undefined
          ? undefined
          : { before };
    return <ModerationLog log={log} place={place} next={next} later={later} action={action} />;
  },
});
