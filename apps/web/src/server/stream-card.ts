// The card for a poll in the stream, built from the API's answers. The
// definition is read as on the poll page (src/server/definition.ts), and the
// display text is checked with @abolishus/crypto's
// `checkElectionRecordToShow`, the check the ballot client runs before it
// shows a question: the record decodes, matches the definition's commitment
// and has exactly its questions and options (docs/spec/display-text.md,
// Checks). So whoever serves the text can't put words on a card that the
// poll it links to doesn't commit to (T-34, T-41). The website reads no
// registry, so the hash checked against is the served definition's own,
// shown on the poll's page for a reader to compare, as there; the ballot
// client checks both records against the registry on the L2 before anyone
// answers.

import { checkElectionRecordToShow } from "@abolishus/crypto";

import type { PollTags, PollView } from "../poll.ts";
import { type CardText, pickTranslation, type StreamCard } from "../stream.ts";
import { fromHex } from "../values.ts";
import { definitionView } from "./definition.ts";

// The codec already refuses ill-formed UTF-8, so this never throws on a
// checked record; `fatal` keeps a replacement character from standing in for
// bytes nobody checked.
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The card for `electionId` from the hex the API served: `definitionHex`,
 * and `displayTextHex` unless the API had none to serve. `locale` picks the
 * translation; `tags` are where the poll is listed, as `loadStream` checked them.
 */
export function streamCard(
  electionId: string,
  definitionHex: string,
  displayTextHex: string | undefined,
  locale: string,
  tags: PollTags,
): StreamCard {
  const view = definitionView(electionId, definitionHex);
  if (!view.ok) return { kind: "unavailable", electionId, problem: view.problem };
  const { poll } = view;
  const text = checkedText(poll, definitionHex, displayTextHex, locale);
  if (text === undefined) return { kind: "unavailable", electionId, problem: "text" };
  return { kind: "poll", poll, text, tags };
}

/**
 * The words of `poll`, decoded from `definitionHex`, in the translation
 * `locale` picks: `undefined` unless `displayTextHex` is a display text the
 * definition commits to with exactly its questions and options, and the
 * definition is well-formed.
 */
export function checkedText(
  poll: PollView,
  definitionHex: string,
  displayTextHex: string | undefined,
  locale: string,
): CardText | undefined {
  if (displayTextHex === undefined) return undefined;
  let display;
  try {
    display = fromHex(displayTextHex);
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
  const checked = checkElectionRecordToShow(
    fromHex(poll.electionId),
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
}
