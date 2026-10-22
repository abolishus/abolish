// An account's e-mail address, under /email on apps/web's origin
// ([[0038-verified-accounts]], Email; P2-31 part 2b): read the verified
// address, ask for a code to a new one, and enter the code. The account
// system lives here, so these routes are here too, never on the API (T-10,
// ADR 0017). This transport parses, asks core and serialises; the rules are
// packages/core's (src/account-emails.ts).
//
// T-11, T-73: a request for a code answers the same whether a code went, a
// notice went (another account holds the address), nothing went (the
// address's daily cap) or the provider didn't take the message. Core sends
// nothing to a capped address, so a request that waited for the provider
// would answer a capped address faster; and core reports a failed send as
// `send-unavailable`, which only an uncapped address can reach. So the
// provider is called after the answer, never before it (`afterAnswer`), and
// a failed send reaches only the operator's log, by kind. The page tells
// the person to ask again if no code arrives.
//
// T-10, T-11, T-67: a request's session names its account and nothing else
// is read from it; answers are no-store, and the request log keeps only the
// route class: never the address or the code. CSRF: the session cookie is
// SameSite=Strict, and every POST must also carry our own Origin. T-52: a
// request for a code costs a Turnstile solve for `email-code`, and every
// limit is core's.

import {
  type EmailKeys,
  type EmailSender,
  EmailVerificationError,
  type EmailVerificationErrorCode,
  readAccountEmail,
  requestEmailCode,
  type Turnstile,
  TURNSTILE_HEADER,
  verifyEmailCode,
} from "@abolishus/core";
import type { Sql } from "postgres";
import * as z from "zod";

/** Every e-mail route: `METHOD /path`. Anything else is answered 404. */
export const EMAIL_ROUTES = ["GET /email", "POST /email/request", "POST /email/verify"] as const;

const ROUTES: ReadonlySet<string> = new Set(EMAIL_ROUTES);

/** What the routes need to verify an address; without it every route answers 503. */
export interface EmailService {
  readonly keys: EmailKeys;
  readonly sender: EmailSender;
}

export interface EmailOptions {
  readonly sql: Sql;
  /** The signed-in account behind a request's cookies (`Accounts.accountOf`). */
  readonly accountOf: (headers: Headers) => Promise<string | undefined>;
  /** The keys and the provider, if this deployment has them. */
  readonly service: EmailService | undefined;
  /** Checks the `email-code` token a request for a code carries in `TURNSTILE_HEADER`. */
  readonly turnstile: Turnstile;
  /** apps/web's origin: every POST must come from it. */
  readonly origin: string;
  /** Where a send the provider didn't take is reported, by kind only. */
  readonly log: (line: { readonly error: string }) => void;
  /** The clock; the system's by default. Injected so tests can set it. */
  readonly now?: () => Date;
}

// Transport bounds only, generous over core's (an address is at most 254
// bytes, a code 8 digits with any spaces or hyphens): what is acceptable is
// core's.
const Inputs = {
  "POST /email/request": z.strictObject({ address: z.string().max(1024) }),
  "POST /email/verify": z.strictObject({ code: z.string().max(64) }),
} as const;

/**
 * `sender`, called without waiting: every send is taken as `sent` at once,
 * and one the provider didn't take is logged by kind only.
 */
function afterAnswer(sender: EmailSender, log: EmailOptions["log"]): EmailSender {
  const failed = () => log({ error: "EmailSendUnavailable" });
  return {
    send: async (message) => {
      sender.send(message).then((outcome) => outcome === "sent" || failed(), failed);
      return "sent";
    },
  };
}

const answer = (status: number, body: object) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const refuse = (status: number, code: string, extra: object = {}) =>
  answer(status, { code, status, ...extra });

// `afterAnswer`'s sender always answers `sent`, so core never throws `send-unavailable`.
const ERRORS: Record<Exclude<EmailVerificationErrorCode, "send-unavailable">, [number, string]> = {
  "invalid-address": [422, "INVALID_ADDRESS"],
  "too-many-this-hour": [429, "TOO_MANY_THIS_HOUR"],
  "too-many-today": [429, "TOO_MANY_TODAY"],
  "challenge-refused": [403, "TURNSTILE_REFUSED"],
  "challenge-unavailable": [503, "TURNSTILE_UNAVAILABLE"],
  "no-code": [409, "NO_CODE"],
  expired: [409, "EXPIRED"],
  "wrong-code": [422, "WRONG_CODE"],
  "too-many-tries": [409, "TOO_MANY_TRIES"],
  "address-taken": [409, "ADDRESS_TAKEN"],
};

/** The e-mail handler: answers every route in `EMAIL_ROUTES` for the signed-in account. */
export function createEmailHandler({
  sql,
  accountOf,
  service,
  turnstile,
  origin,
  log,
  now = () => new Date(),
}: EmailOptions): (request: Request) => Promise<Response> {
  const emailing: EmailService | undefined =
    service === undefined
      ? undefined
      : { keys: service.keys, sender: afterAnswer(service.sender, log) };
  return async (request) => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (!ROUTES.has(route) || url.search !== "") return refuse(404, "NOT_FOUND");
    if (request.method === "POST") {
      // A browser sends Origin on every POST; another site's form or script can't send ours.
      if (request.headers.get("origin") !== origin) return refuse(403, "FORBIDDEN_ORIGIN");
      if (request.headers.get("content-type") !== "application/json")
        return refuse(415, "UNSUPPORTED_MEDIA_TYPE");
    }
    const account = await accountOf(request.headers);
    if (account === undefined) return refuse(401, "SIGNED_OUT");
    if (emailing === undefined) return refuse(503, "EMAIL_UNAVAILABLE");
    if (route === "GET /email") {
      const email = await readAccountEmail(sql, account, emailing.keys);
      return answer(
        200,
        email === undefined
          ? {}
          : { address: email.address, verifiedAt: email.verifiedAt.toISOString() },
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return refuse(400, "BAD_REQUEST");
    }
    try {
      switch (route) {
        case "POST /email/request": {
          const input = Inputs[route].safeParse(body);
          if (!input.success) return refuse(400, "BAD_REQUEST");
          await requestEmailCode(sql, account, input.data.address, {
            ...emailing,
            turnstile,
            token: request.headers.get(TURNSTILE_HEADER),
            now: now(),
          });
          return answer(202, {});
        }
        case "POST /email/verify": {
          const input = Inputs[route].safeParse(body);
          if (!input.success) return refuse(400, "BAD_REQUEST");
          await verifyEmailCode(sql, account, input.data.code, { keys: emailing.keys, now: now() });
          return answer(200, {});
        }
      }
      return refuse(404, "NOT_FOUND");
    } catch (e) {
      if (!(e instanceof EmailVerificationError) || e.code === "send-unavailable") throw e;
      const [status, code] = ERRORS[e.code];
      return refuse(status, code, e.triesLeft === undefined ? {} : { triesLeft: e.triesLeft });
    }
  };
}
