// Following a poll, under /follows on apps/web's origin ([[P2-25]] part 4b):
// a signed-in account follows a poll or stops following it. The account
// system lives here, so follows are here too, never on the API (T-10, ADR
// 0017). This transport parses, asks core and serialises; the rules are
// packages/core's (src/follows.ts).
//
// T-10, T-11: following is not answering. Nothing here reads or names a
// ballot, a nullifier, a receipt or whether the account answered, and the
// website's poll page offers the control to every visitor alike, so a
// follow says nothing about participation. There is no count and no route
// that reads who follows a poll: an account learns only its own follow, in
// the answer to its own change, so opening a poll page never tells the
// server which account opened it. T-10, T-11, T-67: a request's session
// names its account and nothing else is read from it; the poll travels in
// the body, never the path, and answers are no-store, so the request log
// keeps only the route class: never the poll or the account. CSRF: the
// session cookie is SameSite=Strict, and every POST must also carry our own
// Origin. T-52, T-68: the hour's limit and the refusal on a hidden poll are
// core's.

import { FollowError, type FollowErrorCode, setFollow } from "@abolishus/core";
import type { Sql } from "postgres";
import * as z from "zod";

import { fromHex } from "../values.ts";

/** Every follows route: `METHOD /path`. Anything else is answered 404. */
export const FOLLOW_ROUTES = ["POST /follows/set"] as const;

const ROUTES: ReadonlySet<string> = new Set(FOLLOW_ROUTES);

export interface FollowsOptions {
  readonly sql: Sql;
  /** The signed-in account behind a request's cookies (`Accounts.accountOf`). */
  readonly accountOf: (headers: Headers) => Promise<string | undefined>;
  /** apps/web's origin: every POST must come from it. */
  readonly origin: string;
  /** The clock; the system's by default. Injected so tests can set it. */
  readonly now?: () => Date;
}

const Input = z.strictObject({
  // An election ID as the poll page's path spells it: 32 bytes as lowercase hex.
  electionId: z.string().regex(/^[0-9a-f]{64}$/),
  on: z.boolean(),
});

const answer = (status: number, body: object) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const refuse = (status: number, code: string) => answer(status, { code, status });

export const ERRORS: Record<FollowErrorCode, [number, string]> = {
  account: [403, "ACCOUNT_UNVERIFIED"],
  "unknown-election": [404, "UNKNOWN_ELECTION"],
  hidden: [409, "HIDDEN"],
  "too-many-this-hour": [429, "TOO_MANY_THIS_HOUR"],
};

/**
 * The follows handler: answers every route in `FOLLOW_ROUTES`. `set` follows
 * (`on`) or stops following the poll for the signed-in account, and answers
 * whether it now follows it (`following`).
 */
export function createFollowsHandler({
  sql,
  accountOf,
  origin,
  now = () => new Date(),
}: FollowsOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (!ROUTES.has(`${request.method} ${url.pathname}`) || url.search !== "")
      return refuse(404, "NOT_FOUND");
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
    const input = Input.safeParse(body);
    if (!input.success) return refuse(400, "BAD_REQUEST");
    const account = await accountOf(request.headers);
    if (account === undefined) return refuse(401, "SIGNED_OUT");
    try {
      // Following one already followed, or stopping one not followed,
      // changes nothing, so the answer is the state asked for either way.
      await setFollow(sql, account, fromHex(input.data.electionId), input.data.on, { now: now() });
      return answer(200, { following: input.data.on });
    } catch (e) {
      if (!(e instanceof FollowError)) throw e;
      const [status, code] = ERRORS[e.code];
      return refuse(status, code);
    }
  };
}
