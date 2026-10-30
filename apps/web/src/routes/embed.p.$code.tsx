import { parseShortCode } from "@abolishus/core/short-codes";
import { I18nProvider } from "@abolishus/ui";
import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EmbedCard, EmbedNotice, type EmbedTheme } from "../components/poll-embed.tsx";
import { type Locale, negotiateLocale } from "../locales.ts";
import { loadCatalog } from "../messages.ts";
import { siteOrigin } from "../og/origin.ts";
import { finalCount, pollPreview } from "../og/poll.ts";
import { headline } from "../og/text.ts";
import { api } from "../server/api.ts";
import { loadEmbed } from "../server/load.ts";
import stylesheet from "../styles.css?url";
import { isolated, titles } from "../titles.ts";
import { ballotBase } from "../values.ts";

/**
 * The whole document: our stylesheet, the card, and no script. Its title is
 * the card's heading, for a screen reader that announces the framed page's
 * title rather than the frame's own (`embedSnippet`).
 */
function EmbedDocument({
  locale,
  theme,
  title,
  children,
}: {
  locale: Locale;
  theme: EmbedTheme;
  title: string;
  children: ReactNode;
}) {
  return (
    <html lang={locale} data-theme={theme === "auto" ? undefined : theme}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* A card for other pages, not a page to find. */}
        <meta name="robots" content="noindex" />
        <title>{titles(locale).pageTitle(title).title}</title>
        <link rel="stylesheet" href={stylesheet} />
      </head>
      <body className="bg-transparent">
        {/* The framed page's one landmark, so a screen reader's "main" lands on the card. */}
        <main>{children}</main>
      </body>
    </html>
  );
}

const page = (status: number, locale: Locale, theme: EmbedTheme, title: string, body: ReactNode) =>
  new Response(
    `<!doctype html>${renderToStaticMarkup(
      <I18nProvider locale={locale}>
        <EmbedDocument locale={locale} theme={theme} title={title}>
          {body}
        </EmbedDocument>
      </I18nProvider>,
    )}`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8", "content-language": locale },
    },
  );

// A poll's embed, `/embed/p/<code>?theme=<light|dark>` (docs/design/sharing.md,
// The embed decision): the only page another site may frame, so it is
// rendered here as static HTML, never through the router's document with its
// scripts, and gets its own headers (src/security.ts, `embedHeaders`). Any
// theme but light or dark follows the reader's setting. The code and theme
// never reach analytics (`/embed/p/:code`, src/analytics.ts; T-67), and the
// API is asked nothing of the reader's (T-10, T-11).
export const Route = createFileRoute("/embed/p/$code")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const query = new URL(request.url).searchParams.get("theme");
        const theme: EmbedTheme = query === "light" || query === "dark" ? query : "auto";
        // In the reader's language, from their browser's `Accept-Language`
        // alone: a frame on another site gets no cookie of ours, and a cached
        // copy varies by that header only (src/security.ts, `embedHeaders`).
        const locale = negotiateLocale(null, request.headers.get("accept-language"));
        await loadCatalog(locale);
        const { text } = titles(locale);
        const code = parseShortCode(params.code);
        const embed = code === undefined ? undefined : await loadEmbed(api(), code, locale);
        if (code === undefined || embed === undefined || embed.kind === "not-found")
          return page(
            404,
            locale,
            theme,
            text("embedNotFoundTitle"),
            <EmbedNotice kind="not-found" />,
          );
        const origin = siteOrigin();
        const url = `${origin}/p/${code}`;
        // A hidden poll's text was withheld by moderation, so the card
        // shows none of it (docs/moderation-policy.md); its page says why.
        if (embed.kind === "hidden")
          return page(
            200,
            locale,
            theme,
            text("embedHiddenTitle"),
            <EmbedNotice kind="hidden" url={url} />,
          );
        const title = headline(
          pollPreview(embed.poll, code, new URL(origin).host, Date.now(), locale),
        );
        return page(
          200,
          locale,
          theme,
          embed.text === undefined ? title : isolated(embed.text.heading),
          <EmbedCard
            poll={embed.poll}
            asOf={embed.asOf}
            url={url}
            title={title}
            text={embed.text}
            ballot={ballotBase(process.env["BALLOT_URL"]) ?? null}
            results={finalCount(embed.results)}
          />,
        );
      },
    },
  },
});
