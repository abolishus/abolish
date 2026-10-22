// The data behind each page, fetched from the API on the server.

import type { PollTopic } from "@abolishus/core/poll-draft-rules";
import { shortCode } from "@abolishus/core/short-codes";
import { ORPCError } from "@orpc/client";

import { type BoardRow, boardRows } from "../board.ts";
import { BOARD_PAGE, LIST_PAGE, LOG_PAGE } from "../page-sizes.ts";
import type { CardText, StreamCard, StreamSort } from "../stream.ts";
import { fromHex } from "../values.ts";
import { type DefinitionProblem, type Instant, instant, type PollView } from "../poll.ts";
import type { Api } from "./api.ts";
import { definitionView } from "./definition.ts";
import { streamCard } from "./stream-card.ts";

export interface BoardHead {
  /** Entries on the board, as a canonical decimal `u64`. */
  readonly treeSize: string;
  readonly chainHead: string;
  readonly root: string;
}

export type ModerationState = Awaited<ReturnType<Api["moderation"]["getStatus"]>>;

export type PollPage =
  | {
      readonly kind: "poll";
      readonly poll: PollView;
      readonly board: BoardHead;
      readonly moderation: ModerationState;
      /** When the page was loaded, for the poll's status. */
      readonly asOf: Instant;
      /** Its canonical short code, checked against its hash; `undefined` if none is served. */
      readonly code: string | undefined;
    }
  | { readonly kind: "not-found" }
  | { readonly kind: "unavailable"; readonly problem: DefinitionProblem };

const notFound = (error: unknown) =>
  error instanceof ORPCError && error.defined && error.code === "ELECTION_NOT_FOUND";

/** The poll page for `electionId`, which the caller has checked is canonical hex. */
export async function loadPoll(api: Api, electionId: string): Promise<PollPage> {
  let answers;
  try {
    answers = await Promise.all([
      api.elections.getDefinition({ electionId }),
      api.board.getHead({ electionId }),
      api.moderation.getStatus({ electionId }),
      codeOf(api, electionId),
    ]);
  } catch (error) {
    if (notFound(error)) return { kind: "not-found" };
    throw error;
  }
  const [{ definition }, board, moderation, claimed] = answers;
  const view = definitionView(electionId, definition);
  if (!view.ok) return { kind: "unavailable", problem: view.problem };
  // A claim, checked as `/p/<code>` checks it: the code must be a prefix of
  // the hash this page checked, or the page would print another poll's code
  // (T-34). Which of several polls sharing a prefix owns the shorter one is
  // the registry's order, which this page doesn't check.
  const code =
    claimed !== undefined &&
    shortCode(fromHex(view.poll.definitionHash), claimed.length) === claimed
      ? claimed
      : undefined;
  return { kind: "poll", poll: view.poll, board, moderation, asOf: now(), code };
}

/**
 * The API's canonical code for `electionId`, or `undefined` while no
 * registration is recorded. The code is optional on the page, so any failure
 * to read it (an API rolled back to before the route, a slow query) prints no
 * code rather than taking the poll page down.
 */
async function codeOf(api: Api, electionId: string): Promise<string | undefined> {
  try {
    return (await api.elections.getCode({ electionId })).code;
  } catch {
    return undefined;
  }
}

export type ShortLink =
  | { readonly kind: "poll"; readonly electionId: string }
  | { readonly kind: "not-found" };

/**
 * The poll short code `code` names (docs/design/sharing.md, Short links),
 * which the caller has put in its canonical form. The API's answer is a
 * claim: before the page sends anyone on, it fetches the poll's definition,
 * decodes and checks it as the poll page does (T-31, T-34), and requires the
 * code to be a prefix of that definition's hash at the code's length. So a
 * database that points a code at another poll can send a visitor only to a
 * poll whose definition hash really starts with the code; which of several
 * polls sharing it owns the code is the registry's order, which this page
 * doesn't check (part 2's known-weak).
 */
export async function resolveShortLink(api: Api, code: string): Promise<ShortLink> {
  let electionId;
  try {
    const answer = await api.elections.resolveCode({ code });
    // The canonical form of a canonical code is itself: anything else is
    // another code, whatever the API says.
    if (answer.code !== code) return { kind: "not-found" };
    electionId = answer.electionId;
  } catch (error) {
    if (error instanceof ORPCError && error.defined && error.code === "CODE_NOT_FOUND")
      return { kind: "not-found" };
    throw error;
  }
  let definition;
  try {
    ({ definition } = await api.elections.getDefinition({ electionId }));
  } catch (error) {
    if (notFound(error)) return { kind: "not-found" };
    throw error;
  }
  const view = definitionView(electionId, definition);
  if (!view.ok || shortCode(fromHex(view.poll.definitionHash), code.length) !== code)
    return { kind: "not-found" };
  return { kind: "poll", electionId };
}

export type BoardPage =
  | {
      readonly kind: "board";
      readonly poll: PollView;
      readonly head: BoardHead;
      /** Where the page starts, as a canonical decimal `u64`. */
      readonly from: string;
      /** The entries from `from`, checked; empty at the end of the board. */
      readonly rows: readonly BoardRow[];
    }
  | {
      /** `from` is past the end of the board as `head` gives it. */
      readonly kind: "beyond";
      readonly poll: PollView;
      readonly head: BoardHead;
      readonly from: string;
    }
  | { readonly kind: "not-found" }
  | {
      readonly kind: "unavailable";
      /**
       * The definition's, or `undecodable-entries` when the definition pins
       * no board-entry version this page reads or an entry fails its checks
       * (src/board.ts).
       */
      readonly problem: DefinitionProblem | "undecodable-entries";
    };

const outOfRange = (error: unknown) =>
  error instanceof ORPCError && error.defined && error.code === "OUT_OF_RANGE";

/**
 * A page of the board of `electionId` from position `from` (a canonical
 * decimal `u64` and a multiple of `BOARD_PAGE`), which the caller has checked. The definition is decoded and
 * checked as on the poll page; the head is the server's claim, shown as one.
 */
export async function loadBoardPage(
  api: Api,
  electionId: string,
  from: string,
): Promise<BoardPage> {
  let answers;
  try {
    answers = await Promise.all([
      api.elections.getDefinition({ electionId }),
      api.board.getHead({ electionId }),
      // Past the end is an answer of its own, not a failure of the page.
      api.board
        .getEntries({ electionId, start: from, limit: String(BOARD_PAGE) })
        .catch((error: unknown) => {
          if (outOfRange(error)) return undefined;
          throw error;
        }),
    ]);
  } catch (error) {
    if (notFound(error)) return { kind: "not-found" };
    throw error;
  }
  const [{ definition }, head, first] = answers;
  const view = definitionView(electionId, definition);
  if (!view.ok) return { kind: "unavailable", problem: view.problem };
  if (first === undefined) return { kind: "beyond", poll: view.poll, head, from };
  // The API may cut a page short by bytes (T-52); the rest is asked for, so
  // every page holds the same window of the board and the next one starts
  // where it ends. Each answer short of the end holds at least one entry, so
  // this asks at most `BOARD_PAGE` times.
  const entries = [...first.entries];
  let last = first.entries.length;
  while (last > 0 && entries.length < BOARD_PAGE) {
    const more = await api.board.getEntries({
      electionId,
      start: String(BigInt(from) + BigInt(entries.length)),
      limit: String(BOARD_PAGE - entries.length),
    });
    last = more.entries.length;
    entries.push(...more.entries.slice(0, BOARD_PAGE - entries.length));
  }
  const rows =
    view.boardEntryVersion === undefined
      ? undefined
      : boardRows(electionId, view.boardEntryVersion, BigInt(from), entries);
  if (rows === undefined) return { kind: "unavailable", problem: "undecodable-entries" };
  return { kind: "board", poll: view.poll, head, from, rows };
}

export type ModerationLog = Awaited<ReturnType<Api["moderation"]["getLog"]>>;

/** The moderation log after sequence number `after` (a canonical decimal `u64`). */
export async function loadModerationLog(api: Api, after: string): Promise<ModerationLog> {
  return api.moderation.getLog({ after, limit: String(LOG_PAGE) });
}

export type ListedPoll =
  | { readonly kind: "poll"; readonly poll: PollView }
  | {
      readonly kind: "unavailable";
      readonly electionId: string;
      readonly problem: DefinitionProblem;
    };

/**
 * This server's clock as a page loads, to the second: the time a page reads
 * each poll's status at, carried in the page's data so the browser renders
 * the same status the server did.
 */
export function now(): Instant {
  return instant(BigInt(Math.floor(Date.now() / 1000)));
}

export interface PollList {
  readonly polls: readonly ListedPoll[];
  /** When the page was loaded, for each poll's status. */
  readonly asOf: Instant;
  /** Where the next page starts, if this one was full. */
  readonly next: string | undefined;
}

/**
 * A page of the polls the API lists for discovery, from just above `after`
 * (an election ID, or `""` from the start). The API leaves out delisted and
 * hidden polls (T-68); each listed poll's definition is decoded and checked
 * here as on its own page, so the list shows nothing the poll page wouldn't
 * (T-31, T-34). A poll stops being served between the listing and its
 * definition only if the database lost it, so it drops out of the page.
 */
export async function loadPollList(api: Api, after: string, limit = LIST_PAGE): Promise<PollList> {
  const { elections } = await api.elections.list({
    ...(after === "" ? {} : { after }),
    limit: String(limit),
  });
  const answers = await Promise.all(
    elections.map(async (electionId) => {
      try {
        const { definition } = await api.elections.getDefinition({ electionId });
        return { electionId, definition };
      } catch (error) {
        if (notFound(error)) return undefined;
        throw error;
      }
    }),
  );
  const polls: ListedPoll[] = [];
  for (const answer of answers) {
    if (answer === undefined) continue;
    const view = definitionView(answer.electionId, answer.definition);
    polls.push(
      view.ok
        ? { kind: "poll", poll: view.poll }
        : { kind: "unavailable", electionId: answer.electionId, problem: view.problem },
    );
  }
  return {
    polls,
    asOf: now(),
    // The listing's own cursor, not the last poll shown, so a dropped one doesn't end the list.
    next: elections.length === limit ? elections.at(-1) : undefined,
  };
}

/**
 * Polls per page of the stream: each costs the page a definition and a
 * display text, and a display text may be up to 4 MiB (T-52).
 */
export const STREAM_PAGE = 10;

export type Stream =
  | {
      readonly kind: "stream";
      readonly cards: readonly StreamCard[];
      /** Where the next page starts, if this one was full. */
      readonly next: string | undefined;
    }
  /** The API can't sort this way just now (`answered` without the anchoring clock). */
  | { readonly kind: "sort-unavailable" }
  /** `after` names no poll this order can place. */
  | { readonly kind: "cursor-not-found" }
  /**
   * The search is one the API doesn't take: too long or of too many words
   * (src/stream.ts, `streamQuery`), or of no word left once the API
   * normalises it (control characters alone).
   */
  | { readonly kind: "search-refused" }
  /** The place is one the API doesn't take (src/stream.ts, `streamPlace`). */
  | { readonly kind: "place-refused" };

/**
 * What a page of the stream narrows to beyond its order: a search (a query
 * `streamQuery` admits), a topic and a place (one `streamPlace` hands on).
 * Each filters, none ranks.
 */
export interface StreamFilter {
  readonly q?: string | undefined;
  readonly topic?: PollTopic | undefined;
  readonly place?: string | undefined;
}

const listingError = (error: unknown, code: "SORT_UNAVAILABLE" | "CURSOR_NOT_FOUND") =>
  error instanceof ORPCError && error.defined && error.code === code;

// The API's answer to a query whose every term is blank once normalised,
// which no pattern the contract can state catches first (packages/core,
// `searchTerms`).
const searchRefused = (error: unknown) =>
  error instanceof ORPCError && !error.defined && error.code === "BAD_REQUEST";

/**
 * The display text the API serves for `electionId`, or `undefined` if it
 * holds none or withholds it under the moderation policy: either way the
 * card has no words to show (a hidden poll isn't listed, so withheld text
 * here is one hidden since the listing).
 */
async function displayTextOf(api: Api, electionId: string): Promise<string | undefined> {
  try {
    return (await api.elections.getDisplayText({ electionId })).displayText;
  } catch (error) {
    if (
      error instanceof ORPCError &&
      error.defined &&
      (error.code === "DISPLAY_TEXT_NOT_FOUND" || error.code === "DISPLAY_TEXT_WITHHELD")
    )
      return undefined;
    throw error;
  }
}

/**
 * A page of the stream in the order `sort`, from just after `after` (an
 * election ID, or `""` from the start), only of the polls whose question
 * text holds every term of `q` when it is given and that their authors
 * filed under `topic` and at `place` when given (`filter`), each poll's text
 * in `locale`. The API
 * leaves out delisted and hidden polls (T-68) and orders by public data only
 * (packages/api-contract, `elections.list`); each card's definition and text
 * are checked here (src/stream.ts). A poll the database lost between the
 * listing and its definition drops out of the page.
 */
export async function loadStream(
  api: Api,
  sort: StreamSort,
  after: string,
  { q, topic, place }: StreamFilter,
  locale: string,
): Promise<Stream> {
  let elections;
  try {
    ({ elections } = await api.elections.list({
      sort,
      ...(after === "" ? {} : { after }),
      ...(q === undefined ? {} : { q }),
      ...(topic === undefined ? {} : { topic }),
      ...(place === undefined ? {} : { place }),
      limit: String(STREAM_PAGE),
    }));
  } catch (error) {
    if (listingError(error, "SORT_UNAVAILABLE")) return { kind: "sort-unavailable" };
    if (listingError(error, "CURSOR_NOT_FOUND")) return { kind: "cursor-not-found" };
    if (q !== undefined && searchRefused(error)) return { kind: "search-refused" };
    throw error;
  }
  const cards = await Promise.all(
    elections.map(async (electionId) => {
      try {
        const [{ definition }, displayText] = await Promise.all([
          api.elections.getDefinition({ electionId }),
          displayTextOf(api, electionId),
        ]);
        return streamCard(electionId, definition, displayText, locale);
      } catch (error) {
        if (notFound(error)) return undefined;
        throw error;
      }
    }),
  );
  return {
    kind: "stream",
    cards: cards.filter((card) => card !== undefined),
    // The listing's own cursor, as the register's, so a dropped poll doesn't end the stream.
    next: elections.length === STREAM_PAGE ? elections.at(-1) : undefined,
  };
}

export type EmbedPage =
  | {
      readonly kind: "poll";
      readonly poll: PollView;
      /** When the page was loaded, for the poll's status. */
      readonly asOf: Instant;
      /** Its words in the page's locale, checked against the definition; `undefined` if none can be shown. */
      readonly text: CardText | undefined;
    }
  /** Moderation hid its text (docs/moderation-policy.md), so the embed shows none. */
  | { readonly kind: "hidden" }
  | { readonly kind: "not-found" };

/**
 * The poll `code` names (canonical, from the caller), as its embed draws it
 * (docs/design/sharing.md, Embed): resolved as `/p/<code>` resolves it, then
 * loaded and checked as the poll page is, which must print the same code
 * (T-34), with its display text checked as the stream checks a card's
 * (src/stream.ts). Nothing of the reader's is passed on (T-10, T-11).
 */
export async function loadEmbed(api: Api, code: string, locale: string): Promise<EmbedPage> {
  const link = await resolveShortLink(api, code);
  if (link.kind === "not-found") return link;
  const page = await loadPoll(api, link.electionId);
  if (page.kind !== "poll" || page.code !== code) return { kind: "not-found" };
  if (page.moderation.state === "hidden") return { kind: "hidden" };
  let card: StreamCard;
  try {
    const [{ definition }, displayText] = await Promise.all([
      api.elections.getDefinition({ electionId: link.electionId }),
      displayTextOf(api, link.electionId),
    ]);
    card = streamCard(link.electionId, definition, displayText, locale);
  } catch (error) {
    if (notFound(error)) return { kind: "not-found" };
    throw error;
  }
  return {
    kind: "poll",
    poll: page.poll,
    asOf: page.asOf,
    text: card.kind === "poll" ? card.text : undefined,
  };
}
