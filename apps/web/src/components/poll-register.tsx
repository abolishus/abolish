import { Button, buttonVariants, cn, useI18n, useTranslate } from "@abolishus/ui";
import { Input } from "@abolishus/ui/ui/input";
import { Label } from "@abolishus/ui/ui/label";
import { ArrowRight, Search } from "lucide-react";
import { type ReactNode, useId } from "react";

import { catalogs } from "../messages.ts";
import { type Counting, COUNTINGS, POLL_STATUSES, pollStatus, type PollStatus } from "../poll.ts";
import type { ListedPoll, PollList as List, RegisterCounts, RegisterPage } from "../server/load.ts";
import { MAX_STREAM_QUERY, MAX_STREAM_TERMS } from "../stream.ts";
import { FilterGroup } from "./filter-group.tsx";
import { formatUtc, formatUtcWhole } from "./format.ts";
import { LookupForm } from "./lookup-form.tsx";
import { PageHeader, Section } from "./page-parts.tsx";
import { PollRows } from "./poll-list.tsx";
import { COUNTING_LABEL, STATUS_MARK } from "./poll-status.ts";

/**
 * What the register shows of the list: the polls whose words hold every
 * term of `q`, the search the API ran (trimmed, as `streamQuery` hands it
 * on), if any; and of a page of them, one value per group, or all of it.
 * `"all"` is what the form sends for a group left at All, kept as it came so
 * the router has no other spelling to redirect to; `undefined` is a group
 * the address leaves out. Both mean no filter.
 */
export interface RegisterFilters {
  readonly q?: string | undefined;
  readonly status: PollStatus | "all" | undefined;
  readonly counting: Counting | "all" | undefined;
}

/** A group's value, if it filters anything. */
const chosen = <T extends string>(value: T | "all" | undefined): T | undefined =>
  value === "all" ? undefined : value;

/**
 * The register's address for `after` and `filters`, so the next page keeps
 * the same search and filters. The groups' values are from fixed lists and
 * `after` is canonical hex; only the search needs escaping.
 */
export function registerHref(after: string | undefined, filters: RegisterFilters): string {
  const status = chosen(filters.status);
  const counting = chosen(filters.counting);
  const search = [
    ...(after === undefined ? [] : [`after=${after}`]),
    ...(filters.q === undefined ? [] : [`q=${encodeURIComponent(filters.q)}`]),
    ...(status === undefined ? [] : [`status=${status}`]),
    ...(counting === undefined ? [] : [`counting=${counting}`]),
  ];
  return search.length === 0 ? "/polls" : `/polls?${search.join("&")}`;
}

/** Whether `entry` passes `filters`; a poll the page can't read passes only no filter. */
function matches(entry: ListedPoll, filters: RegisterFilters, asOf: List["asOf"]): boolean {
  const status = chosen(filters.status);
  const counting = chosen(filters.counting);
  if (status === undefined && counting === undefined) return true;
  if (entry.kind !== "poll") return false;
  return (
    (status === undefined || pollStatus(entry.poll, asOf) === status) &&
    (counting === undefined || entry.poll.counting === counting)
  );
}

/**
 * The search box: a plain GET form, so it works before the page's script
 * loads, keeping the filters but not the page, since a new search starts
 * from the top. What was typed is shown back only in the box, never in the
 * page's text, so a link can't put words in our voice (T-67).
 */
function SearchForm({ typed, filters }: { typed: string; filters: RegisterFilters }) {
  const t = useTranslate(catalogs);
  const inputId = useId();
  const hintId = useId();
  const status = chosen(filters.status);
  const counting = chosen(filters.counting);
  return (
    <form role="search" method="get" action="/polls" className="grid max-w-2xl gap-2">
      <Label htmlFor={inputId} className="text-base font-semibold">
        {t("registerSearchLabel")}
      </Label>
      <div className="flex flex-wrap gap-3">
        <div className="relative min-w-0 flex-1 basis-64">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id={inputId}
            type="search"
            name="q"
            defaultValue={typed}
            maxLength={MAX_STREAM_QUERY}
            autoComplete="off"
            aria-describedby={hintId}
            className="h-12 ps-11 text-base md:text-base"
          />
        </div>
        <Button type="submit" variant="outline" className="h-12 px-5">
          {t("streamSearchSubmit")}
        </Button>
      </div>
      <p id={hintId} className="m-0 text-sm text-muted-foreground">
        {t("registerSearchHint", { words: MAX_STREAM_TERMS })}
      </p>
      {status === undefined ? null : <input type="hidden" name="status" value={status} />}
      {counting === undefined ? null : <input type="hidden" name="counting" value={counting} />}
    </form>
  );
}

/** Nothing to list: what happened, and a way on. */
function Empty({
  title,
  children,
  href,
  action,
}: {
  title: string;
  children: ReactNode;
  href: string;
  action: string;
}) {
  return (
    <div className="grid justify-items-center gap-4 border border-border px-5 py-16 text-center">
      <h3 className="m-0 font-heading text-2xl font-semibold">{title}</h3>
      <p className="m-0 max-w-md text-sm text-muted-foreground">{children}</p>
      <a className={cn(buttonVariants({ variant: "outline" }))} href={href}>
        {action}
      </a>
    </div>
  );
}

export interface PollRegisterProps {
  page: RegisterPage;
  /** Where this page of the list starts, if not at the beginning. */
  after: string | undefined;
  /** What the search box holds: the visitor's query as it came, or `""`. */
  typed: string;
  filters: RegisterFilters;
  /** What was entered in the lookup form, if it wasn't a poll ID. */
  invalid: string | undefined;
  /** Whether Tier 0 asks for a phone here, which names it on each row's count. */
  phoneVerification: boolean;
}

/**
 * The whole listing in numbers under the heading, as the register's mockup
 * has them: every listed poll, those open now and those not open yet, from
 * the API's counts rather than the page in hand, at the clock the page read
 * statuses by, on the register's first page unsearched. Like the list, they
 * leave out delisted and hidden polls, which the lede says (T-68).
 */
function Tally({ counts, asOf }: { counts: RegisterCounts; asOf: List["asOf"] }) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  const number = new Intl.NumberFormat(locale);
  const figures = [
    { term: t("registerCountListed"), value: counts.listed },
    { term: t("registerCountOpen"), value: counts.open },
    { term: t("registerCountScheduled"), value: counts.scheduled },
  ];
  return (
    <section aria-labelledby="register-counts" className="mt-4">
      {/* A named section, since a list of terms takes no name of its own. */}
      <h2 id="register-counts" className="sr-only">
        {t("registerCounts")}
      </h2>
      <dl className="m-0 grid grid-cols-2 gap-x-8 gap-y-6 border-t border-foreground pt-5 sm:grid-cols-4">
        {figures.map(({ term, value }) => (
          <div key={term} className="grid content-start gap-1">
            <dt className="text-sm text-muted-foreground">{term}</dt>
            <dd className="m-0 font-heading text-3xl font-semibold tabular-nums">
              {number.format(value)}
            </dd>
          </div>
        ))}
        <div className="grid content-start gap-1">
          <dt className="text-sm text-muted-foreground">{t("registerCountAsOf")}</dt>
          {/* As `When` does: the two ICU versions can word a date differently. */}
          <dd className="m-0 pt-2 font-mono text-xs" suppressHydrationWarning>
            {t("utcTime", {
              time:
                asOf.iso === undefined ? asOf.seconds : formatUtcWhole(locale, new Date(asOf.iso)),
            })}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * The register of polls (`/polls`): the lookup form, then a page of the
 * polls our API lists, narrowed by a search the API runs over the polls'
 * words and filtered by status and counting rule. The listing leaves out
 * delisted and hidden polls (T-68) and is only ours: the page says the
 * registry on chain names every poll (T-34). Filters apply to the page in
 * hand, never to a search our server runs, and a poll's status is read from
 * its claimed definition's times against the server's clock.
 */
export function PollRegister({
  page,
  after,
  typed,
  filters,
  invalid,
  phoneVerification,
}: PollRegisterProps) {
  const t = useTranslate(catalogs);
  const { q } = filters;
  const status = chosen(filters.status);
  const counting = chosen(filters.counting);
  const unsearched = registerHref(undefined, { status, counting });
  return (
    <div className="grid gap-16">
      <PageHeader eyebrow={t("registerEyebrow")} title={t("registerTitle")} lede={t("listLede")}>
        {page.kind === "list" && page.counts !== undefined ? (
          <Tally counts={page.counts} asOf={page.asOf} />
        ) : null}
      </PageHeader>

      <section
        aria-labelledby="lookup-title"
        className="grid gap-5 border border-border p-5 sm:p-7"
      >
        <h2 id="lookup-title" className="m-0 font-heading text-2xl font-semibold">
          {t("registerLookupTitle")}
        </h2>
        <LookupForm invalid={invalid} />
      </section>

      <Section
        index="01"
        mark={t("listTitle")}
        title={t("registerFindTitle")}
        id="list-title"
        lede={<p className="m-0">{t("registerFindLede")}</p>}
      >
        <div className="grid gap-3">
          <SearchForm typed={typed} filters={filters} />
          {q === undefined || page.kind === "search-refused" ? null : (
            <p className="m-0 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
              <span>{t("registerSearching")}</span>
              <a className="underline underline-offset-4" href={unsearched}>
                {t("streamSearchClear")}
              </a>
            </p>
          )}
        </div>
        {page.kind === "search-refused" ? (
          <Empty
            title={t("streamSearchRefusedTitle")}
            href={unsearched}
            action={t("streamSearchClear")}
          >
            {t("streamSearchRefused", { words: MAX_STREAM_TERMS, characters: MAX_STREAM_QUERY })}
          </Empty>
        ) : page.polls.length === 0 && q !== undefined ? (
          <Empty title={t("registerSearchEmpty")} href={unsearched} action={t("streamSearchClear")}>
            {t("registerSearchEmptyLede")}
          </Empty>
        ) : page.polls.length === 0 ? (
          <p className="m-0 text-lg">{t("listEmpty")}</p>
        ) : (
          <ListPage
            list={page}
            after={after}
            filters={filters}
            phoneVerification={phoneVerification}
          />
        )}
      </Section>
    </div>
  );
}

/** A page of the list, with its filters over the page in hand and the link to the next. */
function ListPage({
  list,
  after,
  filters,
  phoneVerification,
}: {
  list: List;
  after: string | undefined;
  filters: RegisterFilters;
  phoneVerification: boolean;
}) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  const asOf = list.asOf;
  const readable = list.polls.flatMap((entry) => (entry.kind === "poll" ? [entry.poll] : []));
  const rows = list.polls.filter((entry) => matches(entry, filters, asOf));
  const { q } = filters;
  const status = chosen(filters.status);
  const counting = chosen(filters.counting);
  const filtered = status !== undefined || counting !== undefined;
  const clear = registerHref(after, { q, status: undefined, counting: undefined });
  return (
    <>
      <form method="get" action="/polls" className="grid gap-4">
        {after === undefined ? null : <input type="hidden" name="after" value={after} />}
        {q === undefined ? null : <input type="hidden" name="q" value={q} />}
        <FilterGroup
          name="status"
          legend={t("listStatus")}
          options={POLL_STATUSES}
          checked={status}
          count={(s) =>
            s === "all"
              ? list.polls.length
              : readable.filter((p) => pollStatus(p, asOf) === s).length
          }
          label={(s) => t(STATUS_MARK[s].label)}
        />
        <FilterGroup
          name="counting"
          legend={t("listCounting")}
          options={COUNTINGS}
          checked={counting}
          count={(c) =>
            c === "all" ? list.polls.length : readable.filter((p) => p.counting === c).length
          }
          label={(c) => t(COUNTING_LABEL[c])}
        />
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-border pt-4">
          <button type="submit" className={buttonVariants()}>
            {t("filterApply")}
          </button>
          {filtered ? (
            <a className="underline underline-offset-4" href={clear}>
              {t("filterClear")}
            </a>
          ) : null}
        </div>
        {/* As `When` does: the two ICU versions can word a date differently. */}
        <p className="m-0 text-sm text-muted-foreground" suppressHydrationWarning>
          {t("registerAsOf", {
            time: asOf.iso === undefined ? asOf.seconds : formatUtc(locale, new Date(asOf.iso)),
          })}
        </p>
      </form>

      <div className="grid gap-4">
        <p className="m-0 text-sm font-medium">
          {t("registerMatches", { shown: rows.length, total: list.polls.length })}
        </p>
        {rows.length === 0 ? (
          <Empty title={t("registerNoMatchTitle")} href={clear} action={t("filterClear")}>
            {t("registerNoMatch")}
          </Empty>
        ) : (
          <PollRows
            polls={rows}
            asOf={asOf}
            label={t("listTitle")}
            phoneVerification={phoneVerification}
          />
        )}
      </div>
      {list.next !== undefined ? (
        <a
          className="inline-flex min-h-12 items-center gap-2 justify-self-start underline underline-offset-4"
          href={registerHref(list.next, filters)}
        >
          {t("listMore")}
          <ArrowRight aria-hidden="true" className="size-4" />
        </a>
      ) : null}
    </>
  );
}
