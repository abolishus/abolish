// The words of a link preview, shared by the image and the page's meta tags.
// No result reaches them unless the model's results carry one, and sealed or
// unreleased results carry none (src/og/model.ts).

import type { PollPreview } from "./model.ts";

const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const longDay = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const count = new Intl.NumberFormat("en-US");

/** "15 Nov", in UTC like every time on the board. */
export const dayOf = (iso: string) => day.format(new Date(iso));
/** "7 November 2026". */
export const longDayOf = (iso: string) => longDay.format(new Date(iso));
export const countOf = (n: number) => count.format(n);

const answers = (n: number) => `${count.format(n)} ${n === 1 ? "answer" : "answers"}`;
export const answersSoFar = (n: number) => `${answers(n)} so far`;
export const answersCounted = (n: number) => `${answers(n)} counted`;

/** The headline: the question, or the poll's code while the question isn't served. */
export const headline = (model: PollPreview) =>
  model.question ?? (model.code === undefined ? `A poll on ${model.host}` : `Poll ${model.code}`);

export function byline(model: PollPreview): string {
  const who = model.askedBy === undefined ? `Asked on ${model.host}` : `Asked by ${model.askedBy}`;
  return model.place === undefined ? who : `${who} · ${model.place}`;
}

/** "Closes 15 Nov" or "Closed 15 Nov", if the close fits a date. */
export function closing(model: PollPreview): string | undefined {
  if (model.closesAt === undefined) return undefined;
  const closed = model.results.state === "closed" || model.results.state === "counting";
  return `${closed ? "Closed" : "Closes"} ${dayOf(model.closesAt)}`;
}

const on = (model: PollPreview) =>
  model.closesAt === undefined ? "" : ` on ${dayOf(model.closesAt)}`;

/** Sealed: when results appear, and the count, which the public board shows anyway. */
export function sealedLines(model: PollPreview): [string, string] {
  return [
    `Results when it closes${on(model)}`,
    model.answers === undefined
      ? "What people answer stays sealed until then."
      : `${answersSoFar(model.answers)}. What they say stays sealed until then.`,
  ];
}

/** Open, with nothing released that this site knows of. */
export function openLines(model: PollPreview): [string, string] {
  return [
    model.closesAt === undefined ? "Open" : `Open until ${dayOf(model.closesAt)}`,
    model.answers === undefined
      ? "Anyone can check the count."
      : `${answersSoFar(model.answers)}. Anyone can check the count.`,
  ];
}

export function countingLines(model: PollPreview): [string, string] {
  return [`Closed${on(model)}`, "The count isn't published yet."];
}

/**
 * og:title and og:description: the question, then who asked, the count and
 * the lead or the state. A sealed poll's description says when results
 * appear and nothing else about them.
 */
export function previewText(model: PollPreview): { title: string; description: string } {
  const who =
    model.askedBy === undefined
      ? ""
      : `Asked by ${model.askedBy}${model.place === undefined ? "" : ` in ${model.place}`}. `;
  const so = model.answers === undefined ? "" : `${answersSoFar(model.answers)}. `;
  const results = model.results;
  let status: string;
  switch (results.state) {
    case "sealed":
      status = `${so}Results are sealed until it closes${on(model)}.`;
      break;
    case "open":
      status = `${so}Open until it closes${on(model)}.`;
      break;
    case "counting":
      status = `Closed${on(model)}; the count isn't published yet.`;
      break;
    case "live":
      status = `${so}${"lead" in results ? results.lead.sentence : "Each tier is counted on its own."}`;
      break;
    case "closed":
      status = `Closed${on(model)}. ${"lead" in results ? results.lead.sentence : "Each tier is counted on its own."}`;
  }
  return { title: headline(model), description: `${who}${status} Anyone can check the count.` };
}
