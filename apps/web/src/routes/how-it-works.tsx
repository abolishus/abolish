import { createFileRoute } from "@tanstack/react-router";

import { HowItWorks } from "../components/how-it-works.tsx";
import { pageTitle, text } from "../titles.ts";

export const Route = createFileRoute("/how-it-works")({
  head: () => ({ meta: [pageTitle(text("navHowItWorks"))] }),
  component: HowItWorks,
});
