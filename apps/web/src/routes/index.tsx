import { createFileRoute } from "@tanstack/react-router";

import { HomePage } from "../components/home-page.tsx";
import { fetchHome } from "../data.ts";

export const Route = createFileRoute("/")({
  // The front page stays up when the API doesn't answer: only the questions
  // are left out, and the error says nothing (T-67).
  loader: ({ context: { locale } }) =>
    fetchHome({ data: locale }).then(
      ({ stream, featured, ballot, phoneVerification }) =>
        stream.kind === "stream"
          ? { newest: { cards: stream.cards, ballot, phoneVerification }, featured }
          : { newest: undefined, featured: undefined },
      () => ({ newest: undefined, featured: undefined }),
    ),
  component: function Home() {
    const { newest, featured } = Route.useLoaderData();
    return <HomePage newest={newest} featured={featured} />;
  },
});
