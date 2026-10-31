import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { turnstileChallenge } from "../account/challenge.ts";
import { draftsClient } from "../account/drafts.ts";
import { profilesClient } from "../account/profiles.ts";
import { PollFormPage } from "../components/poll-form.tsx";
import { fetchChallengeKey, fetchPhoneVerification } from "../data.ts";
import { titles } from "../titles.ts";

const POLL_ID = /^[a-z0-9]{32}$/;

// An author's draft, `/account/polls/<id>`, and a new one, `/account/polls/new`
// (a poll ID is 32 lower-case letters and digits, so never `new`). One route,
// so a new draft's first save puts its ID in the address without remounting
// the form. Analytics keeps only the template (`/account/polls/:id`, T-67).
//
// These are the only pages whose policy allows Turnstile (src/security.ts):
// a submitted poll goes on to "Setting up your poll" as a new document, so
// the widget's script never runs under any other page's.
export const Route = createFileRoute("/account_/polls/$id")({
  // `?from=<poll>` on a new poll: one of the author's that didn't open,
  // whose words it starts with. Only a poll ID passes; the form reads it
  // through the author's own session, so another account's is never found.
  validateSearch: (search: Record<string, unknown>): { from?: string } => {
    const from = search["from"];
    return typeof from === "string" && POLL_ID.test(from) ? { from } : {};
  },
  loader: async () => ({
    siteKey: await fetchChallengeKey(),
    phoneVerification: await fetchPhoneVerification(),
  }),
  head: ({ match, params }) => {
    const { pageTitle, text } = titles(match.context.locale);
    return {
      meta: [
        { name: "robots", content: "noindex" },
        pageTitle(
          text(params.id === "new" ? "pollFormNewTitle" : "pollFormEditTitle"),
          text("navAccount"),
        ),
      ],
    };
  },
  component: function AccountPoll() {
    const { id } = Route.useParams();
    const { from } = Route.useSearch();
    const { siteKey, phoneVerification } = Route.useLoaderData();
    const navigate = useNavigate();
    const challenge = useMemo(
      () => (siteKey === null ? undefined : turnstileChallenge(siteKey)),
      [siteKey],
    );
    return (
      <PollFormPage
        client={draftsClient}
        profiles={profilesClient}
        id={id === "new" ? undefined : id}
        from={id === "new" ? from : undefined}
        challenge={challenge}
        phoneVerification={phoneVerification}
        onCreated={(created) =>
          void navigate({ to: "/account/polls/$id", params: { id: created }, replace: true })
        }
        onSubmitted={(submitted) => window.location.assign(`/account/polls/${submitted}/setup`)}
      />
    );
  },
});
