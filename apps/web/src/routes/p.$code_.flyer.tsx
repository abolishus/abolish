import { parseShortCode } from "@abolishus/core/short-codes";
import { useTranslate } from "@abolishus/ui";
import { createFileRoute, notFound } from "@tanstack/react-router";

import { PollFlyer } from "../components/poll-flyer.tsx";
import { Notice } from "../components/site-layout.tsx";
import { fetchPoll, fetchShortLink } from "../data.ts";
import { INKS, type Ink, PAPERS, type Paper } from "../flyer.ts";
import { catalogs } from "../messages.ts";
import { siteOrigin } from "../og/origin.ts";
import { pollPreview } from "../og/poll.ts";
import { headline } from "../og/text.ts";
import { searchText } from "../values.ts";

// A poll's printable flyer, `/p/<code>/flyer?paper=<a4|letter>&ink=<color|mono>`
// (docs/design/sharing.md, Printable flyer): not nested in `/p/<code>`, which
// only redirects. US Letter by default, since abolish.us starts in the US;
// A4 is one link away. The code, paper and ink never reach analytics
// (`/p/:code/flyer`, src/analytics.ts; T-67).
export const Route = createFileRoute("/p/$code_/flyer")({
  // Anything but a known paper or ink is left out, so the router sends the
  // visitor to the URL without it, and the page uses the default.
  validateSearch: (
    search: Record<string, unknown>,
  ): { paper: Paper | undefined; ink: Ink | undefined } => {
    const paper = searchText(search["paper"]);
    const ink = searchText(search["ink"]);
    return { paper: PAPERS.find((p) => p === paper), ink: INKS.find((i) => i === ink) };
  },
  loader: async ({ params }) => {
    const code = parseShortCode(params.code);
    if (code === undefined) throw notFound();
    const link = await fetchShortLink({ data: code });
    if (link.kind === "not-found") throw notFound();
    const page = await fetchPoll({ data: link.electionId });
    // The poll page's own check of the code against the hash it decoded
    // (T-34): a flyer prints only the code the poll's page would.
    if (page.kind !== "poll" || page.code !== code) throw notFound();
    const origin = siteOrigin();
    return {
      poll: page.poll,
      asOf: page.asOf,
      code,
      url: `${origin}/p/${code}`,
      // The link preview's headline, so the flyer and a chat name the poll alike.
      title: headline(pollPreview(page.poll, code, new URL(origin).host, Date.now())),
      // A hidden poll's text was withheld by moderation, so we print nothing
      // to spread it (docs/moderation-policy.md); a delisted one keeps its flyer.
      hidden: page.moderation.state === "hidden",
    };
  },
  // A sheet to print, not a page to find.
  head: () => ({ meta: [{ name: "robots", content: "noindex" }] }),
  component: function Flyer() {
    const t = useTranslate(catalogs);
    const { hidden, ...flyer } = Route.useLoaderData();
    const { paper = "letter", ink = "color" } = Route.useSearch();
    if (hidden)
      return (
        <Notice title={t("flyerTitle")}>
          {t("flyerHidden")}{" "}
          <a className="underline underline-offset-4" href={`/p/${flyer.code}`}>
            {t("flyerBack")}
          </a>
        </Notice>
      );
    return <PollFlyer {...flyer} paper={paper} ink={ink} />;
  },
});
