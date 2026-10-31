import { cn, useTranslate } from "@abolishus/ui";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { catalogs, tierMessage } from "../messages.ts";
import type { PollView } from "../poll.ts";
import { COUNTING_LABEL } from "./poll-status.ts";
import { When } from "./when.tsx";

const TERM = "font-mono text-xs tracking-wide text-muted-foreground uppercase";

/** A row of facts under a heavy rule, like the head of a printed notice. */
function FactStrip({ facts }: { facts: readonly { term: string; value: ReactNode }[] }) {
  return (
    <dl className="m-0 grid grid-cols-1 border-t-2 border-foreground sm:grid-cols-2 lg:grid-cols-4">
      {facts.map((fact) => (
        <div
          key={fact.term}
          className="grid content-start gap-1 border-b border-border py-4 sm:pe-6 lg:border-b-0"
        >
          <dt className={TERM}>{fact.term}</dt>
          <dd className="m-0 text-base text-pretty">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A status in words with its own icon; colour only on the icon. */
export function StatusMark({
  icon: Icon,
  tone,
  children,
}: {
  icon: LucideIcon;
  tone: string;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex min-h-8 items-center gap-2 border border-foreground px-3 font-mono text-xs tracking-widest uppercase">
      <Icon aria-hidden="true" className={cn("size-4", tone)} strokeWidth={2.5} />
      {children}
    </span>
  );
}

/**
 * A poll's facts as its definition states them: who can answer, tier by
 * tier, when it opens and closes, and how it is counted, with how many
 * questions and options it has. The poll page and its results page head
 * themselves with the same strip, so the two can't state a poll differently.
 */
export function PollFacts({
  poll,
  phoneVerification,
}: {
  poll: Pick<
    PollView,
    "version" | "counting" | "questions" | "electorate" | "opensAt" | "closesAt"
  >;
  phoneVerification: boolean;
}) {
  const t = useTranslate(catalogs);
  const options = poll.questions.reduce((sum, q) => sum + q.optionCount, 0);
  return (
    <FactStrip
      facts={[
        {
          term: t("factElectorate"),
          value: (
            <ul className="m-0 grid list-none gap-1 p-0">
              {/* By position: an ill-formed definition can repeat a tier. */}
              {poll.electorate.map((group, i) => (
                <li key={i}>{t(tierMessage(group.tier, phoneVerification))}</li>
              ))}
            </ul>
          ),
        },
        { term: t("factOpens"), value: <When instant={poll.opensAt} /> },
        { term: t("factCloses"), value: <When instant={poll.closesAt} /> },
        {
          term: t("factType"),
          value: (
            <>
              {t(COUNTING_LABEL[poll.counting])}
              <span className="block text-sm text-muted-foreground">
                {poll.version === 5
                  ? `${t("questionCount", { count: poll.questions.length })}, ${t("optionCount", { count: options })}`
                  : t("optionCount", { count: options })}
              </span>
            </>
          ),
        },
      ]}
    />
  );
}
