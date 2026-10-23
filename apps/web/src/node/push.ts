// An account's web push subscriptions, under /push on apps/web's origin
// (P2-27 part 4b): the account page subscribes this browser with its push
// service and hands us the endpoint, and packages/core's `sendNotices` wakes
// it beside a moderation notice's e-mail (src/account-push.ts,
// src/web-push.ts). They are account rows, so they are here, never on the
// API, which reads no account table (T-10, ADR 0017). This transport parses,
// asks core and serialises.
//
// T-10: the routes take no account ID; the session names the account, only
// its own subscriptions are removed, and `status` says only whether this
// browser's endpoint is the account's own, so a browser another account
// subscribed on a shared device isn't shown as this one's. T-76: core
// keeps an endpoint only on a known push service, so no account can make our
// server call an address of its choosing. T-11, T-67: answers are no-store
// and the request log keeps only the route class, never an endpoint (a
// standing way to wake that browser). CSRF: the session cookie is
// SameSite=Strict, and a POST must also carry our own Origin.
//
// `GET /push/key` is the VAPID public key the page subscribes with, the same
// for every visitor: the front never hands it the cookie (src/node/serve.ts).

import { pushSubscribed, subscribePush, unsubscribePush } from "@abolishus/core";
import type { Sql } from "postgres";
import * as z from "zod";

/** Every push route: `METHOD /path`. Anything else is answered 404. */
export const PUSH_ROUTES = [
  "GET /push/key",
  "POST /push/status",
  "POST /push/subscribe",
  "POST /push/unsubscribe",
] as const;

const ROUTES: ReadonlySet<string> = new Set(PUSH_ROUTES);

/** The longest endpoint read; core refuses anything past its own, shorter bound. */
const MAX_ENDPOINT = 2048;

export interface PushOptions {
  readonly sql: Sql;
  /** The signed-in account behind a request's cookies (`Accounts.accountOf`). */
  readonly accountOf: (headers: Headers) => Promise<string | undefined>;
  /**
   * The VAPID public key (`vapidPublicKey`), when this deployment pushes.
   * Without it every route answers 503: a browser subscribed here would
   * never be woken.
   */
  readonly publicKey: string | undefined;
  /** apps/web's origin: every POST must come from it. */
  readonly origin: string;
  /** The clock a subscription is dated by. */
  readonly now?: () => Date;
}

const Input = z.strictObject({ endpoint: z.string().min(1).max(MAX_ENDPOINT) });

const answer = (status: number, body: object) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const refuse = (status: number, code: string) => answer(status, { code, status });

/** The push handler: the key for anyone, and subscriptions for the signed-in account alone. */
export function createPushHandler({
  sql,
  accountOf,
  publicKey,
  origin,
  now = () => new Date(),
}: PushOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (!ROUTES.has(route) || url.search !== "") return refuse(404, "NOT_FOUND");
    if (publicKey === undefined) return refuse(503, "UNAVAILABLE");
    if (route === "GET /push/key") return answer(200, { key: publicKey });
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
    const { endpoint } = input.data;
    if (route === "POST /push/status")
      return answer(200, { subscribed: await pushSubscribed(sql, account, endpoint) });
    if (route === "POST /push/unsubscribe") {
      // The same answer whether or not it was this account's: nothing to act on.
      await unsubscribePush(sql, account, endpoint);
      return answer(200, {});
    }
    const result = await subscribePush(sql, account, endpoint, now());
    if (result === "invalid-endpoint") return refuse(400, "INVALID_ENDPOINT");
    // Deleted between the session's check and the write.
    if (result === "unknown-account") return refuse(401, "SIGNED_OUT");
    return answer(200, {});
  };
}
