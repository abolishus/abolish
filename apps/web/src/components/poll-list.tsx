import { cn, Fingerprint, useTranslate } from "@abolishus/ui";
import { useId } from "react";

import { catalogs } from "../messages.ts";
import { type Instant, pollStatus, type PollView } from "../poll.ts";
import type { ListedPoll } from "../server/load.ts";
import { COUNTING_LABEL, STATUS_MARK } from "./poll-status.ts";
import { When } from "./when.tsx";

/** A listed poll's ID, which names its row where the poll's own words can't. */
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
  const text = entry.kind === "poll" ? entry.text : undefined;
  const shortId = t("shortId", { prefix: electionId.slice(0, 16) });
  return (
    <li className="border-b border-border">
      <article
        aria-labelledby={titleId}
        className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-4 py-6 md:grid-cols-12 md:items-baseline md:gap-x-6"
      >
        {/* In the poll's own words where the definition commits to them, in
            their own language and direction, with its ID under them (T-34,
            T-41); by its ID alone otherwise. */}
        {text === undefined ? (
          <h3 id={titleId} className="m-0 text-lg leading-snug font-medium md:col-span-5">
            <a
              className="font-mono underline underline-offset-4"
              translate="no"
              href={`/polls/${electionId}`}
            >
              {shortId}
            </a>
          </h3>
        ) : (
          <div className="grid min-w-0 gap-1 md:col-span-5">
            <h3
              id={titleId}
              lang={text.language}
              dir="auto"
              className="m-0 text-lg leading-snug font-medium break-words text-pretty"
            >
              <a className="underline underline-offset-4" href={`/polls/${electionId}`}>
                {text.heading}
              </a>
            </h3>
            <p className="m-0 font-mono text-sm text-muted-foreground" translate="no">
              {shortId}
            </p>
          </div>
        )}
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
                <span>{t(COUNTING_LABEL[entry.poll.counting])}</span>
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
 * poll, in its own words where they can be shown and by its ID, its counting
 * rule and its status, read from the definition's
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
