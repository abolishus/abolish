import { FINGERPRINT_SIZE, fingerprintCells } from "@abolishus/ui";

/**
 * The voter's own "I answered" card (docs/design/sharing.md, The "I
 * answered" card): a square picture drawn on this device from the poll's
 * public words, its link and its seal. It carries nothing of the voter's (no
 * answer, tracking code, time or device), so the only thing it tells anyone
 * is what the voter chose to say by sending it; and it proves nothing, since
 * anyone can draw the same card without answering (T-45, T-46).
 */

/** The card's side in pixels: square, as posts and chats prefer. */
export const CARD_SIZE = 1080;

/** Lines the question may take before it is cut short with an ellipsis. */
export const QUESTION_LINES = 6;

/** What the card says, in the reader's language, and the poll's public facts. */
export interface CardText {
  /** "I answered this poll". */
  readonly lead: string;
  /** The poll's first question, as "Ask others" shares it. */
  readonly question: string;
  /** "Answer it too". */
  readonly invite: string;
  /** The short link without its scheme, as a person types it. */
  readonly link: string;
  /** "Anyone can check the count." */
  readonly check: string;
}

/** The width a string takes in the font it will be drawn in. */
export type Measure = (text: string) => number;

const ELLIPSIS = "…";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** `text`'s user-perceived characters, so a cut never splits an accent from its letter or an emoji in two. */
function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), ({ segment }) => segment);
}

/** Cuts `word` into pieces no wider than `width`, a character at a time (a link or a long word in a language without spaces). */
function breakWord(word: string, width: number, measure: Measure): string[] {
  const pieces: string[] = [];
  let piece = "";
  for (const char of graphemes(word)) {
    if (piece !== "" && measure(piece + char) > width) {
      pieces.push(piece);
      piece = char;
    } else {
      piece += char;
    }
  }
  if (piece !== "") pieces.push(piece);
  return pieces;
}

/** Shortens `line` from the end until it fits with an ellipsis after it. */
function ellipsize(line: string, width: number, measure: Measure): string {
  let chars = graphemes(line.trimEnd());
  while (chars.length > 0 && measure(chars.join("").trimEnd() + ELLIPSIS) > width) {
    chars = chars.slice(0, -1);
  }
  return chars.join("").trimEnd() + ELLIPSIS;
}

/**
 * Breaks `text` into at most `maxLines` lines no wider than `width`, at
 * spaces where it can and between characters where a word alone is too
 * wide. Text that doesn't fit ends its last line with an ellipsis. A
 * character wider than the line on its own still takes a line, the one case
 * a line overflows.
 */
export function wrap(text: string, width: number, maxLines: number, measure: Measure): string[] {
  const words = text.split(/\s+/u).filter((word) => word !== "");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const joined = line === "" ? word : `${line} ${word}`;
    if (measure(joined) <= width) {
      line = joined;
      continue;
    }
    if (line !== "") lines.push(line);
    const pieces = breakWord(word, width, measure);
    lines.push(...pieces.slice(0, -1));
    line = pieces.at(-1) ?? "";
  }
  if (line !== "") lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept.at(-1) ?? "";
  return [...kept.slice(0, -1), ellipsize(last, width, measure)];
}

/** The card's palette: always the light theme's, as the link preview's is (docs/design/sharing.md, Link preview), since a picture is shown on whatever ground the chat has. */
const INK = "#09090b";
const MUTED = "#71717a";
const PAPER = "#ffffff";
const EMERALD = "#047857";

const SANS = `"Oxanium Variable", ui-sans-serif, system-ui, sans-serif`;
const MONO = `"JetBrains Mono Variable", ui-monospace, monospace`;

/** The fonts the card is drawn in, so a caller can wait for them to load first. */
export const CARD_FONTS = [`600 44px ${SANS}`, `700 64px ${SANS}`, `600 48px ${MONO}`] as const;

const MARGIN = 96;
const TEXT_WIDTH = CARD_SIZE - 2 * MARGIN;
const QUESTION_LINE = 80;
const SEAL = 200;

/**
 * Draws the card on a `CARD_SIZE` square: the emerald band and the ruled
 * frame of the flyer, "I answered this poll", the question as the hero, and
 * at the foot the poll's seal (the fingerprint of its definition hash, as
 * the board shows it) beside "Answer it too", the short link and "Anyone can
 * check the count".
 */
export function drawCard(ctx: CanvasRenderingContext2D, text: CardText, seal: string): void {
  const cells = fingerprintCells(seal);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "start";
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, CARD_SIZE, CARD_SIZE);
  ctx.fillStyle = EMERALD;
  ctx.fillRect(0, 0, CARD_SIZE, 24);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 4;
  ctx.strokeRect(48, 72, CARD_SIZE - 96, CARD_SIZE - 120);

  ctx.fillStyle = MUTED;
  ctx.font = CARD_FONTS[0];
  ctx.fillText(
    wrap(text.lead, TEXT_WIDTH, 1, (s) => ctx.measureText(s).width)[0] ?? "",
    MARGIN,
    180,
  );

  ctx.fillStyle = INK;
  ctx.font = CARD_FONTS[1];
  const lines = wrap(text.question, TEXT_WIDTH, QUESTION_LINES, (s) => ctx.measureText(s).width);
  lines.forEach((line, i) => ctx.fillText(line, MARGIN, 290 + i * QUESTION_LINE));

  // The foot: a rule, then the seal beside the invitation and the link.
  const foot = CARD_SIZE - 96 - SEAL;
  ctx.fillStyle = INK;
  ctx.fillRect(MARGIN, foot - 40, TEXT_WIDTH, 2);
  drawSeal(ctx, cells, MARGIN, foot, SEAL);
  const left = MARGIN + SEAL + 48;
  const width = CARD_SIZE - MARGIN - left;
  ctx.font = CARD_FONTS[0];
  ctx.fillText(
    wrap(text.invite, width, 1, (s) => ctx.measureText(s).width)[0] ?? "",
    left,
    foot + 52,
  );
  ctx.fillStyle = EMERALD;
  ctx.font = CARD_FONTS[2];
  wrap(text.link, width, 2, (s) => ctx.measureText(s).width).forEach((line, i) =>
    ctx.fillText(line, left, foot + 120 + i * 56),
  );
  ctx.fillStyle = MUTED;
  ctx.font = `500 32px ${SANS}`;
  ctx.fillText(
    wrap(text.check, width, 1, (s) => ctx.measureText(s).width)[0] ?? "",
    left,
    foot + SEAL,
  );
}

/** The fingerprint's glyph as `Fingerprint` draws it in SVG, scaled to `size` pixels at (`x`, `y`). */
function drawSeal(
  ctx: CanvasRenderingContext2D,
  rows: ReturnType<typeof fingerprintCells>,
  x: number,
  y: number,
  size: number,
): void {
  // The SVG's view box: the grid with half a cell around it.
  const unit = size / (FINGERPRINT_SIZE + 1);
  const at = (v: number) => (v + 0.5) * unit;
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 0.08 * unit;
  ctx.strokeRect(
    at(-0.25),
    at(-0.25),
    (FINGERPRINT_SIZE + 0.5) * unit,
    (FINGERPRINT_SIZE + 0.5) * unit,
  );
  ctx.fillStyle = INK;
  rows.forEach((cells, row) =>
    cells.forEach((cell, col) => {
      switch (cell) {
        case "square":
          ctx.fillRect(at(col + 0.1), at(row + 0.1), 0.8 * unit, 0.8 * unit);
          break;
        case "dot":
          ctx.beginPath();
          ctx.arc(at(col + 0.5), at(row + 0.5), 0.3 * unit, 0, 2 * Math.PI);
          ctx.fill();
          break;
        case "corner": {
          // Mirrored with the cell, as the SVG does, so the glyph stays symmetric.
          const outer = col < FINGERPRINT_SIZE / 2 ? col + 0.1 : col + 0.9;
          const inner = col < FINGERPRINT_SIZE / 2 ? col + 0.9 : col + 0.1;
          ctx.beginPath();
          ctx.moveTo(at(outer), at(row + 0.1));
          ctx.lineTo(at(inner), at(row + 0.1));
          ctx.lineTo(at(outer), at(row + 0.9));
          ctx.closePath();
          ctx.fill();
          break;
        }
        case "empty":
          break;
      }
    }),
  );
  ctx.restore();
}

/** The card's file name: the poll's code from its link, so saved cards for different polls don't overwrite each other. */
export function cardFileName(link: string): string {
  const code = /\/p\/([0-9a-z]+)$/iu.exec(link)?.[1]?.toLowerCase();
  return code === undefined ? "answered.png" : `answered-${code}.png`;
}
