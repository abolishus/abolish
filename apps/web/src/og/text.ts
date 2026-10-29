// The words of a link preview, shared by the image and the page's meta tags,
// in the model's locale (P2-28 part 4c-2). No result reaches them unless the
// model's results carry one, and sealed or unreleased results carry none
// (src/og/model.ts).

import type { Locale } from "../locales.ts";
import { titles } from "../titles.ts";
import type { PollPreview } from "./model.ts";

// English dates read "15 Nov", day first, as every time on the board does;
// other locales take their own order.
const DATE_LOCALES: Readonly<Record<Locale, string>> = { "en-US": "en-GB", "es-US": "es-US" };

const day = (locale: Locale) =>
  new Intl.DateTimeFormat(DATE_LOCALES[locale], {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
const longDay = (locale: Locale) =>
  new Intl.DateTimeFormat(DATE_LOCALES[locale], {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** "15 Nov", in UTC like every time on the board. */
export const dayOf = (locale: Locale, iso: string) => day(locale).format(new Date(iso));
/** "7 November 2026". */
export const longDayOf = (locale: Locale, iso: string) => longDay(locale).format(new Date(iso));
export const countOf = (locale: Locale, n: number) => new Intl.NumberFormat(locale).format(n);
/** "62.5%", as the poll page's results print a share. */
export const percentOf = (locale: Locale, share: number) =>
  new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(share);

const words = (model: Pick<PollPreview, "locale">) => titles(model.locale).text;

export const answersSoFar = (model: PollPreview, n: number) =>
  words(model)("ogAnswersSoFar", { count: n });
export const answersCounted = (model: PollPreview, n: number) =>
  words(model)("ogAnswersCounted", { count: n });

/** The headline with no question to show: the poll's code, or the host for a poll with no code yet. */
export const unworded = (model: PollPreview) =>
  model.code === undefined
    ? words(model)("ogHeadlineHost", { host: model.host })
    : words(model)("ogHeadlineCode", { code: model.code });

/** The headline in text: the question, or while none can be shown the poll's code. */
export const headline = (model: PollPreview) => model.question ?? unworded(model);

const isClosed = (model: PollPreview) =>
  model.results.state === "closed" ||
  model.results.state === "counting" ||
  model.results.state === "by-tier";

/** "Closes 15 Nov" or "Closed 15 Nov", if the close fits a date. */
export function closing(model: PollPreview): string | undefined {
  if (model.closesAt === undefined) return undefined;
  return words(model)(isClosed(model) ? "ogClosed" : "ogCloses", {
    day: dayOf(model.locale, model.closesAt),
  });
}

type DayKey =
  | "ogSealed"
  | "ogSealedText"
  | "ogOpenText"
  | "ogCountingHead"
  | "ogCountingText"
  | "ogClosedText";

/** `key`'s words, or its `…On` sibling's naming the day it closes, if that fits a date. */
function onDay(model: PollPreview, key: DayKey): string {
  const text = words(model);
  return model.closesAt === undefined
    ? text(key)
    : text(`${key}On`, { day: dayOf(model.locale, model.closesAt) });
}

/** Sealed: when results appear, and the count, which the public board shows anyway. */
export function sealedLines(model: PollPreview): [string, string] {
  const text = words(model);
  return [
    onDay(model, "ogSealed"),
    model.answers === undefined
      ? text("ogSealedNote")
      : text("ogSealedNoteCount", { answers: answersSoFar(model, model.answers) }),
  ];
}

/** Open, with nothing released that this site knows of. */
export function openLines(model: PollPreview): [string, string] {
  const text = words(model);
  return [
    model.closesAt === undefined
      ? text("ogOpen")
      : text("ogOpenUntil", { day: dayOf(model.locale, model.closesAt) }),
    model.answers === undefined
      ? text("ogCheck")
      : text("ogCheckCount", { answers: answersSoFar(model, model.answers) }),
  ];
}

export function countingLines(model: PollPreview): [string, string] {
  return [onDay(model, "ogCountingHead"), words(model)("ogCountingNote")];
}

/** Closed and counted tier by tier, with no lead across them. */
export function byTierLines(model: PollPreview): [string, string] {
  return [onDay(model, "ogCountingHead"), words(model)("ogTiers")];
}

/**
 * og:title and og:description: the question, then who asked, the count and
 * the lead or the state. A sealed poll's description says when results
 * appear and nothing else about them.
 */
export function previewText(model: PollPreview): { title: string; description: string } {
  const text = words(model);
  const who =
    model.askedBy === undefined
      ? []
      : [
          model.place === undefined
            ? text("ogWho", { name: model.askedBy })
            : text("ogWhoIn", { name: model.askedBy, place: model.place }),
        ];
  const so =
    model.answers === undefined
      ? []
      : [text("ogSoFar", { answers: answersSoFar(model, model.answers) })];
  const results = model.results;
  let status: string[];
  switch (results.state) {
    case "sealed":
      status = [...so, onDay(model, "ogSealedText")];
      break;
    case "open":
      status = [...so, onDay(model, "ogOpenText")];
      break;
    case "counting":
      status = [onDay(model, "ogCountingText")];
      break;
    case "by-tier":
      status = [onDay(model, "ogClosedText"), text("ogTiers")];
      break;
    case "live":
      status = [...so, "lead" in results ? results.lead.text : text("ogTiers")];
      break;
    case "closed":
      status = [
        onDay(model, "ogClosedText"),
        "lead" in results ? results.lead.text : text("ogTiers"),
      ];
  }
  return {
    title: headline(model),
    description: [...who, ...status, text("ogCheck")].join(" "),
  };
}
