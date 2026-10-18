import { BoardLedger, Count, Fingerprint, Hash, StatFigure, useTranslate } from "@abolishus/ui";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@abolishus/ui/ui/pagination";
import { ArrowLeft } from "lucide-react";

import type { BoardRow, EntryKind } from "../board.ts";
import { catalogs, type Messages } from "../messages.ts";
import type { PollView } from "../poll.ts";
import type { BoardHead } from "../server/load.ts";
import { PageHeader, Section } from "./page-parts.tsx";

export interface PollBoardProps {
  poll: PollView;
  head: BoardHead;
  /** Where the page starts, as a canonical decimal `u64`. */
  from: string;
  /** The checked entries from `from`, or `undefined` when `from` is past the end. */
  rows: readonly BoardRow[] | undefined;
  /** Entries per page: every page starts at a multiple of it. */
  pageSize: number;
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
 * server for your own would tell it which entry is yours (T-10).
 */
export function PollBoard({ poll, head, from, rows, pageSize }: PollBoardProps) {
  const t = useTranslate(catalogs);
  const base = `/polls/${poll.electionId}/board`;
  const size = BigInt(head.treeSize);
  const start = BigInt(from);
  const end = start + BigInt(rows?.length ?? 0);
  const page = BigInt(pageSize);
  // Pages start only at multiples of the page size (src/server/load.ts).
  const latest = size === 0n ? 0n : ((size - 1n) / page) * page;
  const earlier = start > 0n ? (start - page < latest ? start - page : latest) : undefined;
  const later = rows !== undefined && rows.length === pageSize && end < size ? end : undefined;
  // Never a second link to a page another one already reaches.
  const toLatest =
    size > 0n && start !== latest && earlier !== latest && later !== latest ? latest : undefined;
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
                <Hash value={head.root} label={t("boardRoot")} />
              </>
            )}
            <p className="m-0 max-w-prose text-sm text-muted-foreground">{t("boardUnanchored")}</p>
          </div>
        </div>
      </PageHeader>

      <Section
        index="01"
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
              entries={rows.map((row) => ({
                index: BigInt(row.index),
                time: String(row.segment),
                kind: t(KIND_TEXT[row.kind]),
                hash: row.hash,
              }))}
            />
          </div>
        )}
        {earlier === undefined && later === undefined && toLatest === undefined ? null : (
          <Pagination aria-label={t("boardPages")} className="flex-wrap justify-between gap-4">
            <PaginationContent className="flex-wrap gap-2">
              {earlier === undefined ? null : (
                <PaginationItem>
                  <PaginationPrevious
                    href={`${base}?from=${earlier}`}
                    text={t("boardEarlier")}
                    aria-label={t("boardEarlier")}
                  />
                </PaginationItem>
              )}
              {later === undefined ? null : (
                <PaginationItem>
                  <PaginationNext
                    href={`${base}?from=${later}`}
                    text={t("boardLater")}
                    aria-label={t("boardLater")}
                  />
                </PaginationItem>
              )}
              {toLatest === undefined ? null : (
                <PaginationItem>
                  <a
                    className="inline-flex min-h-12 items-center px-2 underline underline-offset-4"
                    href={`${base}?from=${toLatest}`}
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
    </div>
  );
}
