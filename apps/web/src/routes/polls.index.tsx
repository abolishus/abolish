import { useTranslate } from "@abolishus/ui";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { LookupForm } from "../components/lookup-form.tsx";
import { PollList } from "../components/poll-list.tsx";
import { fetchPollList } from "../data.ts";
import { catalogs } from "../messages.ts";
import { isElectionId, normalizeElectionId, searchText } from "../values.ts";

// The lookup form's target, and the list of polls: a poll ID goes to its page
// under the one spelling that names it; anything else comes back to the form,
// above the list.
export const Route = createFileRoute("/polls/")({
  // Always sets `id` and `after`: the router lays this object over the raw
  // search, so a key left out would keep whatever the URL held (an array,
  // for `?id=a&id=b`). Anything but a canonical election ID as `after`
  // starts the list from the beginning.
  validateSearch: (
    search: Record<string, unknown>,
  ): { id: string | undefined; after: string | undefined } => {
    const id = searchText(search["id"]);
    const after = searchText(search["after"]);
    return { id: id?.slice(0, 256), after: isElectionId(after) ? after : undefined };
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
    const t = useTranslate(catalogs);
    const { id } = Route.useSearch();
    const list = Route.useLoaderData();
    return (
      <div className="grid gap-10">
        <h1 className="text-4xl font-semibold">{t("navPolls")}</h1>
        <LookupForm invalid={id} />
        <PollList list={list} />
      </div>
    );
  },
});
