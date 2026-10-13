import { cn, Fingerprint, useTranslate } from "@abolishus/ui";
import { useId } from "react";

import { catalogs } from "../messages.ts";
import { type Instant, pollStatus, type PollView } from "../poll.ts";
import type { ListedPoll, PollList as List } from "../server/load.ts";
import { STATUS_MARK } from "./poll-status.ts";
import { When } from "./poll-summary.tsx";

/** A listed poll's ID, which names its row: a definition carries no title of its own. */
function idOf(entry: ListedPoll): string {
  return entry.kind === "poll" ? entry.poll.electionId : entry.electionId;
}

const COLUMN_HEAD = "font-mono text-xs tracking-widest text-muted-foreground uppercase";
// Each cell's label, shown above it on a phone, where the column heads are hidden.
const CELL_TERM = `${COLUMN_HEAD} md:sr-only`;

function Status({ poll, asOf }: { poll: PollView; asOf: Instant }) {
  const t = useTranslate(catalogs);
  const status = pollStatus(poll, asOf);
  const { icon: Icon, tone, label } = STATUS_MARK[status];
  return (
    <span className="grid gap-1">
      <span className="flex items-center gap-2 text-sm font-medium">
        <Icon aria-hidden="true" className={cn("size-4", tone)} />
        {t(label)}
      </span>
      <span className="text-sm text-muted-foreground">
        {t(status === "scheduled" ? "listOpens" : status === "open" ? "listCloses" : "listClosed")}{" "}
        <When instant={status === "scheduled" ? poll.opensAt : poll.closesAt} />
      </span>
    </span>
  );
}

function Row({ entry, asOf }: { entry: ListedPoll; asOf: Instant }) {
  const t = useTranslate(catalogs);
  const titleId = useId();
  const electionId = idOf(entry);
  return (
    <li className="border-b border-border">
      <article
        aria-labelledby={titleId}
        className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-4 py-6 md:grid-cols-12 md:items-baseline md:gap-x-6"
      >
        <h3 id={titleId} className="m-0 text-lg leading-snug font-medium md:col-span-5">
          <a
            className="font-mono underline underline-offset-4"
            translate="no"
            href={`/polls/${electionId}`}
          >
            {t("shortId", { prefix: electionId.slice(0, 16) })}
          </a>
        </h3>
        <span className="row-start-1 justify-self-end md:order-last md:col-span-1 md:row-start-auto">
          <Fingerprint
            value={electionId}
            label={t("fingerprintPoll", { prefix: electionId.slice(0, 8) })}
            size={36}
          />
        </span>
        {entry.kind === "poll" ? (
          <dl className="col-span-2 m-0 grid gap-4 sm:grid-cols-2 md:col-span-6 md:grid-cols-6 md:gap-x-6">
            <div className="grid content-start gap-1 md:col-span-3">
              <dt className={CELL_TERM}>{t("listCounting")}</dt>
              <dd className="m-0 grid gap-1 text-sm">
                <span>
                  {t(entry.poll.electionType === "approval" ? "typeApproval" : "typePlurality")}
                </span>
                {entry.poll.illFormed !== undefined ? (
                  <span className="text-destructive">{t("listIllFormed")}</span>
                ) : null}
              </dd>
            </div>
            <div className="grid content-start gap-1 md:col-span-3">
              <dt className={CELL_TERM}>{t("listStatus")}</dt>
              <dd className="m-0">
                <Status poll={entry.poll} asOf={asOf} />
              </dd>
            </div>
          </dl>
        ) : (
          <p className="col-span-2 m-0 text-sm text-muted-foreground md:col-span-6">
            {t(entry.problem === "undecodable" ? "listUndecodable" : "listMismatch")}
          </p>
        )}
      </article>
    </li>
  );
}

/**
 * Listed polls as rows of the register, under one set of column heads: the
 * poll's ID, its counting rule and its status, read from the definition's
 * times at `asOf` (the server's clock when it loaded them, so the page and
 * its hydration agree).
 */
export function PollRows({
  polls,
  asOf,
  label,
}: {
  polls: readonly ListedPoll[];
  asOf: Instant;
  label: string;
}) {
  const t = useTranslate(catalogs);
  return (
    <div className="grid">
      <div
        aria-hidden="true"
        className="hidden grid-cols-12 gap-x-6 border-y border-foreground py-3 md:grid"
      >
        <span className={cn(COLUMN_HEAD, "col-span-5")}>{t("listPoll")}</span>
        <span className={cn(COLUMN_HEAD, "col-span-3")}>{t("listCounting")}</span>
        <span className={cn(COLUMN_HEAD, "col-span-3")}>{t("listStatus")}</span>
      </div>
      <ol aria-label={label} className="m-0 list-none border-t border-foreground p-0 md:border-t-0">
        {polls.map((entry) => (
          <Row key={idOf(entry)} entry={entry} asOf={asOf} />
        ))}
      </ol>
    </div>
  );
}

/**
 * The polls our API lists for discovery, a page at a time. The listing
 * leaves out delisted and hidden polls (T-68), and it is only ours: the
 * page says that the registry on chain names every poll (T-34).
 */
export function PollList({ list }: { list: List }) {
  const t = useTranslate(catalogs);
  return (
    <section aria-labelledby="list-title" className="grid gap-6">
      <h2 id="list-title" className="m-0 font-heading text-3xl font-semibold">
        {t("listTitle")}
      </h2>
      <p className="m-0 max-w-prose text-muted-foreground">{t("listLede")}</p>
      {list.polls.length === 0 ? (
        <p className="m-0">{t("listEmpty")}</p>
      ) : (
        <PollRows polls={list.polls} asOf={list.asOf} label={t("listTitle")} />
      )}
      {list.next !== undefined ? (
        <a
          className="justify-self-start underline underline-offset-4"
          href={`/polls?after=${list.next}`}
        >
          {t("listMore")}
        </a>
      ) : null}
    </section>
  );
}
