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
