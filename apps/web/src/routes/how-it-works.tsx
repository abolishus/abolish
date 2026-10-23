import { createFileRoute } from "@tanstack/react-router";

import { HowItWorks } from "../components/how-it-works.tsx";
import { titles } from "../titles.ts";

export const Route = createFileRoute("/how-it-works")({
  head: ({ match }) => {
    const { pageTitle, text } = titles(match.context.locale);
    return { meta: [pageTitle(text("navHowItWorks"))] };
  },
  component: HowItWorks,
});
