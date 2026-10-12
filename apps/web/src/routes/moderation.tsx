import { createFileRoute } from "@tanstack/react-router";

import { ModerationLog } from "../components/moderation-log.tsx";
import { fetchModerationLog } from "../data.ts";
import { isCanonicalU64, searchText } from "../values.ts";
import { LOG_PAGE } from "../server/load.ts";

export const Route = createFileRoute("/moderation")({
  validateSearch: (search: Record<string, unknown>): { after?: string } => {
    const after = searchText(search["after"]);
    return isCanonicalU64(after) ? { after } : {};
  },
  loaderDeps: ({ search }) => ({ after: search.after ?? "0" }),
  loader: ({ deps }) => fetchModerationLog({ data: deps.after }),
  component: function Moderation() {
    const log = Route.useLoaderData();
    const last = log.entries.at(-1);
    const next = log.entries.length === LOG_PAGE && last !== undefined ? last.seq : undefined;
    return <ModerationLog log={log} next={next} />;
  },
});
