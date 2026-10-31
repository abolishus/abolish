// Server functions: the only way a page gets data. They run on our server,
// which calls the API (src/server/api.ts), so the browser never does.

import { POLL_TOPICS, type PollTopic } from "@abolishus/core/poll-topics";
import { createServerFn } from "@tanstack/react-start";

import { api } from "./server/api.ts";
import { BOARD_PAGE, FOLLOWED_PAGE } from "./page-sizes.ts";
import {
  loadBoardPage,
  loadFollowedPolls,
  loadModerationLog,
  loadPoll,
  loadPollList,
  loadProfile,
  loadResultsPage,
  loadStream,
  reportPoll,
  resolveShortLink,
  STREAM_PAGE,
} from "./server/load.ts";
import { isStreamPlace, isStreamSearch, STREAM_SORTS, type StreamSort } from "./stream.ts";
import { isLocale } from "./locales.ts";
import { REMOVAL_GROUNDS, type RemovalGround } from "./moderation-grounds.ts";
import {
  ballotBase,
  isCanonicalU64,
  isElectionId,
  isShortCode,
  isSiteKey,
  PROFILE_HANDLE,
} from "./values.ts";

/**
 * Runs `load`, replacing any failure with one fixed error. A server
 * function's error is serialised into the page, and the original's message
 * can name the API's address or quote its answer. The log gets its kind only,
 * as apps/api's does.
 */
async function opaque<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    console.error({ error: error instanceof Error ? error.name : typeof error });
    throw new Error("unavailable");
  }
}

export const fetchPoll = createServerFn({ method: "GET" })
  .inputValidator((electionId: unknown) => {
    if (!isElectionId(electionId)) throw new TypeError("expected an election ID");
    return electionId;
  })
  // Who asked it is read through the front's reader in the request's
  // context (src/start.ts), never the API (T-10); without one, no poll says.
  // The poll's words are in the translation the request's language picks, as
  // the page's own words are.
  .handler(({ data, context }) =>
    opaque(() => loadPoll(api(), data, context.locale, context.readAskedBy)),
  );

export const fetchResultsPage = createServerFn({ method: "GET" })
  .inputValidator((electionId: unknown) => {
    if (!isElectionId(electionId)) throw new TypeError("expected an election ID");
    return electionId;
  })
  .handler(({ data, context }) => opaque(() => loadResultsPage(api(), data, context.locale)));

export const fetchBoardPage = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => {
    const { electionId, from } = (input ?? {}) as { electionId?: unknown; from?: unknown };
    if (!isElectionId(electionId)) throw new TypeError("expected an election ID");
    if (!isCanonicalU64(from) || BigInt(from) % BigInt(BOARD_PAGE) !== 0n)
      throw new TypeError("expected a canonical decimal u64, a multiple of the page size");
    return { electionId, from };
  })
  .handler(({ data }) => opaque(() => loadBoardPage(api(), data.electionId, data.from)));

export const fetchModerationLog = createServerFn({ method: "GET" })
  .inputValidator((before: unknown) => {
    if (!isCanonicalU64(before)) throw new TypeError("expected a canonical decimal u64");
    return before;
  })
  .handler(({ data }) => opaque(() => loadModerationLog(api(), data)));

/**
 * A visitor's report of a poll to the moderators, from its page
 * (src/poll-report.ts). The only POST among the server functions: like
 * every server function it never gets the account cookie (src/node/serve.ts),
 * and the API is asked with the poll and the ground alone (T-10, T-11).
 */
export const sendPollReport = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => {
    const { electionId, reason } = (input ?? {}) as Record<string, unknown>;
    if (!isElectionId(electionId)) throw new TypeError("expected an election ID");
    if (!REMOVAL_GROUNDS.some((g) => g === reason))
      throw new TypeError("expected a removal ground");
    return { electionId, reason: reason as RemovalGround };
  })
  .handler(({ data }) => opaque(() => reportPoll(api(), data.electionId, data.reason)));

export const fetchPollList = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => {
    const { after, q, locale } = (input ?? {}) as Record<string, unknown>;
    // `""` starts the list; `undefined` is refused, so a call must say where it starts.
    if (after !== "" && !isElectionId(after))
      throw new TypeError("expected an election ID or an empty string");
    // `""` is no search; anything else is a query as `streamQuery` gives it, as for the stream.
    if (q !== "" && (typeof q !== "string" || !isStreamSearch(q)))
      throw new TypeError("expected a search query or an empty string");
    // The page's language picks each poll's translation; one of ours only.
    if (!isLocale(locale)) throw new TypeError("expected a locale");
    return { after, q, locale };
  })
  .handler(({ data }) =>
    opaque(async () => ({
      page: await loadPollList(api(), data.after, data.q, data.locale),
      // Names Tier 0 on each row's count, as the stream's cards name it.
      phoneVerification: process.env["PHONE_VERIFICATION"] === "on",
    })),
  );

/**
 * A page of the stream, with the ballot client's address (`BALLOT_URL`)
 * its cards link to, or `null` if none is set, where the cards link only to
 * each poll's page. `limit`, if given, shortens the page (the home page's
 * newest questions).
 */
export const fetchStream = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => {
    const { sort, after, q, topic, place, limit, locale } = (input ?? {}) as Record<
      string,
      unknown
    >;
    if (!STREAM_SORTS.some((s) => s === sort)) throw new TypeError("expected a stream order");
    // `""` starts the stream, as for the register.
    if (after !== "" && !isElectionId(after))
      throw new TypeError("expected an election ID or an empty string");
    // `""` is no search; anything else is a query as `streamQuery` gives it.
    if (q !== "" && (typeof q !== "string" || !isStreamSearch(q)))
      throw new TypeError("expected a search query or an empty string");
    // `""` is no topic and no place; anything else one the API takes.
    if (topic !== "" && !POLL_TOPICS.some((t) => t === topic))
      throw new TypeError("expected a topic or an empty string");
    if (place !== "" && (typeof place !== "string" || !isStreamPlace(place)))
      throw new TypeError("expected a place or an empty string");
    // Bounded by a page, so a caller can't make one request fetch more definitions and texts.
    if (
      limit !== undefined &&
      (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > STREAM_PAGE)
    )
      throw new TypeError("expected a page size from 1 to 10");
    // The page's language picks each card's translation; one of ours only.
    if (!isLocale(locale)) throw new TypeError("expected a locale");
    return {
      locale,
      sort: sort as StreamSort,
      after,
      q,
      topic: topic as PollTopic | "",
      place,
      limit: (limit as number | undefined) ?? STREAM_PAGE,
    };
  })
  .handler(({ data, context }) =>
    opaque(async () => ({
      stream: await loadStream(
        api(),
        data.sort,
        data.after,
        {
          q: data.q === "" ? undefined : data.q,
          topic: data.topic === "" ? undefined : data.topic,
          place: data.place === "" ? undefined : data.place,
        },
        data.locale,
        context.readAskedBy,
        data.limit,
      ),
      ballot: ballotBase(process.env["BALLOT_URL"]) ?? null,
      // Names Tier 0 on each card's count, as the poll page names it (P2-31 part 6a).
      phoneVerification: process.env["PHONE_VERIFICATION"] === "on",
    })),
  );

export const fetchShortLink = createServerFn({ method: "GET" })
  .inputValidator((code: unknown) => {
    if (!isShortCode(code)) throw new TypeError("expected a canonical short code");
    return code;
  })
  .handler(({ data }) => opaque(() => resolveShortLink(api(), data)));

/**
 * This deployment's Turnstile site key (`TURNSTILE_SITE_KEY`), which the poll
 * editor needs to submit; `null` if none is set. Public by design: the
 * widget's secret is the server's alone (src/node/main.ts).
 */
export const fetchChallengeKey = createServerFn({ method: "GET" }).handler((): string | null => {
  const key = process.env["TURNSTILE_SITE_KEY"];
  return isSiteKey(key) ? key : null;
});

/**
 * The ballot client's address (`BALLOT_URL`) a poll's page links to for
 * answering it, or `null` if none is set, where the page offers no link.
 */
export const fetchBallot = createServerFn({ method: "GET" }).handler(
  (): string | null => ballotBase(process.env["BALLOT_URL"]) ?? null,
);

/**
 * Whether this deployment verifies a phone before an account votes
 * (`PHONE_VERIFICATION`; [[0038-verified-accounts]], Owner decision
 * (2026-10-22)): off unless set to `on`, which the deployable refuses at
 * start without a phone provider (src/node/main.ts). The token issuer reads
 * the same setting, so no page asks for a phone the issuer doesn't need.
 */
export const fetchPhoneVerification = createServerFn({ method: "GET" }).handler(
  (): boolean => process.env["PHONE_VERIFICATION"] === "on",
);

/**
 * A page of the profile at `handle` (`/by/<handle>`), from just after
 * `after` (one of its polls, or `""` from the top), with the ballot client's
 * address its cards link to, as the stream's. The profile is read through
 * the front's reader in the request's context (src/start.ts), never the
 * API (T-10); without one this deployment serves no profiles.
 */
export const fetchProfile = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => {
    const { handle, after, locale } = (input ?? {}) as Record<string, unknown>;
    if (typeof handle !== "string" || !PROFILE_HANDLE.test(handle))
      throw new TypeError("expected a profile handle");
    if (after !== "" && !isElectionId(after))
      throw new TypeError("expected an election ID or an empty string");
    if (!isLocale(locale)) throw new TypeError("expected a locale");
    return { handle, after, locale };
  })
  .handler(({ data, context }) =>
    opaque(async () => {
      const read = context.readProfile;
      if (read === undefined) throw new Error("no profile reader");
      return {
        profile: await loadProfile(api(), read, data.handle, data.after, data.locale),
        ballot: ballotBase(process.env["BALLOT_URL"]) ?? null,
      };
    }),
  );

/**
 * Each poll's heading for the account page's list of polls with results
 * (src/account/follow-results.ts), in `locale`'s translation: at most
 * `FOLLOWED_PAGE` distinct polls a call, so one request fetches no more
 * definitions and texts than a page of the stream (T-52). Like every server
 * function it never gets the account cookie (src/node/serve.ts): the list
 * comes from the follows handler, and the polls come here by their IDs
 * alone (T-10).
 */
export const fetchFollowedPolls = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => {
    const { electionIds, locale } = (input ?? {}) as Record<string, unknown>;
    if (
      !Array.isArray(electionIds) ||
      electionIds.length < 1 ||
      electionIds.length > FOLLOWED_PAGE ||
      !electionIds.every(isElectionId) ||
      new Set(electionIds).size !== electionIds.length
    )
      throw new TypeError("expected 1 to 10 distinct election IDs");
    if (!isLocale(locale)) throw new TypeError("expected a locale");
    return { electionIds: electionIds as string[], locale };
  })
  .handler(({ data }) => opaque(() => loadFollowedPolls(api(), data.electionIds, data.locale)));
