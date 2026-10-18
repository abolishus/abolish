// Server functions: the only way a page gets data. They run on our server,
// which calls the API (src/server/api.ts), so the browser never does.

import { createServerFn } from "@tanstack/react-start";

import { api } from "./server/api.ts";
import {
  LIST_PAGE,
  loadModerationLog,
  loadPoll,
  loadPollList,
  resolveShortLink,
} from "./server/load.ts";
import { isCanonicalU64, isElectionId, isShortCode, isSiteKey } from "./values.ts";

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
