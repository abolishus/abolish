// A poll page's link preview, from what the page's loader has: the decoded
// definition, the board head, and the poll's words where the display text
// checked against the definition (src/server/stream-card.ts) and its place.
// The preview doesn't yet say who asked, the board's answer count or released
// totals, so today's preview shows the poll's seal, its question (on the
// image only when its fonts draw it, src/og/glyphs.ts) and, on the image, its
// place, its canonical code and short link (once its registration is
// recorded) and when it closes, and its results are `open` or `counting`,
// never a result.
//
// Its words are in the page's language (P2-28 part 4c-2), and the image's
// address names that language, since a chat fetches the image with none of
// the reader's cookies or headers: `?lang=` for any locale but the default,
// so the default's addresses are what they were before there was a second.

import { DEFAULT_LOCALE, isLocale, type Locale } from "../locales.ts";
import type { PollView } from "../poll.ts";
import type { PollPreview, PreviewFormat } from "./model.ts";
import { previewText } from "./text.ts";

/**
 * Bumped whenever the card's layout or the model's fields change, so every
 * preview gets a new version: a model with no code serializes as one from
 * before codes were optional, since `JSON.stringify` drops `undefined`.
 */
const LAYOUT = 4;

/** An author's words a preview shows, each `undefined` when none can be. */
export interface PreviewWords {
  /** The heading of the checked display text, in the page's translation. */
  readonly question: string | undefined;
  /** Where its author listed it, as the poll page shows it. */
  readonly place: string | undefined;
}

export const NO_WORDS: PreviewWords = { question: undefined, place: undefined };

export function pollPreview(
  poll: PollView,
  code: string | undefined,
  host: string,
  now: number,
  locale: Locale,
  { question, place }: PreviewWords = NO_WORDS,
): PollPreview {
  const closes = poll.closesAt.iso;
  const closed = closes !== undefined && Date.parse(closes) <= now;
  return {
    locale,
    seal: poll.definitionHash,
    code,
    host,
    question,
    askedBy: undefined,
    place,
    // An ill-formed version-5 definition can have no questions; its card
    // still draws one, as the page shows the broken rule beside it.
    questionCount: Math.max(1, poll.questions.length),
    answers: undefined,
    closesAt: closes,
    civic: false,
    results: closed ? { state: "counting" } : { state: "open" },
  };
}

/**
 * A preview's version: changes whenever anything it draws does (a new
 * release, the close, the layout), so a versioned URL can be cached for good
 * and a chat that cached the last one sees a new URL.
 */
export async function previewVersion(model: PollPreview, format: PreviewFormat): Promise<string> {
  const text = JSON.stringify([LAYOUT, format, model]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).subarray(0, 12), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * The preview image's path for poll `electionId` in `locale`, with
 * `version` if given: its query names only what differs from the default.
 */
export function previewPath(
  electionId: string,
  format: PreviewFormat,
  locale: Locale,
  version?: string,
): string {
  const query = new URLSearchParams();
  if (format === "square") query.set("format", "square");
  if (locale !== DEFAULT_LOCALE) query.set("lang", locale);
  if (version !== undefined) query.set("v", version);
  const search = query.toString();
  return `/polls/${electionId}/preview.png${search === "" ? "" : `?${search}`}`;
}

/**
 * The locale an image's `lang` parameter names: none is the default's, and
 * otherwise exactly one of our other locales; anything else, the default's
 * name included, is no image of ours, so each image has one address.
 */
export function previewLocale(lang: string | null): Locale | undefined {
  if (lang === null) return DEFAULT_LOCALE;
  return isLocale(lang) && lang !== DEFAULT_LOCALE ? lang : undefined;
}

/** What the poll page's head needs: the image's versioned URL and the text beside it. */
export interface PreviewMeta {
  readonly image: string;
  readonly title: string;
  readonly description: string;
}

export async function previewMeta(
  poll: PollView,
  code: string | undefined,
  origin: string,
  now: number,
  locale: Locale,
  words: PreviewWords = NO_WORDS,
): Promise<PreviewMeta> {
  const model = pollPreview(poll, code, new URL(origin).host, now, locale, words);
  const version = await previewVersion(model, "landscape");
  return {
    image: `${origin}${previewPath(poll.electionId, "landscape", locale, version)}`,
    ...previewText(model),
  };
}
