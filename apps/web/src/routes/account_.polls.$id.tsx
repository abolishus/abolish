import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { draftsClient } from "../account/drafts.ts";
import { PollFormPage } from "../components/poll-form.tsx";

// An author's draft, `/account/polls/<id>`, and a new one, `/account/polls/new`
// (a poll ID is 32 lower-case letters and digits, so never `new`). One route,
// so a new draft's first save puts its ID in the address without remounting
// the form. Analytics keeps only the template (`/account/polls/:id`, T-67).
export const Route = createFileRoute("/account_/polls/$id")({
  head: () => ({ meta: [{ name: "robots", content: "noindex" }] }),
  component: function AccountPoll() {
    const { id } = Route.useParams();
    const navigate = useNavigate();
    return (
      <PollFormPage
        client={draftsClient}
        id={id === "new" ? undefined : id}
        onCreated={(created) =>
          void navigate({ to: "/account/polls/$id", params: { id: created }, replace: true })
        }
      />
    );
  },
});
