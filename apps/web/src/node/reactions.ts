// Reactions on a poll, under /reactions on apps/web's origin ([[P2-25]] part
// 5b): anyone reads a poll's counts, and a signed-in account reads its own
// reactions and sets or takes back one. The account system lives here,
// so reactions are here too, never on the API (T-10, ADR 0017). This
// transport parses, asks core and serialises; the rules are packages/core's
// (src/reactions.ts).
//
// T-10, T-11: a reaction is on the poll, never on an answer. Nothing here
// reads or names a ballot, a nullifier, a receipt or whether the account
// answered, and the website's poll page offers the control to every visitor
// alike, so a reaction says nothing about participation. T-11: the counts
// never read the session, so the page reads them for every visitor without
// telling the server which account opened which poll; only a visitor who
// chooses to react sends `own`, which names both. T-10, T-11, T-67: a
// request's session names its account and nothing else is read from it; the
// poll travels in the body, never the path, and answers are no-store, so the
// request log keeps only the route class: never the poll, the reaction or
// the account. CSRF: the session cookie is SameSite=Strict, and every POST
// must also carry our own Origin. T-52, T-68: the hour's limit and the
// refusals on a hidden poll are core's.

import {
  REACTIONS,
  ReactionError,
  type ReactionErrorCode,
  readOwnReactions,
  readReactionCounts,
  setReaction,
} from "@abolishus/core";
import type { Sql } from "postgres";
import * as z from "zod";

import { fromHex } from "../values.ts";

/** Every reactions route: `METHOD /path`. Anything else is answered 404. */
export const REACTION_ROUTES = [
  "POST /reactions/counts",
  "POST /reactions/own",
  "POST /reactions/set",
] as const;

const ROUTES: ReadonlySet<string> = new Set(REACTION_ROUTES);

export interface ReactionsOptions {
  readonly sql: Sql;
  /** The signed-in account behind a request's cookies (`Accounts.accountOf`). */
  readonly accountOf: (headers: Headers) => Promise<string | undefined>;
  /** apps/web's origin: every POST must come from it. */
  readonly origin: string;
  /** The clock; the system's by default. Injected so tests can set it. */
  readonly now?: () => Date;
}

/** An election ID as the poll page's path spells it: 32 bytes as lowercase hex. */
const ElectionId = z.string().regex(/^[0-9a-f]{64}$/);

const Poll = z.strictObject({ electionId: ElectionId });

const Inputs = {
  "POST /reactions/counts": Poll,
  "POST /reactions/own": Poll,
  "POST /reactions/set": z.strictObject({
    electionId: ElectionId,
    reaction: z.enum(REACTIONS),
    on: z.boolean(),
  }),
} as const;

const answer = (status: number, body: object) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const refuse = (status: number, code: string) => answer(status, { code, status });

export const ERRORS: Record<ReactionErrorCode, [number, string]> = {
  account: [403, "ACCOUNT_UNVERIFIED"],
  // The schema admits only `REACTIONS`, so core never sees another.
  invalid: [400, "BAD_REQUEST"],
  "unknown-election": [404, "UNKNOWN_ELECTION"],
  hidden: [409, "HIDDEN"],
  "too-many-this-hour": [429, "TOO_MANY_THIS_HOUR"],
};

/**
 * The reactions handler: answers every route in `REACTION_ROUTES`. `counts`
 * answers the poll's counts to anyone, never reading the session; `own` and
 * `set` answer them with the signed-in account's own reactions (`own`).
 */
export function createReactionsHandler({
  sql,
  accountOf,
  origin,
  now = () => new Date(),
}: ReactionsOptions): (request: Request) => Promise<Response> {
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
        case "POST /reactions/counts": {
          const input = Inputs[route].safeParse(body);
          if (!input.success) return refuse(400, "BAD_REQUEST");
          return answer(200, {
            counts: await readReactionCounts(sql, fromHex(input.data.electionId)),
          });
        }
        case "POST /reactions/own": {
          const input = Inputs[route].safeParse(body);
          if (!input.success) return refuse(400, "BAD_REQUEST");
          const account = await accountOf(request.headers);
          if (account === undefined) return refuse(401, "SIGNED_OUT");
          return answer(200, await withOwn(account, fromHex(input.data.electionId)));
        }
        case "POST /reactions/set": {
          const input = Inputs[route].safeParse(body);
          if (!input.success) return refuse(400, "BAD_REQUEST");
          const account = await accountOf(request.headers);
          if (account === undefined) return refuse(401, "SIGNED_OUT");
          const electionId = fromHex(input.data.electionId);
          await setReaction(sql, account, electionId, input.data.reaction, input.data.on, {
            now: now(),
          });
          // Read after the change, so the answer counts it. A poll hidden
          // since is refused here even when a reaction was just taken back,
          // which landed.
          return answer(200, await withOwn(account, electionId));
        }
      }
      return refuse(404, "NOT_FOUND");
    } catch (e) {
      if (!(e instanceof ReactionError)) throw e;
      const [status, code] = ERRORS[e.code];
      return refuse(status, code);
    }
  };

  async function withOwn(account: string, electionId: Uint8Array) {
    return {
      counts: await readReactionCounts(sql, electionId),
      own: await readOwnReactions(sql, account, electionId),
    };
  }
}
