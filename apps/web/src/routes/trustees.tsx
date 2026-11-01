import { createFileRoute } from "@tanstack/react-router";

import { TrusteesPage } from "../components/trustees-page.tsx";
import { titles } from "../titles.ts";

export const Route = createFileRoute("/trustees")({
  head: ({ match }) => {
    const { pageTitle, text } = titles(match.context.locale);
    return { meta: [pageTitle(text("navKeys"))] };
  },
  component: TrusteesPage,
});
