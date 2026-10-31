import { POLL_TOPICS, type PollTopic } from "@abolishus/core/poll-topics";
import { createFileRoute } from "@tanstack/react-router";

import { StreamPage } from "../components/stream.tsx";
import { fetchStream } from "../data.ts";
import { POLL_TOPIC_MESSAGES } from "../messages.ts";
import { STREAM_SORTS, type StreamSort, streamPlace, streamQuery } from "../stream.ts";
import { titles } from "../titles.ts";
import { isElectionId, searchText } from "../values.ts";

// The stream: the polls open now, in one of the API's public orders, and
// only those whose question holds every word of a search, and that their
// authors filed under a topic or at a place, when the page asks for them.
export const Route = createFileRoute("/discover")({
  // Always sets every key, as the register's does: a key left out would keep
  // whatever the URL held. An order not on the list is no order, which is
  // `new`, a topic not on the list is no topic, and anything but a canonical
  // election ID as `after` starts from the top. `q` and `place` stay as
  // typed, for the form; `streamQuery` and `streamPlace` read them.
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    sort: StreamSort | undefined;
    after: string | undefined;
    q: string | undefined;
    topic: PollTopic | undefined;
    place: string | undefined;
  } => {
    const sort = searchText(search["sort"]);
    const after = searchText(search["after"]);
    const topic = searchText(search["topic"]);
    return {
      sort: STREAM_SORTS.find((s) => s === sort),
      after: isElectionId(after) ? after : undefined,
      q: searchText(search["q"]),
      topic: POLL_TOPICS.find((t) => t === topic),
      place: searchText(search["place"]),
    };
  },
  loaderDeps: ({ search }) => ({
    sort: search.sort ?? "new",
    after: search.after ?? "",
    query: streamQuery(search.q),
    topic: search.topic ?? "",
    place: streamPlace(search.place),
  }),
  // A query or place the API wouldn't take is refused here, without a request.
  loader: ({ context: { locale }, deps: { sort, after, query, topic, place } }) =>
    query.kind === "refused"
      ? { stream: { kind: "search-refused" as const }, ballot: null, phoneVerification: false }
      : place.kind === "refused"
        ? { stream: { kind: "place-refused" as const }, ballot: null, phoneVerification: false }
        : fetchStream({
            data: {
              sort,
              after,
              q: query.kind === "search" ? query.q : "",
              topic,
              place: place.kind === "place" ? place.place : "",
              locale,
            },
          }),
  // A topic's page is named by the topic, from the fixed list; a search or a
  // place is never in the title (T-67).
  head: ({ match }) => {
    const { search } = match;
    const { pageTitle, text } = titles(match.context.locale);
    return {
      meta: [
        search.topic === undefined
          ? pageTitle(text("navDiscover"))
          : pageTitle(text(POLL_TOPIC_MESSAGES[search.topic]), text("navDiscover")),
      ],
    };
  },
  component: function Discover() {
    const { sort, after, q, topic, place } = Route.useSearch();
    const { stream, ballot, phoneVerification } = Route.useLoaderData();
    const query = streamQuery(q);
    const filter = streamPlace(place);
    return (
      <StreamPage
        stream={stream}
        sort={sort ?? "new"}
        typed={q ?? ""}
        typedPlace={place ?? ""}
        filter={{
          q: query.kind === "search" ? query.q : undefined,
          topic,
          place: filter.kind === "place" ? filter.place : undefined,
        }}
        ballot={ballot}
        phoneVerification={phoneVerification}
        later={after !== undefined}
      />
    );
  },
});
