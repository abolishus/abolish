// Moderation of a creator's profile, under /profiles on apps/web's origin
// ([[0040-creator-profiles]]; P2-27 part 1c-2c): anyone reports a profile by
// its handle, and a signed-in author sees their own profile's moderation and
// appeals its newest hide. Both read `account_profiles`, an account table,
// so they are here, never on the API, which reads none (T-10, ADR 0017).
// This transport parses, asks core and serialises; the rules are
// packages/core's (src/profile-moderation.ts).
//
// T-10, T-11: a report never reads the session (the front strips its cookie,
// src/node/serve.ts), so no account is ever joined to the profile it
// reported, and core counts the report with nothing about the reporter, as
// a poll's report on the API. The author's routes take no handle: the
// session names the account, and the account names its one profile, so no
// one sees another's appeals. Answers carry the public decisions, never a
// moderator or a reviewer (T-68). T-10, T-11, T-67: the handle travels in
// the body, never the path, and answers are no-store, so the request log
// keeps only the route class. CSRF: the session cookie is SameSite=Strict,
// and every POST must also carry our own Origin.

import {
  AppealError,
  type AppealErrorCode,
  fileProfileAppeal,
  ModerationError,
  PROFILE_HANDLE,
  type ProfileModeration,
  readProfileModeration,
  REMOVAL_REASONS,
  reportProfile,
} from "@abolishus/core";
import type { Sql } from "postgres";
import * as z from "zod";

/** Every profiles route: `METHOD /path`. Anything else is answered 404. */
export const PROFILE_ROUTES = [
  "POST /profiles/report",
  "POST /profiles/moderation",
  "POST /profiles/appeal",
] as const;

const ROUTES: ReadonlySet<string> = new Set(PROFILE_ROUTES);

export interface ProfilesOptions {
  readonly sql: Sql;
  /** The signed-in account behind a request's cookies (`Accounts.accountOf`). */
  readonly accountOf: (headers: Headers) => Promise<string | undefined>;
  /** apps/web's origin: every POST must come from it. */
  readonly origin: string;
}

const Inputs = {
  "POST /profiles/report": z.strictObject({
    handle: z.string().regex(PROFILE_HANDLE),
    reason: z.enum(REMOVAL_REASONS),
  }),
  "POST /profiles/moderation": z.strictObject({}),
  "POST /profiles/appeal": z.strictObject({}),
} as const;

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

/**
 * The profiles handler: answers every route in `PROFILE_ROUTES`. `report`
 * answers anyone alike, never reading the session; `moderation` and
 * `appeal` act on the signed-in account's own profile.
 */
export function createProfilesHandler({
  sql,
  accountOf,
  origin,
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
      switch (route) {
        case "POST /profiles/report": {
          const input = Inputs[route].safeParse(body);
          if (!input.success) return refuse(400, "BAD_REQUEST");
          await reportProfile(sql, input.data.handle, input.data.reason);
          return answer(200, {});
        }
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
      throw e;
    }
  };
}
