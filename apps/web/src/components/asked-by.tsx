import { useTranslate } from "@abolishus/ui";

import { catalogs } from "../messages.ts";
import type { AskedBy as Asker } from "../poll.ts";

/**
 * "Asked by" and the profile's name, a link to its page
 * ([[0040-creator-profiles]]). The name is its author's words, in their own
 * direction (`<bdi>`), so a right-to-left name can't reorder the words
 * around it (T-75). The link is a line of small text, 14px tall on a card,
 * so an invisible box 24px tall centred on it takes the tap: a thumb aimed at
 * the name missed it where every other link on the card is 24px or more
 * (WCAG 2.5.8; P2-29, the stream's iteration 8). It reaches 5px past the
 * line, into the gap above the card's heading, and moves nothing.
 */
export function AskedBy({ askedBy }: { askedBy: Asker }) {
  const t = useTranslate(catalogs);
  return (
    <span className="min-w-0 wrap-anywhere">
      {t("askedBy")}{" "}
      <a
        className="relative font-medium text-foreground underline underline-offset-4 before:absolute before:inset-x-0 before:top-1/2 before:h-6 before:-translate-y-1/2 before:content-['']"
        href={`/by/${askedBy.handle}`}
      >
        <bdi>{askedBy.name}</bdi>
      </a>
    </span>
  );
}
