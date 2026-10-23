import { createFileRoute } from "@tanstack/react-router";

import { HomePage } from "../components/home-page.tsx";
import { fetchStream } from "../data.ts";

/** Questions the home page shows from the top of the stream: one row of cards at desktop width. */
const HOME_STREAM = 3;

export const Route = createFileRoute("/")({
  // The front page stays up when the API doesn't answer: only the newest
  // questions are left out, and the error says nothing (T-67).
  loader: () =>
    fetchStream({
      data: { sort: "new", after: "", q: "", topic: "", place: "", limit: HOME_STREAM },
    }).then(
      ({ stream, ballot }) =>
        stream.kind === "stream" ? { cards: stream.cards, ballot } : undefined,
      () => undefined,
    ),
  component: function Home() {
    return <HomePage newest={Route.useLoaderData()} />;
  },
});
