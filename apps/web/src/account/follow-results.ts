// The account page's list of the polls it followed whose results are in
// ([[P2-25]] part 4c-2b): read from and cleared through the follows handler
// on our own origin (src/node/follows.ts, /follows/results), and each poll's
// heading through a server function by the polls' IDs alone
// (`fetchFollowedPolls`, handed in by the route, so this module and its
// stories carry no server function). The session cookie goes only to the follows
// handler, because the call is same-origin, as the account client's does
// (src/account/client.ts); the server functions never get it, so the
// server that reads the polls' words never learns whose list they are on
// (T-10). Following is not answering: nothing here knows whether this
// browser answered any of them (T-10, T-11).

import { isElectionId } from "../values.ts";

/** A poll on the list, as the list shows it. */
export interface FollowedPoll {
  /** The election ID, as the poll page's path spells it. */
  readonly electionId: string;
  /**
   * Its title, or its first question when it has none, in the page's
   * language, checked against its definition; none when its words can't be
   * shown (withheld, missing or failing their checks, or the poll is gone).
   */
  readonly heading: string | undefined;
}

/** Why the list wasn't read or changed. */
export type FollowResultsFailure =
  /** The session ended, or there is none: sign in again. */
  | "signedOut"
  /** The server refused or failed, or the network did. */
  | "failed";

export class FollowResultsError extends Error {
  readonly failure: FollowResultsFailure;
  constructor(failure: FollowResultsFailure) {
    super(`follow results ${failure}`);
    this.name = "FollowResultsError";
    this.failure = failure;
  }
}

/** Every call the list makes, so it can be shown with stand-ins (stories, tests). */
export interface FollowResultsClient {
  /** The account's polls with results, by election ID in byte order. */
  list(): Promise<readonly string[]>;
  /** Takes the poll off the list; taking off one already gone is no failure. */
  drop(electionId: string): Promise<void>;
  /** Each poll's heading in `locale`, in the order asked, at most `FOLLOWED_PAGE` at once. */
  headings(electionIds: readonly string[], locale: string): Promise<readonly FollowedPoll[]>;
}

/** The handler's body, exactly, or `failed`. */
function exactly(value: unknown, key: string): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, key)
  )
    throw new FollowResultsError("failed");
  return (value as Record<string, unknown>)[key];
}

async function call(path: string, body: object): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    // Exactly this type, with no charset: the handler refuses anything else.
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {
    throw new FollowResultsError("failed");
  });
  const answer: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const code =
      typeof answer === "object" && answer !== null
        ? (answer as Record<string, unknown>)["code"]
        : undefined;
    throw new FollowResultsError(code === "SIGNED_OUT" ? "signedOut" : "failed");
  }
  return answer;
}

/** The polls' server function (src/data.ts, `fetchFollowedPolls`), as the client calls it. */
export type ReadFollowedPolls = (input: {
  data: { electionIds: string[]; locale: string };
}) => Promise<readonly FollowedPoll[]>;

/** The client for this origin's follows handler, and `read` for the polls' headings. */
export const followResultsClient = (read: ReadFollowedPolls): FollowResultsClient => ({
  list: async () => {
    const polls = exactly(await call("/follows/results", {}), "polls");
    // Election IDs in strictly increasing byte order, as core lists them;
    // lowercase hex sorts as its bytes do.
    if (
      !Array.isArray(polls) ||
      !polls.every(isElectionId) ||
      polls.some((id, i) => i > 0 && (polls[i - 1] as string) >= id)
    )
      throw new FollowResultsError("failed");
    return polls as string[];
  },
  drop: async (electionId) => {
    if (
      typeof exactly(await call("/follows/results/drop", { electionId }), "dropped") !== "boolean"
    )
      throw new FollowResultsError("failed");
  },
  headings: async (electionIds, locale) => {
    const polls = await read({
      data: { electionIds: [...electionIds], locale },
    }).catch(() => {
      throw new FollowResultsError("failed");
    });
    // The server answers the polls asked for, in order; anything else isn't its answer.
    if (
      polls.length !== electionIds.length ||
      polls.some((p, i) => p.electionId !== electionIds[i])
    )
      throw new FollowResultsError("failed");
    return polls;
  },
});
