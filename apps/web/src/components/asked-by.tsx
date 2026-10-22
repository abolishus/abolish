import { useTranslate } from "@abolishus/ui";

import { catalogs } from "../messages.ts";
import type { AskedBy as Asker } from "../poll.ts";

/**
 * "Asked by" and the profile's name, a link to its page
 * ([[0040-creator-profiles]]). The name is its author's words, in their own
 * direction (`<bdi>`), so a right-to-left name can't reorder the words
 * around it (T-75).
 */
export function AskedBy({ askedBy }: { askedBy: Asker }) {
  const t = useTranslate(catalogs);
  return (
    <span className="min-w-0 wrap-anywhere">
      {t("askedBy")}{" "}
      <a
        className="font-medium text-foreground underline underline-offset-4"
        href={`/by/${askedBy.handle}`}
      >
        <bdi>{askedBy.name}</bdi>
      </a>
    </span>
  );
}
