import { cn, Count, Fingerprint, Hash, useTranslate } from "@abolishus/ui";
import { ArrowRight, ChevronDown, EyeOff, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { ReactionsClient } from "../account/reactions.ts";
import { catalogs, type Messages } from "../messages.ts";
import {
  type Instant,
  instructionOf,
  pollStatus,
  type PollStatus,
  type PollView,
  type Tier,
} from "../poll.ts";
import type { BoardHead, ModerationState } from "../server/load.ts";
import { PollReactions } from "./poll-reactions.tsx";
import { PollShare, type PollShareProps } from "./poll-share.tsx";
import { COUNTING_LABEL, instructionMessage, STATUS_MARK } from "./poll-status.ts";
import { When } from "./when.tsx";

export interface PollSummaryProps {
  poll: PollView;
  board: BoardHead;
  moderation: ModerationState;
  /** When the page was loaded: the poll's status is read at this time. */
  asOf: Instant;
  /** The canonical short code, if one is served. */
  code: string | undefined;
  /** The share sheet's link and title, for a poll with a short link that isn't hidden. */
  share?: PollShareProps | undefined;
  /** Where the poll's reactions are read and set; without one, none are shown. */
  reactions?: ReactionsClient | undefined;
}

const TIER_LABEL = { 0: "tier0", 1: "tier1", 2: "tier2" } as const satisfies Record<Tier, string>;

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

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-t border-border py-3 sm:grid-cols-[16rem_1fr] sm:gap-4">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="m-0">{children}</dd>
    </div>
  );
}

/** The poll's status, in words with its own icon; colour only on the icon. */
function StatusMark({
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

const STATUS_TEXT = {
  open: "pollStatus_open",
  scheduled: "pollStatus_scheduled",
  closed: "pollStatus_closed",
} as const satisfies Record<PollStatus, keyof Messages>;

/**
 * One poll's page, in the everyday register ([[language]]): what it is and
 * where it stands on the surface, and what our server says about it one step
 * down, behind "How do we know this is real?". That part says plainly that
 * these are claims, and shows the hashes a reader needs to check them (T-24,
 * T-34). A native disclosure keeps the evidence in the server's HTML, so it
 * opens without the page's script.
 */
export function PollSummary({
  poll,
  board,
  moderation,
  asOf,
  code,
  share,
  reactions,
}: PollSummaryProps) {
  const t = useTranslate(catalogs);
  const latest = moderation.latest;
  const status = pollStatus(poll, asOf);
  const counting = t(COUNTING_LABEL[poll.counting]);
  const options = poll.questions.reduce((sum, q) => sum + q.optionCount, 0);
  const illFormed = poll.illFormed;
  const tiers = (
    <ul className="m-0 grid list-none gap-1 p-0">
      {/* By position: an ill-formed definition can repeat a tier. */}
      {poll.electorate.map((group, i) => (
        <li key={i}>{t(TIER_LABEL[group.tier])}</li>
      ))}
    </ul>
  );
  return (
    <article className="grid gap-16">
      <header className="grid gap-6 pt-2 md:pt-10">
        <p className="m-0 font-mono text-xs tracking-widest text-muted-foreground uppercase">
          {t("pollTitle")} · {counting}
        </p>
        <h1 className="m-0 max-w-4xl font-heading text-4xl leading-[1.05] font-semibold tracking-tight text-balance break-all sm:text-6xl">
          {t("pollHeading", { prefix: poll.electionId.slice(0, 16) })}
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          <StatusMark icon={STATUS_MARK[status].icon} tone={STATUS_MARK[status].tone}>
            {t(STATUS_TEXT[status])}
          </StatusMark>
          {moderation.state === "visible" ? null : (
            <StatusMark icon={EyeOff} tone="text-pending">
              {t(moderation.state === "hidden" ? "action_hide" : "action_delist")}
            </StatusMark>
          )}
        </div>

        {moderation.state !== "visible" && latest !== undefined ? (
          <p role="note" className="m-0 max-w-prose border-l-4 border-pending pl-4">
            {t(moderation.state === "hidden" ? "moderationHidden" : "moderationDelisted", {
              reason: t(`reason_${latest.reason}`),
            })}{" "}
            <a className="underline underline-offset-4" href="/moderation">
              {t("moderationLogLink")}
            </a>
          </p>
        ) : null}

        {illFormed !== undefined ? (
          <p role="alert" className="m-0 max-w-prose border-l-4 border-destructive pl-4">
            {illFormed.question === undefined
              ? t("illFormed", { rule: t(`rule_${illFormed.rule}`) })
              : t("illFormedQuestion", {
                  rule: t(`rule_${illFormed.rule}`),
                  number: illFormed.question + 1,
                })}
          </p>
        ) : null}

        <FactStrip
          facts={[
            { term: t("factElectorate"), value: tiers },
            { term: t("factOpens"), value: <When instant={poll.opensAt} /> },
            { term: t("factCloses"), value: <When instant={poll.closesAt} /> },
            {
              term: t("factType"),
              value: (
                <>
                  {counting}
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
      </header>

      <section
        aria-labelledby="answer-title"
        className="grid max-w-3xl gap-3 bg-muted/60 p-5 sm:p-6"
      >
        <h2 id="answer-title" className="m-0 font-heading text-2xl font-semibold">
          {t("pollAnswerTitle")}
        </h2>
        <p className="m-0 text-base text-pretty">
          {t(status === "closed" ? "pollAnswerClosed" : "pollAnswer")}
        </p>
        {share === undefined ? null : (
          <div className="pt-2">
            <PollShare {...share} />
          </div>
        )}
      </section>

      {/* Not for a hidden poll, which takes none and shows no counts (T-68). */}
      {reactions === undefined || moderation.state === "hidden" ? null : (
        <PollReactions electionId={poll.electionId} client={reactions} />
      )}

      <details className="group border-t border-border pt-8">
        <summary className="flex min-h-12 cursor-pointer list-none items-center gap-4 underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none [&::-webkit-details-marker]:hidden">
          {/* A seal only: the evidence below names the same fingerprint. */}
          <span aria-hidden="true" className="contents">
            <Fingerprint
              value={poll.definitionHash}
              label={t("fingerprintDefinition", { prefix: poll.definitionHash.slice(0, 8) })}
              size={44}
            />
          </span>
          <h2 className="m-0 font-heading text-2xl font-semibold">{t("evidenceSummary")}</h2>
          <ChevronDown aria-hidden="true" className="size-5 group-open:rotate-180" />
        </summary>
        <div className="grid gap-12 pt-8">
          <p className="m-0 max-w-prose border-l-2 border-foreground ps-4 text-pretty text-muted-foreground">
            {t("pollClaim")}
          </p>

          <section aria-labelledby="fingerprint-title" className="grid gap-4">
            <h3 id="fingerprint-title" className="m-0 font-heading text-xl font-semibold">
              {t("evidenceFingerprintTitle")}
            </h3>
            <p className="m-0 max-w-prose text-muted-foreground">{t("evidenceFingerprint")}</p>
            <div className="flex min-w-0 items-start gap-4">
              <Fingerprint
                value={poll.definitionHash}
                label={t("fingerprintDefinition", { prefix: poll.definitionHash.slice(0, 8) })}
                size={64}
              />
              <div className="min-w-0">
                <Hash value={poll.definitionHash} label={t("definitionHash")} />
              </div>
            </div>
            <Hash value={poll.electionId} label={t("pollId")} />
          </section>

          <section aria-labelledby="definition-title" className="grid gap-4">
            <h3 id="definition-title" className="m-0 font-heading text-xl font-semibold">
              {t("evidenceDefinitionTitle")}
            </h3>
            <dl className="m-0">
              <Fact term={t("factType")}>{counting}</Fact>
              <Fact term={t("factOptions")}>
                <Count value={options} />
              </Fact>
              {poll.version === 5 ? (
                <Fact term={t("factQuestions")}>
                  {/* Each question's limits as the proof enforces them, and no
                      figure across questions (T-29, T-34). */}
                  <ol className="m-0 grid list-none gap-1 p-0">
                    {poll.questions.map((q, i) => {
                      const instruction = instructionMessage(instructionOf(q));
                      return (
                        <li key={i}>
                          <span className="font-medium">
                            {t("questionNumber", { number: i + 1 })}
                          </span>
                          {": "}
                          {t("questionLimits", {
                            instruction: t(instruction.key, instruction.values),
                            options: t("optionCount", { count: q.optionCount }),
                            min: q.minSelections,
                            max: q.maxSelections,
                          })}
                        </li>
                      );
                    })}
                  </ol>
                </Fact>
              ) : (
                poll.questions.map((q, i) => (
                  <Fact key={i} term={t("factSelections")}>
                    {t("selectionsRange", { min: q.minSelections, max: q.maxSelections })}
                  </Fact>
                ))
              )}
              <Fact term={t("factElectorate")}>
                <ul className="m-0 grid list-none gap-1 p-0">
                  {poll.electorate.map((group, i) => (
                    <li key={i}>
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
              <Fact term={t("factOpens")}>
                <When instant={poll.opensAt} />
              </Fact>
              <Fact term={t("factCloses")}>
                <When instant={poll.closesAt} />
              </Fact>
              {code === undefined ? null : (
                <Fact term={t("factShortLink")}>
                  <a className="font-mono underline underline-offset-4" href={`/p/${code}`}>
                    /p/{code}
                  </a>
                </Fact>
              )}
            </dl>
          </section>

          <section aria-labelledby="board-title" className="grid gap-4">
            <h3 id="board-title" className="m-0 font-heading text-xl font-semibold">
              {t("boardTitle")}
            </h3>
            {board.treeSize === "0" ? (
              <p className="m-0">{t("boardEmpty")}</p>
            ) : (
              <>
                <p className="m-0">
                  {t("boardEntries")}: <Count value={BigInt(board.treeSize)} />
                </p>
                <Hash value={board.chainHead} label={t("boardHead")} />
                <Hash value={board.root} label={t("boardRoot")} />
                <p className="m-0 max-w-prose text-muted-foreground">{t("boardUnanchored")}</p>
              </>
            )}
            <a
              className="inline-flex min-h-12 items-center gap-2 justify-self-start underline underline-offset-4"
              href={`/polls/${poll.electionId}/board`}
            >
              {t("boardLink")}
              <ArrowRight aria-hidden="true" className="size-4" />
            </a>
          </section>
        </div>
      </details>
    </article>
  );
}
