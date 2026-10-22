// What a card in the stream shows of a poll, apart from where its links go:
// the stream's card (stream.tsx) and the creation form's preview of it
// (poll-form.tsx) draw the same face, so the preview can't drift from what
// people will see. Its own module, so the form's script doesn't carry the
// stream's page (P2-28 part 2b).

import { useTranslate } from "@abolishus/ui";
import type { ReactNode } from "react";

import { catalogs } from "../messages.ts";
import type { PollTags } from "../poll.ts";
import type { CardText } from "../stream.ts";
import { ListedUnder } from "./listed-under.tsx";

export function CardFace({
  titleId,
  closes,
  questions,
  text,
  tags,
  href,
  linked,
  children,
}: {
  titleId: string;
  /** When it closes, or `null` where that isn't known yet. */
  closes: ReactNode;
  questions: number;
  text: CardText;
  tags: PollTags;
  /** The poll's page, which the heading links to, or `undefined` before there is one. */
  href: string | undefined;
  /** Whether the tags link to the stream narrowed to each. */
  linked: boolean;
  /** The answers. */
  children: ReactNode;
}) {
  const t = useTranslate(catalogs);
  return (
    <article
      aria-labelledby={titleId}
      className="grid content-start gap-5 border border-border p-5 sm:p-6"
    >
      {closes === null && questions <= 1 ? null : (
        <p className="m-0 flex flex-wrap justify-between gap-x-4 gap-y-1 text-sm text-muted-foreground">
          {closes === null ? null : (
            <span>
              {t("streamCloses")} {closes}
            </span>
          )}
          {questions > 1 ? <span>{t("questionCount", { count: questions })}</span> : null}
        </p>
      )}
      <div className="grid gap-2">
        <h3
          id={titleId}
          lang={text.language}
          dir="auto"
          className="m-0 font-heading text-2xl leading-tight font-semibold text-balance break-words sm:text-3xl"
        >
          {href === undefined ? (
            text.heading
          ) : (
            <a href={href} className="underline-offset-4 hover:underline">
              {text.heading}
            </a>
          )}
        </h3>
        {text.question === undefined ? null : (
          <p lang={text.language} dir="auto" className="m-0 text-lg text-pretty break-words">
            {text.question}
          </p>
        )}
      </div>
      <ListedUnder tags={tags} linked={linked} />
      {children}
    </article>
  );
}

/** One answer's look on a card: a link into the ballot client in the stream, plain in a preview. */
export const CARD_ANSWER =
  "flex min-h-12 items-center justify-between gap-3 border border-input px-4 py-2 text-base font-medium";
