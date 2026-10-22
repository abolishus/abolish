import { createFileRoute } from "@tanstack/react-router";

import { StreamPage } from "../components/stream.tsx";
import { fetchStream } from "../data.ts";
import { STREAM_SORTS, type StreamSort } from "../stream.ts";
import { isElectionId, searchText } from "../values.ts";

// The stream: the polls open now, in one of the API's public orders.
export const Route = createFileRoute("/discover")({
  // Always sets every key, as the register's does: a key left out would keep
  // whatever the URL held. An order not on the list is no order, which is
  // `new`, and anything but a canonical election ID as `after` starts from
  // the top.
  validateSearch: (
    search: Record<string, unknown>,
  ): { sort: StreamSort | undefined; after: string | undefined } => {
    const sort = searchText(search["sort"]);
    const after = searchText(search["after"]);
    return {
      sort: STREAM_SORTS.find((s) => s === sort),
      after: isElectionId(after) ? after : undefined,
    };
  },
  loaderDeps: ({ search }) => ({ sort: search.sort ?? "new", after: search.after ?? "" }),
  loader: ({ deps }) => fetchStream({ data: deps }),
  component: function Discover() {
    const { sort } = Route.useSearch();
    const { stream, ballot } = Route.useLoaderData();
    return <StreamPage stream={stream} sort={sort ?? "new"} ballot={ballot} />;
  },
});
