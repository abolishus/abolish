// Server functions: the only way a page gets data. They run on our server,
// which calls the API (src/server/api.ts), so the browser never does.

import { POLL_TOPICS, type PollTopic } from "@abolishus/core/poll-topics";
import { createServerFn } from "@tanstack/react-start";

import { api } from "./server/api.ts";
import { BOARD_PAGE, LIST_PAGE } from "./page-sizes.ts";
import {
  loadBoardPage,
  loadModerationLog,
  loadPoll,
  loadPollList,
  loadProfile,
  loadStream,
  resolveShortLink,
} from "./server/load.ts";
import { isStreamPlace, isStreamSearch, STREAM_SORTS, type StreamSort } from "./stream.ts";
import { LOCALE } from "./messages.ts";
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
  .handler(({ data }) => opaque(() => loadPoll(api(), data)));

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
  .inputValidator((after: unknown) => {
    if (!isCanonicalU64(after)) throw new TypeError("expected a canonical decimal u64");
    return after;
  })
  .handler(({ data }) => opaque(() => loadModerationLog(api(), data)));

export const fetchPollList = createServerFn({ method: "GET" })
  .inputValidator((after: unknown) => {
    // `""` starts the list; `undefined` is refused, so a call must say where it starts.
    if (after !== "" && !isElectionId(after))
      throw new TypeError("expected an election ID or an empty string");
    return after;
  })
  .handler(({ data }) => opaque(() => loadPollList(api(), data)));

/** The first `limit` listed polls, for the home page. */
export const fetchFirstPolls = createServerFn({ method: "GET" })
  .inputValidator((limit: unknown) => {
    // Bounded by a page of the list, so a caller can't make one request fetch more definitions.
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > LIST_PAGE)
      throw new TypeError("expected a page size from 1 to 20");
    return limit as number;
  })
  .handler(({ data }) => opaque(() => loadPollList(api(), "", data)));

/**
 * A page of the stream, with the ballot client's address (`BALLOT_URL`)
 * its cards link to, or `null` if none is set, where the cards link only to
 * each poll's page.
 */
export const fetchStream = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => {
    const { sort, after, q, topic, place } = (input ?? {}) as Record<string, unknown>;
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
    return {
      sort: sort as StreamSort,
      after,
      q,
      topic: topic as PollTopic | "",
      place,
    };
  })
  .handler(({ data }) =>
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
        LOCALE,
      ),
      ballot: ballotBase(process.env["BALLOT_URL"]) ?? null,
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
    const { handle, after } = (input ?? {}) as Record<string, unknown>;
    if (typeof handle !== "string" || !PROFILE_HANDLE.test(handle))
      throw new TypeError("expected a profile handle");
    if (after !== "" && !isElectionId(after))
      throw new TypeError("expected an election ID or an empty string");
    return { handle, after };
  })
  .handler(({ data, context }) =>
    opaque(async () => {
      const read = context.readProfile;
      if (read === undefined) throw new Error("no profile reader");
      return {
        profile: await loadProfile(api(), read, data.handle, data.after, LOCALE),
        ballot: ballotBase(process.env["BALLOT_URL"]) ?? null,
      };
    }),
  );
