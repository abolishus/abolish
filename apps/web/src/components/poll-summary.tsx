import { Count, Hash, useI18n, useTranslate } from "@abolishus/ui";
import type { ReactNode } from "react";

import { catalogs } from "../messages.ts";
import type { PollView, Tier } from "../poll.ts";
import type { BoardHead, ModerationState } from "../server/load.ts";
import { formatInstant } from "./format.ts";

export interface PollSummaryProps {
  poll: PollView;
  board: BoardHead;
  moderation: ModerationState;
}

const TIER_LABEL = { 0: "tier0", 1: "tier1", 2: "tier2" } as const satisfies Record<Tier, string>;

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-t border-border py-3 sm:grid-cols-[16rem_1fr] sm:gap-4">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="m-0">{children}</dd>
    </div>
  );
}

/**
 * What our server says about one poll: its definition, decoded with the
 * verifier's own code, and the board's current head. The page says plainly
 * that these are claims, and shows the hashes a reader needs to check them
 * (T-24, T-34).
 */
export function PollSummary({ poll, board, moderation }: PollSummaryProps) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  const latest = moderation.latest;
  return (
    <article className="grid gap-8">
      <header className="grid gap-4">
        <h1 className="text-3xl font-semibold">{t("pollTitle")}</h1>
        <Hash value={poll.electionId} label={t("pollId")} />
        <p className="max-w-prose text-muted-foreground">{t("pollClaim")}</p>
      </header>

      {moderation.state !== "visible" && latest !== undefined ? (
        <p role="note" className="max-w-prose border-l-4 border-pending pl-4">
          {t(moderation.state === "hidden" ? "moderationHidden" : "moderationDelisted", {
            reason: t(`reason_${latest.reason}`),
          })}{" "}
          <a className="underline underline-offset-4" href="/moderation">
            {t("moderationLogLink")}
          </a>
        </p>
      ) : null}

      {poll.illFormed !== undefined ? (
        <p role="alert" className="max-w-prose border-l-4 border-destructive pl-4">
          {t("illFormed", { rule: poll.illFormed })}
        </p>
      ) : null}

      <dl className="m-0">
        <Fact term={t("factType")}>
          {t(poll.electionType === "approval" ? "typeApproval" : "typePlurality")}
        </Fact>
        <Fact term={t("factOptions")}>
          <Count value={poll.optionCount} />
        </Fact>
        <Fact term={t("factSelections")}>
          {t("selectionsRange", { min: poll.minSelections, max: poll.maxSelections })}
        </Fact>
        <Fact term={t("factElectorate")}>
          <ul className="m-0 grid list-none gap-1 p-0">
            {poll.electorate.map((group) => (
              <li key={group.tier}>
                {t(TIER_LABEL[group.tier])}:{" "}
                <span className="tabular-nums">
                  {t("groupMembers", { count: BigInt(group.groupSize) })}
                </span>
              </li>
            ))}
          </ul>
        </Fact>
        <Fact term={t("factTrustees")}>
          <span className="tabular-nums">
            {t("trusteesOf", { threshold: poll.threshold, size: poll.panelSize })}
          </span>
        </Fact>
        <Fact term={t("factOpens")}>{formatInstant(locale, poll.opensAt)}</Fact>
        <Fact term={t("factCloses")}>{formatInstant(locale, poll.closesAt)}</Fact>
      </dl>

      <Hash value={poll.definitionHash} label={t("definitionHash")} />

      <section aria-labelledby="board-title" className="grid gap-4">
        <h2 id="board-title" className="text-2xl font-semibold">
          {t("boardTitle")}
        </h2>
        {board.treeSize === "0" ? (
          <p>{t("boardEmpty")}</p>
        ) : (
          <>
            <p>
              {t("boardEntries")}: <Count value={BigInt(board.treeSize)} />
            </p>
            <Hash value={board.chainHead} label={t("boardHead")} />
            <Hash value={board.root} label={t("boardRoot")} />
            <p className="max-w-prose text-muted-foreground">{t("boardUnanchored")}</p>
          </>
        )}
      </section>
    </article>
  );
}
