// Where every entry of a board goes in `BoardMap`, in device pixels. Pure, so
// it is tested without a browser and the drawing code only paints.
//
// Each segment is a block of square cells, one per entry, filled column by
// column (top to bottom, then the next column to the right), so time runs
// left to right through a block, and blocks run left to right, line by line,
// like words. Every block has the same number of rows, so a block's width is
// its count of entries: a busy hour is a long block.

import type { EntryRange } from "./board-tree.ts";

export interface LayoutSegment {
  /** Index of the segment's first entry. */
  readonly first: number;
  /** Entries in the segment. */
  readonly size: number;
  /** A grouping above segments, such as the day: a new group starts a new line. */
  readonly group?: string | undefined;
}

export interface BoardLayoutOptions {
  readonly segments: readonly LayoutSegment[];
  /** The entries to show; segments outside it are left out, and ones across its ends clipped. */
  readonly range: EntryRange;
  /** Width to fill, in device pixels. */
  readonly width: number;
  /** The height to stay within if any pitch allows it, in device pixels. */
  readonly maxHeight: number;
  /** The largest cell pitch to consider, in device pixels. */
  readonly maxPitch: number;
  /** The fewest rows a block may have. */
  readonly minRows: number;
  /** Space between blocks on a line, in device pixels. */
  readonly gap: number;
  /** Heights, in device pixels, of the lanes around each line of blocks. */
  readonly lanes: {
    /** Below the blocks: segment labels and anchor rules. */
    readonly label: number;
    /** Below the blocks of a line where no label fits: the anchor rules alone. */
    readonly rule: number;
    /** Above the first line of a new group: its name. */
    readonly group: number;
    /** Above the line holding `mine`: its label. */
    readonly mine: number;
    /** Between lines. */
    readonly between: number;
  };
  /** The narrowest block a segment's label fits under, in device pixels. */
  readonly labelWidth: number;
  /** The reader's entry, to make room for its label. */
  readonly mine?: number | undefined;
}

export interface PlacedBlock {
  /** Index into `segments`. */
  readonly segment: number;
  /** The first entry drawn and how many, after clipping to the range. */
  readonly first: number;
  readonly size: number;
  readonly x: number;
  readonly y: number;
  readonly cols: number;
  readonly width: number;
  readonly line: number;
}

export interface PlacedLine {
  readonly top: number;
  /** Whether its lane below has room for segment labels. */
  readonly labelled: boolean;
  /** Where its blocks start. */
  readonly blocksTop: number;
  /** A group name to draw above it, when it starts one. */
  readonly group?: string | undefined;
  /** Whether it holds the reader's entry (its label lane is above the group lane). */
  readonly mine: boolean;
}

export interface BoardLayout {
  /** Distance between cells, and a cell's side, in device pixels. */
  readonly pitch: number;
  readonly cell: number;
  /** Rows in every block. */
  readonly rows: number;
  readonly blocks: readonly PlacedBlock[];
  readonly lines: readonly PlacedLine[];
  readonly height: number;
}

/** A cell's side for a pitch: a hairline gap once cells are big enough to show one. */
export function cellSize(pitch: number): number {
  return pitch >= 3 ? pitch - Math.max(1, Math.round(pitch / 6)) : pitch;
}

function flow(
  o: BoardLayoutOptions,
  pitch: number,
  rowsWanted?: number,
  grouped = true,
): BoardLayout {
  const { range, lanes } = o;
  const visible: { segment: number; first: number; size: number; group?: string | undefined }[] =
    [];
  o.segments.forEach((s, segment) => {
    const first = Math.max(s.first, range.from);
    const end = Math.min(s.first + s.size, range.to);
    if (end > first)
      visible.push({ segment, first, size: end - first, group: grouped ? s.group : undefined });
  });
  const cols = Math.max(1, Math.floor(o.width / pitch));
  const gap = Math.min(o.gap, Math.max(2, pitch * 2));
  const largest = Math.max(1, ...visible.map((v) => v.size));
  const rows = Math.max(o.minRows, Math.ceil(largest / cols), rowsWanted ?? 0);
  const blockHeight = rows * pitch;

  const blocks: PlacedBlock[] = [];
  const lines: PlacedLine[] = [];
  let pending: typeof visible = [];
  let top = 0;
  let previousGroup: string | undefined;

  const close = () => {
    if (pending.length === 0) return;
    const line = lines.length;
    const group = pending[0]?.group;
    const startsGroup = group !== undefined && group !== previousGroup;
    const holdsMine =
      o.mine !== undefined && pending.some((v) => o.mine! >= v.first && o.mine! < v.first + v.size);
    const blocksTop = top + (holdsMine ? lanes.mine : 0) + (startsGroup ? lanes.group : 0);
    let x = 0;
    let labelled = false;
    for (const v of pending) {
      const width = Math.ceil(v.size / rows) * pitch;
      if (width >= o.labelWidth) labelled = true;
      blocks.push({ ...v, x, y: blocksTop, cols: Math.ceil(v.size / rows), width, line });
      x += width + gap;
    }
    lines.push({
      top,
      labelled,
      blocksTop,
      group: startsGroup ? group : undefined,
      mine: holdsMine,
    });
    previousGroup = pending.at(-1)?.group;
    top = blocksTop + blockHeight + (labelled ? lanes.label : lanes.rule) + lanes.between;
    pending = [];
  };

  let x = 0;
  for (const v of visible) {
    const width = Math.ceil(v.size / rows) * pitch;
    const newGroup = pending.length > 0 && v.group !== pending.at(-1)?.group;
    if (pending.length > 0 && (x + width > o.width || newGroup)) {
      close();
      x = 0;
    }
    pending.push(v);
    x += width + gap;
  }
  close();
  return {
    pitch,
    cell: cellSize(pitch),
    rows,
    blocks,
    lines,
    height: Math.max(0, top - lanes.between),
  };
}

/**
 * The shortest layout at a pitch: blocks only as tall as the busiest segment
 * needs to fit the width, or taller, so shorter blocks share a line and fewer
 * lines spend height on their lanes.
 */
function shortest(o: BoardLayoutOptions, pitch: number, grouped: boolean): BoardLayout {
  let best = flow(o, pitch, undefined, grouped);
  const limit = Math.max(best.rows * 12, 64);
  for (let rows = best.rows + 1; rows <= limit; rows = Math.ceil(rows * 1.08)) {
    const layout = flow(o, pitch, rows, grouped);
    if (layout.height < best.height) best = layout;
  }
  return best;
}

function largest(options: BoardLayoutOptions, grouped: boolean): BoardLayout {
  let layout = shortest(options, 1, grouped);
  for (let pitch = Math.max(1, Math.floor(options.maxPitch)); pitch >= 1; pitch--) {
    layout = shortest(options, pitch, grouped);
    if (layout.height <= options.maxHeight) return layout;
  }
  return layout;
}

/**
 * The layout at the largest pitch, up to `maxPitch`, whose height fits
 * `maxHeight`; at one device pixel per entry if none does. Every entry gets a
 * whole cell at every pitch: nothing is aggregated or sampled. Groups start
 * their own lines unless that costs more than a quarter of the cell's size.
 */
export function layoutBoard(options: BoardLayoutOptions): BoardLayout {
  if (!(options.width >= 1)) throw new RangeError("a board map needs a width");
  const grouped = largest(options, true);
  if (!options.segments.some((s) => s.group !== undefined)) return grouped;
  const flat = largest(options, false);
  return grouped.pitch >= flat.pitch * 0.75 ? grouped : flat;
}

/** The top-left corner of an entry's cell, in device pixels. */
export function cellPosition(
  layout: BoardLayout,
  block: PlacedBlock,
  index: number,
): { x: number; y: number } {
  const local = index - block.first;
  return {
    x: block.x + Math.floor(local / layout.rows) * layout.pitch,
    y: block.y + (local % layout.rows) * layout.pitch,
  };
}

/** The block holding an entry, if it is shown. */
export function blockOf(layout: BoardLayout, index: number): PlacedBlock | undefined {
  return layout.blocks.find((b) => index >= b.first && index < b.first + b.size);
}
