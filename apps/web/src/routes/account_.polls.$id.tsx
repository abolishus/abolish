import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";

import { turnstileChallenge } from "../account/challenge.ts";
import { draftsClient } from "../account/drafts.ts";
import { profilesClient } from "../account/profiles.ts";
import { PollFormPage } from "../components/poll-form.tsx";
import { fetchChallengeKey, fetchPhoneVerification } from "../data.ts";

// An author's draft, `/account/polls/<id>`, and a new one, `/account/polls/new`
// (a poll ID is 32 lower-case letters and digits, so never `new`). One route,
// so a new draft's first save puts its ID in the address without remounting
// the form. Analytics keeps only the template (`/account/polls/:id`, T-67).
//
// These are the only pages whose policy allows Turnstile (src/security.ts):
// a submitted poll goes on to "Setting up your poll" as a new document, so
// the widget's script never runs under any other page's.
export const Route = createFileRoute("/account_/polls/$id")({
  loader: async () => ({
    siteKey: await fetchChallengeKey(),
    phoneVerification: await fetchPhoneVerification(),
  }),
  head: () => ({ meta: [{ name: "robots", content: "noindex" }] }),
  component: function AccountPoll() {
    const { id } = Route.useParams();
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
