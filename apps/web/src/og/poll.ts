// A poll page's link preview, from what the page's loader has: the decoded
// definition, the board head, the poll's words where the display text
// checked against the definition (src/server/stream-card.ts) and its place,
// and its results as the page reads them (src/results.ts). The preview
// doesn't yet say who asked, the board's answer count or live releases, so
// today's preview shows the poll's seal, its question (on the image only
// when its fonts draw it, src/og/glyphs.ts) and, on the image, its place, its
// canonical code and short link (once its registration is recorded) and when
// it closes. Its results are `open` while it is open, whatever the API
// answers, so nothing about answers shows before the close; once closed, the
// first question's final lead where its one tier's count is published
// (P2-24 part 4), and `counting` or `by-tier` otherwise.
//
// Its words are in the page's language (P2-28 part 4c-2), and the image's
// address names that language, since a chat fetches the image with none of
// the reader's cookies or headers: `?lang=` for any locale but the default,
// so the default's addresses are what they were before there was a second.

import { DEFAULT_LOCALE, isLocale, type Locale } from "../locales.ts";
import type { PollView } from "../poll.ts";
import { leadersOf, type PollResults, shareOf } from "../results.ts";
import { isolated, titles } from "../titles.ts";
import { drawable } from "./glyphs.ts";
import type { EverydayResults, Lead, PollPreview, PreviewFormat } from "./model.ts";
import { percentOf, previewText } from "./text.ts";

/**
 * Bumped whenever the card's layout or the model's fields change, so every
 * preview gets a new version: a model with no code serializes as one from
 * before codes were optional, since `JSON.stringify` drops `undefined`.
 */
const LAYOUT = 5;

/** An author's words a preview shows, each `undefined` when none can be. */
export interface PreviewWords {
  /** The heading of the checked display text, in the page's translation. */
  readonly question: string | undefined;
  /** Where its author listed it, as the poll page shows it. */
  readonly place: string | undefined;
  /** The first question's option labels, in option order. */
  readonly options?: readonly string[] | undefined;
}

export const NO_WORDS: PreviewWords = { question: undefined, place: undefined };

/**
 * The first question's lead over `counted` ballots, in the words of the
 * poll page's results (src/components/poll-results.tsx): every option tied
 * at the top, or none picked. An option goes by number where it has no
 * label, and on the image also where the card's fonts can't draw its label.
 */
export function leadOf(
  counts: readonly string[],
  counted: number,
  locale: Locale,
  options: readonly string[] | undefined,
): Lead {
  const { text } = titles(locale);
  const leaders = leadersOf(counts);
  const top = leaders[0];
  if (top === undefined)
    return { leaders: undefined, tied: false, text: text("resultsNothingPicked"), share: 0 };
  const share = shareOf(counts[top] ?? "0", counted);
  const list = new Intl.ListFormat(locale, { type: "conjunction" });
  const numbered = (i: number) => text("resultsOption", { number: i + 1 });
  const named = (label: (i: number) => string) => list.format(leaders.map(label));
  return {
    leaders: named((i) => {
      const words = options?.[i];
      return (words === undefined ? undefined : drawable(words)) ?? numbered(i);
    }),
    tied: leaders.length > 1,
    text: text(leaders.length === 1 ? "resultsLeader" : "resultsTied", {
      option: named((i) => {
        const words = options?.[i];
        return words === undefined ? numbered(i) : isolated(words);
      }),
      share: percentOf(locale, share),
    }),
    share,
  };
}

/**
 * A closed poll's results on its preview, and the answers they counted:
 * the first question's lead where the poll's results are read in one tier
 * with every cell opened. Several tiers get no lead, since the card has room
 * for one and none may join two (ADR 0026; T-16); anything less than a
 * published count is still `counting`.
 */
function closedResults(
  results: PollResults | undefined,
  locale: Locale,
  options: readonly string[] | undefined,
): { results: EverydayResults; answers: number | undefined } {
  const counting = { results: { state: "counting" } as const, answers: undefined };
  if (results?.kind !== "read") return counting;
  const [only, ...others] = results.tiers;
  if (others.length > 0)
    return results.tiers.some((t) => t.questions !== undefined)
      ? { results: { state: "by-tier" }, answers: undefined }
      : counting;
  const counts = only?.questions?.[0];
  if (only === undefined || counts === undefined) return counting;
  return {
    results: { state: "closed", lead: leadOf(counts, only.counted, locale, options) },
    answers: only.counted,
  };
}

export function pollPreview(
  poll: PollView,
  code: string | undefined,
  host: string,
  now: number,
  locale: Locale,
  { question, place, options }: PreviewWords = NO_WORDS,
  results?: PollResults,
): PollPreview {
  const closes = poll.closesAt.iso;
  const closed = closes !== undefined && Date.parse(closes) <= now;
  const final = closed
    ? closedResults(results, locale, options)
    : { results: { state: "open" } as const, answers: undefined };
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
    answers: final.answers,
    closesAt: closes,
    civic: false,
    results: final.results,
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
  results?: PollResults,
): Promise<PreviewMeta> {
  const model = pollPreview(poll, code, new URL(origin).host, now, locale, words, results);
  const version = await previewVersion(model, "landscape");
  return {
    image: `${origin}${previewPath(poll.electionId, "landscape", locale, version)}`,
    ...previewText(model),
  };
}
