// The data behind each page, fetched from the API on the server.

import { ORPCError } from "@orpc/client";

import { definitionView, type DefinitionProblem, type PollView } from "../poll.ts";
import type { Api } from "./api.ts";

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
    ]);
  } catch (error) {
    if (notFound(error)) return { kind: "not-found" };
    throw error;
  }
  const [{ definition }, board, moderation] = answers;
  const view = definitionView(electionId, definition);
  if (!view.ok) return { kind: "unavailable", problem: view.problem };
  return { kind: "poll", poll: view.poll, board, moderation };
}

/** Decisions per page of the moderation log. */
export const LOG_PAGE = 50;

export type ModerationLog = Awaited<ReturnType<Api["moderation"]["getLog"]>>;

/** The moderation log after sequence number `after` (a canonical decimal `u64`). */
export async function loadModerationLog(api: Api, after: string): Promise<ModerationLog> {
  return api.moderation.getLog({ after, limit: String(LOG_PAGE) });
}

/** Polls per page of the discovery list: each costs the page one definition fetch. */
export const LIST_PAGE = 20;

export type ListedPoll =
  | { readonly kind: "poll"; readonly poll: PollView }
  | {
      readonly kind: "unavailable";
      readonly electionId: string;
      readonly problem: DefinitionProblem;
    };

export interface PollList {
  readonly polls: readonly ListedPoll[];
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
    // The listing's own cursor, not the last poll shown, so a dropped one doesn't end the list.
    next: elections.length === LIST_PAGE ? elections.at(-1) : undefined,
  };
}
