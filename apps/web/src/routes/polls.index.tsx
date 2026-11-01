import { POLL_TOPICS } from "@abolishus/core/poll-topics";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { PollRegister, type RegisterFilters } from "../components/poll-register.tsx";
import { fetchPollList } from "../data.ts";
import { POLL_TOPIC_MESSAGES } from "../messages.ts";
import { COUNTINGS, POLL_STATUSES } from "../poll.ts";
import { streamPlace, streamQuery } from "../stream.ts";
import { titles } from "../titles.ts";
import { isElectionId, normalizeElectionId, oneOf, searchText } from "../values.ts";

// The lookup form's target, and the register of polls: a poll ID goes to its
// page under the one spelling that names it; anything else comes back to the
// form, above the list, which a search narrows to the polls whose words hold
// every term and to those filed under a topic or at a place, as the stream's
// does.
export const Route = createFileRoute("/polls/")({
  // Always sets every key: the router lays this object over the raw
  // search, so a key left out would keep whatever the URL held (an array,
  // for `?id=a&id=b`). Anything but a canonical election ID as `after`
  // starts the list from the beginning, and a topic not on the list is no
  // topic. `q` and `place` stay as typed, for the form; `streamQuery` and
  // `streamPlace` read them.
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    id: string | undefined;
    after: string | undefined;
    q: string | undefined;
    place: string | undefined;
  } & Omit<RegisterFilters, "q" | "place"> => {
    const id = searchText(search["id"]);
    const after = searchText(search["after"]);
    const topic = searchText(search["topic"]);
    return {
      id: id?.slice(0, 256),
      after: isElectionId(after) ? after : undefined,
      q: searchText(search["q"]),
      topic: POLL_TOPICS.find((t) => t === topic),
      place: searchText(search["place"]),
      status: oneOf(search["status"], POLL_STATUSES),
      counting: oneOf(search["counting"], COUNTINGS),
    };
  },
  beforeLoad: ({ search }) => {
    if (search.id === undefined) return;
    const electionId = normalizeElectionId(search.id);
    if (electionId !== undefined)
      throw redirect({ to: "/polls/$electionId", params: { electionId } });
  },
  loaderDeps: ({ search }) => ({
    after: search.after ?? "",
    query: streamQuery(search.q),
    topic: search.topic ?? "",
    place: streamPlace(search.place),
  }),
  // A query or place the API wouldn't take is refused here, without a request.
  loader: ({ context: { locale }, deps: { after, query, topic, place } }) =>
    query.kind === "refused"
      ? { page: { kind: "search-refused" as const }, phoneVerification: false }
      : place.kind === "refused"
        ? { page: { kind: "place-refused" as const }, phoneVerification: false }
        : fetchPollList({
            data: {
              after,
              q: query.kind === "search" ? query.q : "",
              topic,
              place: place.kind === "place" ? place.place : "",
              locale,
            },
          }),
  // A topic's register is named by the topic, from the fixed list, as the
  // stream's is; a search or a place is never in the title (T-67).
  head: ({ match }) => {
    const { search } = match;
    const { pageTitle, text } = titles(match.context.locale);
    return {
      meta: [
        search.topic === undefined
          ? pageTitle(text("navPolls"))
          : pageTitle(text(POLL_TOPIC_MESSAGES[search.topic]), text("navPolls")),
      ],
    };
  },
  component: function Polls() {
    const { id, after, q, topic, place, status, counting } = Route.useSearch();
    const { page, phoneVerification } = Route.useLoaderData();
    const query = streamQuery(q);
    const filed = streamPlace(place);
    return (
      <PollRegister
        page={page}
        after={after}
        typed={q ?? ""}
        typedPlace={place ?? ""}
        filters={{
          q: query.kind === "search" ? query.q : undefined,
          topic,
          place: filed.kind === "place" ? filed.place : undefined,
          status,
          counting,
        }}
        invalid={id}
        phoneVerification={phoneVerification}
      />
    );
  },
});
