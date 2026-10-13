// Sample data and helpers for the sharing mockups (Storybook only). Invented.

import { num, pct, RIVERSIDE_FINAL } from "./everyday-data.ts";
import { RIVERSIDE } from "./everyday-fixtures.ts";
import { LEVY, TIERS } from "./fixtures.ts";

/** The website, where a short link opens the poll's page. */
export const WEB_HOST = "abolish.us";
/** The ballot client's own entry points (ADR 0020), where the same path opens the ballot. */
export const BALLOT_HOST = "abolish.ch";
export const ENS_NAME = "abolishus.eth";

/** Crockford base32, lower case: no i, l, o or u, so a code read aloud or off paper survives. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * A poll's short code: the first 35 bits of its fingerprint (the definition
 * hash) as 7 base32 characters. Anyone holding the board can resolve it, so
 * every entry point and mirror can; a later poll whose prefix is taken gets
 * one character more.
 */
export function shortCode(id: string, length = 7): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    let value = 0;
    for (let b = 0; b < 5; b++) {
      const bit = i * 5 + b;
      const nibble = Number.parseInt(id[bit >> 2] ?? "0", 16);
      value = (value << 1) | ((nibble >> (3 - (bit & 3))) & 1);
    }
    out += ALPHABET.charAt(value);
  }
  return out;
}

/** "abolish.us/p/p6kh40x": how a link is printed and shown, without the scheme. */
export const shortLink = (id: string) => `${WEB_HOST}/p/${shortCode(id)}`;
export const shortHref = (id: string) => `https://${shortLink(id)}`;
/** The ballot client for this poll, as the handoff opens it: poll and pick ride in the fragment, never sent to a server. */
export const ballotHref = (id: string, pick?: string) =>
  `https://${BALLOT_HOST}/#poll=${id}${pick === undefined ? "" : `&pick=${pick}`}`;
export const flyerHref = (id: string) => `/p/${shortCode(id)}/flyer`;
export const embedSrc = (id: string, theme: EmbedTheme) =>
  `https://${WEB_HOST}/embed/p/${shortCode(id)}${theme === "auto" ? "" : `?theme=${theme}`}`;
/** The fallback when abolish.us is down or blocked: the ballot client's entry points take the code. */
export const alsoAt = (id: string) =>
  `open ${BALLOT_HOST} or ${ENS_NAME} and enter the code ${shortCode(id)}`;

export type EmbedTheme = "light" | "dark" | "auto";

export type ShareState = "live" | "sealed" | "closed";

export interface ShareOption {
  key: string;
  label: string;
  /** Absent while results are sealed. */
  count?: number;
}

export interface SharePoll {
  id: string;
  title: string;
  askedBy: string;
  place: string;
  state: ShareState;
  closesDay: string;
  closes: string;
  /** Answers so far (live, sealed) or counted (closed). */
  answers: number;
  /** When the latest live release came out. */
  updated?: string;
  /** Every question's text; the first one's options and counts drive the lead. */
  questions: readonly string[];
  options: readonly ShareOption[];
}

const PRIORITY = RIVERSIDE.questions[0]!;
const LATEST = RIVERSIDE.batches.at(-1)!;

const priorityOptions = (counts: Record<string, number> | undefined): ShareOption[] =>
  PRIORITY.options.map((o) => ({ ...o, count: counts?.[o.key] ?? 0 }));

/** A one-question live poll: the most common thing people share. */
export const SHARE_LIVE: SharePoll = {
  id: "1c8a56f03dbcedea6909b56ab69cbec253c423da046f482587a01f1ebec1614f",
  title: "Which one improvement should Riverside ask the city for next year?",
  askedBy: RIVERSIDE.askedBy,
  place: RIVERSIDE.place,
  state: "live",
  closesDay: "15 Nov",
  closes: RIVERSIDE.closes,
  answers: LATEST.ballots,
  updated: "7 Nov, 12:00 UTC",
  questions: [PRIORITY.text],
  options: priorityOptions(LATEST.counts["priority"]),
};

export const SHARE_CLOSED: SharePoll = {
  ...SHARE_LIVE,
  state: "closed",
  answers: RIVERSIDE_FINAL.ballots,
  options: priorityOptions(RIVERSIDE_FINAL.counts["priority"]),
};

export const SHARE_SEALED: SharePoll = {
  id: "af940777c746b4013b944cfc9935757ad8c4ec99a6574675323aef900f0ce913",
  title: "Should the river path close to cars on Sunday mornings?",
  askedBy: RIVERSIDE.askedBy,
  place: RIVERSIDE.place,
  state: "sealed",
  closesDay: "15 Nov",
  closes: RIVERSIDE.closes,
  answers: 1_206,
  questions: ["Should the river path close to cars on Sunday mornings?"],
  options: [
    { key: "yes", label: "Yes" },
    { key: "no", label: "No" },
    { key: "unsure", label: "Not sure" },
  ],
};

/** RIVERSIDE itself: three questions, live. */
export const SHARE_MULTI: SharePoll = {
  id: RIVERSIDE.id,
  title: RIVERSIDE.title,
  askedBy: RIVERSIDE.askedBy,
  place: RIVERSIDE.place,
  state: "live",
  closesDay: "15 Nov",
  closes: RIVERSIDE.closes,
  answers: LATEST.ballots,
  updated: "7 Nov, 12:00 UTC",
  questions: RIVERSIDE.questions.map((q) => q.text),
  options: priorityOptions(LATEST.counts["priority"]),
};

export interface Lead {
  label: string;
  share: number;
  /** The result as a plain sentence. */
  sentence: string;
}

/** The leading option of the first question, or nothing while sealed. */
export function leadOf(poll: SharePoll): Lead | undefined {
  if (poll.state === "sealed" || poll.answers === 0) return undefined;
  const top = poll.options.toSorted((a, b) => (b.count ?? 0) - (a.count ?? 0))[0];
  if (top === undefined) return undefined;
  const share = (top.count ?? 0) / poll.answers;
  const sentence =
    poll.state === "closed"
      ? `${top.label} came first, with ${pct(share)}.`
      : `${top.label} leads, with ${pct(share)}.`;
  return { label: top.label, share, sentence };
}

/** "2,418 answers so far", "3,152 answers counted". */
export function answersLine(poll: SharePoll): string {
  return poll.state === "closed"
    ? `${num(poll.answers)} answers counted`
    : `${num(poll.answers)} answers so far`;
}

export function questionsLine(poll: SharePoll): string {
  return poll.questions.length === 1 ? "1 question" : `${poll.questions.length} questions`;
}

/** The civic record's levy, one row per tier and never summed. */
export const SHARE_CIVIC = {
  id: LEVY.definitionHash,
  title: LEVY.title,
  kind: LEVY.kind,
  scope: LEVY.scope,
  counted: "3 November 2026",
  tiers: LEVY.results.map((r) => {
    const tier = TIERS.find((t) => t.key === r.tier)!;
    return {
      key: r.tier,
      name: tier.name,
      ballots: r.ballots,
      yes: (r.counts["yes"] ?? 0) / r.ballots,
    };
  }),
};

/** One decimal, as the civic record reads. */
export const pct1 = (share: number) =>
  new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(share);

/**
 * A stand-in for a real QR code: version 2's 25×25 grid with its finder,
 * timing and alignment patterns in place, and data modules drawn from the
 * poll id so each poll looks different. It encodes nothing; a real encoder
 * replaces it.
 */
export function qrPlaceholder(id: string): boolean[][] {
  const n = 25;
  const grid: boolean[][] = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
  const reserved: boolean[][] = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
  const finder = (top: number, left: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const y = top + r;
        const x = left + c;
        if (y < 0 || x < 0 || y >= n || x >= n) continue;
        reserved[y]![x] = true;
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        grid[y]![x] = ring !== 2 && ring <= 3;
      }
    }
  };
  finder(0, 0);
  finder(0, n - 7);
  finder(n - 7, 0);
  for (let r = 16; r <= 20; r++) {
    for (let c = 16; c <= 20; c++) {
      reserved[r]![c] = true;
      const ring = Math.max(Math.abs(r - 18), Math.abs(c - 18));
      grid[r]![c] = ring !== 1;
    }
  }
  for (let i = 8; i < n - 8; i++) {
    reserved[6]![i] = true;
    reserved[i]![6] = true;
    grid[6]![i] = i % 2 === 0;
    grid[i]![6] = i % 2 === 0;
  }
  const bytes = id.match(/../g)?.map((h) => Number.parseInt(h, 16)) ?? [0];
  let k = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (reserved[r]![c]) continue;
      const byte = bytes[k % bytes.length]! ^ ((k * 151) & 0xff);
      grid[r]![c] = ((byte >> (k % 8)) & 1) === 1;
      k++;
    }
  }
  return grid;
}
