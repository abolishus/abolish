import { BoardLedger, Count, Fingerprint, ScrollScene, StatFigure, cn } from "@abolishus/ui";
import { NativeSelect, NativeSelectOption } from "@abolishus/ui/ui/native-select";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@abolishus/ui/ui/pagination";
import { ToggleGroup, ToggleGroupItem } from "@abolishus/ui/ui/toggle-group";
import { useId, useState } from "react";

import {
  ANCHORS,
  AS_OF,
  BOARD_TOTALS,
  BOARDS,
  HOURLY,
  HOURLY_STEPS,
  hourLabel,
  short,
  sumHours,
  type EntryKind,
} from "./board-data.ts";
import { Micro, Section } from "./board-parts.tsx";
import { LEVY } from "./fixtures.ts";
import { MockShell, PageHead } from "./shell.tsx";

const fmt = (n: number) => n.toLocaleString("en-US");
const DAY_TOTAL = sumHours(0, 23);
const PEAK = Math.max(...HOURLY);
const PEAK_HOUR = HOURLY.indexOf(PEAK);

const STEP_COPY: readonly { range: string; text: string }[] = [
  {
    range: "00:00–06:00 UTC",
    text: `Overnight, ${fmt(sumHours(0, 5))} entries in six hours, from polls already open in other time zones.`,
  },
  {
    range: "06:00–09:00 UTC",
    text: `Alder County's library levy opens at 06:00. The boards take ${fmt(sumHours(6, 8))} entries in three hours, ${fmt(HOURLY[8] ?? 0)} of them between 08:00 and 09:00.`,
  },
  {
    range: "09:00–15:00 UTC",
    text: `The busiest stretch: ${fmt(sumHours(9, 14))} entries in six hours. The peak hour, ${hourLabel(PEAK_HOUR)}–${hourLabel(PEAK_HOUR + 1)}, adds ${fmt(PEAK)}.`,
  },
  {
    range: "15:00–20:00 UTC",
    text: `${fmt(sumHours(15, 19))} entries until the levy's polls close at 20:00 UTC. From then on the board accepts no ballots for it.`,
  },
  {
    range: "20:00–24:00 UTC",
    text: `After the close come spoiled-ballot openings and the trustees' tally shares: ${fmt(sumHours(20, 23))} entries. The day ends at ${fmt(DAY_TOTAL)} entries across every board.`,
  },
];

const W = 600;
const H = 300;
const PAD = { left: 44, right: 8, top: 16, bottom: 28 };
const MAX = 16_000;

function HourlyChart({ step }: { step: number }) {
  const last = HOURLY_STEPS[step] ?? 23;
  const first = step === 0 ? 0 : (HOURLY_STEPS[step - 1] ?? -1) + 1;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const band = plotW / 24;
  const y = (v: number) => PAD.top + plotH - (v / MAX) * plotH;
  const through = last === 23 ? "the end of the day" : `${hourLabel(last + 1)} UTC`;
  const cumulative = sumHours(0, last);
  return (
    <figure className="m-0 grid gap-6" data-step={step} data-testid="hourly-chart">
      <div className="grid gap-1 border-t-2 border-foreground pt-3">
        <Micro>Through {through}</Micro>
        <p className="m-0 font-heading text-5xl font-semibold tabular-nums">
          <Count value={cumulative} />
        </p>
        <p className="m-0 text-sm text-muted-foreground">entries on all boards since 00:00 UTC</p>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Entries per hour on 3 November 2026, all boards, shown through ${through}: ${fmt(cumulative)} entries. Every hour is in the table below.`}
        className="h-auto w-full overflow-visible"
      >
        {[0, 5_000, 10_000, 15_000].map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(v)}
              y2={y(v)}
              className={v === 0 ? "stroke-foreground" : "stroke-border"}
              strokeWidth={v === 0 ? 1.5 : 1}
            />
            <text
              x={PAD.left - 8}
              y={y(v) + 4}
              textAnchor="end"
              className="fill-muted-foreground font-mono text-[11px]"
            >
              {v === 0 ? "0" : `${v / 1000}k`}
            </text>
          </g>
        ))}
        {HOURLY.map((v, hour) => {
          const drawn = hour <= last;
          const current = hour >= first && hour <= last;
          const x = PAD.left + hour * band + band * 0.14;
          return (
            <rect
              key={hour}
              x={x}
              width={band * 0.72}
              y={y(v)}
              height={y(0) - y(v)}
              style={{
                transform: `scaleY(${drawn ? 1 : 0})`,
                transformBox: "fill-box",
                transformOrigin: "bottom",
              }}
              className={cn(
                "motion-safe:transition-[transform,fill] motion-safe:duration-500 motion-safe:ease-out",
                current ? "fill-primary" : "fill-foreground/30",
              )}
            />
          );
        })}
        {[0, 6, 12, 18, 23].map((hour) => (
          <text
            key={hour}
            x={PAD.left + hour * band + band / 2}
            y={H - 8}
            textAnchor="middle"
            className="fill-muted-foreground font-mono text-[11px]"
          >
            {hourLabel(hour)}
          </text>
        ))}
        {[
          { hour: 6, label: "Levy opens 06:00", show: last >= 6 },
          { hour: 20, label: "Polls closed 20:00 UTC", show: last >= 19 },
        ].map((note) => (
          <g
            key={note.hour}
            className={cn(
              "motion-safe:transition-opacity motion-safe:duration-300",
              note.show ? "opacity-100" : "opacity-0",
            )}
          >
            <line
              x1={PAD.left + note.hour * band}
              x2={PAD.left + note.hour * band}
              y1={PAD.top - 4}
              y2={y(0)}
              className="stroke-foreground"
              strokeDasharray="3 3"
            />
            <text
              x={PAD.left + note.hour * band + (note.hour > 12 ? -6 : 6)}
              y={PAD.top + 6}
              textAnchor={note.hour > 12 ? "end" : "start"}
              className="fill-foreground font-mono text-[11px]"
            >
              {note.label}
            </text>
          </g>
        ))}
      </svg>
    </figure>
  );
}

function HourlyTable() {
  return (
    <details className="group border-y border-border">
      <summary className="flex min-h-12 cursor-pointer items-center gap-2 text-sm font-medium">
        Every hour as a table
      </summary>
      <table className="mb-6 w-full max-w-md border-collapse text-sm">
        <caption className="pb-3 text-start font-mono text-xs tracking-wide text-muted-foreground uppercase">
          Entries per hour on all boards, 3 November 2026 (UTC)
        </caption>
        <thead>
          <tr className="border-y border-foreground">
            <th scope="col" className="py-2 text-start font-medium">
              Hour
            </th>
            <th scope="col" className="py-2 text-end font-medium">
              Entries
            </th>
          </tr>
        </thead>
        <tbody>
          {HOURLY.map((v, hour) => (
            <tr key={hour} className="border-b border-border">
              <th scope="row" className="py-1.5 text-start font-mono font-normal">
                {hourLabel(hour)}–{hourLabel(hour + 1)}
              </th>
              <td className="py-1.5 text-end font-mono">
                <Count value={v} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-foreground">
            <th scope="row" className="py-2 text-start font-medium">
              Day total
            </th>
            <td className="py-2 text-end font-mono font-medium">
              <Count value={DAY_TOTAL} />
            </td>
          </tr>
        </tfoot>
      </table>
    </details>
  );
}

const KINDS: readonly ("All" | EntryKind)[] = [
  "All",
  "Ballot",
  "Spoiled ballot",
  "Opening",
  "Tally share",
];

function Ledger() {
  const [boardId, setBoardId] = useState(BOARDS[0]?.id ?? "");
  const [kind, setKind] = useState<"All" | EntryKind>("All");
  const selectId = useId();
  const kindLabelId = useId();
  const board = BOARDS.find((b) => b.id === boardId) ?? BOARDS[0];
  if (board === undefined) return null;
  const rows = board.sample.filter((e) => kind === "All" || e.kind === kind);
  const firstIndex = board.sample[0]?.index ?? 0;
  const lastIndex = board.sample.at(-1)?.index ?? 0;
  const page = Math.floor(firstIndex / 12) + 1;
  return (
    <div className="grid gap-10">
      <div className="grid gap-8 md:grid-cols-12">
        <div className="grid content-start gap-3 md:col-span-5">
          <label
            htmlFor={selectId}
            className="font-mono text-xs tracking-widest text-muted-foreground uppercase"
          >
            Board
          </label>
          <NativeSelect
            id={selectId}
            value={boardId}
            onChange={(e) => {
              setBoardId(e.target.value);
              setKind("All");
            }}
            className="w-full [&>select]:h-12 [&>select]:text-sm"
          >
            {BOARDS.map((b) => (
              <NativeSelectOption key={b.id} value={b.id}>
                {b.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="grid content-start gap-3 md:col-span-7">
          <Micro>
            <span id={kindLabelId}>Kind of entry</span>
          </Micro>
          <ToggleGroup
            aria-labelledby={kindLabelId}
            variant="outline"
            value={[kind]}
            onValueChange={(next) => {
              const picked = next[0] as "All" | EntryKind | undefined;
              if (picked !== undefined) setKind(picked);
            }}
            className="w-full flex-wrap"
          >
            {KINDS.map((k) => (
              <ToggleGroupItem
                key={k}
                value={k}
                className="h-12 px-4 text-sm aria-pressed:bg-foreground aria-pressed:text-background"
              >
                {k === "All" ? "All kinds" : k}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-12 md:gap-x-6">
        <div className="min-w-0 md:col-span-8">
          {rows.length === 0 ? (
            <p className="m-0 border-y border-foreground py-8 text-sm" role="status">
              No {kind.toLowerCase()} entries on this page of the board. Tally shares are added
              after a poll closes.
            </p>
          ) : (
            <BoardLedger
              caption={`${board.title}, entries ${fmt(firstIndex)}–${fmt(lastIndex)} of ${fmt(board.entries)}`}
              columns={{ index: "Entry", time: "Time (UTC)", kind: "Kind", hash: "Entry hash" }}
              fingerprintLabel={(e) => `Fingerprint of entry ${fmt(Number(e.index))}`}
              entries={rows}
            />
          )}
        </div>
        <div className="grid content-start gap-3 border-t-2 border-foreground pt-3 md:col-span-4">
          <Micro>Board head</Micro>
          <div className="flex items-start gap-4">
            <Fingerprint
              value={board.head}
              label={`Fingerprint of the head of ${board.title}, ${board.head.slice(0, 8)}`}
              size={64}
            />
            <code translate="no" className="min-w-0 font-mono text-xs leading-relaxed break-all">
              {board.head}
            </code>
          </div>
          <p className="m-0 text-sm text-muted-foreground">
            The hash of the latest entry, chained to every entry before it. Two copies of the board
            with the same head hold the same <Count value={board.entries} /> entries.
          </p>
        </div>
      </div>

      <Pagination aria-label="Board pages" className="justify-between gap-4">
        <p className="m-0 self-center font-mono text-xs text-muted-foreground">
          Page {fmt(page)} of {fmt(board.pages)}
        </p>
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious href="#" text="Earlier" aria-label="Earlier entries" />
          </PaginationItem>
          <PaginationItem>
            <PaginationNext href="#" text="Later" aria-label="Later entries" />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}

function Anchors() {
  const final = ANCHORS[0]?.levy.size ?? 1;
  return (
    <ol
      aria-label="Anchors, newest first"
      className="m-0 grid list-none border-t border-foreground p-0"
    >
      {ANCHORS.map((anchor, i) => (
        <li
          key={anchor.segment}
          className="reveal relative grid gap-6 border-b border-border py-8 ps-8 md:grid-cols-12 md:gap-x-6 md:ps-10"
        >
          <span
            aria-hidden="true"
            className={cn(
              "absolute top-9 left-0 size-3 border border-foreground",
              i === 0 ? "bg-primary" : "bg-background",
            )}
          />
          {i < ANCHORS.length - 1 ? (
            <span
              aria-hidden="true"
              className="absolute top-12 bottom-0 left-1.5 w-px -translate-x-1/2 bg-border"
            />
          ) : null}
          <div className="grid content-start gap-1 md:col-span-3">
            <h3 className="m-0 font-heading text-xl font-semibold">
              <time dateTime={`2026-11-03T${anchor.at.slice(-9, -4)}:00Z`}>{anchor.at}</time>
            </h3>
            <p className="m-0 font-mono text-xs text-muted-foreground">
              Segment <Count value={anchor.segment} />
            </p>
            {i === 0 ? <p className="m-0 text-sm text-recorded">Latest</p> : null}
          </div>
          <div className="grid min-w-0 content-start gap-3 md:col-span-5">
            <p className="m-0 text-sm">
              Alder County library levy at <Count value={anchor.levy.size} /> entries
            </p>
            <span aria-hidden="true" className="block h-1.5 bg-muted">
              <span
                className="draw-x block h-full bg-foreground/70"
                style={{ width: `${(anchor.levy.size / final) * 100}%` }}
              />
            </span>
            <div className="flex items-start gap-3">
              <Fingerprint
                value={anchor.levy.root}
                label={`Fingerprint of Merkle root ${anchor.levy.root.slice(0, 8)}`}
                size={36}
              />
              <p className="m-0 grid min-w-0 gap-0.5">
                <span className="text-xs text-muted-foreground">Merkle root</span>
                <code translate="no" className="font-mono text-xs break-all">
                  {anchor.levy.root}
                </code>
              </p>
            </div>
          </div>
          <dl className="m-0 grid min-w-0 content-start gap-3 text-sm md:col-span-4">
            <div className="grid gap-0.5">
              <dt className="text-xs text-muted-foreground">Ethereum transaction</dt>
              <dd className="m-0 font-mono text-xs break-all">0x{anchor.tx}</dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-xs text-muted-foreground">L1 block</dt>
              <dd className="m-0 font-mono text-xs">
                <Count value={anchor.block} />
              </dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-xs text-muted-foreground">Boards in this transaction</dt>
              <dd className="m-0 font-mono text-xs">
                <Count value={anchor.boards} />
              </dd>
            </div>
          </dl>
        </li>
      ))}
    </ol>
  );
}

export function BoardPage() {
  const latest = ANCHORS[0];
  return (
    <MockShell current="/board">
      <PageHead
        eyebrow="The public bulletin board"
        title="The board"
        lede="An entry is one record added to the end of a poll's board, such as an encrypted ballot, and once the hour's anchor is on Ethereum no one, including us, can change or remove it."
      >
        <div className="mt-6 grid gap-10 md:grid-cols-12 md:gap-x-6">
          <StatFigure
            className="md:col-span-4"
            value={<Count value={BOARD_TOTALS.entries} />}
            label="Entries on all boards"
            scope={`${fmt(BOARD_TOTALS.boards)} boards, one per poll, as of ${AS_OF}`}
          />
          <StatFigure
            className="md:col-span-4"
            value="21:00 UTC"
            label="Last anchor to Ethereum"
            scope={`3 Nov 2026 · L1 block ${fmt(latest?.block ?? 0)} · ${latest?.boards ?? 0} boards`}
          />
          <div className="reveal grid content-start gap-3 border-t-2 border-foreground pt-3 md:col-span-4">
            <div className="flex items-center gap-4">
              <Fingerprint
                value={LEVY.boardHead}
                label={`Fingerprint of the levy board's head, ${LEVY.boardHead.slice(0, 8)}`}
                size={56}
              />
              <p className="m-0 grid gap-1">
                <span className="text-sm">Board head, Alder County library levy</span>
                <code translate="no" className="font-mono text-xs text-muted-foreground">
                  {short(LEVY.boardHead)}
                </code>
              </p>
            </div>
          </div>
        </div>
      </PageHead>

      <Section
        index="01"
        mark="Activity"
        title="Entries per hour"
        lede="Election day for the Alder County library levy, 3 November 2026. Scroll through the day: the chart draws each hour only once the text has reached it."
      >
        <ScrollScene
          label="Entries per hour through 3 November 2026"
          side="start"
          steps={STEP_COPY.map((s) => (
            <div key={s.range} className="grid gap-2">
              <Micro>{s.range}</Micro>
              <p className="m-0 text-lg text-pretty">{s.text}</p>
            </div>
          ))}
          graphic={(step) => <HourlyChart step={step} />}
        />
        <HourlyTable />
      </Section>

      <Section
        index="02"
        mark="The ledger"
        title="Read a board, entry by entry"
        lede="Each poll has its own board. Every entry shows its number, the time the board recorded it, its kind and its hash. No entry shows how anyone voted."
      >
        <Ledger />
      </Section>

      <Section
        index="03"
        mark="Anchors"
        title="Anchored to Ethereum, every hour"
        lede="Each hour, the size, head and Merkle root of every board that changed go into one Ethereum transaction. From then on, an altered entry no longer matches its anchor, and anyone can check that from Ethereum alone."
      >
        <Anchors />
      </Section>
    </MockShell>
  );
}
