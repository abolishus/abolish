// Page data and helpers for the everyday-register mockups (Storybook only). Invented.

import {
  type EverydayPoll,
  type EverydayQuestion,
  type LiveBatch,
  type QuestionKind,
  RIVERSIDE,
  STREAM,
} from "./everyday-fixtures.ts";

const NUMBER = new Intl.NumberFormat("en-US");
const WHOLE = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });

export const num = (value: number) => NUMBER.format(value);
/** Everyday results read in whole percentages; the civic record keeps one decimal. */
export const pct = (share: number) => WHOLE.format(share);

/** The audience in words, for a count: "people with an account". */
export const PEOPLE = "people with an account";

/** "7 November, 12:00 UTC" → { day: "7 Nov", time: "12:00 UTC" }. */
export function releaseTime(at: string) {
  const [date = at, time = ""] = at.split(", ");
  const [d = "", month = ""] = date.split(" ");
  return { day: `${d} ${month.slice(0, 3)}`, time };
}

export function ruleText(rule: QuestionKind): string {
  switch (rule.kind) {
    case "one":
      return "Pick one";
    case "any":
      return "Pick any";
    case "upTo":
      return `Pick up to ${rule.max}`;
    case "exactly":
      return `Pick exactly ${rule.count}`;
  }
}

/** Questions where one person can pick several answers, so shares add up past 100%. */
export const picksSeveral = (q: EverydayQuestion) => q.rule.kind !== "one";

export interface RankedOption {
  key: string;
  label: string;
  count: number;
  /** Out of the people who answered, not out of picks. */
  share: number;
}

export function ranked(q: EverydayQuestion, batch: LiveBatch): RankedOption[] {
  const counts = batch.counts[q.key] ?? {};
  return q.options
    .map((o) => {
      const count = counts[o.key] ?? 0;
      return { key: o.key, label: o.label, count, share: count / batch.ballots };
    })
    .toSorted((a, b) => b.count - a.count);
}

export function leader(q: EverydayQuestion, batch: LiveBatch): RankedOption {
  const top = ranked(q, batch)[0];
  if (top === undefined) throw new RangeError(`no options for ${q.key}`);
  return top;
}

const HEADLINES: Record<string, (label: string, share: string) => string> = {
  priority: (label, share) => `${label} leads, with ${share}.`,
  events: (label, share) => `${label} is the favourite: ${share} would go.`,
  safe: (label, share) => `“${label}” is the most common answer, at ${share}.`,
};

/** The result as a sentence, before any bars. */
export function headline(q: EverydayQuestion, batch: LiveBatch): string {
  const top = leader(q, batch);
  const share = pct(top.share);
  const custom = HEADLINES[q.key];
  if (custom !== undefined) return custom(top.label, share);
  return top.share > 0.5
    ? `Most people chose “${top.label}”: ${share}.`
    : `“${top.label}” leads, with ${share}.`;
}

/** The RIVERSIDE count once it closed: every option at or above its last live release. */
export const RIVERSIDE_FINAL: LiveBatch = {
  at: "15 November, 12:00 UTC",
  ballots: 3_152,
  counts: {
    priority: { lights: 1_318, toilets: 742, courts: 405, trees: 687 },
    events: { market: 1_874, cinema: 1_409, cleanup: 806, music: 1_121 },
    safe: { very: 230, mostly: 841, unsure: 512, unsafe: 1_098, never: 471 },
  },
};

export const RIVERSIDE_CLOSED = {
  closed: "15 November 2026, 12:00 UTC",
  counted: "15 November 2026, 13:40 UTC",
};

export const LATEST = RIVERSIDE.batches.at(-1)!;
export const PREVIOUS = RIVERSIDE.batches.at(-2)!;

/** "Updated 7 Nov, 12:00 UTC · 1,112 new answers since 4 Nov" */
export function updateLine(
  index: number,
  batches: readonly LiveBatch[] = RIVERSIDE.batches,
  /** The last batch is the final count at close. */
  closed = false,
) {
  const batch = batches[index];
  if (batch === undefined) throw new RangeError(`no batch ${index}`);
  const at = releaseTime(batch.at);
  const before = batches[index - 1];
  if (closed && index === batches.length - 1 && before !== undefined) {
    return {
      when: `Final count, closed ${at.day}, ${at.time}`,
      change: `${num(batch.ballots - before.ballots)} more answers after ${releaseTime(before.at).day}`,
    };
  }
  if (before === undefined) {
    return {
      when: `First results ${at.day}, ${at.time}`,
      change: `${num(batch.ballots)} answers`,
    };
  }
  return {
    when: `Updated ${at.day}, ${at.time}`,
    change: `${num(batch.ballots - before.ballots)} new answers since ${releaseTime(before.at).day}`,
  };
}

export const answerHref = (pollId: string, pick?: string) =>
  `/polls/${pollId}/answer${pick === undefined ? "" : `#pick=${pick}`}`;

export const RIVERSIDE_SLUG = "riverside";
export const EVIDENCE_HREF = `/polls/${RIVERSIDE_SLUG}/record`;

/** Someone who answered on 5 November: their receipt, never their answers. */
export const MY_ANSWER = {
  on: "5 November",
  receipt: "4c1f9e07a2d8b36f5e1a0c9d7b42e86f13a5d0c8e9f27b6a4d1c3e5f7a9b0d2e",
  entry: 1_877,
  inUpdate: "7 Nov",
};

export type StreamItem = (typeof STREAM)[number];

export interface StreamDetail {
  audience: string;
  asked: string;
  /** Latest live release, for live polls. */
  updated?: string;
  /** Answerable straight from the card when it is one pick-one question. */
  options?: readonly { key: string; label: string }[];
  /** What the civic record calls it, and its method, for the civic item. */
  civic?: { kind: string; scope: string };
}

export const STREAM_DETAIL: Record<StreamItem["id"], StreamDetail> = {
  riverside: { audience: PEOPLE, asked: "Asked 1 Nov", updated: releaseTime(LATEST.at).day },
  "four-day": {
    audience: PEOPLE,
    asked: "Asked 6 Nov",
    options: [
      { key: "yes", label: "Yes" },
      { key: "no", label: "No" },
      { key: "unsure", label: "Not sure" },
    ],
  },
  "bus-23": { audience: PEOPLE, asked: "Asked 5 Nov", updated: "8 Nov" },
  "library-hours": {
    audience: PEOPLE,
    asked: "Asked 8 Nov",
    updated: "9 Nov",
    options: [
      { key: "ten", label: "10:00 to 16:00" },
      { key: "noon", label: "12:00 to 17:00" },
      { key: "closed", label: "Keep it closed on Sundays" },
    ],
  },
  levy: {
    audience: "document-verified voters",
    asked: "Referendum",
    civic: { kind: "Referendum", scope: "Registered voters in Alder County, counted by tier" },
  },
};

export const TOPICS = [...new Set(STREAM.map((s) => s.topic))];
export const PLACES = [...new Set(STREAM.map((s) => s.place))];

/** Who can open the answers, in plain words, while Abolish alone is the default panel. */
export function launchKeyStatement(poll: EverydayPoll): string {
  const base =
    "During launch, Abolish alone holds the key for this poll. We could read individual answers, though not who gave them; we’ve promised not to and destroy the key after the final count.";
  const added = poll.trustees.added;
  if (added.length === 0) return base;
  const who =
    added.length === 1
      ? `their own trustee, ${added[0]}`
      : `their own trustees, ${added.join(" and ")}`;
  return `${base} The asker added ${who}, so this poll’s answers can only be opened with them too.`;
}
