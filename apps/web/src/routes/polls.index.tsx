import { createFileRoute, redirect } from "@tanstack/react-router";

import { PollRegister, type RegisterFilters } from "../components/poll-register.tsx";
import { fetchPollList } from "../data.ts";
import { COUNTINGS, POLL_STATUSES } from "../poll.ts";
import { streamQuery } from "../stream.ts";
import { titles } from "../titles.ts";
import { isElectionId, normalizeElectionId, oneOf, searchText } from "../values.ts";

// The lookup form's target, and the register of polls: a poll ID goes to its
// page under the one spelling that names it; anything else comes back to the
// form, above the list, which a search narrows to the polls whose words hold
// every term, as the stream's does.
export const Route = createFileRoute("/polls/")({
  // Always sets every key: the router lays this object over the raw
  // search, so a key left out would keep whatever the URL held (an array,
  // for `?id=a&id=b`). Anything but a canonical election ID as `after`
  // starts the list from the beginning. `q` stays as typed, for the box;
  // `streamQuery` reads it.
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    id: string | undefined;
    after: string | undefined;
    q: string | undefined;
  } & Omit<RegisterFilters, "q"> => {
    const id = searchText(search["id"]);
    const after = searchText(search["after"]);
    return {
      id: id?.slice(0, 256),
      after: isElectionId(after) ? after : undefined,
      q: searchText(search["q"]),
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
  loaderDeps: ({ search }) => ({ after: search.after ?? "", query: streamQuery(search.q) }),
  // A query the API wouldn't take is refused here, without a request.
  loader: ({ context: { locale }, deps: { after, query } }) =>
    query.kind === "refused"
      ? { page: { kind: "search-refused" as const }, phoneVerification: false }
      : fetchPollList({ data: { after, q: query.kind === "search" ? query.q : "", locale } }),
  head: ({ match }) => {
    const { pageTitle, text } = titles(match.context.locale);
    return { meta: [pageTitle(text("navPolls"))] };
  },
  component: function Polls() {
    const { id, after, q, status, counting } = Route.useSearch();
    const { page, phoneVerification } = Route.useLoaderData();
    const query = streamQuery(q);
    return (
      <PollRegister
        page={page}
        after={after}
        typed={q ?? ""}
        filters={{ q: query.kind === "search" ? query.q : undefined, status, counting }}
        invalid={id}
        phoneVerification={phoneVerification}
      />
    );
  },
});
