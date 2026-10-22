import { createFileRoute } from "@tanstack/react-router";

import { StreamPage } from "../components/stream.tsx";
import { fetchStream } from "../data.ts";
import { STREAM_SORTS, type StreamSort, streamQuery } from "../stream.ts";
import { isElectionId, searchText } from "../values.ts";

// The stream: the polls open now, in one of the API's public orders, and
// only those whose question holds every word of a search when there is one.
export const Route = createFileRoute("/discover")({
  // Always sets every key, as the register's does: a key left out would keep
  // whatever the URL held. An order not on the list is no order, which is
  // `new`, and anything but a canonical election ID as `after` starts from
  // the top. `q` stays as typed, for the search box; `streamQuery` reads it.
  validateSearch: (
    search: Record<string, unknown>,
  ): { sort: StreamSort | undefined; after: string | undefined; q: string | undefined } => {
    const sort = searchText(search["sort"]);
    const after = searchText(search["after"]);
    return {
      sort: STREAM_SORTS.find((s) => s === sort),
      after: isElectionId(after) ? after : undefined,
      q: searchText(search["q"]),
    };
  },
  loaderDeps: ({ search }) => ({
    sort: search.sort ?? "new",
    after: search.after ?? "",
    query: streamQuery(search.q),
  }),
  // A query the API wouldn't take is refused here, without a request.
  loader: ({ deps: { sort, after, query } }) =>
    query.kind === "refused"
      ? { stream: { kind: "search-refused" as const }, ballot: null }
      : fetchStream({ data: { sort, after, q: query.kind === "search" ? query.q : "" } }),
  component: function Discover() {
    const { sort, q } = Route.useSearch();
    const { stream, ballot } = Route.useLoaderData();
    const query = streamQuery(q);
    return (
      <StreamPage
        stream={stream}
        sort={sort ?? "new"}
        typed={q ?? ""}
        q={query.kind === "search" ? query.q : undefined}
        ballot={ballot}
      />
    );
  },
});
