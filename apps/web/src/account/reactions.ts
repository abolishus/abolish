// The poll page's calls to the reactions handler on our own origin
// (src/node/reactions.ts, /reactions; [[P2-25]] part 5b). The session cookie
// goes only because the call is same-origin, as the account client's does
// (src/account/client.ts); the handler names the account from it, and
// nothing here names one (T-10). A reaction is on the poll, never on an
// answer, and nothing here knows whether this browser answered (T-10, T-11).
// T-11: `counts` is all the page asks for on its own; `own`, which names the
// account beside the poll, is asked only once the visitor chooses to react.

/**
 * packages/core's `REACTIONS`, in the order they are shown, spelled here so
 * the page's bundle carries none of core's database code; a test holds the
 * two lists equal.
 */
export const REACTIONS = ["heart", "laugh", "wow", "thinking", "sad", "clap"] as const;
export type Reaction = (typeof REACTIONS)[number];

/** How many accounts set each reaction on a poll; every one of `REACTIONS`. */
export type ReactionCounts = Readonly<Record<Reaction, number>>;

/** A poll's reactions as a signed-in account sees them. */
export interface ReactionsView {
  readonly counts: ReactionCounts;
  /** The account's own, in `REACTIONS` order. */
  readonly own: readonly Reaction[];
}

/** Why a reaction wasn't read or changed. */
export type ReactionsFailure =
  /** The session ended, or there is none: sign in to react. */
  | "signedOut"
  /** The account has no verified e-mail address yet. */
  | "unverified"
  /** Moderation hid the poll: no reactions, and no counts. */
  | "hidden"
  /** The account changed as many reactions this hour as it may (T-52). */
  | "tooManyThisHour"
  /** The server refused or failed, or the network did. */
  | "failed";

export class ReactionsError extends Error {
  readonly failure: ReactionsFailure;
  constructor(failure: ReactionsFailure) {
    super(`reactions ${failure}`);
    this.name = "ReactionsError";
    this.failure = failure;
  }
}

/** Every call the page makes, so it can be shown with stand-ins (stories, tests). */
export interface ReactionsClient {
  /** The counts, for anyone: the session isn't read. */
  counts(electionId: string): Promise<ReactionCounts>;
  /** The counts and the signed-in account's own. */
  own(electionId: string): Promise<ReactionsView>;
  /** Sets (`on`) or takes back `reaction`, answering the poll's reactions after it. */
  set(electionId: string, reaction: Reaction, on: boolean): Promise<ReactionsView>;
}

// The handler's codes (src/node/reactions.ts, ERRORS); anything else is
// `failed`. A poll with no stored definition is the page's own 404.
const REFUSALS: Readonly<Record<string, ReactionsFailure>> = {
  SIGNED_OUT: "signedOut",
  ACCOUNT_UNVERIFIED: "unverified",
  HIDDEN: "hidden",
  TOO_MANY_THIS_HOUR: "tooManyThisHour",
};

function refusal(answer: unknown): ReactionsError {
  const code =
    typeof answer === "object" && answer !== null
      ? (answer as Record<string, unknown>)["code"]
      : undefined;
  return new ReactionsError(
    (typeof code === "string" && Object.hasOwn(REFUSALS, code) && REFUSALS[code]) || "failed",
  );
}

const isReaction = (value: unknown): value is Reaction =>
  (REACTIONS as readonly unknown[]).includes(value);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Exactly every reaction's count, each a whole number, or `failed`. */
function reactionCounts(value: unknown): ReactionCounts {
  if (!isObject(value)) throw new ReactionsError("failed");
  const entries = Object.entries(value);
  if (
    entries.length !== REACTIONS.length ||
    !entries.every(([k, n]) => isReaction(k) && Number.isSafeInteger(n) && (n as number) >= 0)
  )
    throw new ReactionsError("failed");
  // Every key and count was checked above.
  const tally = value as Record<Reaction, number>;
  return Object.fromEntries(REACTIONS.map((r) => [r, tally[r]])) as Record<Reaction, number>;
}

/** Exactly the handler's answer, or `failed`. */
function countsOnly(value: unknown): ReactionCounts {
  if (!isObject(value) || Object.keys(value).length !== 1) throw new ReactionsError("failed");
  return reactionCounts(value["counts"]);
}

/** Exactly the handler's answer, or `failed`: each of its own once. */
function reactionsView(value: unknown): ReactionsView {
  if (!isObject(value) || Object.keys(value).length !== 2) throw new ReactionsError("failed");
  const { own } = value;
  if (!Array.isArray(own) || !own.every(isReaction) || new Set(own).size !== own.length)
    throw new ReactionsError("failed");
  return {
    counts: reactionCounts(value["counts"]),
    own: REACTIONS.filter((r) => own.includes(r)),
  };
}

async function call(
  path: "/reactions/counts" | "/reactions/own" | "/reactions/set",
  body: object,
): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    // Exactly this type, with no charset: the handler refuses anything else.
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {
    throw new ReactionsError("failed");
  });
  const answer: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw refusal(answer);
  return answer;
}

/** The client for this origin's reactions handler. */
export const reactionsClient: ReactionsClient = {
  counts: async (electionId) => countsOnly(await call("/reactions/counts", { electionId })),
  own: async (electionId) => reactionsView(await call("/reactions/own", { electionId })),
  set: async (electionId, reaction, on) =>
    reactionsView(await call("/reactions/set", { electionId, reaction, on })),
};
