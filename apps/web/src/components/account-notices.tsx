import { useTranslate } from "@abolishus/ui";

import { catalogs } from "../messages.ts";
import { Section } from "./page-parts.tsx";

export interface AccountNoticesProps {
  /** The section's number on the page. */
  readonly index: string;
}

/**
 * What the account is told by e-mail, and how (P2-27 part 3c-1). Moderation
 * notices are the only kind so far and can't be turned off, since an appeal
 * needs the author to know; they go to the verified address, the day after
 * the decision, saying only that there was one (packages/core's
 * `account-notices.ts`, T-73). The choices for the optional kinds come once
 * there are results to tell of ([[P2-25]]).
 */
export function AccountNotices({ index }: AccountNoticesProps) {
  const t = useTranslate(catalogs);
  return (
    <Section
      index={index}
      mark={t("noticesMark")}
      title={t("noticesTitle")}
      id="notices-title"
      lede={<p className="m-0">{t("noticesLede")}</p>}
    >
      <div className="grid max-w-prose gap-4 text-base text-pretty">
        <ul className="m-0 grid list-none border-t-2 border-foreground p-0">
          <li className="grid gap-0.5 border-b border-border py-4">
            <span className="font-semibold">{t("noticesModeration")}</span>
            <span className="text-sm text-muted-foreground">{t("noticesModerationHelp")}</span>
          </li>
        </ul>
        <p className="m-0">{t("noticesWhen")}</p>
      </div>
    </Section>
  );
}
