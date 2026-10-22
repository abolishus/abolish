import { createFileRoute, redirect } from "@tanstack/react-router";

import { PollRegister, type RegisterFilters } from "../components/poll-register.tsx";
import { fetchPollList } from "../data.ts";
import { COUNTINGS, POLL_STATUSES } from "../poll.ts";
import { isElectionId, normalizeElectionId, searchText } from "../values.ts";

/** A filter's value if it is `"all"` or in `allowed`; anything else, a repeat included, is dropped. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | "all" | undefined {
  const given = searchText(value);
  return given === "all" || allowed.some((option) => option === given)
    ? (given as T | "all")
    : undefined;
}

// The lookup form's target, and the register of polls: a poll ID goes to its
// page under the one spelling that names it; anything else comes back to the
// form, above the list.
export const Route = createFileRoute("/polls/")({
  // Always sets every key: the router lays this object over the raw
  // search, so a key left out would keep whatever the URL held (an array,
  // for `?id=a&id=b`). Anything but a canonical election ID as `after`
  // starts the list from the beginning.
  validateSearch: (
    search: Record<string, unknown>,
  ): { id: string | undefined; after: string | undefined } & RegisterFilters => {
    const id = searchText(search["id"]);
    const after = searchText(search["after"]);
    return {
      id: id?.slice(0, 256),
      after: isElectionId(after) ? after : undefined,
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
  loaderDeps: ({ search }) => ({ after: search.after ?? "" }),
  loader: ({ deps }) => fetchPollList({ data: deps.after }),
  component: function Polls() {
    const { id, after, status, counting } = Route.useSearch();
    const list = Route.useLoaderData();
    return <PollRegister list={list} after={after} filters={{ status, counting }} invalid={id} />;
  },
});
