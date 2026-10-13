// The data behind each page, fetched from the API on the server.

import { shortCode } from "@abolishus/core/short-codes";
import { ORPCError } from "@orpc/client";

import { fromHex } from "../values.ts";
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
  return { kind: "poll", poll: view.poll, board, moderation, code };
}

/** The API's canonical code for `electionId`, or `undefined` while no registration is recorded. */
async function codeOf(api: Api, electionId: string): Promise<string | undefined> {
  try {
    return (await api.elections.getCode({ electionId })).code;
  } catch (error) {
    if (error instanceof ORPCError && error.defined && error.code === "CODE_NOT_FOUND")
      return undefined;
    throw error;
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
