import {
  BoardLedger,
  buttonVariants,
  Count,
  Fingerprint,
  Hash,
  StatFigure,
  useI18n,
  useTranslate,
} from "@abolishus/ui";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@abolishus/ui/ui/pagination";
import { ArrowLeft, Check, X } from "lucide-react";

import {
  type ActivityBar,
  activityBars,
  type AnchorRow,
  type BoardRow,
  type EntryKind,
  sizeShare,
} from "../board.ts";
import { CEREMONY_ROUNDS, type CeremonyView } from "../ceremony.ts";
import { ENTRY_KINDS } from "../entry-kinds.ts";
import { catalogs, type Messages } from "../messages.ts";
import type { PollView } from "../poll.ts";
import type { BoardHead, Histories, Inclusion } from "../server/load.ts";
import { PageHeader, Section } from "./page-parts.tsx";
import { FilterGroup } from "./filter-group.tsx";
import { Bar } from "./poll-results.tsx";

export interface PollBoardProps {
  poll: PollView;
  head: BoardHead;
  /** Where the page starts, as a canonical decimal `u64`. */
  from: string;
  /** The checked entries from `from`, or `undefined` when `from` is past the end. */
  rows: readonly BoardRow[] | undefined;
  /** The kind of entry the page shows, or every kind with `"all"` or `undefined`. */
  kind: EntryKind | "all" | undefined;
  /** Whether `rows` are in the head's tree; `undefined` with `rows`. */
  inclusion: Inclusion | undefined;
  /** The key ceremony from the board's first entry, on the page that holds it; `undefined` elsewhere. */
  ceremony: CeremonyView | undefined;
  /** Entries per page: every page starts at a multiple of it. */
  pageSize: number;
  /** The board's latest checkpoints, checked, or `undefined` when they failed their checks. */
  anchors: readonly AnchorRow[] | undefined;
  /** Whether the head and the anchors shown are one history; `undefined` with `anchors`. */
  histories: Histories | undefined;
  /** How many checkpoints the page asked for: as many back means there may be earlier ones. */
  activityPage: number;
  /** How many of them the anchors show. */
  anchorPage: number;
}

const KIND_TEXT = {
  ballot: "entryKind_ballot",
  "spoiled-opening": "entryKind_spoiledOpening",
  ceremony: "entryKind_ceremony",
  "tally-opening": "entryKind_tallyOpening",
  "contract-event": "entryKind_contractEvent",
  "share-receipt": "entryKind_shareReceipt",
  "share-complaint": "entryKind_shareComplaint",
  destruction: "entryKind_destruction",
  "close-statement": "entryKind_closeStatement",
  "running-opening": "entryKind_runningOpening",
  "author-approvals": "entryKind_authorApprovals",
} as const satisfies Record<EntryKind, keyof Messages>;

/**
 * One poll's board, entry by entry (T-23): the head as the server claims it,
 * and a page of entries this page decoded and hashed itself (src/board.ts).
 * Every link is a plain one to another page of the same route, so reading the
 * board needs no script. It never looks up an entry by number: asking our
 * server for your own would tell it which entry is yours (T-10). Each entry
 * the head counts is checked to be in its tree, every one of the page alike,
 * so those proofs say no more than the page did (src/server/load.ts). The kind
 * filter works on the page in hand, as the register's filters do, so the
 * server is asked for the same 25 entries whatever a visitor filters by.
 */
export function PollBoard({
  poll,
  head,
  from,
  rows,
  kind,
  inclusion,
  ceremony,
  pageSize,
  anchors,
  histories,
  activityPage,
  anchorPage,
}: PollBoardProps) {
  const t = useTranslate(catalogs);
  const base = `/polls/${poll.electionId}/board`;
  const size = BigInt(head.treeSize);
  const start = BigInt(from);
  const end = start + BigInt(rows?.length ?? 0);
  const page = BigInt(pageSize);
  // Pages start only at multiples of the page size (src/page-sizes.ts).
  const latest = size === 0n ? 0n : ((size - 1n) / page) * page;
  const earlier = start > 0n ? (start - page < latest ? start - page : latest) : undefined;
  const later = rows !== undefined && rows.length === pageSize && end < size ? end : undefined;
  // Never a second link to a page another one already reaches.
  const toLatest =
    size > 0n && start !== latest && earlier !== latest && later !== latest ? latest : undefined;
  const only = kind === "all" ? undefined : kind;
  // Values are canonical decimals and kinds from a fixed list: nothing needs escaping.
  const pageHref = (at: bigint, of: EntryKind | undefined) =>
    `${base}?from=${at}${of === undefined ? "" : `&kind=${of}`}`;
  const shown = only === undefined ? rows : rows?.filter((row) => row.kind === only);
  return (
    <div className="grid gap-16">
      <PageHeader
        eyebrow={t("boardPageEyebrow", { prefix: poll.electionId.slice(0, 16) })}
        title={t("boardPageTitle")}
        lede={t("boardPageLede")}
      >
        <a
          className="inline-flex min-h-12 items-center gap-2 justify-self-start underline underline-offset-4"
          href={`/polls/${poll.electionId}`}
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t("boardPageBack")}
        </a>
        <div className="mt-6 grid gap-10 md:grid-cols-12 md:gap-x-6">
          <StatFigure
            className="md:col-span-4"
            value={<Count value={size} />}
            label={t("boardEntries")}
            scope={t("boardPageScope")}
          />
          <div className="grid min-w-0 content-start gap-3 border-t-2 border-foreground pt-3 md:col-span-8">
            {size === 0n ? (
              <p className="m-0">{t("boardEmpty")}</p>
            ) : (
              <>
                <div className="flex min-w-0 items-start gap-4">
                  <Fingerprint
                    value={head.chainHead}
                    label={t("fingerprintHead", { prefix: head.chainHead.slice(0, 8) })}
                    size={56}
                  />
                  <div className="min-w-0">
                    <Hash value={head.chainHead} label={t("boardHead")} />
                  </div>
                </div>
                <p className="m-0 max-w-prose text-sm text-muted-foreground">
                  {t("boardHeadMeaning", { count: size })}
                </p>
                <Hash value={head.root} label={t("boardRoot")} />
              </>
            )}
            <p className="m-0 max-w-prose text-sm text-muted-foreground">{t("boardUnanchored")}</p>
            {histories?.head === undefined ? null : (
              <History ok={histories.head}>
                {t(histories.head ? "boardHeadHistory" : "boardHeadHistoryBroken")}
              </History>
            )}
          </div>
        </div>
      </PageHeader>

      <Section
        index="01"
        mark={t("boardActivityMark")}
        title={t("boardActivityTitle")}
        id="activity-title"
        lede={<p className="m-0">{t("boardActivityLede")}</p>}
      >
        <p className="m-0 max-w-prose border-l-2 border-foreground ps-4 text-pretty text-muted-foreground">
          {t("boardActivityClaim")}
        </p>
        {anchors === undefined ? (
          <p className="m-0 border-y border-foreground py-8 text-lg" role="status">
            {t("boardActivityUndecodable")}
          </p>
        ) : (
          <Activity bars={activityBars(anchors, activityPage)} />
        )}
      </Section>

      <Section
        index="02"
        mark={t("boardLedgerMark")}
        title={t("boardLedgerTitle")}
        id="ledger-title"
        lede={<p className="m-0">{t("boardLedgerLede")}</p>}
      >
        <p className="m-0 max-w-prose border-l-2 border-foreground ps-4 text-pretty text-muted-foreground">
          {t("boardPageClaim")}
        </p>
        {rows === undefined ? (
          <p className="m-0 border-y border-foreground py-8 text-lg" role="status">
            {t("boardBeyond", { entry: start, count: size })}
          </p>
        ) : rows.length === 0 ? (
          <p className="m-0 border-y border-foreground py-8 text-lg" role="status">
            {t(size === 0n ? "boardEmpty" : "boardEnd")}
          </p>
        ) : (
          <>
            <form method="get" action={base} className="grid gap-4">
              {start === 0n ? null : <input type="hidden" name="from" value={from} />}
              <FilterGroup
                name="kind"
                legend={t("boardKindLegend")}
                // Only the kinds on this page, and the one chosen: offering a
                // kind no entry here has would only ever show nothing.
                options={ENTRY_KINDS.filter(
                  (k) => k === only || rows.some((row) => row.kind === k),
                )}
                checked={only}
                count={(k) =>
                  k === "all" ? rows.length : rows.filter((row) => row.kind === k).length
                }
                label={(k) => t(KIND_TEXT[k])}
              />
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-border pt-4">
                <button type="submit" className={buttonVariants()}>
                  {t("boardKindApply")}
                </button>
                {only === undefined ? null : (
                  <a className="underline underline-offset-4" href={pageHref(start, undefined)}>
                    {t("filterClear")}
                  </a>
                )}
              </div>
            </form>
            {only === undefined ? null : (
              <p className="m-0 text-sm font-medium">
                {t("boardKindMatches", { shown: shown?.length ?? 0, total: rows.length })}
              </p>
            )}
            {shown === undefined || shown.length === 0 ? (
              <p className="m-0 border-y border-foreground py-8 text-lg" role="status">
                {t("boardKindNone")}
              </p>
            ) : (
              <div className="min-w-0 overflow-x-auto">
                <BoardLedger
                  caption={t("boardCaption", { first: start, last: end - 1n, count: size })}
                  columns={{
                    index: t("boardColumnEntry"),
                    time: t("boardColumnPeriod"),
                    kind: t("boardColumnKind"),
                    hash: t("boardColumnHash"),
                  }}
                  fingerprintLabel={(row) => t("fingerprintEntry", { entry: BigInt(row.index) })}
                  entries={shown.map((row) => ({
                    index: BigInt(row.index),
                    time: String(row.segment),
                    kind: t(KIND_TEXT[row.kind]),
                    hash: row.hash,
                  }))}
                />
              </div>
            )}
            {inclusion === undefined || inclusion.checked === 0 ? null : (
              <History ok={inclusion.outside === undefined}>
                {inclusion.outside === undefined
                  ? t("boardInTree", { count: BigInt(inclusion.checked) })
                  : t("boardOutsideTree", { entry: BigInt(inclusion.outside) })}
              </History>
            )}
          </>
        )}
        {earlier === undefined && later === undefined && toLatest === undefined ? null : (
          <Pagination aria-label={t("boardPages")} className="flex-wrap justify-between gap-4">
            <PaginationContent className="flex-wrap gap-2">
              {earlier === undefined ? null : (
                <PaginationItem>
                  <PaginationPrevious
                    href={pageHref(earlier, only)}
                    text={t("boardEarlier")}
                    aria-label={t("boardEarlier")}
                  />
                </PaginationItem>
              )}
              {later === undefined ? null : (
                <PaginationItem>
                  <PaginationNext
                    href={pageHref(later, only)}
                    text={t("boardLater")}
                    aria-label={t("boardLater")}
                  />
                </PaginationItem>
              )}
              {toLatest === undefined ? null : (
                <PaginationItem>
                  <a
                    className="inline-flex min-h-12 items-center px-2 underline underline-offset-4"
                    href={pageHref(toLatest, only)}
                  >
                    {t("boardLatest")}
                  </a>
                </PaginationItem>
              )}
            </PaginationContent>
          </Pagination>
        )}
        <p className="m-0 max-w-prose text-pretty">{t("boardOwnEntry")}</p>
      </Section>

      <Section
        index="03"
        mark={t("boardAnchorsMark")}
        title={t("boardAnchorsTitle")}
        id="anchors-title"
        lede={<p className="m-0">{t("boardAnchorsLede")}</p>}
      >
        <p className="m-0 max-w-prose border-l-2 border-foreground ps-4 text-pretty text-muted-foreground">
          {t("boardAnchorsClaim")}
        </p>
        {anchors === undefined ? (
          <p className="m-0 border-y border-foreground py-8 text-lg" role="status">
            {t("boardAnchorsUndecodable")}
          </p>
        ) : anchors.length === 0 ? (
          <p className="m-0 border-y border-foreground py-8 text-lg" role="status">
            {t("boardAnchorsNone")}
          </p>
        ) : (
          <ol
            aria-label={t("boardAnchorsList")}
            className="m-0 grid list-none border-t border-foreground p-0"
          >
            {anchors.slice(0, anchorPage).map((anchor, i) => (
              <li
                key={anchor.segment}
                className="grid gap-6 border-b border-border py-8 md:grid-cols-12 md:gap-x-6"
              >
                <div className="grid content-start gap-1 md:col-span-3">
                  <h3 className="m-0 font-heading text-xl font-semibold">
                    {t("boardAnchorPeriod", { segment: anchor.segment })}
                  </h3>
                  {i === 0 ? (
                    <p className="m-0 text-sm text-muted-foreground">{t("boardAnchorLatest")}</p>
                  ) : null}
                </div>
                <div className="grid min-w-0 content-start gap-3 md:col-span-9">
                  <dl className="m-0 grid gap-0.5">
                    <dt className="text-xs text-muted-foreground">{t("boardAnchorSize")}</dt>
                    <dd className="m-0 font-mono text-sm">
                      <Count value={BigInt(anchor.size)} />
                    </dd>
                  </dl>
                  <Bar share={sizeShare(anchor, anchors[0]!)} lead={false} />
                  <div className="flex min-w-0 items-start gap-4">
                    <Fingerprint
                      value={anchor.hash}
                      label={t("fingerprintCheckpoint", { segment: anchor.segment })}
                      size={36}
                    />
                    <div className="min-w-0">
                      <Hash value={anchor.hash} label={t("boardAnchorHash")} />
                    </div>
                  </div>
                  <Hash value={anchor.head} label={t("boardAnchorHead")} />
                  <Hash value={anchor.root} label={t("boardAnchorRoot")} />
                  {histories?.anchors[i] === undefined ? null : (
                    <History ok={histories.anchors[i]}>
                      {t(histories.anchors[i] ? "boardAnchorExtends" : "boardAnchorBroken", {
                        segment: anchors[i + 1]?.segment ?? 0,
                      })}
                    </History>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
        {anchors !== undefined && anchors.length > anchorPage ? (
          <p className="m-0 max-w-prose text-pretty">
            {t("boardAnchorsMore", { count: anchorPage })}
          </p>
        ) : null}
      </Section>

      <Section
        index="04"
        mark={t("boardCeremonyMark")}
        title={t("boardCeremonyTitle")}
        id="ceremony-title"
        lede={<p className="m-0">{t("boardCeremonyLede")}</p>}
      >
        <p className="m-0 max-w-prose border-l-2 border-foreground ps-4 text-pretty text-muted-foreground">
          {t("boardCeremonyClaim")}
        </p>
        {ceremony !== undefined ? (
          <Ceremony ceremony={ceremony} />
        ) : size === 0n ? (
          <p className="m-0 border-y border-foreground py-8 text-lg" role="status">
            {t("boardCeremonyEmpty")}
          </p>
        ) : (
          <p className="m-0 border-y border-foreground py-8 text-lg">
            {t("boardCeremonyElsewhere")}{" "}
            <a className="underline underline-offset-4" href={`${base}?from=0#ceremony-title`}>
              {t("boardCeremonyFirstPage")}
            </a>
          </p>
        )}
      </Section>
    </div>
  );
}

/**
 * The ceremony's record as this page read it: whether it is the one the
 * definition commits to (T-34, T-37), its hash, and which seats sent each of
 * the four rounds, never which qualified, since that takes the proofs the
 * verifier checks (T-40). Every seat being ours during launch is said beside
 * them (T-14).
 */
function Ceremony({ ceremony }: { ceremony: CeremonyView }) {
  const t = useTranslate(catalogs);
  if (ceremony.kind !== "transcript")
    return (
      <p className="m-0 border-l-2 border-destructive py-2 ps-3 text-lg font-medium" role="status">
        {t(ceremony.kind === "missing" ? "boardCeremonyMissing" : "boardCeremonyUndecodable")}
      </p>
    );
  const complete = ceremony.seats.filter((seat) => seat.rounds === CEREMONY_ROUNDS).length;
  return (
    <div className="grid gap-8">
      <div className="grid min-w-0 gap-3">
        <History ok={ceremony.committed}>
          {t(ceremony.committed ? "boardCeremonyCommitted" : "boardCeremonyNotCommitted")}
        </History>
        <div className="flex min-w-0 items-start gap-4">
          <Fingerprint value={ceremony.hash} label={t("fingerprintCeremony")} size={36} />
          <div className="min-w-0">
            <Hash value={ceremony.hash} label={t("boardCeremonyHash")} />
          </div>
        </div>
      </div>
      <div className="grid gap-4">
        <h3 className="m-0 font-heading text-xl font-semibold">
          {t("boardCeremonySeatsTitle", { count: complete, seats: ceremony.seats.length })}
        </h3>
        <ol
          aria-label={t("boardCeremonySeats")}
          className="m-0 grid list-none border-t border-foreground p-0 text-sm"
        >
          {ceremony.seats.map((seat) => {
            const all = seat.rounds === CEREMONY_ROUNDS;
            const Icon = all ? Check : X;
            return (
              <li
                key={seat.index}
                className="grid grid-cols-[1fr_auto] gap-x-4 border-b border-border py-3"
              >
                <span>{t("boardCeremonySeat", { index: seat.index })}</span>
                <span className="flex items-center gap-1.5 self-center">
                  <Icon
                    aria-hidden="true"
                    className={all ? "size-4 text-recorded" : "size-4 text-muted-foreground"}
                  />
                  {all
                    ? t("boardCeremonyAllRounds")
                    : t("boardCeremonySomeRounds", { count: seat.rounds })}
                </span>
              </li>
            );
          })}
        </ol>
        <p className="m-0 max-w-prose text-pretty">
          {t("boardCeremonyLaunch")}{" "}
          <a className="underline underline-offset-4" href="/trustees">
            {t("navKeys")}
          </a>
        </p>
      </div>
    </div>
  );
}

/**
 * One verdict of the server's proofs, in words with a mark beside them. A
 * failed one is evidence and says so (T-24); the colour only repeats the words.
 */
function History({ ok, children }: { ok: boolean; children: string }) {
  const Icon = ok ? Check : X;
  return (
    <p
      data-history={ok ? "one" : "broken"}
      className={
        ok
          ? "m-0 flex max-w-prose items-start gap-2 text-sm"
          : "m-0 flex max-w-prose items-start gap-2 border-l-2 border-destructive ps-3 text-sm font-medium"
      }
    >
      <Icon
        aria-hidden="true"
        className={
          ok ? "mt-0.5 size-4 shrink-0 text-recorded" : "mt-0.5 size-4 shrink-0 text-destructive"
        }
      />
      <span>{children}</span>
    </p>
  );
}

// The chart's own units: the SVG scales to its column.
const CHART = { width: 640, height: 180, top: 4, bottom: 4, left: 0, right: 0 };

/**
 * The entries per period as bars, one per checkpointed period, earliest
 * first, with every count in a table under it. Heights are SVG attributes,
 * never inline styles, so the page keeps `style-src 'self'`; nothing moves.
 */
function Activity({ bars }: { bars: readonly ActivityBar[] }) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  const period = new Intl.NumberFormat(locale);
  const first = bars[0];
  const last = bars.at(-1);
  if (first === undefined || last === undefined)
    return (
      <p className="m-0 border-y border-foreground py-8 text-lg" role="status">
        {t("boardActivityNone")}
      </p>
    );
  const counts = bars.map((bar) => BigInt(bar.added));
  const total = counts.reduce((sum, n) => sum + n, 0n);
  const most = counts.reduce((top, n) => (n > top ? n : top), 0n);
  // An all-zero run (re-anchors only) draws flat bars rather than divide by zero.
  const max = most > 0n ? most : 1n;
  const plot = CHART.height - CHART.top - CHART.bottom;
  const band = (CHART.width - CHART.left - CHART.right) / bars.length;
  const base = CHART.top + plot;
  return (
    <div className="grid gap-6">
      <figure className="m-0 grid gap-2 border-t-2 border-foreground pt-3">
        <p aria-hidden="true" className="m-0 text-sm text-muted-foreground">
          {t("boardActivityMost", { count: most })}
        </p>
        <svg
          viewBox={`0 0 ${CHART.width} ${CHART.height}`}
          role="img"
          aria-label={t("boardActivityChart", {
            first: first.segment,
            last: last.segment,
            total,
          })}
          className="h-auto w-full"
        >
          {bars.map((bar, i) => {
            // A ratio of u64 counts: scaled in bigint first, so a large board loses no precision.
            const height = (Number((BigInt(bar.added) * 10_000n) / max) / 10_000) * plot;
            return (
              <rect
                key={bar.segment}
                x={CHART.left + i * band + band * 0.14}
                width={band * 0.72}
                y={base - height}
                height={height}
                className="fill-primary"
              />
            );
          })}
          <line
            x1={CHART.left}
            x2={CHART.width - CHART.right}
            y1={base}
            y2={base}
            className="stroke-foreground"
            strokeWidth={1.5}
          />
        </svg>
        {/* HTML, not SVG text, so the labels keep their size as the chart scales down. */}
        <div
          aria-hidden="true"
          className="flex justify-between gap-4 font-mono text-xs text-muted-foreground"
        >
          <span>{t("boardActivityPeriod", { segment: first.segment })}</span>
          {bars.length > 1 ? (
            <span>{t("boardActivityPeriod", { segment: last.segment })}</span>
          ) : null}
        </div>
      </figure>
      <details>
        <summary className="inline-flex min-h-12 cursor-pointer items-center underline underline-offset-4">
          {t("boardActivityTable")}
        </summary>
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full border-collapse text-sm tabular-nums">
            <caption className="py-2 text-start text-muted-foreground">
              {t("boardActivityCaption")}
            </caption>
            <thead>
              <tr className="border-b border-foreground">
                <th scope="col" className="py-2 text-start font-medium">
                  {t("boardActivityColumnPeriod")}
                </th>
                <th scope="col" className="py-2 text-end font-medium">
                  {t("boardActivityColumnAdded")}
                </th>
              </tr>
            </thead>
            <tbody>
              {bars.map((bar) => (
                <tr key={bar.segment} className="border-b border-border">
                  <th scope="row" className="py-2 text-start font-mono font-normal">
                    {period.format(bar.segment)}
                  </th>
                  <td className="py-2 text-end">
                    <Count value={BigInt(bar.added)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
