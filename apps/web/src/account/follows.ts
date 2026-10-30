// The poll page's call to the follows handler on our own origin
// (src/node/follows.ts, /follows; [[P2-25]] part 4b). The session cookie
// goes only because the call is same-origin, as the account client's does
// (src/account/client.ts); the handler names the account from it, and
// nothing here names one (T-10). Following is not answering, and nothing
// here knows whether this browser answered (T-10, T-11). T-11: the page
// calls this only once the visitor chooses to follow or stop, never on its
// own, so opening a poll page doesn't name the account beside the poll.

/** Why a follow wasn't changed. */
export type FollowsFailure =
  /** The session ended, or there is none: sign in to follow. */
  | "signedOut"
  /** The account has no verified e-mail address yet, where its notices would go. */
  | "unverified"
  /** Moderation hid the poll: it takes no new followers. */
  | "hidden"
  /** The account followed and stopped as often as it may this hour (T-52). */
  | "tooManyThisHour"
  /** The server refused or failed, or the network did. */
  | "failed";

export class FollowsError extends Error {
  readonly failure: FollowsFailure;
  constructor(failure: FollowsFailure) {
    super(`follows ${failure}`);
    this.name = "FollowsError";
    this.failure = failure;
  }
}

/** Every call the page makes, so it can be shown with stand-ins (stories, tests). */
export interface FollowsClient {
  /** Follows (`on`) or stops following the poll, answering whether it's now followed. */
  set(electionId: string, on: boolean): Promise<boolean>;
}

// The handler's codes (src/node/follows.ts, ERRORS); anything else is
// `failed`. A poll with no stored definition is the page's own 404.
const REFUSALS: Readonly<Record<string, FollowsFailure>> = {
  SIGNED_OUT: "signedOut",
  ACCOUNT_UNVERIFIED: "unverified",
  HIDDEN: "hidden",
  TOO_MANY_THIS_HOUR: "tooManyThisHour",
};

function refusal(answer: unknown): FollowsError {
  const code =
    typeof answer === "object" && answer !== null
      ? (answer as Record<string, unknown>)["code"]
      : undefined;
  return new FollowsError(
    (typeof code === "string" && Object.hasOwn(REFUSALS, code) && REFUSALS[code]) || "failed",
  );
}

/** Exactly the handler's answer, or `failed`. */
function following(value: unknown): boolean {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1
  )
    throw new FollowsError("failed");
  const { following } = value as Record<string, unknown>;
  if (typeof following !== "boolean") throw new FollowsError("failed");
  return following;
}

/** The client for this origin's follows handler. */
export const followsClient: FollowsClient = {
  set: async (electionId, on) => {
    const response = await fetch("/follows/set", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      // Exactly this type, with no charset: the handler refuses anything else.
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ electionId, on }),
    }).catch(() => {
      throw new FollowsError("failed");
    });
    const answer: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw refusal(answer);
    const now = following(answer);
    // The handler answers the state asked for; anything else isn't its answer.
    if (now !== on) throw new FollowsError("failed");
    return now;
  },
};
