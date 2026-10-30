// Followed polls' results landing, on a timer in apps/web, the one service
// granted the account tables (T-10): each run reads the results of the polls
// some account follows from the API, as the poll page does, and lands those
// whose results are in (packages/core, landResults), which turns each of the
// poll's follows into a line on its follower's list and queues their notice
// for after the next UTC midnight ([[P2-25]] part 4c). Every followed poll is
// read on each pass, so a follow set after a poll's results landed is told
// on the next run, not never.
//
// The API is asked for each poll by its ID alone, from the server, never for
// an account or with anything of one, so the API learns only that some
// account here follows the poll, never which or how many (T-10, T-68).
// Every instance runs it; a poll landed twice at once tells each follower
// once, since a landing deletes the follows it tells.

import { followedPolls, landResults, MAX_FOLLOWED_POLLS } from "@abolishus/core";
import { ORPCError } from "@orpc/client";
import type { Sql } from "postgres";

import type { Api } from "../server/api.ts";
import { toHex } from "../values.ts";

/** How often followed polls' results are read. */
export const LAND_EVERY_MS = 10 * 60 * 1000;
/**
 * The most pages of followed polls one run reads, so a run's reads are
 * bounded; the next run carries on where it stopped. A notice is due only
 * after the next UTC midnight anyway, so a pass that takes a few runs tells
 * no one later.
 */
export const LAND_PAGES = 3;
/** The most results reads in flight at once. */
export const LAND_READS = 4;

/**
 * Whether a poll's results are in: `in` once the board's openings pass
 * (every cell opened), `not-yet` while they don't or the API counts or has
 * none yet, `failed` for any read that didn't answer.
 */
export type ResultsIn = (electionId: Uint8Array) => Promise<"in" | "not-yet" | "failed">;

/**
 * `ResultsIn` through the API's `GET /elections/results`. These are the
 * board's results, not the verifier's verdict, which is what the poll's
 * results page shows the follower too (T-29, T-34).
 */
export function resultsInFrom(api: Pick<Api, "elections">): ResultsIn {
  return async (electionId) => {
    try {
      const served = await api.elections.getResults({ electionId: toHex(electionId) });
      return served.state === "read" && served.passed ? "in" : "not-yet";
    } catch (error) {
      if (
        error instanceof ORPCError &&
        error.defined &&
        (error.code === "RESULTS_NOT_COUNTED" || error.code === "RESULTS_NOT_READY")
      )
        return "not-yet";
      return "failed";
    }
  };
}

export interface ResultsLandingOptions {
  readonly sql: Sql;
  readonly resultsIn: ResultsIn;
  /** A failed read or landing, by kind only; the next pass tries again. */
  readonly log: (line: { readonly error: string }) => void;
  readonly everyMs?: number;
  /** The clock; the system's by default. */
  readonly now?: () => Date;
}

/** Lands followed polls' results once now and then every `everyMs`, until the returned `stop`. */
export function startResultsLanding({
  sql,
  resultsIn,
  log,
  everyMs = LAND_EVERY_MS,
  now = () => new Date(),
}: ResultsLandingOptions): { stop(): Promise<void> } {
  let busy = false;
  let running: Promise<void> = Promise.resolve();
  // Where the pass stopped: the last poll read, or the start.
  let after: Uint8Array | undefined;
  const run = () => {
    // A run still going when the next is due: the next is skipped.
    if (busy) return;
    busy = true;
    running = (async () => {
      try {
        after = await landPages(sql, resultsIn, after, now, log);
      } catch {
        log({ error: "ResultsLandingFailed" });
      } finally {
        busy = false;
      }
    })();
  };
  run();
  const timer = setInterval(run, everyMs);
  // A pending run never holds the process open on shutdown.
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}

/**
 * Reads up to `LAND_PAGES` pages of followed polls from `after` and lands
 * each whose results are in, returning where the next run starts: the last
 * poll read, or `undefined` once the pass reached the end. Failures are
 * logged once a run each, by kind only, never with a poll (T-10).
 */
async function landPages(
  sql: Sql,
  resultsIn: ResultsIn,
  from: Uint8Array | undefined,
  now: () => Date,
  log: ResultsLandingOptions["log"],
): Promise<Uint8Array | undefined> {
  let after = from;
  let readFailed = false;
  let landFailed = false;
  for (let page = 0; page < LAND_PAGES; page++) {
    const polls = await followedPolls(sql, after === undefined ? {} : { after });
    for (let i = 0; i < polls.length; i += LAND_READS)
      await Promise.all(
        polls.slice(i, i + LAND_READS).map(async (electionId) => {
          const state = await resultsIn(electionId);
          if (state === "failed") readFailed = true;
          if (state !== "in") return;
          // Each landing on its own, so one failing keeps no other poll's followers waiting.
          await landResults(sql, electionId, { now: now() }).catch(() => {
            landFailed = true;
          });
        }),
      );
    after = polls.at(-1);
    if (polls.length < MAX_FOLLOWED_POLLS) {
      after = undefined;
      break;
    }
  }
  if (readFailed) log({ error: "ResultsReadFailed" });
  if (landFailed) log({ error: "ResultsLandFailed" });
  return after;
}
