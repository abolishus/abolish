import { createFileRoute } from "@tanstack/react-router";

import { accountClient } from "../account/client.ts";
import { draftsClient } from "../account/drafts.ts";
import { profilesClient } from "../account/profiles.ts";
import { verifyClient } from "../account/verify.ts";
import { AccountPanel } from "../components/account-panel.tsx";
import { fetchPhoneVerification } from "../data.ts";

export const Route = createFileRoute("/account")({
  // Nothing on it for a search engine; the server renders it signed out, and
  // the page's script asks the account handler for the session.
  head: () => ({ meta: [{ name: "robots", content: "noindex" }] }),
  loader: async () => ({ phone: await fetchPhoneVerification() }),
  component: function Account() {
    const { phone } = Route.useLoaderData();
    return (
      <AccountPanel
        client={accountClient}
        drafts={draftsClient}
        profiles={profilesClient}
        verify={verifyClient}
        phone={phone}
      />
    );
  },
});
