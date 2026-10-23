import { createFileRoute } from "@tanstack/react-router";

import { accountClient } from "../account/client.ts";
import { draftsClient } from "../account/drafts.ts";
import { exportClient } from "../account/export.ts";
import { profilesClient } from "../account/profiles.ts";
import { pushClient } from "../account/push.ts";
import { verifyClient } from "../account/verify.ts";
import { AccountPanel } from "../components/account-panel.tsx";
import { fetchPhoneVerification } from "../data.ts";
import { titles } from "../titles.ts";

export const Route = createFileRoute("/account")({
  // Nothing on it for a search engine; the server renders it signed out, and
  // the page's script asks the account handler for the session.
  head: ({ match }) => {
    const { pageTitle, text } = titles(match.context.locale);
    return { meta: [{ name: "robots", content: "noindex" }, pageTitle(text("navAccount"))] };
  },
  loader: async () => ({ phone: await fetchPhoneVerification() }),
  component: function Account() {
    const { phone } = Route.useLoaderData();
    return (
      <AccountPanel
        client={accountClient}
        drafts={draftsClient}
        profiles={profilesClient}
        verify={verifyClient}
        accountExport={exportClient}
        push={pushClient}
        phone={phone}
      />
    );
  },
});
