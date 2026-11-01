import {
  cn,
  Fingerprint,
  Hash,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TierSwitcher,
  useI18n,
  useTranslate,
} from "@abolishus/ui";
import { ArrowLeft, ArrowRight, CircleCheckBig } from "lucide-react";

import { catalogs, tierMessage } from "../messages.ts";
import type { PollStatus, PollView } from "../poll.ts";
import {
  type CellResults,
  isCounted,
  leadersOf,
  type PollResults,
  shareOf,
  type TierResults,
  turnoutOf,
} from "../results.ts";
import type { BoardHead } from "../server/load.ts";
import { recountOne } from "../recount.ts";
import type { PollWords } from "../stream.ts";
import { BoardHeadFacts } from "./board-head.tsx";
import { PageHeader, Section } from "./page-parts.tsx";
import { PollFacts, StatusMark } from "./poll-facts.tsx";
import { Bar, ResultsQuestion } from "./poll-results.tsx";
import { STATUS_MARK, STATUS_TEXT } from "./poll-status.ts";

export interface PollResultsPageProps {
  poll: Pick<
    PollView,
    | "electionId"
    | "version"
    | "rolling"
    | "definitionHash"
    | "counting"
    | "questions"
    | "electorate"
    | "threshold"
    | "panelSize"
    | "opensAt"
    | "closesAt"
  >;
  /** The poll's heading in its own words; without them, it goes by its ID. */
  heading: string | undefined;
  results: PollResults;
  /** Each cell's results; `undefined` where they don't fit the poll's partition. */
  cells: readonly CellResults[] | undefined;
  status: PollStatus;
  /** Every question's words; without them, questions and options go by number. */
  words: PollWords | undefined;
  /** Whether this deployment verifies a phone before an account votes, which names Tier 0. */
  phoneVerification: boolean;
  /** The board's head as our server claims it; `undefined` if it couldn't be read. */
  head: BoardHead | undefined;
}

function usePercent() {
  const { locale } = useI18n();
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
}

/** The question's caption in a table: its words, or its number. */
function QuestionCaption({
  index,
  words,
  several,
}: {
  index: number;
  words: PollWords | undefined;
  several: boolean;
}) {
  const t = useTranslate(catalogs);
  const heading = words?.questions[index]?.question;
  if (heading === undefined && !several) return null;
  return (
    <span className="block font-heading text-base font-semibold text-foreground">
      {heading === undefined ? t("questionNumber", { number: index + 1 }) : <bdi>{heading}</bdi>}
    </span>
  );
}

// The table primitives keep every cell on one line; these wrap, so a table
// of a few columns fits a phone without scrolling.
const WRAP = "px-2 whitespace-normal";

/** An option by its words, or by its number. */
function OptionLabel({
  options,
  index,
}: {
  options: readonly string[] | undefined;
  index: number;
}) {
  const t = useTranslate(catalogs);
  const label = options?.[index];
  return label === undefined ? t("resultsOption", { number: index + 1 }) : <bdi>{label}</bdi>;
}

/** One share and count, the most picked in bold. */
function Share({ count, counted, lead }: { count: string; counted: number; lead: boolean }) {
  const t = useTranslate(catalogs);
  const percent = usePercent();
  return (
    <>
      <span className={cn("block font-mono", lead && "font-semibold")}>
        {percent.format(shareOf(count, counted))}
      </span>
      <span className="block text-xs text-muted-foreground">
        {t("resultsPeople", { count: BigInt(count) })}
      </span>
    </>
  );
}

/**
 * Each question's results, a table per question with one row per option and
 * one column per tier, headed by how many answered it and its turnout, and
 * no total column: the tiers are never added together (ADR 0026; T-16).
 */
function SideBySide({
  poll,
  tiers,
  words,
  phoneVerification,
}: {
  poll: PollResultsPageProps["poll"];
  tiers: readonly TierResults[];
  words: PollWords | undefined;
  phoneVerification: boolean;
}) {
  const t = useTranslate(catalogs);
  const turnoutText = useTurnoutText();
  // Each tier's own, beside how many answered it; never one across tiers (T-16).
  const turnouts = tiers.map((tier) => turnoutText(poll, tier));
  const several = poll.questions.length > 1;
  return (
    <Section id="results-side-title" title={t("resultsSideBySide")}>
      <div className="grid gap-12">
        {poll.questions.map((q, index) => {
          const options = words?.questions[index]?.options;
          const leaders = tiers.map((tier) => {
            const counts = tier.questions?.[index];
            return counts === undefined ? [] : leadersOf(counts);
          });
          return (
            <Table key={index}>
              <TableCaption className="pb-3 text-start text-sm text-muted-foreground">
                <QuestionCaption index={index} words={words} several={several} />
                {t("resultsSideBySideCaption")}
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col" className={WRAP}>
                    {t("resultsAnswer")}
                  </TableHead>
                  {tiers.map((tier, j) => (
                    <TableHead key={tier.tier} scope="col" className={cn(WRAP, "text-end")}>
                      <span className="block">{t(tierMessage(tier.tier, phoneVerification))}</span>
                      <span className="block text-xs font-normal text-muted-foreground">
                        {t("resultsAnswered", { count: tier.counted })}
                      </span>
                      {turnouts[j] === undefined ? null : (
                        <span className="block text-xs font-normal text-muted-foreground">
                          {t("resultsTurnoutIs", { turnout: turnouts[j].text })}
                        </span>
                      )}
                      {tier.fewCouldAnswer === true ? (
                        <span className="block text-xs font-normal">
                          {t("resultsFewCouldAnswerShort")}
                        </span>
                      ) : null}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {Array.from({ length: q.optionCount }, (_, i) => (
                  <TableRow key={i}>
                    <TableHead scope="row" className={cn(WRAP, "font-normal")}>
                      <OptionLabel options={options} index={i} />
                    </TableHead>
                    {tiers.map((tier, j) => {
                      const counts = tier.questions?.[index];
                      if (counts === undefined)
                        // Said once, down the tier's whole column.
                        return i === 0 ? (
                          <TableCell
                            key={tier.tier}
                            rowSpan={q.optionCount}
                            className={cn(WRAP, "text-end text-muted-foreground")}
                          >
                            {t("resultsNotAllPublished")}
                          </TableCell>
                        ) : null;
                      return (
                        <TableCell key={tier.tier} className={cn(WRAP, "text-end")}>
                          <Share
                            count={counts[i] ?? "0"}
                            counted={tier.counted}
                            lead={leaders[j]?.includes(i) ?? false}
                          />
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          );
        })}
      </div>
    </Section>
  );
}

/** The regions a cell holds, numbered from 1, or nothing where the page can't say. */
function regionsOf(cell: CellResults["cell"], list: Intl.ListFormat, t: (n: number) => string) {
  const regions = cell.regions;
  if (regions === undefined) return undefined;
  return list.format(regions.map((r) => t(r + 1)));
}

/**
 * A tier's cells, each counted and opened on its own, a table per question
 * with one row per cell: the tier's results are their sum. Shown only where
 * the tier has more than one cell, each with its member count, its anonymity
 * set (T-16).
 */
function Cells({
  poll,
  cells,
  words,
}: {
  poll: PollResultsPageProps["poll"];
  cells: readonly CellResults[];
  words: PollWords | undefined;
}) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  const list = new Intl.ListFormat(locale, { type: "conjunction" });
  const several = poll.questions.length > 1;
  const id = `results-cells-${cells[0]?.cell.tier ?? 0}`;
  return (
    <section aria-labelledby={id} className="grid gap-6">
      <div className="grid gap-2">
        <h3 id={id} className="m-0 font-heading text-xl font-semibold">
          {t("resultsCellsTitle")}
        </h3>
        <p className="m-0 max-w-prose text-base text-pretty text-muted-foreground">
          {t("resultsCellsLede", { count: cells.length })}
        </p>
      </div>
      {poll.questions.map((_, index) => {
        const options = words?.questions[index]?.options;
        return (
          <Table key={index}>
            {several || words?.questions[index]?.question !== undefined ? (
              <TableCaption className="pb-3 text-start text-sm">
                <QuestionCaption index={index} words={words} several={several} />
              </TableCaption>
            ) : null}
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className={WRAP}>
                  {t("resultsCell")}
                </TableHead>
                <TableHead scope="col" className={WRAP}>
                  {t("resultsAnswers")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cells.map((c, i) => {
                const counts = c.questions?.[index];
                const members = t(poll.rolling ? "groupMembersAtOpening" : "groupMembers", {
                  count: BigInt(c.cell.members),
                });
                const regions = regionsOf(c.cell, list, (number) => t("resultsRegion", { number }));
                const leaders = counts === undefined ? [] : leadersOf(counts);
                return (
                  <TableRow key={i}>
                    <TableHead scope="row" className={cn(WRAP, "align-top font-normal")}>
                      <span className="block">{t("resultsCellName", { number: i + 1 })}</span>
                      <span className="block text-xs text-muted-foreground">
                        {regions === undefined ? members : `${regions} · ${members}`}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {t("resultsAnswered", { count: c.counted })}
                      </span>
                    </TableHead>
                    <TableCell className={cn(WRAP, "align-top")}>
                      {counts === undefined ? (
                        <span className="text-muted-foreground">
                          {t(c.state === "failed" ? "resultsCellFailed" : "resultsCellMissing")}
                        </span>
                      ) : (
                        <ul className="m-0 grid list-none gap-2 p-0">
                          {counts.map((count, j) => (
                            <li
                              key={j}
                              className="grid grid-cols-[1fr_auto] items-baseline gap-x-3"
                            >
                              <span className="text-pretty">
                                <OptionLabel options={options} index={j} />
                              </span>
                              <span className="text-end">
                                <Share
                                  count={count}
                                  counted={c.counted}
                                  lead={leaders.includes(j)}
                                />
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        );
      })}
    </section>
  );
}

/**
 * How many of the tier's members answered: a share of the members the
 * definition names for it. Only for a tier the definition names once, so the
 * members are that tier's alone, and only where the figure can be a share
 * (`turnoutOf`). The tiers' turnouts are never added up (T-16). For a
 * rolling poll, a share of who could answer by the close, as our server read
 * it, never of the definition's members at the opening: whoever joined by
 * the close could answer too, so a share of those would overstate turnout,
 * and there is none while the server hasn't read the close
 * ([[0028-rolling-electorates]]).
 */
function turnout(poll: PollResultsPageProps["poll"], tier: TierResults) {
  const groups = poll.electorate.filter((g) => g.tier === tier.tier);
  const members = poll.rolling
    ? tier.couldAnswer?.toString()
    : groups.length === 1
      ? groups[0]?.groupSize
      : undefined;
  const share = members === undefined ? undefined : turnoutOf(tier.counted, members);
  return members === undefined || share === undefined
    ? undefined
    : { members, share, rolling: poll.rolling };
}

/** The tier's turnout in words, "17.1% of 7,220 members", or nothing where there is none. */
function useTurnoutText() {
  const t = useTranslate(catalogs);
  const percent = usePercent();
  return (poll: PollResultsPageProps["poll"], tier: TierResults) => {
    const of = turnout(poll, tier);
    return of === undefined
      ? undefined
      : {
          share: of.share,
          text: t(of.rolling ? "resultsTurnoutOfClose" : "resultsTurnoutOf", {
            share: percent.format(of.share),
            count: BigInt(of.members),
          }),
        };
  };
}

/** The tier's turnout with its bar, as the results page's mockup puts it above the tier's result. */
function Turnout({ poll, tier }: { poll: PollResultsPageProps["poll"]; tier: TierResults }) {
  const t = useTranslate(catalogs);
  const of = useTurnoutText()(poll, tier);
  if (of === undefined) return null;
  return (
    <p className="m-0 grid max-w-xl grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-2">
      <span className="text-sm">{t("resultsTurnout")}</span>
      <span className="text-end font-mono text-sm tabular-nums">{of.text}</span>
      <Bar share={of.share} lead={false} />
    </p>
  );
}

/** One tier's panel: each question's sentence and bars, then its cells if it has several. */
function TierPanel({
  poll,
  tier,
  cells,
  words,
}: {
  poll: PollResultsPageProps["poll"];
  tier: TierResults;
  cells: readonly CellResults[] | undefined;
  words: PollWords | undefined;
}) {
  const t = useTranslate(catalogs);
  const several = poll.questions.length > 1;
  const own = cells?.filter((c) => c.cell.tier === tier.tier);
  return (
    <div className="grid gap-10">
      <Turnout poll={poll} tier={tier} />
      {/* The verifier's small-count flag on who could answer: the results
          stand, and say what so few can reveal (8.2, T-16). */}
      {tier.fewCouldAnswer === true ? (
        <p className="m-0 max-w-prose text-base">{t("resultsFewCouldAnswer")}</p>
      ) : null}
      {tier.questions === undefined ? (
        <p role="status" className="m-0 max-w-prose text-base">
          {t("resultsTierPending")}
        </p>
      ) : tier.counted === 0 ? (
        <p className="m-0 text-base">{t("resultsNoneAnswered")}</p>
      ) : (
        // Each question on its own: no figure joins two (ADR 0026; T-16).
        tier.questions.map((counts, i) => (
          <ResultsQuestion
            key={i}
            number={several ? i + 1 : undefined}
            heading={words?.questions[i]?.question}
            options={words?.questions[i]?.options}
            counts={counts}
            counted={tier.counted}
            level={3}
          />
        ))
      )}
      {own === undefined ? (
        <p role="status" className="m-0 max-w-prose text-base text-muted-foreground">
          {t("resultsCellsUnavailable")}
        </p>
      ) : own.length > 1 ? (
        <Cells poll={poll} cells={own} words={words} />
      ) : null}
    </div>
  );
}

/**
 * Who opened each cell of the count: the seats its passing openings are
 * attributed to, by the signature the board checked (docs/spec/tally.md,
 * Opening record), one row per cell in partition order. A seat opens a cell
 * only with `threshold` seats' shares, so naming it says who combined them,
 * not that it could open the cell alone. These are our server's reading of
 * the board, as the counts are (T-29, T-34).
 */
function Openings({
  poll,
  cells,
  phoneVerification,
}: {
  poll: PollResultsPageProps["poll"];
  cells: readonly CellResults[];
  phoneVerification: boolean;
}) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  const list = new Intl.ListFormat(locale, { type: "conjunction" });
  const numbers = new Intl.NumberFormat(locale);
  return (
    <Section
      id="results-openings-title"
      title={t("resultsOpeningsTitle")}
      lede={t("resultsOpeningsLede", { threshold: poll.threshold, size: poll.panelSize })}
    >
      <Table className="max-w-3xl">
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className={WRAP}>
              {t("resultsOpeningsPart")}
            </TableHead>
            <TableHead scope="col" className={WRAP}>
              {t("resultsOpenedBy")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {cells.map((c, i) => {
            const own = cells.filter((o) => o.cell.tier === c.cell.tier);
            const tier = t(tierMessage(c.cell.tier, phoneVerification));
            return (
              <TableRow key={i}>
                <TableHead scope="row" className={cn(WRAP, "font-normal")}>
                  {own.length > 1
                    ? `${tier} · ${t("resultsCellName", { number: own.indexOf(c) + 1 })}`
                    : tier}
                </TableHead>
                <TableCell className={WRAP}>
                  {c.state !== "opened" ? (
                    <span className="text-muted-foreground">
                      {t(c.state === "failed" ? "resultsCellFailed" : "resultsCellMissing")}
                    </span>
                  ) : c.signers.length === 0 ? (
                    t("resultsOpenedUnsigned")
                  ) : (
                    t("resultsSeats", {
                      count: c.signers.length,
                      seats: list.format(c.signers.map((s) => numbers.format(s))),
                    })
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Section>
  );
}

const STATE_TEXT = {
  "not-counted": "resultsNotCounted",
  "not-ready": "resultsUnavailable",
  unavailable: "resultsUnavailable",
} as const;

/**
 * A poll's results page of its own: tier by tier behind a tier switcher,
 * question by question, each in a sentence and then each option's share and
 * count; the tiers side by side with no total column; and, where a tier is
 * counted in several cells, each cell's own results. As on the poll page,
 * these are the results our server reads from the openings on the board,
 * not the verifier's verdict, so the page says so and links to checking
 * them (T-34), first under its facts and again with the ways to check
 * them. It is headed by the poll's facts as the poll page states them, and
 * marked counted only once it has closed with every tier's every
 * question read, as the register marks it; the poll's ID and definition
 * hash, which a recount starts from, are with the ways to check it, after
 * the board's head as the poll page states it.
 */
export function PollResultsPage({
  poll,
  heading,
  results,
  cells,
  status,
  words,
  phoneVerification,
  head,
}: PollResultsPageProps) {
  const t = useTranslate(catalogs);
  const prefix = poll.electionId.slice(0, 16);
  const read = results.kind === "read" && results.tiers.length > 0 ? results.tiers : undefined;
  const counted = status === "closed" && isCounted(poll, results);
  const mark = counted
    ? { icon: CircleCheckBig, tone: "text-recorded", text: "resultsStatusCounted" as const }
    : { ...STATUS_MARK[status], text: STATUS_TEXT[status] };
  return (
    <article className="grid gap-16">
      <PageHeader
        eyebrow={t("resultsPageEyebrow", { prefix })}
        title={
          // Long unbroken words, the ID's above all, wrap rather than push the page sideways.
          heading === undefined ? (
            <span className="break-all">{t("pollHeading", { prefix })}</span>
          ) : (
            <bdi className="break-words">{heading}</bdi>
          )
        }
        lede={t("resultsPageLede")}
      >
        <a
          className="inline-flex min-h-12 items-center gap-2 justify-self-start underline underline-offset-4 focus-text"
          href={`/polls/${poll.electionId}`}
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t("boardPageBack")}
        </a>
        <div className="flex flex-wrap items-center gap-3">
          <StatusMark icon={mark.icon} tone={mark.tone}>
            {t(mark.text)}
          </StatusMark>
        </div>
        <PollFacts poll={poll} phoneVerification={phoneVerification} />
        {/* The mockup's claim under the facts: before any figure, the page
            says it shows our server's word, and links down to how to check
            it without us (T-34). No verifier verdict is claimed, since none
            of our boards is anchored yet (T-53). */}
        <p className="m-0 max-w-prose border-l-2 border-foreground ps-4 text-pretty text-muted-foreground">
          {t("resultsUpFront")}{" "}
          <a
            className="text-foreground underline underline-offset-4 focus-text"
            href="#results-check-title"
          >
            {t("resultsUpFrontLink")}
          </a>
        </p>
      </PageHeader>

      {read === undefined ? (
        <p role="status" className="m-0 max-w-prose text-lg text-pretty">
          {t(
            results.kind === "read"
              ? "resultsUnavailable"
              : results.kind === "unopened"
                ? status === "closed"
                  ? "resultsCounting"
                  : "resultsSealed"
                : STATE_TEXT[results.kind],
          )}
        </p>
      ) : (
        <>
          <Section id="results-tiers-title" title={t("resultsByGroup")}>
            <TierSwitcher
              label={t("resultsByGroup")}
              tiers={read.map((tier) => ({
                value: String(tier.tier),
                label: t(tierMessage(tier.tier, phoneVerification)),
                scope:
                  tier.counted === 0
                    ? t("resultsNoneAnswered")
                    : t("resultsAnswered", { count: tier.counted }),
              }))}
            >
              {(tab) => {
                const tier = read.find((r) => String(r.tier) === tab.value);
                return tier === undefined ? null : (
                  <TierPanel poll={poll} tier={tier} cells={cells} words={words} />
                );
              }}
            </TierSwitcher>
          </Section>
          {read.length > 1 ? (
            <SideBySide
              poll={poll}
              tiers={read}
              words={words}
              phoneVerification={phoneVerification}
            />
          ) : null}
        </>
      )}

      {read === undefined || cells === undefined || cells.length === 0 ? null : (
        <Openings poll={poll} cells={cells} phoneVerification={phoneVerification} />
      )}

      <Section id="results-board-title" title={t("resultsBoardTitle")} lede={t("resultsBoardLede")}>
        <div className="grid max-w-3xl gap-4">
          {head === undefined ? (
            <p role="status" className="m-0">
              {t("resultsBoardUnavailable")}
            </p>
          ) : (
            <BoardHeadFacts head={head} />
          )}
        </div>
      </Section>

      <Section id="results-check-title" title={t("resultsCheckTitle")}>
        <div className="grid max-w-3xl gap-6">
          <p className="m-0 max-w-prose border-l-2 border-foreground ps-4 text-pretty text-muted-foreground">
            {t("resultsClaim")}
          </p>
          <div className="grid gap-4">
            <p className="m-0 max-w-prose text-pretty">{t("resultsFingerprints")}</p>
            <Hash value={poll.electionId} label={t("pollId")} />
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
          </div>
          {/* The mockup's first step. Receipts stay on the voter's device,
              and, as on the board page, this page never looks one up: a
              lookup would tell our server which entry is the asker's, tied
              to their address (T-11), so it points to a whole copy instead. */}
          <div className="grid min-w-0 gap-3">
            <h3 className="m-0 font-heading text-lg font-semibold">{t("resultsReceiptTitle")}</h3>
            <p className="m-0 max-w-prose text-pretty">{t("resultsReceiptBody")}</p>
            <p className="m-0 max-w-prose text-pretty text-muted-foreground">
              {t("resultsReceiptCheck")}
            </p>
          </div>
          <div className="grid min-w-0 gap-3">
            <h3 className="m-0 font-heading text-lg font-semibold">{t("resultsRecountTitle")}</h3>
            <p className="m-0 max-w-prose text-pretty">{t("resultsRecountBody")}</p>
            {/* Wraps rather than scrolls, as on the verify page, so the ID is
                never hidden at 360px. */}
            <pre
              aria-label={t("resultsRecountTitle")}
              className="m-0 border border-foreground bg-muted p-4 font-mono text-sm whitespace-pre-wrap wrap-anywhere"
            >
              <code translate="no">{recountOne(poll.electionId)}</code>
            </pre>
            <dl className="m-0 grid gap-1 text-sm">
              <dt>
                <code translate="no" className="font-mono">
                  $GATEWAY
                </code>
              </dt>
              <dd className="m-0 text-muted-foreground">{t("recountValueGateway")}</dd>
            </dl>
            {/* Until the anchor runs the command finds nothing of ours to
                check, so the page says so rather than imply it would (T-53). */}
            <p className="m-0 max-w-prose text-pretty text-muted-foreground">
              {t("recountNotYetBody")}
            </p>
          </div>
          <ul className="m-0 grid list-none gap-2 p-0">
            <li>
              <a
                className="inline-flex min-h-12 items-center gap-2 underline underline-offset-4 focus-text"
                href={`/polls/${poll.electionId}/board`}
              >
                {t("resultsCheck")}
                <ArrowRight aria-hidden="true" className="size-4" />
              </a>
            </li>
            <li>
              <a
                className="inline-flex min-h-12 items-center gap-2 underline underline-offset-4 focus-text"
                href="/verify"
              >
                {t("resultsVerify")}
                <ArrowRight aria-hidden="true" className="size-4" />
              </a>
            </li>
          </ul>
        </div>
      </Section>
    </article>
  );
}
