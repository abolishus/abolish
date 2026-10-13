// Sample boards for the "your place on the board" mockups (Storybook only).
// Invented, but shaped like real boards and consistent with board-data.ts and
// fixtures.ts: the levy's anchors, and the Riverside receipt at entry 1,203.
// Hashes are stand-ins from sampleHash, consistent with each other (each
// parent is mixed from its two children), not computed with `H`.

import { auditPath, type BoardMapSegment, type InclusionSibling } from "@abolishus/ui";

import { sampleHash } from "./board-data.ts";
import { RECEIPT } from "./fixtures.ts";

const pad = (n: number) => String(n).padStart(2, "0");
const fmt = (n: number) => n.toLocaleString("en-US");

/** A deterministic number in [0, 1). */
function unit(seed: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
}

interface SegmentSpec {
  label: string;
  group: string;
  /** Hour of day the period starts, for entry times. */
  hour: number;
  /** The anchoring period `s`. */
  period: number;
  size: number;
  anchor: { at: string; block: number; tx: string } | null;
  /** Kind codes at given offsets into the segment; the rest are ballots. */
  kinds?: Readonly<Record<number, number>>;
}

export interface SampleBoard {
  id: string;
  kinds: Uint8Array;
  segments: BoardMapSegment[];
  specs: readonly SegmentSpec[];
}

function build(id: string, specs: readonly SegmentSpec[], eventRate: number) {
  const total = specs.reduce((n, s) => n + s.size, 0);
  const kinds = new Uint8Array(total);
  const segments: BoardMapSegment[] = [];
  let first = 0;
  specs.forEach((spec) => {
    for (let j = 0; j < spec.size; j++)
      kinds[first + j] = spec.kinds?.[j] ?? (unit(first + j) < eventRate ? 3 : 0);
    segments.push({
      segment: spec.period,
      first,
      size: spec.size,
      label: spec.label,
      group: spec.group,
      anchor: spec.anchor === null ? null : { at: spec.anchor.at, block: spec.anchor.block },
    });
    first += spec.size;
  });
  return { id, kinds, segments, specs } satisfies SampleBoard;
}

export const segmentOf = (board: SampleBoard, index: number) => {
  const i = board.segments.findIndex((s) => index >= s.first && index < s.first + s.size);
  return { segment: board.segments[i]!, spec: board.specs[i]! };
};

/** The entry hash of a sample board's entry; the Riverside receipt's own hash at 1,203. */
export function entryHash(board: SampleBoard, index: number): string {
  if (board.id === "parks" && index === RECEIPT.entry) return RECEIPT.hash;
  return sampleHash(`${board.id}-${index}`);
}

/** When an entry was appended: spread through its hour, or the receipt's own time. */
export function entryTime(board: SampleBoard, index: number): string {
  if (board.id === "parks" && index >= 1_199 && index <= 1_207) {
    const seconds = 2 * 60 + 12 + (index - RECEIPT.entry) * 9;
    return `14:${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
  }
  const { segment, spec } = segmentOf(board, index);
  const seconds = Math.floor(((index - segment.first + 0.5) / segment.size) * 3600);
  return `${pad(spec.hour)}:${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

export const KIND_NAMES = ["Ballot", "Spoiled ballot", "Trustee record", "Contract event"];

/** Ledger rows around an entry. */
export function ledgerAround(board: SampleBoard, index: number, span: number) {
  return Array.from({ length: span * 2 + 1 }, (_, i) => {
    const at = index - span + i;
    return {
      index: at,
      time: entryTime(board, at),
      kind: KIND_NAMES[board.kinds[at] ?? 0]!,
      hash: entryHash(board, at),
    };
  });
}

/**
 * An inclusion proof as a verifier returns it, for entry `index` in the tree
 * of the first `size` entries: leaf hash, audit path with sides, each
 * computed parent and the root.
 */
export function proofFor(board: SampleBoard, index: number, size: number) {
  const entry = entryHash(board, index);
  const leafHash = sampleHash(`leaf:${entry}`);
  const siblings: InclusionSibling[] = [];
  const parents: string[] = [];
  let running = leafHash;
  for (const step of auditPath(index, size)) {
    const hash = sampleHash(`${board.id}-subtree-${step.sibling.from}-${step.sibling.to}`);
    siblings.push({ side: step.side, hash });
    running =
      step.side === "left"
        ? sampleHash(`node:${hash}${running}`)
        : sampleHash(`node:${running}${hash}`);
    parents.push(running);
  }
  return { index, size, entryHash: entry, leafHash, siblings, parents, root: running };
}

/** Ethereum block of the anchor at `hour` on 3 November, as board-data.ts's ANCHORS count them. */
/** The anchoring period of 14:00–15:00 UTC on 3 November, as board-data.ts's ANCHORS number them. */
const PERIOD_3NOV_14 = 495_135;
const levyBlock = (hour: number) => 21_384_112 - (21 - hour) * 300;
const anchorTx = (hour: number) =>
  hour === 15 ? RECEIPT.anchorTx : sampleHash(`anchor-tx-${hour}`);

// The Alder County library levy on 3 November 2026: the registration and the
// key ceremony before the 06:00 opening, ballots until 20:00, then the
// spoiled-ballot openings, the tally and the trustees' destruction statements.
// Checkpoint sizes from 15:00 on are board-data.ts's anchored ones.
const LEVY_HOURS = [
  8, 5_596, 9_134, 8_672, 9_778, 11_917, 13_173, 14_662, 15_538, 13_482, 13_340, 14_110, 13_450,
  9_520, 9_122, 372,
];

export const LEVY_BOARD = build(
  "levy",
  LEVY_HOURS.map((size, i) => {
    const hour = 5 + i;
    const kinds: Record<number, number> = {};
    if (i === 0) [3, 2, 2, 2, 2, 2, 2, 2].forEach((k, j) => (kinds[j] = k));
    if (hour === 20) for (let j = 0; j < size; j++) kinds[j] = j < 344 ? 1 : 2;
    return {
      label: `${pad(hour)}:00`,
      group: "3 Nov 2026",
      hour,
      period: PERIOD_3NOV_14 - 14 + hour,
      size,
      anchor: {
        at: `${pad(hour + 1)}:00 UTC`,
        block: levyBlock(hour + 1),
        tx: anchorTx(hour + 1),
      },
      kinds,
    };
  }),
  0.0004,
);

export const LEVY_MINE = 95_208;
export const LEVY_MINE_AT = segmentOf(LEVY_BOARD, LEVY_MINE);
/** The 15:00 checkpoint closes the 14:00 segment: 101,960 entries. */
export const LEVY_CHECKPOINT = LEVY_MINE_AT.segment.first + LEVY_MINE_AT.segment.size;
export const LEVY_PROOF = proofFor(LEVY_BOARD, LEVY_MINE, LEVY_CHECKPOINT);

/** How many entries of each kind a board or a run of it holds. */
export function countKinds(board: SampleBoard, from = 0, to = board.kinds.length) {
  const counts = [0, 0, 0, 0];
  for (let i = from; i < to; i++) counts[board.kinds[i] ?? 0]!++;
  return counts;
}

// Riverside park improvements, an open poll since 1 November, 12:00 UTC:
// answers come in by day and thin out at night. 2,418 entries by the 12:00
// anchor on 7 November; the receipt's entry, 1,203, at 14:02:12 on 3 November.
const DAYS = ["1 Nov", "2 Nov", "3 Nov", "4 Nov", "5 Nov", "6 Nov", "7 Nov"];

function daytime(hour: number): number {
  const shape = [
    0.05, 0.03, 0.02, 0.02, 0.03, 0.08, 0.25, 0.6, 0.85, 0.9, 0.95, 1, 1.15, 1.1, 1, 0.95, 1, 1.15,
    1.3, 1.35, 1.2, 0.9, 0.5, 0.2,
  ];
  return shape[hour] ?? 0;
}

/** `count` answers over hours `[from, to)` (absolute hours from 1 Nov 00:00), dropping empty hours. */
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

const OPEN = 12; // 1 Nov, 12:00
const RECEIPT_HOUR = 2 * 24 + 14; // 3 Nov, 14:00
const AT_12 = 6 * 24 + 12; // 7 Nov, 12:00

/** The Riverside board's hours, and their anchors; `extra` hours after 12:00 on 7 November. */
export function riversideHours(extra: readonly { hour: number; size: number }[] = []) {
  const hours = [
    { hour: OPEN, size: 1 + 3 }, // its registration, the key ceremony's transcripts
    ...spread(1_190 - 4, OPEN + 1, RECEIPT_HOUR, 0.15),
    { hour: RECEIPT_HOUR, size: 40 },
    ...spread(2_418 - 1_230, RECEIPT_HOUR + 1, AT_12, 0.15),
    ...extra,
  ];
  return hours;
}

/** Ethereum blocks for Riverside's anchors, on the same 12-second clock as the levy's. */
const riversideBlock = (absoluteHour: number) => 21_384_112 + (absoluteHour - (2 * 24 + 21)) * 300;

export function buildRiverside(
  hours: readonly { hour: number; size: number }[],
  unanchoredFrom = Infinity,
  kinds: Readonly<Record<number, number>> = {},
) {
  let first = 0;
  return build(
    "parks",
    hours.map(({ hour, size }) => {
      const segmentKinds: Record<number, number> = {};
      if (hour === OPEN) [3, 2, 2, 2].forEach((k, j) => (segmentKinds[j] = k));
      for (let j = 0; j < size; j++) {
        const k = kinds[first + j];
        if (k !== undefined) segmentKinds[j] = k;
      }
      first += size;
      const end = hour + 1;
      return {
        label: `${pad(hour % 24)}:00`,
        group: DAYS[Math.floor(hour / 24)]!,
        hour: hour % 24,
        period: PERIOD_3NOV_14 + hour - RECEIPT_HOUR,
        size,
        anchor:
          hour >= unanchoredFrom
            ? null
            : {
                at: `${DAYS[Math.floor(end / 24)]}, ${pad(end % 24)}:00 UTC`,
                block: riversideBlock(end),
                tx: end === RECEIPT_HOUR + 1 ? RECEIPT.anchorTx : sampleHash(`parks-anchor-${end}`),
              },
        kinds: segmentKinds,
      };
    }),
    0.002,
  );
}

/** The board as the poll page shows it, as of the 12:00 anchor on 7 November. */
export const RIVERSIDE_BOARD = buildRiverside(riversideHours(), Infinity, { 1_201: 1 });
export const RIVERSIDE_MINE = RECEIPT.entry;
export const RIVERSIDE_MINE_AT = segmentOf(RIVERSIDE_BOARD, RIVERSIDE_MINE);
/** The 15:00 checkpoint on 3 November closes the receipt's segment. */
export const RIVERSIDE_CHECKPOINT =
  RIVERSIDE_MINE_AT.segment.first + RIVERSIDE_MINE_AT.segment.size;
export const RIVERSIDE_PROOF = proofFor(RIVERSIDE_BOARD, RIVERSIDE_MINE, RIVERSIDE_CHECKPOINT);

export { fmt, pad };
