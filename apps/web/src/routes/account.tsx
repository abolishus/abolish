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
import { searchText } from "../values.ts";

// A full load, not the router's navigation: the poll form's page is the only
// one whose policy allows Turnstile (src/security.ts), and a document keeps
// the policy it was served with. Replaced, so Back doesn't land here again.
const ask = () => window.location.replace("/account/polls/new");

export const Route = createFileRoute("/account")({
  // `?next=new-poll`, from home's "Ask a question": signed in, the visitor
  // goes on to a new poll's form. Nothing else is honoured, so the page can't
  // be made to send anyone elsewhere.
  validateSearch: (search: Record<string, unknown>): { next: "new-poll" | undefined } => ({
    next: searchText(search["next"]) === "new-poll" ? "new-poll" : undefined,
  }),
  // Nothing on it for a search engine; the server renders it signed out, and
  // the page's script asks the account handler for the session.
  head: ({ match }) => {
    const { pageTitle, text } = titles(match.context.locale);
    return { meta: [{ name: "robots", content: "noindex" }, pageTitle(text("navAccount"))] };
  },
  loader: async () => ({ phone: await fetchPhoneVerification() }),
  component: function Account() {
    const { phone } = Route.useLoaderData();
    const { next } = Route.useSearch();
    return (
      <AccountPanel
        client={accountClient}
        drafts={draftsClient}
        profiles={profilesClient}
        verify={verifyClient}
        accountExport={exportClient}
        push={pushClient}
        phone={phone}
        ask={next === "new-poll" ? ask : undefined}
      />
    );
  },
});
