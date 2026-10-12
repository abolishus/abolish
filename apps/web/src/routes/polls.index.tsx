import { createFileRoute, redirect } from "@tanstack/react-router";

import { LookupForm } from "../components/lookup-form.tsx";
import { normalizeElectionId, searchText } from "../values.ts";

// The lookup form's target: a poll ID goes to its page under the one
// spelling that names it; anything else comes back to the form.
export const Route = createFileRoute("/polls/")({
  validateSearch: (search: Record<string, unknown>): { id?: string } => {
    const id = searchText(search["id"]);
    return id === undefined ? {} : { id: id.slice(0, 256) };
  },
  beforeLoad: ({ search }) => {
    if (search.id === undefined) return;
    const electionId = normalizeElectionId(search.id);
    if (electionId !== undefined)
      throw redirect({ to: "/polls/$electionId", params: { electionId } });
  },
  component: function Lookup() {
    const { id } = Route.useSearch();
    return <LookupForm invalid={id} />;
  },
});
