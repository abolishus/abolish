// Sample data for the board, receipt and verify mockups (Storybook only).
// Invented, like fixtures.ts: no real election, transaction or block.

import { LEVY, PARKS, COUNCIL, RECEIPT } from "./fixtures.ts";

/** A stable, made-up 32-byte hash for sample rows, from any seed text. */
export function sampleHash(seed: string): string {
  let h = 0x811c9dc5;
  for (const c of seed) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let out = "";
  for (let i = 0; i < 8; i++) {
    h ^= h << 13;
    h >>>= 0;
    h ^= h >>> 17;
    h ^= h << 5;
    h >>>= 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out;
}

/** "1bddad59…bd8c1a5d": enough to tell entries apart in running text. */
export function short(hash: string, size = 8): string {
  return `${hash.slice(0, size)}…${hash.slice(-size)}`;
}

/** The moment the board page is a snapshot of. */
export const AS_OF = "3 November 2026, 21:04 UTC";

export const BOARD_TOTALS = {
  entries: 4_118_302,
  boards: 1_284,
};

/** Entries appended per hour on 3 November 2026 (UTC), across every board. */
export const HOURLY: readonly number[] = [
  212, 168, 141, 133, 176, 384, 6_120, 8_610, 9_402, 9_048, 11_230, 13_950, 13_104, 15_480, 14_720,
  12_096, 13_814, 13_746, 12_452, 9_311, 1_286, 2_214, 690, 402,
];

export const hourLabel = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

/** Where each step of the entries-per-hour scene stops: the last hour it shows. */
export const HOURLY_STEPS = [5, 8, 14, 19, 23] as const;

export const sumHours = (from: number, to: number) =>
  HOURLY.slice(from, to + 1).reduce((total, n) => total + n, 0);

export interface Anchor {
  at: string;
  segment: number;
  block: number;
  tx: string;
  /** Boards whose checkpoints went in the same transaction. */
  boards: number;
  /** The levy board's checkpoint in it. */
  levy: { size: number; root: string };
}

const LEVY_SIZES = [161_874, 161_502, 152_380, 142_860, 129_410, 115_300, 101_960];

export const ANCHORS: readonly Anchor[] = LEVY_SIZES.map((size, i) => {
  const hour = 21 - i;
  return {
    at: `3 Nov 2026, ${hourLabel(hour)} UTC`,
    segment: 495_141 - i,
    block: 21_384_112 - i * 300,
    tx: i === 6 ? RECEIPT.anchorTx : sampleHash(`anchor-tx-${hour}`),
    boards: [212, 214, 214, 213, 211, 209, 208][i] ?? 208,
    levy: { size, root: i === 0 ? LEVY.boardHead : sampleHash(`levy-root-${hour}`) },
  };
});

export type EntryKind = "Ballot" | "Spoiled ballot" | "Opening" | "Tally share";

export interface SampleEntry {
  index: number;
  time: string;
  kind: EntryKind;
  hash: string;
}

export interface BoardOption {
  id: string;
  title: string;
  entries: number;
  head: string;
  pages: number;
  sample: readonly SampleEntry[];
}

function entries(
  election: string,
  first: number,
  startSeconds: number,
  kinds: Partial<Record<number, EntryKind>>,
  count = 12,
): SampleEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const seconds = startSeconds + i * 3 + (i % 4);
    const hh = Math.floor(seconds / 3600);
    const mm = Math.floor((seconds % 3600) / 60);
    const ss = seconds % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return {
      index: first + i,
      time: `${pad(hh)}:${pad(mm)}:${pad(ss)}`,
      kind: kinds[i] ?? "Ballot",
      hash: sampleHash(`${election}-${first + i}`),
    };
  });
}

export const BOARDS: readonly BoardOption[] = [
  {
    id: LEVY.id,
    title: LEVY.title,
    entries: LEVY.entries,
    head: LEVY.boardHead,
    pages: Math.ceil(LEVY.entries / 12),
    sample: entries("levy", 98_204, 14 * 3600 + 7, {
      3: "Spoiled ballot",
      4: "Opening",
      9: "Spoiled ballot",
    }),
  },
  {
    id: PARKS.id,
    title: PARKS.title,
    entries: PARKS.entries,
    head: sampleHash("parks-head"),
    pages: Math.ceil(PARKS.entries / 12),
    sample: entries("parks", 2_407, 20 * 3600 + 41 * 60, { 6: "Spoiled ballot", 7: "Opening" }),
  },
  {
    id: COUNCIL.id,
    title: COUNCIL.title,
    entries: COUNCIL.entries,
    head: sampleHash("council-head"),
    pages: Math.ceil(COUNCIL.entries / 12),
    sample: entries("council", 599, 0, {
      5: "Tally share",
      6: "Tally share",
      7: "Tally share",
      8: "Tally share",
      9: "Tally share",
      10: "Tally share",
      11: "Tally share",
    }),
  },
];

/** The receipt's neighbourhood on the Riverside park board, the receipt itself at 1,203. */
export const RECEIPT_EXCERPT: readonly SampleEntry[] = Array.from({ length: 9 }, (_, i) => {
  const index = 1_199 + i;
  const seconds = 2 * 60 + 12 + (index - RECEIPT.entry) * 9;
  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  return {
    index,
    time: `14:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`,
    kind: index === 1_201 ? "Spoiled ballot" : "Ballot",
    hash: index === RECEIPT.entry ? RECEIPT.hash : sampleHash(`parks-${index}`),
  };
});
