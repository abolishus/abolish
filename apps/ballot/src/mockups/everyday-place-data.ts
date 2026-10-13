// The Riverside board for "Your place" (Storybook only), as the ballot client
// sees it the moment the receipt for entry 2,431 arrives, on 7 November at
// 14:02:12 UTC. Copied from the website's board-place-data.ts rather than
// imported, so the ballot client never reaches into the website's code; the
// same generator gives the same first 2,418 entries. Invented, and the hashes
// are stand-ins, consistent with each other (each parent is mixed from its two
// children), not computed with `H`.

import { auditPath, type BoardMapSegment, type InclusionSibling } from "@abolishus/ui";

import { EVERYDAY_RECEIPT, EVERYDAY_SEALED } from "./everyday-fixtures.ts";

const pad = (n: number) => String(n).padStart(2, "0");
export const fmt = (n: number) => n.toLocaleString("en-US");

/** A stable, made-up 32-byte hash from any seed text. */
function sampleHash(seed: string): string {
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

function unit(seed: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
}

const DAYS = ["1 Nov", "2 Nov", "3 Nov", "4 Nov", "5 Nov", "6 Nov", "7 Nov"];

function daytime(hour: number): number {
  const shape = [
    0.05, 0.03, 0.02, 0.02, 0.03, 0.08, 0.25, 0.6, 0.85, 0.9, 0.95, 1, 1.15, 1.1, 1, 0.95, 1, 1.15,
    1.3, 1.35, 1.2, 0.9, 0.5, 0.2,
  ];
  return shape[hour] ?? 0;
}

function spread(count: number, from: number, to: number, fade: number) {
  const weights = Array.from({ length: to - from }, (_, i) => {
    const h = from + i;
    return daytime(h % 24) * Math.exp(-fade * (h / 24)) * (0.75 + unit(h) * 0.5);
  });
  const sum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (w / sum) * count);
  const sizes = raw.map(Math.floor);
  let left = count - sizes.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left === 0) break;
    sizes[i]!++;
    left--;
  }
  return sizes.map((size, i) => ({ hour: from + i, size })).filter((h) => h.size > 0);
}

const OPEN = 12;
const RECEIPT_HOUR = 2 * 24 + 14;
const AT_12 = 6 * 24 + 12;
/** The hour of the receipt, 7 November 14:00: not anchored until 15:00. */
const NOW_HOUR = 6 * 24 + 14;
/** The anchoring period of 14:00–15:00 UTC on 3 November, on the anchor contract's clock. */
const PERIOD_3NOV_14 = 495_135;

const HOURS = [
  { hour: OPEN, size: 4 },
  ...spread(1_186, OPEN + 1, RECEIPT_HOUR, 0.15),
  { hour: RECEIPT_HOUR, size: 40 },
  ...spread(2_418 - 1_230, RECEIPT_HOUR + 1, AT_12, 0.15),
  { hour: AT_12, size: 7 },
  { hour: AT_12 + 1, size: 6 },
  { hour: NOW_HOUR, size: 1 },
];

const block = (absoluteHour: number) => 21_384_112 + (absoluteHour - (2 * 24 + 21)) * 300;

function build() {
  const total = HOURS.reduce((n, h) => n + h.size, 0);
  const kinds = new Uint8Array(total);
  const segments: BoardMapSegment[] = [];
  let first = 0;
  for (const { hour, size } of HOURS) {
    for (let j = 0; j < size; j++) kinds[first + j] = unit(first + j) < 0.002 ? 3 : 0;
    if (hour === OPEN) [3, 2, 2, 2].forEach((k, j) => (kinds[j] = k));
    const end = hour + 1;
    segments.push({
      segment: PERIOD_3NOV_14 + hour - RECEIPT_HOUR,
      first,
      size,
      label: `${pad(hour % 24)}:00`,
      group: DAYS[Math.floor(hour / 24)]!,
      anchor:
        hour === NOW_HOUR
          ? null
          : { at: `${DAYS[Math.floor(end / 24)]}, ${pad(end % 24)}:00 UTC`, block: block(end) },
    });
    first += size;
  }
  kinds[1_201] = 1;
  kinds[EVERYDAY_SEALED.spoiledEntry] = 1;
  kinds[EVERYDAY_RECEIPT.entry] = 0;
  return { kinds, segments };
}

export const BOARD = build();
export const MINE = EVERYDAY_RECEIPT.entry;
/** The board the receipt signs: every entry up to and including yours. */
export const SIZE = MINE + 1;
export const MINE_SEGMENT = BOARD.segments.at(-1)!;

const KIND_WORDS = ["Answer", "Checked, set aside", "Key holders' record", "Sent to Ethereum"];

export function entryHash(index: number): string {
  return index === MINE ? EVERYDAY_RECEIPT.hash : sampleHash(`parks-${index}`);
}

/** Rows of the board just before yours, and yours. */
export function rowsUpTo(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const index = MINE - count + 1 + i;
    const time =
      index === MINE
        ? "14:02:12"
        : index === EVERYDAY_SEALED.spoiledEntry
          ? "13:58:40"
          : `13:${pad(40 + i * 3)}:${pad((index * 17) % 60)}`;
    return {
      index,
      time,
      kind:
        index === EVERYDAY_SEALED.spoiledEntry
          ? "Your checked answers, set aside"
          : KIND_WORDS[BOARD.kinds[index] ?? 0]!,
      hash: entryHash(index),
    };
  });
}

/** The receipt's inclusion proof: entry 2,431 in the tree of the first 2,432 entries. */
export const PROOF = (() => {
  const entry = entryHash(MINE);
  const leafHash = sampleHash(`leaf:${entry}`);
  const siblings: InclusionSibling[] = [];
  const parents: string[] = [];
  let running = leafHash;
  for (const step of auditPath(MINE, SIZE)) {
    const hash = sampleHash(`parks-subtree-${step.sibling.from}-${step.sibling.to}`);
    siblings.push({ side: step.side, hash });
    running =
      step.side === "left"
        ? sampleHash(`node:${hash}${running}`)
        : sampleHash(`node:${running}${hash}`);
    parents.push(running);
  }
  return { index: MINE, size: SIZE, entryHash: entry, leafHash, siblings, parents, root: running };
})();
