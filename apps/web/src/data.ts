// Server functions: the only way a page gets data. They run on our server,
// which calls the API (src/server/api.ts), so the browser never does.

import { createServerFn } from "@tanstack/react-start";

import { api } from "./server/api.ts";
import { loadModerationLog, loadPoll } from "./server/load.ts";
import { isCanonicalU64, isElectionId } from "./values.ts";

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
