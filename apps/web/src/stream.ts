// The stream's orders and filters, and what a card in it shows of a poll,
// as the server checks and builds it (src/server/stream-card.ts). Nothing
// here imports a decoder, so the pages' script doesn't carry one (P2-28
// part 2b).

import type { DefinitionProblem, PollTags, PollView } from "./poll.ts";
import type { StreamFilter } from "./server/load.ts";

/** The stream's orders, as `GET /elections` names them: each lists only the polls open now. */
export const STREAM_SORTS = ["new", "closing", "answered"] as const;

export type StreamSort = (typeof STREAM_SORTS)[number];

/**
 * The longest search query and its most terms, as `GET /elections` bounds
 * them; a test ties these copies to @abolishus/api-contract's. Copies, so the
 * page's bundle doesn't carry the whole contract.
 */
export const MAX_STREAM_QUERY = 200;
export const MAX_STREAM_TERMS = 8;

const QUERY = new RegExp(`^\\s*\\S+(?:\\s+\\S+){0,${MAX_STREAM_TERMS - 1}}\\s*$`, "u");

/**
 * What a stream's `q` asks for: no search when it is absent or only
 * whitespace, a search for it trimmed when the API's contract admits that,
 * and a refusal otherwise (too long, or too many words), which the page says
 * without asking the API.
 */
export type StreamQuery =
  | { readonly kind: "none" }
  | { readonly kind: "search"; readonly q: string }
  | { readonly kind: "refused" };

export function streamQuery(q: string | undefined): StreamQuery {
  const trimmed = q?.trim() ?? "";
  if (trimmed === "") return { kind: "none" };
  // Code points, as the API contract's `maxLength` counts them.
  if ([...trimmed].length > MAX_STREAM_QUERY || !QUERY.test(trimmed)) return { kind: "refused" };
  return { kind: "search", q: trimmed };
}

/** A query exactly as `streamQuery` hands one on: what a server function takes as a search. */
export function isStreamSearch(q: string): boolean {
  const query = streamQuery(q);
  return query.kind === "search" && query.q === q;
}

/**
 * The longest place a listing filters by, as `GET /elections` bounds it; a
 * test ties this copy to @abolishus/api-contract's.
 */
export const MAX_STREAM_PLACE = 80;

/**
 * What a stream's `place` asks for: no filter when it is absent or only
 * whitespace; a filter by it single-spaced and trimmed, as the API keys a
 * place (packages/core, `placeKey`), when that is at most
 * `MAX_STREAM_PLACE` code points and something is left of it once
 * normalised; and a refusal otherwise, which the page says without asking
 * the API. So every place sent is one the API takes, and a refusal from it
 * is the search's.
 */
export type StreamPlace =
  | { readonly kind: "none" }
  | { readonly kind: "place"; readonly place: string }
  | { readonly kind: "refused" };

const spaced = (s: string) => s.replace(/\s+/gu, " ").trim();

export function streamPlace(place: string | undefined): StreamPlace {
  const tidy = spaced(place ?? "");
  if (tidy === "") return { kind: "none" };
  if (Array.from(tidy).length > MAX_STREAM_PLACE) return { kind: "refused" };
  // The API's normalisation (packages/core, `normalizeSearchText`): control
  // characters alone, which `\s` doesn't match, leave no place to match.
  if (spaced(tidy.normalize("NFKC").replace(/\p{Cc}/gu, " ")) === "") return { kind: "refused" };
  return { kind: "place", place: tidy };
}

/** A place exactly as `streamPlace` hands one on: what a server function takes as a filter. */
export function isStreamPlace(place: string): boolean {
  const filter = streamPlace(place);
  return filter.kind === "place" && filter.place === place;
}

/**
 * The stream's address for `sort` narrowed by `filter`, from just after
 * `after`. `new` is the default, so its first page is plain `/discover`.
 * Orders and topics are from fixed lists and `after` is canonical hex, so
 * only the query and the place need escaping.
 */
export function streamHref(
  sort: StreamSort,
  { q, topic, place }: StreamFilter = {},
  after?: string,
): string {
  const search = [
    ...(sort === "new" ? [] : [`sort=${sort}`]),
    ...(topic === undefined ? [] : [`topic=${topic}`]),
    ...(place === undefined ? [] : [`place=${encodeURIComponent(place)}`]),
    ...(q === undefined ? [] : [`q=${encodeURIComponent(q)}`]),
    ...(after === undefined ? [] : [`after=${after}`]),
  ];
  return search.length === 0 ? "/discover" : `/discover?${search.join("&")}`;
}

/** One language's words for a card. */
export interface CardText {
  /** The translation's tag, lowercase BCP 47, as the record holds it. */
  readonly language: string;
  /** The poll's title, or its first question's text when it has no title (version 1 never has one). */
  readonly heading: string;
  /** The first question's text, when the poll has a title of its own. */
  readonly question: string | undefined;
  /**
   * The first question's option labels, in option order: the index here is
   * the pick a card's answer link carries ([[first-answer]], step 1).
   */
  readonly options: readonly string[];
}

/**
 * Why a listed poll's card has no words: its definition (as on the poll
 * page), or `text` when the display text is missing, withheld or fails its
 * checks, or the definition is ill-formed, which the check refuses too.
 */
export type CardProblem = DefinitionProblem | "text";

export type StreamCard =
  | {
      readonly kind: "poll";
      readonly poll: PollView;
      readonly text: CardText;
      readonly tags: PollTags;
    }
  | { readonly kind: "unavailable"; readonly electionId: string; readonly problem: CardProblem };

/**
 * The translation for `preferred`: the tag that matches it exactly, else the
 * first whose primary language matches, else the record's first (records
 * sort their translations by tag), as the ballot client picks.
 */
export function pickTranslation<T extends { readonly language: string }>(
  translations: readonly T[],
  preferred: string,
): T {
  const wanted = preferred.toLowerCase();
  const primary = (tag: string) => tag.split("-")[0];
  const choice =
    translations.find((t) => t.language === wanted) ??
    translations.find((t) => primary(t.language) === primary(wanted)) ??
    translations[0];
  if (choice === undefined) throw new RangeError("a display text has at least one translation");
  return choice;
}
