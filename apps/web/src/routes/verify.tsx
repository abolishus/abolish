import { createFileRoute } from "@tanstack/react-router";

import { VerifyPage } from "../components/verify-page.tsx";
import { titles } from "../titles.ts";

export const Route = createFileRoute("/verify")({
  head: ({ match }) => {
    const { pageTitle, text } = titles(match.context.locale);
    return { meta: [pageTitle(text("navVerify"))] };
  },
  component: VerifyPage,
});
