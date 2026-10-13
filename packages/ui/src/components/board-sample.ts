// Sample boards for the stories (Storybook only): invented, but shaped like
// real ones, and built deterministically so every run draws the same cells.
// The hashes are stand-ins from a small mixing function, not `H`: they look
// like hashes and are consistent with each other (each parent is mixed from
// its two children), which is all a drawing needs.

import { auditPath } from "../lib/board-tree.ts";
import type { BoardMapLabels, BoardMapSegment } from "./board-map.tsx";
import type { InclusionAnchor, InclusionPathLabels, InclusionSibling } from "./inclusion-path.tsx";

/** A stable, made-up 32-byte hash from any seed text. */
export function sampleHash(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
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

/** A deterministic number in [0, 1) for an entry. */
function unit(seed: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
}

export interface SampleSegment {
  label: string;
  group?: string;
  size: number;
  anchor: { at: string; block: number } | null;
  /** Kind codes for the segment's first entries, in order; the rest are ballots. */
  lead?: readonly number[];
  /** Kind codes for its last entries. */
  tail?: readonly number[];
}

/**
 * A board from its segments: ballots, with a direct-submitted ballot (a
 * contract event) now and then, and whatever each segment leads or ends with.
 */
export function buildBoard(
  specs: readonly SampleSegment[],
  firstSegment: number,
  eventRate = 0.0004,
): { kinds: Uint8Array; segments: BoardMapSegment[] } {
  const total = specs.reduce((n, s) => n + s.size, 0);
  const kinds = new Uint8Array(total);
  const segments: BoardMapSegment[] = [];
  let first = 0;
  specs.forEach((spec, i) => {
    for (let j = 0; j < spec.size; j++) {
      const index = first + j;
      const lead = spec.lead?.[j];
      const fromEnd = spec.size - j;
      const tail = spec.tail?.[(spec.tail?.length ?? 0) - fromEnd];
      kinds[index] = lead ?? tail ?? (unit(index) < eventRate ? 3 : 0);
    }
    segments.push({
      segment: firstSegment + i,
      first,
      size: spec.size,
      label: spec.label,
      ...(spec.group === undefined ? {} : { group: spec.group }),
      anchor: spec.anchor,
    });
    first += spec.size;
  });
  return { kinds, segments };
}

/** The entry hash of a sample board's entry. */
export const entryHashOf = (board: string, index: number) => sampleHash(`${board}-entry-${index}`);

/**
 * An inclusion proof for a sample board, shaped as a verifier returns it:
 * the leaf hash, the audit path with sides, each computed parent and the root.
 */
export function sampleProof(board: string, index: number, size: number) {
  const entryHash = entryHashOf(board, index);
  const leafHash = sampleHash(`leaf:${entryHash}`);
  const siblings: InclusionSibling[] = [];
  const parents: string[] = [];
  let running = leafHash;
  for (const step of auditPath(index, size)) {
    const hash = sampleHash(`${board}-subtree-${step.sibling.from}-${step.sibling.to}`);
    siblings.push({ side: step.side, hash });
    running =
      step.side === "left"
        ? sampleHash(`node:${hash}${running}`)
        : sampleHash(`node:${running}${hash}`);
    parents.push(running);
  }
  return { index, size, entryHash, leafHash, siblings, parents, root: running };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "14:27:40": when an entry was appended, spread evenly through its hour. */
export function sampleTime(segment: BoardMapSegment, startHour: number, index: number): string {
  const seconds = Math.floor(((index - segment.first + 0.5) / segment.size) * 3600);
  return `${pad(startHour)}:${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

// The Alder County library levy: 3 November 2026, polls 06:00 to 20:00 UTC.
// The registration and the key ceremony's transcripts board before opening;
// spoiled-ballot openings, the tally and the trustees' destruction statements
// after the close.
const LEVY_HOURS = [
  8, 5_596, 9_134, 8_672, 9_778, 11_917, 13_173, 14_662, 15_538, 13_482, 13_340, 14_110, 13_450,
  9_520, 9_122, 372,
];
const LEVY_FIRST_HOUR = 5;

export const LEVY_BOARD = buildBoard(
  LEVY_HOURS.map((size, i) => {
    const hour = LEVY_FIRST_HOUR + i;
    return {
      label: `${pad(hour)}:00`,
      group: "3 Nov 2026",
      size,
      anchor: { at: `${pad(hour + 1)}:00 UTC`, block: 21_384_112 - (21 - (hour + 1)) * 300 },
      ...(i === 0 ? { lead: [3, 2, 2, 2, 2, 2, 2, 2] } : {}),
      ...(i === LEVY_HOURS.length - 1
        ? { tail: [...Array<number>(344).fill(1), ...Array<number>(28).fill(2)] }
        : {}),
    };
  }),
  495_121 + LEVY_FIRST_HOUR,
);

/** The reader's entry: a ballot in the 14:00 segment. */
export const LEVY_MINE = 95_208;
export const LEVY_MINE_SEGMENT = LEVY_BOARD.segments.find(
  (s) => LEVY_MINE >= s.first && LEVY_MINE < s.first + s.size,
)!;
/** The checkpoint anchored at 15:00 closes the 14:00 segment. */
export const LEVY_CHECKPOINT_SIZE = LEVY_MINE_SEGMENT.first + LEVY_MINE_SEGMENT.size;
export const LEVY_PROOF = sampleProof("levy", LEVY_MINE, LEVY_CHECKPOINT_SIZE);
export const LEVY_ANCHOR_TX = "e015669745eafb8afb5ee8930d0af31747d8b1e0658079db0b322750ec31a20b";

/** The ledger rows around the reader's entry. */
export function levyLedger(span: number) {
  const hour = LEVY_FIRST_HOUR + LEVY_BOARD.segments.indexOf(LEVY_MINE_SEGMENT);
  return Array.from({ length: span * 2 + 1 }, (_, i) => {
    const index = LEVY_MINE - span + i;
    return {
      index,
      time: sampleTime(LEVY_MINE_SEGMENT, hour, index),
      kind: LEVY_BOARD.kinds[index] === 3 ? "Contract event" : "Ballot",
      hash: entryHashOf("levy", index),
    };
  });
}

export const LEVY_MAP_LABELS: BoardMapLabels = {
  caption: "Alder County library levy: the whole board, 161,874 entries in 16 hourly segments",
  description:
    "Every entry on the board as one square, in order, each hour's segment a block whose length is its count. Your entry is marked in the 14:00 segment.",
  kinds: {
    ballot: "Ballots",
    spoiled: "Spoiled-ballot openings",
    trustee: "Trustee records",
    event: "Contract events",
  },
  anchored: "Segment anchored to Ethereum",
  unanchored: "Not anchored yet",
  mine: "Your entry, {index}",
  position:
    "Your entry is entry {index} of {total}, in the {segment} segment, anchored at {anchor} in Ethereum block {block}.",
  positionPending:
    "Your entry is entry {index} of {total}, in the {segment} segment, not anchored yet.",
  table: {
    summary: "Every segment as a table",
    caption: "Entries per segment, 3 November 2026 (UTC)",
    segment: "Segment",
    entries: "Entries",
    anchor: "Anchored",
    notAnchored: "Not yet",
    breakdown: "{kind}: {count}",
    anchorCell: "{at}, block {block}",
  },
};

export const LEVY_PATH_LABELS: InclusionPathLabels = {
  caption: "Entry 95,208 in the tree of 101,960 entries",
  leaf: "Your entry",
  entryHash: "Entry hash",
  leafHash: "Leaf hash",
  step: "Step {step} of {total}",
  given: "From the proof",
  computed: "Computed",
  range: "entries {from}–{to}",
  single: "entry {index}",
  count: { one: "{count} entry", other: "{count} entries" },
  root: "Root of all {size} entries",
  anchoredRoot: "Anchored root",
  verdict: {
    verified:
      "The computed root is the anchored root, all 64 characters. Entry 95,208 is on the anchored board.",
    mismatch:
      "The computed root does not match the anchored root. This path does not prove the entry is on the anchored board.",
    pending:
      "The computed root is the one your receipt holds. Its checkpoint is anchored at 15:00 UTC.",
  },
  fingerprint: "Fingerprint of {what}, {hash}",
  levels: {
    one: "{count} step, from your entry to all {size} entries",
    other: "{count} steps, from your entry to all {size} entries",
  },
  full: "Every hash of the proof, in full",
  sides: { left: "on the left", right: "on the right" },
};

export const LEVY_ANCHOR: InclusionAnchor = {
  root: LEVY_PROOF.root,
  size: LEVY_PROOF.size,
  title: "Checkpoint anchored 3 Nov 2026, 15:00 UTC",
  facts: [
    { label: "Segment", value: "495,135 (14:00–15:00 UTC)" },
    { label: "Size", value: "101,960 entries" },
    { label: "Ethereum block", value: "21,382,312" },
    { label: "Transaction", value: `0x${LEVY_ANCHOR_TX}`, evidence: true },
  ],
};
