import { createFileRoute } from "@tanstack/react-router";

import { draftsClient } from "../account/drafts.ts";
import { PollSetupPage } from "../components/poll-setup.tsx";

// "Setting up your poll", `/account/polls/<id>/setup` (P2-22 part 6d): where
// the editor sends a submitted poll, as a new document. Not the editor's own
// page, so its policy is every other page's and Turnstile's script never runs
// here (src/security.ts, T-55). Analytics keeps only the template
// (`/account/polls/:id/setup`, T-67).
export const Route = createFileRoute("/account_/polls/$id_/setup")({
  head: () => ({ meta: [{ name: "robots", content: "noindex" }] }),
  component: function AccountPollSetup() {
    const { id } = Route.useParams();
    return <PollSetupPage client={draftsClient} id={id} />;
  },
});
