// The data behind each page, fetched from the API on the server.

import { placeIsWellFormed, type PollTopic } from "@abolishus/core/poll-draft-rules";
import { shortCode } from "@abolishus/core/short-codes";
import { ORPCError } from "@orpc/client";

import {
  type AnchorRow,
  anchorRows,
  type BoardRow,
  boardRows,
  oneHistory,
  type TreeClaim,
} from "../board.ts";
import { ACTIVITY_PAGE, ANCHOR_PAGE, BOARD_PAGE, LIST_PAGE, LOG_PAGE } from "../page-sizes.ts";
import type { FollowedPoll } from "../account/follow-results.ts";
import {
  type CellResults,
  cellResultsView,
  type PollResults,
  resultsView,
  type ServedResults,
} from "../results.ts";
import type { CardText, PollWords, StreamCard, StreamSort } from "../stream.ts";
import { fromHex, PROFILE_HANDLE } from "../values.ts";
import {
  type AskedBy,
  type DefinitionProblem,
  type Instant,
  instant,
  NO_TAGS,
  type PollTags,
  type PollView,
} from "../poll.ts";
import type { RemovalGround } from "../components/moderation-log.tsx";
import type { Api } from "./api.ts";
import { definitionView } from "./definition.ts";
import { cardText, checkedWords, streamCard } from "./stream-card.ts";

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
      /** Where it is listed, as `tagsOf` reads it. */
      readonly tags: PollTags;
      /** Who asked it, as `askedByOf` reads it. */
      readonly askedBy: AskedBy | undefined;
      /** Its words in the page's locale, as `wordsOf` reads them; `undefined` if none can be shown. */
      readonly text: CardText | undefined;
      /** Every question's words, as `text` is checked; `undefined` with it. */
      readonly words: PollWords | undefined;
      /** Its results so far, as `resultsOf` reads them. */
      readonly results: PollResults;
    }
  | { readonly kind: "not-found" }
  | { readonly kind: "unavailable"; readonly problem: DefinitionProblem };

const notFound = (error: unknown) =>
  error instanceof ORPCError && error.defined && error.code === "ELECTION_NOT_FOUND";

/**
 * The poll page for `electionId`, which the caller has checked is canonical
 * hex, with its words in `locale`'s translation, saying who asked it as
 * `readAskedBy` reads it.
 */
export async function loadPoll(
  api: Api,
  electionId: string,
  locale: string,
  readAskedBy?: ReadAskedBy,
): Promise<PollPage> {
  let answers;
  try {
    answers = await Promise.all([
      api.elections.getDefinition({ electionId }),
      api.board.getHead({ electionId }),
      api.moderation.getStatus({ electionId }),
      codeOf(api, electionId),
      tagsOf(api, electionId),
      askedByOf(readAskedBy, electionId),
      wordsOf(api, electionId),
      resultsOf(api, electionId),
    ]);
  } catch (error) {
    if (notFound(error)) return { kind: "not-found" };
    throw error;
  }
  const [{ definition }, board, moderation, claimed, tags, askedBy, displayText, served] = answers;
  const view = definitionView(electionId, definition);
  if (!view.ok) return { kind: "unavailable", problem: view.problem };
  // The API withholds a hidden poll's text; dropped here too, should its
  // answers to the two reads straddle the hiding (T-68).
  const words =
    moderation.state === "hidden"
      ? undefined
      : checkedWords(view.poll, definition, displayText, locale);
  // A claim, checked as `/p/<code>` checks it: the code must be a prefix of
  // the hash this page checked, or the page would print another poll's code
  // (T-34). Which of several polls sharing a prefix owns the shorter one is
  // the registry's order, which this page doesn't check.
  const code =
    claimed !== undefined &&
    shortCode(fromHex(view.poll.definitionHash), claimed.length) === claimed
      ? claimed
      : undefined;
  return {
    kind: "poll",
    poll: view.poll,
    board,
    moderation,
    asOf: now(),
    code,
    // The API withholds a hidden poll's tags; dropped here too, should its
    // answers straddle the hiding, since the place now reaches the preview (T-68).
    tags: moderation.state === "hidden" ? NO_TAGS : tags,
    // Core names no one for a hidden poll; dropped here too, since the page's
    // data reaches the browser whether or not it is shown (T-68).
    askedBy: moderation.state === "hidden" ? undefined : askedBy,
    text: words === undefined ? undefined : cardText(words),
    words,
    // Moderation never withholds a result: a hidden poll's is shown by
    // option number (docs/moderation-policy.md).
    results: "state" in served ? resultsView(view.poll, served) : served,
  };
}

export type ResultsPage =
  | {
      readonly kind: "results";
      readonly poll: PollView;
      /** When the page was loaded, for the poll's status. */
      readonly asOf: Instant;
      /** Whether moderation hides the poll, so its words are withheld. */
      readonly hidden: boolean;
      /** Its words in the page's locale, as on the poll page. */
      readonly text: CardText | undefined;
      readonly words: PollWords | undefined;
      readonly results: PollResults;
      /** Each cell's results, as `cellResultsView` reads them; `undefined` where they don't fit. */
      readonly cells: readonly CellResults[] | undefined;
    }
  | { readonly kind: "not-found" }
  | { readonly kind: "unavailable"; readonly problem: DefinitionProblem };

/**
 * The results page for `electionId`, which the caller has checked is
 * canonical hex: the poll page's reads of its definition, words and results,
 * with each cell's results beside its tiers'. Nothing else of the poll page
 * is read, and the results are asked for by the poll's ID alone (T-10).
 */
export async function loadResultsPage(
  api: Api,
  electionId: string,
  locale: string,
): Promise<ResultsPage> {
  let answers;
  try {
    answers = await Promise.all([
      api.elections.getDefinition({ electionId }),
      api.moderation.getStatus({ electionId }),
      wordsOf(api, electionId),
      resultsOf(api, electionId),
    ]);
  } catch (error) {
    if (notFound(error)) return { kind: "not-found" };
    throw error;
  }
  const [{ definition }, moderation, displayText, served] = answers;
  const view = definitionView(electionId, definition);
  if (!view.ok) return { kind: "unavailable", problem: view.problem };
  // As on the poll page: a hidden poll's words are dropped, its results never are (T-68).
  const hidden = moderation.state === "hidden";
  const words = hidden ? undefined : checkedWords(view.poll, definition, displayText, locale);
  return {
    kind: "results",
    poll: view.poll,
    asOf: now(),
    hidden,
    text: words === undefined ? undefined : cardText(words),
    words,
    results: "state" in served ? resultsView(view.poll, served) : served,
    cells: "state" in served ? cellResultsView(view.poll, view.cells, served) : [],
  };
}

/** How long the poll page waits for its results before showing it without them. */
export const RESULTS_WAIT_MS = 2_000;

/**
 * The results the API reads for `electionId` (`GET /elections/results`):
 * as served, `not-counted` or `not-ready` by the API's codes, and
 * `unavailable` for any other failure or an answer slower than
 * `RESULTS_WAIT_MS`. The results are optional on the page, as its words
 * are, and the worker can take the API's whole 10 s to read them, so a slow
 * read shows the poll without them rather than holding the page (T-52).
 */
async function resultsOf(
  api: Api,
  electionId: string,
): Promise<ServedResults | Exclude<PollResults, { kind: "read" }>> {
  try {
    return await api.elections.getResults(
      { electionId },
      { signal: AbortSignal.timeout(RESULTS_WAIT_MS) },
    );
  } catch (error) {
    if (error instanceof ORPCError && error.defined) {
      if (error.code === "RESULTS_NOT_COUNTED") return { kind: "not-counted" };
      if (error.code === "RESULTS_NOT_READY") return { kind: "not-ready" };
    }
    return { kind: "unavailable" };
  }
}

/**
 * The display text the API serves for `electionId`, as `displayTextOf`
 * reads it, or `undefined` when the read fails: the words are optional on a
 * page, as the code is, so a failed or slow read shows the poll by its code
 * rather than taking the page down.
 */
async function wordsOf(api: Api, electionId: string): Promise<string | undefined> {
  try {
    return await displayTextOf(api, electionId);
  } catch {
    return undefined;
  }
}

/**
 * Who asked `electionId` (packages/core's `askedBy`): the profile its author
 * chose to show it on, none for a hidden poll or profile
 * ([[0040-creator-profiles]]). An account table, so read by the front
 * (src/node/main.ts) and handed to the server functions in the request's
 * context by the poll's public ID alone, never asked of the API, which reads
 * no account table (T-10).
 */
export type ReadAskedBy = (electionId: string) => Promise<AskedBy | undefined>;

/**
 * `readAskedBy`'s answer for `electionId`, or `undefined` without a reader
 * (a front with no database) or when the read fails: "Asked by" is optional
 * on a page, as the code and tags are, so a slow or failed read shows no
 * name rather than taking the page down. A failure is logged by its kind
 * only, as `opaque` logs (src/data.ts), so a broken grant doesn't go
 * unnoticed. A handle that isn't one core could
 * have issued was written past core's rules (T-68) and links nowhere, so it
 * names no one.
 */
async function askedByOf(
  readAskedBy: ReadAskedBy | undefined,
  electionId: string,
): Promise<AskedBy | undefined> {
  if (readAskedBy === undefined) return undefined;
  let read;
  try {
    read = await readAskedBy(electionId);
  } catch (error) {
    console.error({ error: error instanceof Error ? error.name : typeof error });
    return undefined;
  }
  return read !== undefined && PROFILE_HANDLE.test(read.handle) ? read : undefined;
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

/**
 * Where the API lists `electionId` (`GET /elections/tags`), or no tags while
 * it withholds them (a hidden poll) or the read fails: they are optional on
 * a page, as the code is, so an API without the route or a slow answer shows
 * none rather than taking the page down. The contract bounds the place only;
 * one a draft couldn't hold (a bidi override, an invisible character, or
 * spacing at either end) is written past the rules (T-68) and isn't shown,
 * so the place can't reorder or hide the words around it (T-67).
 */
async function tagsOf(api: Api, electionId: string): Promise<PollTags> {
  let served;
  try {
    served = await api.elections.getTags({ electionId });
  } catch {
    return NO_TAGS;
  }
  const { topic, place } = served;
  return { topic, place: place !== undefined && placeIsWellFormed(place) ? place : undefined };
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

/**
 * The board's latest `ACTIVITY_PAGE` checkpoints, checked (src/board.ts), or `undefined` when
 * one the server sent fails its checks: the page then shows the entries
 * without them.
 */
export type Anchors = readonly AnchorRow[] | undefined;

/**
 * Whether the trees the board page shows are one history, each by our
 * server's consistency proof checked here (src/board.ts, `oneHistory`).
 */
export interface Histories {
  /** The head's tree and the latest checkpoint's, the smaller first; `undefined` with no checkpoint. */
  readonly head: boolean | undefined;
  /** For each checkpoint the anchors show but the last, whether it extends the next (earlier) one. */
  readonly anchors: readonly boolean[];
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
      readonly anchors: Anchors;
      /** `undefined` with `anchors`. */
      readonly histories: Histories | undefined;
    }
  | {
      /** `from` is past the end of the board as `head` gives it. */
      readonly kind: "beyond";
      readonly poll: PollView;
      readonly head: BoardHead;
      readonly from: string;
      readonly anchors: Anchors;
      readonly histories: Histories | undefined;
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
 * Whether `earlier` and `later` are one history, by the server's consistency
 * proof between them. Equal sizes need no proof, and an empty `earlier` has
 * none: a board that held entries never reads empty again. A server that
 * refuses one as out of range claims a tree larger than its board, so the
 * claims fail.
 */
async function proveOneHistory(
  api: Api,
  electionId: string,
  earlier: TreeClaim,
  later: TreeClaim,
): Promise<boolean> {
  if (earlier.size === later.size || earlier.size === "0") return oneHistory(earlier, later, []);
  try {
    const { path } = await api.board.getConsistencyProof({
      electionId,
      firstSize: earlier.size,
      secondSize: later.size,
    });
    return oneHistory(earlier, later, path);
  } catch (error) {
    if (outOfRange(error)) return false;
    throw error;
  }
}

/**
 * The histories of the trees the board page shows: at most `ANCHOR_PAGE`
 * proofs, all asked for at once. They name only sizes every visitor sees, so
 * they tell our server nothing a visit didn't (T-10). The head and the
 * checkpoints are read together, so either may be the larger.
 */
export async function loadHistories(
  api: Api,
  electionId: string,
  head: BoardHead,
  anchors: readonly AnchorRow[],
): Promise<Histories> {
  const shown = anchors.slice(0, ANCHOR_PAGE);
  const latest = shown[0];
  const tree = { size: head.treeSize, root: head.root };
  const [headHistory, anchorHistories] = await Promise.all([
    latest === undefined
      ? undefined
      : BigInt(tree.size) <= BigInt(latest.size)
        ? proveOneHistory(api, electionId, tree, latest)
        : proveOneHistory(api, electionId, latest, tree),
    Promise.all(
      shown.slice(1).map((earlier, i) => proveOneHistory(api, electionId, earlier, shown[i]!)),
    ),
  ]);
  return { head: headHistory, anchors: anchorHistories };
}

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
      api.board.getCheckpoints({ electionId, limit: String(ACTIVITY_PAGE) }),
    ]);
  } catch (error) {
    if (notFound(error)) return { kind: "not-found" };
    throw error;
  }
  const [{ definition }, head, first, { checkpoints }] = answers;
  const view = definitionView(electionId, definition);
  if (!view.ok) return { kind: "unavailable", problem: view.problem };
  const anchors = anchorRows(electionId, checkpoints);
  const histories = () =>
    anchors === undefined ? undefined : loadHistories(api, electionId, head, anchors);
  if (first === undefined)
    return { kind: "beyond", poll: view.poll, head, from, anchors, histories: await histories() };
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
  return {
    kind: "board",
    poll: view.poll,
    head,
    from,
    rows,
    anchors,
    histories: await histories(),
  };
}

export type ModerationLog = Awaited<ReturnType<Api["moderation"]["getLog"]>>;

/** The moderation log after sequence number `after` (a canonical decimal `u64`). */
export async function loadModerationLog(api: Api, after: string): Promise<ModerationLog> {
  return api.moderation.getLog({ after, limit: String(LOG_PAGE) });
}

/**
 * Reports the poll `electionId` to the moderators under `reason`, as a
 * visitor asked on its page: `"gone"` if the API keeps no definition for it.
 * The request names the poll and the ground only (src/server/api.ts; T-10,
 * T-11).
 */
export async function reportPoll(
  api: Api,
  electionId: string,
  reason: RemovalGround,
): Promise<"reported" | "gone"> {
  try {
    await api.moderation.report({ electionId, reason });
    return "reported";
  } catch (error) {
    if (notFound(error)) return "gone";
    throw error;
  }
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
export async function loadPollList(api: Api, after: string): Promise<PollList> {
  const { elections } = await api.elections.list({
    ...(after === "" ? {} : { after }),
    limit: String(LIST_PAGE),
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
    next: elections.length === LIST_PAGE ? elections.at(-1) : undefined,
  };
}

/**
 * Polls per page of the stream: each costs the page a definition, a display
 * text and its tags, and a display text may be up to 4 MiB (T-52).
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
 * are checked here (src/server/stream-card.ts), and its tags read as the poll
 * page reads them (`tagsOf`), and who asked it as `readAskedBy` reads it
 * (`askedByOf`). A poll the database lost between the listing and its
 * definition drops out of the page. A page holds `limit` polls at most.
 */
export async function loadStream(
  api: Api,
  sort: StreamSort,
  after: string,
  { q, topic, place }: StreamFilter,
  locale: string,
  readAskedBy?: ReadAskedBy,
  limit = STREAM_PAGE,
): Promise<Stream> {
  let elections;
  try {
    ({ elections } = await api.elections.list({
      sort,
      ...(after === "" ? {} : { after }),
      ...(q === undefined ? {} : { q }),
      ...(topic === undefined ? {} : { topic }),
      ...(place === undefined ? {} : { place }),
      limit: String(limit),
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
        const [{ definition }, displayText, tags, askedBy] = await Promise.all([
          api.elections.getDefinition({ electionId }),
          displayTextOf(api, electionId),
          tagsOf(api, electionId),
          askedByOf(readAskedBy, electionId),
        ]);
        const card = streamCard(electionId, definition, displayText, locale, tags);
        return card.kind === "poll" ? { ...card, askedBy } : card;
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
    next: elections.length === limit ? elections.at(-1) : undefined,
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
      /** Its results, as its page reads them (`resultsOf`). */
      readonly results: PollResults;
    }
  /** Moderation hid its text (docs/moderation-policy.md), so the embed shows none. */
  | { readonly kind: "hidden" }
  | { readonly kind: "not-found" };

/**
 * The poll `code` names (canonical, from the caller), as its embed draws it
 * (docs/design/sharing.md, Embed): resolved as `/p/<code>` resolves it, then
 * loaded and checked as the poll page is, which must print the same code
 * (T-34), with its display text checked as the stream checks a card's
 * (src/server/stream-card.ts), and its results as the page reads them.
 * Nothing of the reader's is passed on (T-10, T-11).
 */
export async function loadEmbed(api: Api, code: string, locale: string): Promise<EmbedPage> {
  const link = await resolveShortLink(api, code);
  if (link.kind === "not-found") return link;
  const page = await loadPoll(api, link.electionId, locale);
  if (page.kind !== "poll" || page.code !== code) return { kind: "not-found" };
  if (page.moderation.state === "hidden") return { kind: "hidden" };
  return {
    kind: "poll",
    poll: page.poll,
    asOf: page.asOf,
    text: page.text,
    results: page.results,
  };
}

/**
 * A creator's profile as apps/web's server reads it from packages/core's
 * `readProfile` ([[0040-creator-profiles]]): an account table, so read by
 * the front (src/node/main.ts) and handed to the page's server function in
 * the request's context, never asked of the API, which reads no account
 * table (T-10). Polls are election IDs in lowercase hex, the latest
 * registered first.
 */
export type ProfileRecord =
  | {
      readonly state: "visible";
      readonly handle: string;
      readonly name: string;
      readonly polls: readonly string[];
    }
  | { readonly state: "hidden"; readonly handle: string; readonly reason: RemovalGround };

/** The profile at `handle`, or `undefined` if no profile has it now. */
export type ReadProfile = (handle: string) => Promise<ProfileRecord | undefined>;

export type ProfilePage =
  | {
      readonly kind: "profile";
      readonly name: string;
      readonly cards: readonly StreamCard[];
      /** Where the next page starts (the last poll of this one), if more follow. */
      readonly next: string | undefined;
    }
  /** Moderation hid it: the ground only, never the name or the polls. */
  | { readonly kind: "hidden"; readonly reason: RemovalGround }
  | { readonly kind: "not-found" };

/**
 * A page of the profile at `handle` (`/by/<handle>`): its name and, from
 * just after `after` (one of its polls, or `""` from the top), up to
 * `STREAM_PAGE` of the polls it shows, each card built and checked as the
 * stream's (src/server/stream-card.ts), so the profile shows no words its
 * polls don't commit to (T-34, T-41). Core lists only polls registered and
 * neither delisted nor hidden, at most 100, so a page costs what a page of
 * the stream does (T-52). An `after` the profile no longer shows starts from
 * the top. A poll the database lost since drops out of the page.
 */
export async function loadProfile(
  api: Api,
  read: ReadProfile,
  handle: string,
  after: string,
  locale: string,
): Promise<ProfilePage> {
  const profile = await read(handle);
  if (profile === undefined) return { kind: "not-found" };
  if (profile.state === "hidden") return { kind: "hidden", reason: profile.reason };
  const start = after === "" ? 0 : profile.polls.indexOf(after) + 1;
  const shown = profile.polls.slice(start, start + STREAM_PAGE);
  const cards = await Promise.all(
    shown.map(async (electionId) => {
      try {
        const [{ definition }, displayText, tags] = await Promise.all([
          api.elections.getDefinition({ electionId }),
          displayTextOf(api, electionId),
          tagsOf(api, electionId),
        ]);
        return streamCard(electionId, definition, displayText, locale, tags);
      } catch (error) {
        if (notFound(error)) return undefined;
        throw error;
      }
    }),
  );
  return {
    kind: "profile",
    name: profile.name,
    cards: cards.filter((card) => card !== undefined),
    next: start + STREAM_PAGE < profile.polls.length ? shown.at(-1) : undefined,
  };
}

/**
 * The words the account page's list of polls with results shows for each of
 * `electionIds` ([[P2-25]] part 4c-2b): its heading in `locale`'s
 * translation, checked as a stream card's (src/server/stream-card.ts), so the
 * list shows no words its polls don't commit to (T-34, T-41). A poll whose
 * definition fails its checks, whose text is missing or withheld (a hidden
 * poll's, T-68) or that the database lost has no heading, so the list still
 * shows it to be taken off. Asked by the polls' IDs alone, as the poll page
 * asks: the server function never gets the account cookie (T-10).
 */
export async function loadFollowedPolls(
  api: Api,
  electionIds: readonly string[],
  locale: string,
): Promise<readonly FollowedPoll[]> {
  return Promise.all(
    electionIds.map(async (electionId): Promise<FollowedPoll> => {
      try {
        const [{ definition }, displayText] = await Promise.all([
          api.elections.getDefinition({ electionId }),
          displayTextOf(api, electionId),
        ]);
        const card = streamCard(electionId, definition, displayText, locale, NO_TAGS);
        return card.kind === "poll"
          ? { electionId, heading: card.text.heading }
          : { electionId, heading: undefined };
      } catch (error) {
        if (notFound(error)) return { electionId, heading: undefined };
        throw error;
      }
    }),
  );
}
