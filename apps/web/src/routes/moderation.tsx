import { createFileRoute } from "@tanstack/react-router";

import { ModerationLog } from "../components/moderation-log.tsx";
import { fetchModerationLog } from "../data.ts";
import { isCanonicalU64, searchText } from "../values.ts";
import { LOG_PAGE } from "../page-sizes.ts";
import { pageTitle, text } from "../titles.ts";

export const Route = createFileRoute("/moderation")({
  // Always sets `after`, as in polls.index.tsx: anything but a canonical
  // u64 starts the log from the beginning.
  validateSearch: (search: Record<string, unknown>): { after: string | undefined } => {
    const after = searchText(search["after"]);
    return { after: isCanonicalU64(after) ? after : undefined };
  },
  loaderDeps: ({ search }) => ({ after: search.after ?? "0" }),
  loader: ({ deps }) => fetchModerationLog({ data: deps.after }),
  head: () => ({ meta: [pageTitle(text("navModeration"))] }),
  component: function Moderation() {
    const log = Route.useLoaderData();
    const last = log.entries.at(-1);
    const next = log.entries.length === LOG_PAGE && last !== undefined ? last.seq : undefined;
    return <ModerationLog log={log} next={next} />;
  },
});
