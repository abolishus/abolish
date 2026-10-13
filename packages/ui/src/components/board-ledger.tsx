import { cn } from "cn";

import { Count } from "./count.tsx";
import { Fingerprint } from "./fingerprint.tsx";

export interface LedgerEntry {
  /** The entry's position on the board. */
  index: number | bigint;
  /** When it was recorded, already formatted by the caller (UTC, the board's). */
  time: string;
  /** What kind of entry it is ("Ballot", "Spoiled ballot", "Anchor"), translated. */
  kind: string;
  /** The entry's hash: 64 lowercase hex digits. */
  hash: string;
}

export interface BoardLedgerProps {
  /** Names the ledger, with its scope, translated by the caller. */
  caption: string;
  /** Column headings, translated by the caller. */
  columns: { index: string; time: string; kind: string; hash: string };
  /** The fingerprint's accessible name for an entry ("Fingerprint of entry 1,204"). */
  fingerprintLabel: (entry: LedgerEntry) => string;
  entries: readonly LedgerEntry[];
  /** The index of an entry to mark, such as the reader's own receipt. */
  highlight?: number | bigint;
  className?: string;
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

/**
 * Board entries on a strict ruled grid, like a public register: number, time,
 * kind, fingerprint and hash. Rows settle in as they scroll into view.
 */
export function BoardLedger({
  caption,
  columns,
  fingerprintLabel,
  entries,
  highlight,
  className,
}: BoardLedgerProps) {
  return (
    <table data-slot="board-ledger" className={cn("w-full border-collapse text-sm", className)}>
      <caption className="pb-3 text-start font-mono text-xs tracking-wide text-muted-foreground uppercase">
        {caption}
      </caption>
      <thead>
        <tr className="border-y border-foreground text-start">
          <th scope="col" className="py-2 pe-4 text-start font-medium">
            {columns.index}
          </th>
          <th scope="col" className="py-2 pe-4 text-start font-medium">
            {columns.time}
          </th>
          <th scope="col" className="hidden py-2 pe-4 text-start font-medium sm:table-cell">
            {columns.kind}
          </th>
          <th scope="col" className="py-2 text-start font-medium">
            {columns.hash}
          </th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => {
          const marked = highlight !== undefined && BigInt(entry.index) === BigInt(highlight);
          return (
            <tr
              key={entry.index.toString()}
              aria-current={marked ? "true" : undefined}
              className={cn("reveal border-b border-border", marked && "bg-muted")}
            >
              <td className="py-2 pe-4 align-middle font-mono">
                <Count value={entry.index} />
              </td>
              <td className="py-2 pe-4 align-middle font-mono whitespace-nowrap">{entry.time}</td>
              <td className="hidden py-2 pe-4 align-middle sm:table-cell">{entry.kind}</td>
              <td className="py-2 align-middle">
                <span className="flex items-center gap-3">
                  <Fingerprint value={entry.hash} label={fingerprintLabel(entry)} size={28} />
                  <code className="font-mono text-xs">{shortHash(entry.hash)}</code>
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
