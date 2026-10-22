import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";

import { turnstileChallenge } from "../account/challenge.ts";
import { verifyClient } from "../account/verify.ts";
import { VerifyPage } from "../components/account-verify.tsx";
import { fetchChallengeKey } from "../data.ts";

// Verifying the account's e-mail and phone, `/account/verify` (P2-31 part 4).
// Asking for a code takes a Turnstile token (T-52), so this is one of the
// pages whose policy allows Turnstile (src/security.ts); the account page
// links here rather than loading the widget itself.
export const Route = createFileRoute("/account_/verify")({
  loader: async () => ({ siteKey: await fetchChallengeKey() }),
  head: () => ({ meta: [{ name: "robots", content: "noindex" }] }),
  component: function AccountVerify() {
    const { siteKey } = Route.useLoaderData();
    const challenge = useMemo(
      () => (siteKey === null ? undefined : turnstileChallenge(siteKey)),
      [siteKey],
    );
    return <VerifyPage client={verifyClient} challenge={challenge} />;
  },
});
