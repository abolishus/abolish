// A creator's profile, under /profiles on apps/web's origin
// ([[0040-creator-profiles]]; P2-27 parts 1c-2c and 1d-1): anyone reports a
// profile by its handle; a signed-in author makes, renames and deletes their
// own profile, chooses which of their polls it shows, sees its moderation
// and appeals its newest hide. All read `account_profiles`, an account table,
// so they are here, never on the API, which reads none (T-10, ADR 0017).
// This transport parses, asks core and serialises; the rules are
// packages/core's (src/profile-moderation.ts).
//
// T-10, T-11: a report never reads the session (the front strips its cookie,
// src/node/serve.ts), so no account is ever joined to the profile it
// reported, and core counts the report with nothing about the reporter, as
// a poll's report on the API. The author's routes take no handle: the
// session names the account, and the account names its one profile, so no
// one sees another's profile or appeals; a poll is shown only by the account
// that wrote it (core's `showOnProfile`). Answers carry the public decisions, never a
// moderator or a reviewer (T-68). T-10, T-11, T-67: the handle travels in
// the body, never the path, and answers are no-store, so the request log
// keeps only the route class. CSRF: the session cookie is SameSite=Strict,
// and every POST must also carry our own Origin.

import {
  AppealError,
  type AppealErrorCode,
  deleteProfile,
  fileProfileAppeal,
  makeProfile,
  ModerationError,
  type OwnProfile,
  PROFILE_HANDLE,
  ProfileError,
  type ProfileErrorCode,
  type ProfileModeration,
  readOwnProfile,
  readProfileModeration,
  REMOVAL_REASONS,
  renameProfile,
  reportProfile,
  showOnProfile,
} from "@abolishus/core";
import type { Sql } from "postgres";
import * as z from "zod";

/** Every profiles route: `METHOD /path`. Anything else is answered 404. */
export const PROFILE_ROUTES = [
  "POST /profiles/report",
  "POST /profiles/moderation",
  "POST /profiles/appeal",
  "POST /profiles/own",
  "POST /profiles/make",
  "POST /profiles/rename",
  "POST /profiles/delete",
  "POST /profiles/show",
] as const;

const ROUTES: ReadonlySet<string> = new Set(PROFILE_ROUTES);

export interface ProfilesOptions {
  readonly sql: Sql;
  /** The signed-in account behind a request's cookies (`Accounts.accountOf`). */
  readonly accountOf: (headers: Headers) => Promise<string | undefined>;
  /** apps/web's origin: every POST must come from it. */
  readonly origin: string;
  /** The clock a name's one change a UTC day is counted by. */
  readonly now?: () => Date;
}

const PollId = z.string().regex(/^[a-z0-9]{32}$/);
// `profileName` judges the name; the schema only takes a string.
const Name = z.string();

const Inputs = {
  "POST /profiles/report": z.strictObject({
    handle: z.string().regex(PROFILE_HANDLE),
    reason: z.enum(REMOVAL_REASONS),
  }),
  "POST /profiles/moderation": z.strictObject({}),
  "POST /profiles/appeal": z.strictObject({}),
  "POST /profiles/own": z.strictObject({}),
  "POST /profiles/make": z.strictObject({ name: Name }),
  "POST /profiles/rename": z.strictObject({ name: Name }),
  "POST /profiles/delete": z.strictObject({}),
  "POST /profiles/show": z.strictObject({ pollId: PollId, on: z.boolean() }),
} as const;

const own = (p: OwnProfile) => ({
  handle: p.handle,
  name: p.name,
  // A UTC day, as `YYYY-MM-DD`.
  ...(p.renamableOn === undefined ? {} : { renamableOn: p.renamableOn.toISOString().slice(0, 10) }),
  pollIds: p.pollIds,
});

// Sequence numbers are Postgres `bigint`s, so decimal strings, as the API's log.
const moderation = (m: ProfileModeration) => ({
  handle: m.handle,
  state: m.state,
  ...(m.latest === undefined
    ? {}
    : {
        latest: {
          seq: m.latest.seq.toString(),
          action: m.latest.action,
          reason: m.latest.reason,
          decidedAt: m.latest.decidedAt.toISOString(),
        },
      }),
  appealable: m.appealable,
  appeals: m.appeals.map((a) => ({
    decisionSeq: a.decisionSeq.toString(),
    filedAt: a.filedAt.toISOString(),
    ...(a.outcome === undefined ? {} : { outcome: a.outcome }),
    ...(a.reviewedAt === undefined ? {} : { reviewedAt: a.reviewedAt.toISOString() }),
  })),
});

const answer = (status: number, body: object) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const refuse = (status: number, code: string) => answer(status, { code, status });

// `fileProfileAppeal` can refuse only these, given a signed-in account.
const APPEAL_ERRORS: Partial<Record<AppealErrorCode, [number, string]>> = {
  "not-found": [404, "NO_PROFILE"],
  "not-appealable": [409, "NOT_APPEALABLE"],
  "already-appealed": [409, "ALREADY_APPEALED"],
};

const PROFILE_ERRORS: Readonly<Record<ProfileErrorCode, [number, string]>> = {
  account: [403, "PHONE_UNVERIFIED"],
  exists: [409, "PROFILE_EXISTS"],
  "invalid-name": [422, "INVALID_NAME"],
  "no-profile": [404, "NO_PROFILE"],
  "too-soon": [429, "ONE_NAME_A_DAY"],
  hidden: [409, "HIDDEN"],
  "not-found": [404, "NOT_FOUND"],
};

/**
 * The profiles handler: answers every route in `PROFILE_ROUTES`. `report`
 * answers anyone alike, never reading the session; the rest act on the
 * signed-in account's own profile.
 */
export function createProfilesHandler({
  sql,
  accountOf,
  origin,
  now = () => new Date(),
}: ProfilesOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (!ROUTES.has(route) || url.search !== "") return refuse(404, "NOT_FOUND");
    // A browser sends Origin on every POST; another site's form or script can't send ours.
    if (request.headers.get("origin") !== origin) return refuse(403, "FORBIDDEN_ORIGIN");
    if (request.headers.get("content-type") !== "application/json")
      return refuse(415, "UNSUPPORTED_MEDIA_TYPE");

    let body: unknown;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return refuse(400, "BAD_REQUEST");
    }
    try {
      if (route === "POST /profiles/report") {
        const input = Inputs[route].safeParse(body);
        if (!input.success) return refuse(400, "BAD_REQUEST");
        await reportProfile(sql, input.data.handle, input.data.reason);
        return answer(200, {});
      }
      // Every other route acts on the signed-in author's own profile.
      switch (route) {
        case "POST /profiles/moderation": {
          if (!Inputs[route].safeParse(body).success) return refuse(400, "BAD_REQUEST");
          const account = await accountOf(request.headers);
          if (account === undefined) return refuse(401, "SIGNED_OUT");
          const m = await readProfileModeration(sql, account);
          if (m === undefined) return refuse(404, "NO_PROFILE");
          return answer(200, moderation(m));
        }
        case "POST /profiles/appeal": {
          if (!Inputs[route].safeParse(body).success) return refuse(400, "BAD_REQUEST");
          const account = await accountOf(request.headers);
          if (account === undefined) return refuse(401, "SIGNED_OUT");
          const seq = await fileProfileAppeal(sql, account);
          return answer(201, { decisionSeq: seq.toString() });
        }
        case "POST /profiles/own": {
          if (!Inputs[route].safeParse(body).success) return refuse(400, "BAD_REQUEST");
          const account = await accountOf(request.headers);
          if (account === undefined) return refuse(401, "SIGNED_OUT");
          const p = await readOwnProfile(sql, account, { now: now() });
          if (p === undefined) return refuse(404, "NO_PROFILE");
          return answer(200, own(p));
        }
        case "POST /profiles/make": {
          const input = Inputs[route].safeParse(body);
          if (!input.success) return refuse(400, "BAD_REQUEST");
          const account = await accountOf(request.headers);
          if (account === undefined) return refuse(401, "SIGNED_OUT");
          const handle = await makeProfile(sql, account, input.data.name, { now: now() });
          return answer(201, { handle });
        }
        case "POST /profiles/rename": {
          const input = Inputs[route].safeParse(body);
          if (!input.success) return refuse(400, "BAD_REQUEST");
          const account = await accountOf(request.headers);
          if (account === undefined) return refuse(401, "SIGNED_OUT");
          const changed = await renameProfile(sql, account, input.data.name, { now: now() });
          return answer(200, { changed });
        }
        case "POST /profiles/delete": {
          if (!Inputs[route].safeParse(body).success) return refuse(400, "BAD_REQUEST");
          const account = await accountOf(request.headers);
          if (account === undefined) return refuse(401, "SIGNED_OUT");
          return answer(200, { deleted: await deleteProfile(sql, account) });
        }
        case "POST /profiles/show": {
          const input = Inputs[route].safeParse(body);
          if (!input.success) return refuse(400, "BAD_REQUEST");
          const account = await accountOf(request.headers);
          if (account === undefined) return refuse(401, "SIGNED_OUT");
          const { pollId, on } = input.data;
          return answer(200, { changed: await showOnProfile(sql, account, pollId, on) });
        }
      }
      return refuse(404, "NOT_FOUND");
    } catch (e) {
      // The schema admits only well-formed handles and removal grounds, so
      // a report is refused only for a handle no profile has now.
      if (e instanceof ModerationError && e.code === "unknown-profile")
        return refuse(404, "UNKNOWN_PROFILE");
      if (e instanceof AppealError) {
        const known = APPEAL_ERRORS[e.code];
        if (known === undefined) throw e;
        return refuse(known[0], known[1]);
      }
      if (e instanceof ProfileError) {
        const [status, code] = PROFILE_ERRORS[e.code];
        return refuse(status, code);
      }
      throw e;
    }
  };
}
