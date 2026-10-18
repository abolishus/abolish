import { buttonVariants, cn, useI18n, useTranslate } from "@abolishus/ui";
import { ArrowRight } from "lucide-react";
import { useId } from "react";

import { catalogs } from "../messages.ts";
import { type Counting, POLL_STATUSES, pollStatus, type PollStatus } from "../poll.ts";
import type { ListedPoll, PollList as List } from "../server/load.ts";
import { formatUtc } from "./format.ts";
import { LookupForm } from "./lookup-form.tsx";
import { PageHeader, Section } from "./page-parts.tsx";
import { PollRows } from "./poll-list.tsx";
import { COUNTING_LABEL, STATUS_MARK } from "./poll-status.ts";

export const COUNTINGS = [
  "plurality",
  "approval",
  "questions",
] as const satisfies readonly Counting[];

/**
 * What the register shows of a page of the list: one value per group, or
 * all of it. `"all"` is what the form sends for a group left at All, kept
 * as it came so the router has no other spelling to redirect to;
 * `undefined` is a group the address leaves out. Both mean no filter.
 */
export interface RegisterFilters {
  readonly status: PollStatus | "all" | undefined;
  readonly counting: Counting | "all" | undefined;
}

/** A group's value, if it filters anything. */
const chosen = <T extends string>(value: T | "all" | undefined): T | undefined =>
  value === "all" ? undefined : value;

/**
 * The register's address for `after` and `filters`, so the next page keeps
 * the same filters. Values are from fixed lists, and `after` is canonical
 * hex, so nothing here needs escaping.
 */
export function registerHref(after: string | undefined, filters: RegisterFilters): string {
  const status = chosen(filters.status);
  const counting = chosen(filters.counting);
  const search = [
    ...(after === undefined ? [] : [`after=${after}`]),
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

const CHIP =
  "inline-flex min-h-12 cursor-pointer items-center gap-2 border border-input px-4 text-sm has-checked:border-foreground has-checked:bg-foreground has-checked:text-background has-focus-visible:ring-3 has-focus-visible:ring-ring";

/**
 * One group of filters, as native radio buttons in a plain GET form, so it
 * works before the page's script loads, or without it (the kit's toggle group
 * and radio group need the script, and the toggle group sets an inline style
 * the CSP refuses). One value per group keeps each filter a single search
 * parameter, which the router keeps as sent. Each option says how many polls
 * on this page it matches.
 */
function FilterGroup<T extends string>({
  name,
  legend,
  options,
  checked,
  count,
  label,
}: {
  name: string;
  legend: string;
  options: readonly T[];
  checked: T | undefined;
  count: (option: T | "all") => number;
  label: (option: T) => string;
}) {
  const t = useTranslate(catalogs);
  const legendId = useId();
  return (
    <div
      role="radiogroup"
      aria-labelledby={legendId}
      className="grid gap-3 border-t border-border pt-4 md:grid-cols-12 md:items-center md:gap-x-6"
    >
      <span
        id={legendId}
        className="font-mono text-xs tracking-widest text-muted-foreground uppercase md:col-span-2"
      >
        {legend}
      </span>
      <div className="flex flex-wrap gap-2 md:col-span-10">
        {(["all", ...options] as const).map((option) => (
          <label key={option} className={CHIP}>
            <input
              type="radio"
              name={name}
              value={option}
              defaultChecked={option === "all" ? checked === undefined : checked === option}
              className="size-4 accent-current"
            />
            {option === "all" ? t("filterAll") : label(option)}
            <span className="font-mono text-xs tabular-nums opacity-80">{count(option)}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export interface PollRegisterProps {
  list: List;
  /** Where this page of the list starts, if not at the beginning. */
  after: string | undefined;
  filters: RegisterFilters;
  /** What was entered in the lookup form, if it wasn't a poll ID. */
  invalid: string | undefined;
}

/**
 * The register of polls (`/polls`): the lookup form, then a page of the
 * polls our API lists, filtered by status and counting rule. The listing
 * leaves out delisted and hidden polls (T-68) and is only ours: the page
 * says the registry on chain names every poll (T-34). Filters apply to the
 * page in hand, never to a search our server runs, and a poll's status is
 * read from its claimed definition's times against the server's clock.
 */
export function PollRegister({ list, after, filters, invalid }: PollRegisterProps) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  const asOf = list.asOf;
  const readable = list.polls.flatMap((entry) => (entry.kind === "poll" ? [entry.poll] : []));
  const rows = list.polls.filter((entry) => matches(entry, filters, asOf));
  const status = chosen(filters.status);
  const counting = chosen(filters.counting);
  const filtered = status !== undefined || counting !== undefined;
  const clear = registerHref(after, { status: undefined, counting: undefined });
  return (
    <div className="grid gap-16">
      <PageHeader eyebrow={t("registerEyebrow")} title={t("registerTitle")} lede={t("listLede")} />

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
        {list.polls.length === 0 ? (
          <p className="m-0 text-lg">{t("listEmpty")}</p>
        ) : (
          <>
            <form method="get" action="/polls" className="grid gap-4">
              {after === undefined ? null : <input type="hidden" name="after" value={after} />}
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
                  time:
                    asOf.iso === undefined ? asOf.seconds : formatUtc(locale, new Date(asOf.iso)),
                })}
              </p>
            </form>

            <div className="grid gap-4">
              <p className="m-0 text-sm font-medium">
                {t("registerMatches", { shown: rows.length, total: list.polls.length })}
              </p>
              {rows.length === 0 ? (
                <div className="grid justify-items-center gap-4 border border-border px-5 py-16 text-center">
                  <h3 className="m-0 font-heading text-2xl font-semibold">
                    {t("registerNoMatchTitle")}
                  </h3>
                  <p className="m-0 max-w-md text-sm text-muted-foreground">
                    {t("registerNoMatch")}
                  </p>
                  <a className={cn(buttonVariants({ variant: "outline" }))} href={clear}>
                    {t("filterClear")}
                  </a>
                </div>
              ) : (
                <PollRows polls={rows} asOf={asOf} label={t("listTitle")} />
              )}
            </div>
          </>
        )}
        {list.next !== undefined ? (
          <a
            className="inline-flex min-h-12 items-center gap-2 justify-self-start underline underline-offset-4"
            href={registerHref(list.next, filters)}
          >
            {t("listMore")}
            <ArrowRight aria-hidden="true" className="size-4" />
          </a>
        ) : null}
      </Section>
    </div>
  );
}
