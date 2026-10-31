import {
  cn,
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
import { ArrowLeft, ArrowRight } from "lucide-react";

import { catalogs, tierMessage } from "../messages.ts";
import type { PollStatus, PollView } from "../poll.ts";
import {
  type CellResults,
  leadersOf,
  type PollResults,
  shareOf,
  type TierResults,
} from "../results.ts";
import type { PollWords } from "../stream.ts";
import { PageHeader, Section } from "./page-parts.tsx";
import { ResultsQuestion } from "./poll-results.tsx";

export interface PollResultsPageProps {
  poll: Pick<PollView, "electionId" | "questions" | "threshold" | "panelSize">;
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
 * one column per tier, and no total column: the tiers are never added
 * together (ADR 0026; T-16).
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
                  {tiers.map((tier) => (
                    <TableHead key={tier.tier} scope="col" className={cn(WRAP, "text-end")}>
                      <span className="block">{t(tierMessage(tier.tier, phoneVerification))}</span>
                      <span className="block text-xs font-normal text-muted-foreground">
                        {t("resultsAnswered", { count: tier.counted })}
                      </span>
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
                const members = t("groupMembers", { count: BigInt(c.cell.members) });
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
 * count; the tiers side by side with no total row; and, where a tier is
 * counted in several cells, each cell's own results. As on the poll page,
 * these are the results our server reads from the openings on the board,
 * not the verifier's verdict, so the page says so and links to checking
 * them (T-34).
 */
export function PollResultsPage({
  poll,
  heading,
  results,
  cells,
  status,
  words,
  phoneVerification,
}: PollResultsPageProps) {
  const t = useTranslate(catalogs);
  const prefix = poll.electionId.slice(0, 16);
  const read = results.kind === "read" && results.tiers.length > 0 ? results.tiers : undefined;
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
          className="inline-flex min-h-12 items-center gap-2 justify-self-start underline underline-offset-4"
          href={`/polls/${poll.electionId}`}
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t("boardPageBack")}
        </a>
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

      <Section id="results-check-title" title={t("resultsCheckTitle")}>
        <div className="grid max-w-3xl gap-6">
          <p className="m-0 max-w-prose border-l-2 border-foreground ps-4 text-pretty text-muted-foreground">
            {t("resultsClaim")}
          </p>
          <ul className="m-0 grid list-none gap-2 p-0">
            <li>
              <a
                className="inline-flex min-h-12 items-center gap-2 underline underline-offset-4"
                href={`/polls/${poll.electionId}/board`}
              >
                {t("resultsCheck")}
                <ArrowRight aria-hidden="true" className="size-4" />
              </a>
            </li>
            <li>
              <a
                className="inline-flex min-h-12 items-center gap-2 underline underline-offset-4"
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
