// The account page's calls to the profiles handler on our own origin
// (src/node/profiles.ts, /profiles; [[0040-creator-profiles]]; P2-27 part
// 1d-2 and 1d-3): the author's own profile, its name, deleting it, which
// of the author's polls it shows, and its moderation and appeal. The session cookie goes only because the call is
// same-origin, as the account client's does (src/account/client.ts); the
// handler names the account from it, and nothing here names one, nor ever
// sends a handle (T-10). The report route is the profile page's, and goes
// without the session; nothing here calls it.

import type { AppealOutcome, ProfileModerationState } from "@abolishus/core";

import { REMOVAL_GROUNDS, RESTORE_GROUNDS } from "../components/moderation-log.tsx";

import { PROFILE_HANDLE } from "../values.ts";

export { PROFILE_HANDLE };

const POLL_ID = /^[a-z0-9]{32}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const U64 = /^(?:0|[1-9][0-9]{0,19})$/;

/** The signed-in account's own profile. */
export interface OwnProfileView {
  /** Its page's address is `/by/<handle>`; it never changes. */
  readonly handle: string;
  readonly name: string;
  /** `YYYY-MM-DD`, UTC: the day the name can change again; none while it can change today. */
  readonly renamableOn: string | undefined;
  /** The author's polls it shows. */
  readonly pollIds: readonly string[];
}

type RemovalGround = (typeof REMOVAL_GROUNDS)[number];
type RestoreGround = (typeof RESTORE_GROUNDS)[number];

/** A moderation decision about the profile, as the public log has it, never its moderator. */
export type ProfileDecision = {
  /** Its number in the public log. */
  readonly seq: bigint;
  /** ISO 8601. */
  readonly decidedAt: string;
} & (
  | { readonly action: "hide"; readonly reason: RemovalGround }
  | { readonly action: "restore"; readonly reason: RestoreGround }
);

/** One of the author's appeals, never its reviewer. */
export interface ProfileAppealView {
  /** The log number of the decision it contests. */
  readonly decisionSeq: bigint;
  /** ISO 8601. */
  readonly filedAt: string;
  /** None while it waits for review. */
  readonly outcome: AppealOutcome | undefined;
  /** ISO 8601, with the outcome. */
  readonly reviewedAt: string | undefined;
}

/** The profile's moderation as its author sees it (docs/moderation-policy.md, Appeals). */
export interface ProfileModerationView {
  readonly state: ProfileModerationState;
  /** The newest decision; none while nothing has been decided about the profile. */
  readonly latest: ProfileDecision | undefined;
  /** Whether the newest decision can be appealed now. */
  readonly appealable: boolean;
  /** Oldest decision first. */
  readonly appeals: readonly ProfileAppealView[];
}

/** Why a profile action didn't happen. */
export type ProfilesFailure =
  /** The session ended: sign in again. */
  | "signedOut"
  /** A profile needs the account's phone verified first. */
  | "phoneUnverified"
  /** The name isn't one a profile can have. */
  | "invalidName"
  /** The name was set already this UTC day. */
  | "oneNameADay"
  /** Moderation hides the profile, so its name can't change. */
  | "hidden"
  /** The profile was made, deleted or decided about since the page read it. */
  | "changed"
  /** The server refused or failed, or the network did. */
  | "failed";

export class ProfilesError extends Error {
  readonly failure: ProfilesFailure;
  constructor(failure: ProfilesFailure) {
    super(`profile action ${failure}`);
    this.name = "ProfilesError";
    this.failure = failure;
  }
}

/** Every call the page makes, so it can be shown with stand-ins (stories, tests). */
export interface ProfilesClient {
  /** The account's profile, or none. */
  own(): Promise<OwnProfileView | undefined>;
  /** Makes the account's profile, returning its handle. */
  make(name: string): Promise<string>;
  /** Renames the profile, answering whether the name changed. */
  rename(name: string): Promise<boolean>;
  /** Deletes the profile, retiring its handle. */
  remove(): Promise<void>;
  /** The profile's moderation: its state, newest decision and the author's appeals. */
  moderation(): Promise<ProfileModerationView>;
  /** Appeals the profile's newest decision, which must be an unappealed hide. */
  appeal(): Promise<void>;
  /**
   * Shows one of the author's own polls on the profile, or stops showing
   * it, answering whether that changed anything.
   */
  show(pollId: string, on: boolean): Promise<boolean>;
}

// The handler's codes (src/node/profiles.ts, PROFILE_ERRORS and the
// author's routes); anything else is `failed`. `NO_PROFILE` is `own`'s
// answer for an account with none, and `changed` everywhere else.
const REFUSALS: Readonly<Record<string, ProfilesFailure>> = {
  SIGNED_OUT: "signedOut",
  PHONE_UNVERIFIED: "phoneUnverified",
  INVALID_NAME: "invalidName",
  ONE_NAME_A_DAY: "oneNameADay",
  HIDDEN: "hidden",
  PROFILE_EXISTS: "changed",
  NO_PROFILE: "changed",
  NOT_APPEALABLE: "changed",
  ALREADY_APPEALED: "changed",
};

// `show`'s `NOT_FOUND` is a poll the account no longer has, deleted or
// discarded since the page read it; from any other route it is a route
// the handler doesn't serve.
const SHOW_REFUSALS: Readonly<Record<string, ProfilesFailure>> = {
  ...REFUSALS,
  NOT_FOUND: "changed",
};

type Path = "/own" | "/make" | "/rename" | "/delete" | "/moderation" | "/appeal" | "/show";

/** The handler's answer, or `undefined` for `NO_PROFILE` where `none` is set. */
async function call(path: Path, body: object, none = false, refusals = REFUSALS): Promise<unknown> {
  const response = await fetch(`/profiles${path}`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    // Exactly this type, with no charset: the handler refuses anything else.
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {
    throw new ProfilesError("failed");
  });
  const answer: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const code = isObject(answer) ? answer["code"] : undefined;
    if (none && response.status === 404 && code === "NO_PROFILE") return undefined;
    throw new ProfilesError(
      (typeof code === "string" && Object.hasOwn(refusals, code) && refusals[code]) || "failed",
    );
  }
  if (!isObject(answer)) throw new ProfilesError("failed");
  return answer;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `value` if it is an object with every key in `required` and none outside `optional`, else `failed`. */
function exactly(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (!isObject(value)) throw new ProfilesError("failed");
  const keys = Object.keys(value);
  if (
    !required.every((k) => keys.includes(k)) ||
    !keys.every((k) => required.includes(k) || optional.includes(k))
  )
    throw new ProfilesError("failed");
  return value;
}

const matching = (pattern: RegExp, value: unknown): string => {
  if (typeof value !== "string" || !pattern.test(value)) throw new ProfilesError("failed");
  return value;
};

const flag = (value: unknown): boolean => {
  if (typeof value !== "boolean") throw new ProfilesError("failed");
  return value;
};

const seq = (value: unknown): bigint => BigInt(matching(U64, value));

/** Exactly the handler's profile, or `failed`: each shown poll once. */
function ownOf(value: unknown): OwnProfileView {
  const p = exactly(value, ["handle", "name", "pollIds"], ["renamableOn"]);
  const { name, pollIds } = p;
  if (typeof name !== "string" || name === "") throw new ProfilesError("failed");
  if (!Array.isArray(pollIds) || new Set(pollIds).size !== pollIds.length)
    throw new ProfilesError("failed");
  return {
    handle: matching(PROFILE_HANDLE, p["handle"]),
    name,
    renamableOn: p["renamableOn"] === undefined ? undefined : matching(DAY, p["renamableOn"]),
    pollIds: pollIds.map((id) => matching(POLL_ID, id)),
  };
}

const REMOVALS: ReadonlySet<string> = new Set(REMOVAL_GROUNDS);
const RESTORES: ReadonlySet<string> = new Set(RESTORE_GROUNDS);
const OUTCOMES: ReadonlySet<string> = new Set([
  "upheld",
  "rejected",
  "superseded",
] as const satisfies readonly AppealOutcome[]);

function decisionOf(value: unknown): ProfileDecision {
  const d = exactly(value, ["seq", "action", "reason", "decidedAt"]);
  const common = { seq: seq(d["seq"]), decidedAt: matching(ISO, d["decidedAt"]) };
  const { action, reason } = d;
  if (action === "hide" && typeof reason === "string" && REMOVALS.has(reason))
    return { ...common, action, reason: reason as RemovalGround };
  if (action === "restore" && typeof reason === "string" && RESTORES.has(reason))
    return { ...common, action, reason: reason as RestoreGround };
  throw new ProfilesError("failed");
}

/**
 * The handler's answer for the profile's moderation, refused unless it
 * holds together: the state is the newest decision's, only a hide can be
 * appealable, and an appeal has a review time exactly when it has an
 * outcome. The page words what it shows from these alone (T-68). The
 * handle the handler also sends is the one `own` gives, so it isn't kept.
 */
function moderationOf(value: unknown): ProfileModerationView {
  const m = exactly(value, ["handle", "state", "appealable", "appeals"], ["latest"]);
  matching(PROFILE_HANDLE, m["handle"]);
  const appealable = flag(m["appealable"]);
  const latest = m["latest"] === undefined ? undefined : decisionOf(m["latest"]);
  const state = latest?.action === "hide" ? "hidden" : "visible";
  if (m["state"] !== state || (appealable && state === "visible"))
    throw new ProfilesError("failed");
  if (!Array.isArray(m["appeals"])) throw new ProfilesError("failed");
  const appeals = m["appeals"].map((v): ProfileAppealView => {
    const a = exactly(v, ["decisionSeq", "filedAt"], ["outcome", "reviewedAt"]);
    const { outcome } = a;
    if (outcome !== undefined && (typeof outcome !== "string" || !OUTCOMES.has(outcome)))
      throw new ProfilesError("failed");
    if ((outcome === undefined) !== (a["reviewedAt"] === undefined))
      throw new ProfilesError("failed");
    return {
      decisionSeq: seq(a["decisionSeq"]),
      filedAt: matching(ISO, a["filedAt"]),
      outcome: outcome as AppealOutcome | undefined,
      reviewedAt: a["reviewedAt"] === undefined ? undefined : matching(ISO, a["reviewedAt"]),
    };
  });
  return { state, latest, appealable, appeals };
}

/** The client for this origin's profiles handler. */
export const profilesClient: ProfilesClient = {
  async own() {
    const answer = await call("/own", {}, true);
    return answer === undefined ? undefined : ownOf(answer);
  },
  async make(name) {
    return matching(PROFILE_HANDLE, exactly(await call("/make", { name }), ["handle"])["handle"]);
  },
  async rename(name) {
    return flag(exactly(await call("/rename", { name }), ["changed"])["changed"]);
  },
  async remove() {
    // `false`: no profile to delete, which another tab or session did first.
    if (!flag(exactly(await call("/delete", {}), ["deleted"])["deleted"]))
      throw new ProfilesError("changed");
  },
  async moderation() {
    return moderationOf(await call("/moderation", {}));
  },
  async appeal() {
    matching(U64, exactly(await call("/appeal", {}), ["decisionSeq"])["decisionSeq"]);
  },
  async show(pollId, on) {
    const answer = await call("/show", { pollId, on }, false, SHOW_REFUSALS);
    return flag(exactly(answer, ["changed"])["changed"]);
  },
};
