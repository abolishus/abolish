// What a card in the stream shows of a poll, built from the API's answers.
// The definition is read as on the poll page (src/poll.ts), and the display
// text is checked with @abolishus/crypto's `checkElectionRecordToShow`, the
// check the ballot client runs before it shows a question: the record
// decodes, matches the definition's commitment and has exactly its questions
// and options (docs/spec/display-text.md, Checks). So whoever serves the text
// can't put words on a card that the poll it links to doesn't commit to
// (T-34, T-41). The website reads no registry, so the hash checked against is
// the served definition's own, shown on the poll's page for a reader to
// compare, as there; the ballot client checks both records against the
// registry on the L2 before anyone answers.

import { checkElectionRecordToShow } from "@abolishus/crypto";

import { definitionView, type DefinitionProblem, type PollView } from "./poll.ts";
import { fromHex } from "./values.ts";

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
  if (trimmed.length > MAX_STREAM_QUERY || !QUERY.test(trimmed)) return { kind: "refused" };
  return { kind: "search", q: trimmed };
}

/** A query exactly as `streamQuery` hands one on: what a server function takes as a search. */
export function isStreamSearch(q: string): boolean {
  const query = streamQuery(q);
  return query.kind === "search" && query.q === q;
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
  | { readonly kind: "poll"; readonly poll: PollView; readonly text: CardText }
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

// The codec already refuses ill-formed UTF-8, so this never throws on a
// checked record; `fatal` keeps a replacement character from standing in for
// bytes nobody checked.
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The card for `electionId` from the hex the API served: `definitionHex`,
 * and `displayTextHex` unless the API had none to serve. `locale` picks the
 * translation.
 */
export function streamCard(
  electionId: string,
  definitionHex: string,
  displayTextHex: string | undefined,
  locale: string,
): StreamCard {
  const view = definitionView(electionId, definitionHex);
  if (!view.ok) return { kind: "unavailable", electionId, problem: view.problem };
  const { poll } = view;
  const text = (() => {
    if (displayTextHex === undefined) return undefined;
    let display;
    try {
      display = fromHex(displayTextHex);
    } catch (error) {
      if (error instanceof RangeError) return undefined;
      throw error;
    }
    const checked = checkElectionRecordToShow(
      fromHex(electionId),
      fromHex(poll.definitionHash),
      fromHex(definitionHex),
      display,
    );
    if (!checked.ok) return undefined;
    const tagged = <T extends { readonly language: Uint8Array }>(translations: readonly T[]) =>
      pickTranslation(
        translations.map((t) => ({ ...t, language: utf8.decode(t.language) })),
        locale,
      );
    if (checked.version === 1) {
      const t = tagged(checked.displayText.translations);
      return {
        language: t.language,
        heading: utf8.decode(t.question),
        question: undefined,
        options: t.options.map((o) => utf8.decode(o.label)),
      };
    }
    const t = tagged(checked.displayText.translations);
    const title = utf8.decode(t.title);
    // A checked text has exactly the definition's questions, and a well-formed definition one at least.
    const first = t.questions[0]!;
    const question = utf8.decode(first.question);
    return {
      language: t.language,
      heading: title === "" ? question : title,
      question: title === "" ? undefined : question,
      options: first.options.map((o) => utf8.decode(o.label)),
    };
  })();
  if (text === undefined) return { kind: "unavailable", electionId, problem: "text" };
  return { kind: "poll", poll, text };
}
