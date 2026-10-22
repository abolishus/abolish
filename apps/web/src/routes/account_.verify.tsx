import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";

import { turnstileChallenge } from "../account/challenge.ts";
import { verifyClient } from "../account/verify.ts";
import { VerifyPage } from "../components/account-verify.tsx";
import { fetchChallengeKey, fetchPhoneVerification } from "../data.ts";

// Verifying the account's e-mail, and its phone where this deployment turns
// phone verification on, `/account/verify` (P2-31 parts 4 and 6a).
// Asking for a code takes a Turnstile token (T-52), so this is one of the
// pages whose policy allows Turnstile (src/security.ts); the account page
// links here rather than loading the widget itself.
export const Route = createFileRoute("/account_/verify")({
  loader: async () => ({
    siteKey: await fetchChallengeKey(),
    phone: await fetchPhoneVerification(),
  }),
  head: () => ({ meta: [{ name: "robots", content: "noindex" }] }),
  component: function AccountVerify() {
    const { siteKey, phone } = Route.useLoaderData();
    const challenge = useMemo(
      () => (siteKey === null ? undefined : turnstileChallenge(siteKey)),
      [siteKey],
    );
    return <VerifyPage client={verifyClient} challenge={challenge} phone={phone} />;
  },
});
